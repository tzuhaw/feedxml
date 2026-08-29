import sax from "sax";
import type { Readable } from "node:stream";
import type { RawRecord } from "@feedxml/shared";

/**
 * Streaming XML front-end: walks the document with a SAX parser and materializes
 * ONLY the subtree of each record element (e.g. <product>).
 *
 * Backpressure is real, not simulated: the source is consumed chunk-by-chunk
 * via async iteration, and the next chunk is not pulled until every record
 * completed by the previous chunk has been handled by `onRecord`. (sax's own
 * stream wrapper always returns true from write(), so pipe() would never pause
 * the source.) Memory is bounded by one chunk's worth of records.
 *
 * A rejection from `onRecord` aborts immediately — the async iterator's early
 * exit destroys the source stream, so a dead database stops the download too.
 */
export function parseXmlRecords(
  stream: Readable,
  recordElement: string,
  onRecord: (record: RawRecord) => void | Promise<void>,
): Promise<void> {
  return parse(stream, recordElement, onRecord);
}

async function parse(
  stream: Readable,
  recordElement: string,
  onRecord: (record: RawRecord) => void | Promise<void>,
): Promise<void> {
  const parser = sax.parser(true, { trim: false });
  // Open nodes INSIDE the current record; empty means we're between records.
  const stack: RawRecord[] = [];
  // Records completed by the chunk currently being parsed (a handful at most).
  const completed: RawRecord[] = [];
  let parseError: Error | null = null;

  parser.onerror = (err) => {
    parseError = err;
  };

  parser.onopentag = (tag) => {
    const inRecord = stack.length > 0;
    if (!inRecord && tag.name !== recordElement) return;
    const node: RawRecord = {
      name: tag.name,
      attributes: Object.fromEntries(
        Object.entries(tag.attributes).map(([k, v]) => [k, String(v)]),
      ),
      children: [],
      text: "",
      raw: "",
    };
    if (inRecord) stack[stack.length - 1]!.children.push(node);
    stack.push(node);
  };

  const appendText = (text: string) => {
    if (stack.length > 0) stack[stack.length - 1]!.text += text;
  };
  parser.ontext = appendText;
  parser.oncdata = appendText;

  parser.onclosetag = (name) => {
    if (stack.length === 0) return;
    const node = stack.pop()!;
    if (stack.length === 0 && name === recordElement) {
      // `raw` is only read on Skip verdicts — serialize lazily, cache on first use.
      let cached: string | undefined;
      Object.defineProperty(node, "raw", {
        configurable: true,
        enumerable: true,
        get: () => (cached ??= serialize(node)),
      });
      completed.push(node);
    }
  };

  // String chunks split on codepoint boundaries (multi-byte-safe).
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    parser.write(chunk as string);
    if (parseError) throw parseError;
    while (completed.length > 0) {
      await onRecord(completed.shift()!);
    }
  }
  parser.close();
  if (parseError) throw parseError;
  while (completed.length > 0) {
    await onRecord(completed.shift()!);
  }
}

/** Rebuild the record's XML for Issue evidence. Not byte-identical to the source; structurally faithful. */
function serialize(node: RawRecord): string {
  const attrs = Object.entries(node.attributes)
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join("");
  const inner =
    escapeXml(node.text.trim()) + node.children.map(serialize).join("");
  return `<${node.name}${attrs}>${inner}</${node.name}>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
