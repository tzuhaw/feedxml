import type { Readable } from "node:stream";
import {
  withDefaultVariant,
  type FeedTransform,
  type SkippedRecord,
} from "@feedxml/shared";
import { parseXmlRecords } from "./frontends/xml.js";
import type { SkippedWriter, StagingWriter } from "./staging.js";

export interface DuplicateRecord {
  productCode: string;
  occurrence: number;
}

export interface StageResult {
  /** Records encountered in the Snapshot, valid or not. */
  records: number;
  /** UNIQUE Product Codes staged — the Snapshot's catalog size. */
  staged: number;
  /** Total Skipped records — present but invalid, never Missing (CONTEXT.md). */
  skippedCount: number;
  /**
   * Evidence sample of Skipped records, capped so a fully-broken 1M-record
   * Snapshot cannot hold every raw fragment in memory. The complete set of
   * Skipped codes lives durably in staging_skipped.
   */
  skipped: SkippedRecord[];
  /** Total duplicate occurrences (same Product Code more than once; last wins). */
  duplicateCount: number;
  /** Evidence sample of duplicates, same cap rationale as `skipped`. */
  duplicates: DuplicateRecord[];
}

const MAX_EVIDENCE_SAMPLES = 1000;

/**
 * The shared streaming core: file → record nodes → per-Feed transform →
 * staging writers. Format front-ends and supplier transforms plug in;
 * everything else is common to every Feed.
 *
 * Memory note: `seen` grows with the catalog (unique codes), not the file —
 * bounded and acceptable; everything per-record stays flat.
 */
export async function stageSnapshot(
  stream: Readable,
  transform: FeedTransform,
  writer: StagingWriter,
  skippedWriter: SkippedWriter,
): Promise<StageResult> {
  const result: StageResult = {
    records: 0,
    staged: 0,
    skippedCount: 0,
    skipped: [],
    duplicateCount: 0,
    duplicates: [],
  };
  const seen = new Set<string>();
  const skippedSeen = new Set<string>();

  await parseXmlRecords(stream, transform.recordElement, async (node) => {
    result.records += 1;
    const outcome = transform.transform(node);
    if (outcome.ok) {
      const code = outcome.product.productCode;
      if (seen.has(code)) {
        // Duplicate Product Code within one Snapshot: last wins, logged.
        result.duplicateCount += 1;
        if (result.duplicates.length < MAX_EVIDENCE_SAMPLES) {
          result.duplicates.push({ productCode: code, occurrence: result.duplicateCount });
        }
      } else {
        seen.add(code);
        result.staged += 1;
      }
      await writer.write(withDefaultVariant(outcome.product));
    } else {
      result.skippedCount += 1;
      if (result.skipped.length < MAX_EVIDENCE_SAMPLES) {
        result.skipped.push(outcome.skipped);
      }
      const code = outcome.skipped.productCode;
      if (code && !skippedSeen.has(code)) {
        skippedSeen.add(code);
        await skippedWriter.write(code);
      }
    }
  });

  await writer.flush();
  await skippedWriter.flush();
  return result;
}
