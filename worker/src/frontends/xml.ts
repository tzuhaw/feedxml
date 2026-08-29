import sax from "sax";
import type { Readable } from "node:stream";
import type { RawRecord } from "@feedxml/shared";

/**
 * Streaming XML front-end: walks the document with a SAX parser and materializes
 * ONLY the subtree of each record element (e.g. <product>). Memory stays flat
 * regardless of file size — nothing outside the current record is retained.
 */
export function parseXmlRecords(
  stream: Readable,
  recordElement: string,
  onRecord: (record: RawRecord) => void | Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parser = sax.createStream(true, { trim: false });
    // Stack of open nodes INSIDE the current record; empty means we're between records.
    let stack: RawRecord[] = [];
    let root: RawRecord | null = null;
    let pending: Promise<void> = Promise.resolve();

    parser.on("opentag", (tag) => {
      const isRecordStart = root === null && tag.name === recordElement;
      if (root === null && !isRecordStart) return;
      const node: RawRecord = {
        name: tag.name,
        attributes: Object.fromEntries(
          Object.entries(tag.attributes).map(([k, v]) => [k, String(v)]),
        ),
        children: [],
        text: "",
        raw: "",
      };
      if (isRecordStart) {
        root = node;
      } else {
        stack[stack.length - 1]!.children.push(node);
      }
      stack.push(node);
    });

    parser.on("text", (text) => {
      if (stack.length > 0) stack[stack.length - 1]!.text += text;
    });
    parser.on("cdata", (text) => {
      if (stack.length > 0) stack[stack.length - 1]!.text += text;
    });

    parser.on("closetag", (name) => {
      if (root === null || stack.length === 0) return;
      const node = stack.pop()!;
      if (stack.length === 0 && name === recordElement) {
        node.raw = serialize(node);
        const record = node;
        root = null;
        // Serialize record handling so backpressure from the writer is respected.
        pending = pending.then(() => onRecord(record));
        pending.catch(() => {
          /* surfaced at end() below */
        });
      }
    });

    parser.on("error", (err) => reject(err));
    parser.on("end", () => {
      pending.then(resolve, reject);
    });

    stream.on("error", reject);
    stream.pipe(parser);
  });
}

/** Rebuild the record's XML for Issue evidence. Not byte-identical to the source; structurally faithful. */
export function serialize(node: RawRecord): string {
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
