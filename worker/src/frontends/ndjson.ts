import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { RawRecord } from "@feedxml/shared";

/**
 * Streaming NDJSON front-end: one JSON object per line, each converted to the
 * same RawRecord shape the XML front-end produces — so a Feed's transform is
 * written ONCE and works for whichever format that supplier's channel
 * delivers (DESIGN.md: the scrape channel feeds the same pipeline).
 *
 * Backpressure is inherent: readline's async iterator pulls the next line only
 * after the previous record has been handled.
 */
/** One record has no business being this large; matches the XML front-end's cap. */
const MAX_LINE_CHARS = 10_000_000;
/** Evidence is a sample, never a copy of the payload. */
const MAX_EVIDENCE_CHARS = 2000;

export async function parseNdjsonRecords(
  stream: Readable,
  onRecord: (record: RawRecord) => void | Promise<void>,
): Promise<void> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;

  // A record-level defect: hand the transform something it will Skip (with a
  // capped evidence sample) rather than failing the whole Run on one bad line.
  const defect = (reason: string, sample: string): RawRecord => ({
    name: "record",
    attributes: {},
    children: [],
    text: "",
    raw: `line ${lineNumber} (${reason}): ${sample.slice(0, MAX_EVIDENCE_CHARS)}`,
  });

  for await (const line of lines) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (trimmed.length > MAX_LINE_CHARS) {
      // Almost always a whole JSON-array file on one line rather than NDJSON.
      await onRecord(defect("line exceeds the per-record size limit", trimmed));
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      await onRecord(defect("not valid JSON", trimmed));
      continue;
    }
    if (Array.isArray(value) || value === null || typeof value !== "object") {
      // NDJSON is one OBJECT per line; an array means the file is plain JSON.
      await onRecord(defect("line is not a JSON object", trimmed));
      continue;
    }
    await onRecord(toRawRecord("record", value, trimmed.slice(0, MAX_EVIDENCE_CHARS)));
  }
}

/** JSON keys that carry an element's TEXT rather than one of its attributes. */
const TEXT_KEYS = ["value", "text", "_text"];

/**
 * JSON → RawRecord. Three conventions make a JSON record indistinguishable
 * from the XML shape a transform was written against:
 *
 * - a scalar property becomes BOTH an attribute and a child node with text,
 *   because XML feeds express the same fact either way;
 * - arrays become repeated children of the same (singular) name, exactly how
 *   XML expresses repetition;
 * - a `value` / `text` / `_text` property becomes the node's OWN text, which
 *   is how `<attribute name="color">blue</attribute>` — an element with both
 *   attributes and text — comes across. Without this, transforms reading
 *   `node.text` silently get empty strings.
 */
export function toRawRecord(name: string, value: unknown, raw = ""): RawRecord {
  const node: RawRecord = { name, attributes: {}, children: [], text: "", raw };

  if (value === null || value === undefined) return node;

  if (Array.isArray(value)) {
    for (const item of value) node.children.push(toRawRecord(name, item));
    return node;
  }

  if (typeof value !== "object") {
    node.text = String(value);
    return node;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === null || child === undefined) continue;
    if (Array.isArray(child)) {
      // `{variants: [...]}` becomes <variants><variant/>… so that childText
      // and children() navigate identically to the XML shape.
      const container: RawRecord = {
        name: key,
        attributes: {},
        children: child.map((item) => toRawRecord(singular(key), item)),
        text: "",
        raw: "",
      };
      node.children.push(container);
    } else if (typeof child === "object") {
      node.children.push(toRawRecord(key, child));
    } else {
      const text = String(child);
      node.attributes[key] = text;
      if (TEXT_KEYS.includes(key)) node.text = text;
      node.children.push({ name: key, attributes: {}, children: [], text, raw: "" });
    }
  }
  return node;
}

/**
 * Container key → item name, matching how XML nests repetition
 * (`<variants><variant/>`, `<categories><category/>`). Naive trailing-'s'
 * stripping mangles real keys — "address" would become "addres" and a
 * transform looking for <address> would find nothing, losing the field
 * silently — so words that only look plural are left alone.
 */
function singular(key: string): string {
  if (/ies$/i.test(key)) return `${key.slice(0, -3)}y`; // categories → category
  if (/(ss|us|is)$/i.test(key)) return key; // address, status, analysis
  if (/(ch|sh|x|z|s)es$/i.test(key)) return key.slice(0, -2); // boxes → box
  if (/s$/i.test(key)) return key.slice(0, -1); // variants → variant
  return key;
}
