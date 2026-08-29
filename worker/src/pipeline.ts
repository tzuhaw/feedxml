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
  /** Total Skipped records — present but invalid, never Missing (CONTEXT.md). */
  skippedCount: number;
  /**
   * Evidence sample of Skipped records, capped so a fully-broken 1M-record
   * Snapshot cannot hold every raw fragment in memory. The cap comfortably
   * exceeds any per-run Issue volume an admin would review.
   */
  skipped: SkippedRecord[];
}

const MAX_SKIPPED_SAMPLES = 1000;

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
  const result: StageResult = { records: 0, staged: 0, skippedCount: 0, skipped: [] };

  await parseXmlRecords(stream, transform.recordElement, async (node) => {
    result.records += 1;
    const outcome = transform.transform(node);
    if (outcome.ok) {
      await writer.write(withDefaultVariant(outcome.product));
      result.staged += 1;
    } else {
      result.skippedCount += 1;
      if (result.skipped.length < MAX_SKIPPED_SAMPLES) {
        result.skipped.push(outcome.skipped);
      }
    }
  });

  await writer.flush();
  return result;
}
