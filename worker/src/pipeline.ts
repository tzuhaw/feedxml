import type { Readable } from "node:stream";
import {
  withDefaultVariant,
  type FeedTransform,
  type SkippedRecord,
} from "@feedxml/shared";
import { parseXmlRecords } from "./frontends/xml.js";
import type { StagingWriter } from "./staging.js";

export interface StageResult {
  /** Records encountered in the Snapshot, valid or not. */
  records: number;
  /** Records staged (valid). */
  staged: number;
  /** Records present but invalid — Skipped, never Missing (CONTEXT.md). */
  skipped: SkippedRecord[];
}

/**
 * The shared streaming core: file → record nodes → per-Feed transform →
 * staging writer. Format front-ends and supplier transforms plug in;
 * everything else is common to every Feed.
 */
export async function stageSnapshot(
  stream: Readable,
  transform: FeedTransform,
  writer: StagingWriter,
): Promise<StageResult> {
  const result: StageResult = { records: 0, staged: 0, skipped: [] };

  await parseXmlRecords(stream, transform.recordElement, async (node) => {
    result.records += 1;
    const outcome = transform.transform(node);
    if (outcome.ok) {
      await writer.write(withDefaultVariant(outcome.product));
      result.staged += 1;
    } else {
      result.skipped.push(outcome.skipped);
    }
  });

  await writer.flush();
  return result;
}
