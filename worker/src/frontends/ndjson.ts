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
export async function parseNdjsonRecords(
  stream: Readable,
  onRecord: (record: RawRecord) => void | Promise<void>,
): Promise<void> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      // A corrupt line is a record-level defect: hand the transform something
      // it will Skip (with the raw line as evidence) rather than failing the
      // whole Run on one bad byte.
      await onRecord({
        name: "record",
        attributes: {},
        children: [],
        text: "",
        raw: `line ${lineNumber}: ${trimmed.slice(0, 2000)}`,
      });
      continue;
    }
    await onRecord(toRawRecord("record", value, trimmed));
  }
}

/**
 * JSON → RawRecord. Scalar properties become BOTH an attribute and a child
 * node with text, because XML feeds express the same fact either way and a
 * transform written for one must not have to care. Arrays become repeated
 * children of the same name — exactly how XML expresses repetition.
 */
export function toRawRecord(name: string, value: unknown, raw = ""): RawRecord {
  const node: RawRecord = { name, attributes: {}, children: [], text: "", raw };

  if (value === null || value === undefined) return node;

  if (Array.isArray(value)) {
    // A bare array under a key: children are added by the caller's loop.
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
      node.children.push({ name: key, attributes: {}, children: [], text, raw: "" });
    }
  }
  return node;
}

function singular(key: string): string {
  return key.endsWith("s") ? key.slice(0, -1) : key;
}
