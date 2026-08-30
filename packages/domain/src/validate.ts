import type { FeedThresholds } from "@feedxml/shared";

/** Aggregate numbers a Run is judged on (CONTEXT.md: Halted). */
export interface RunCounts {
  records: number;
  /** Unique Product Codes staged. */
  staged: number;
  skipped: number;
  duplicates: number;
  /** Active catalog size for this Supplier before the Run applies. */
  activeBefore: number;
  /** Unique staged count of the Feed's last successful Run; null on the first Run. */
  previousStaged: number | null;
  /** Active products with no record at all in this Snapshot (Missing, not Skipped). */
  missing: number;
}

export interface Breach {
  rule: "count_drop" | "missing_set" | "error_rate";
  observed: number;
  limit: number;
}

/**
 * Pure evaluation of the per-Feed thresholds. Any breach means the Run halts
 * before anything is applied and a human decides (DESIGN.md §4).
 */
export function evaluateThresholds(c: RunCounts, t: FeedThresholds): Breach[] {
  const breaches: Breach[] = [];
  if (c.previousStaged !== null && c.previousStaged > 0) {
    const drop = 1 - c.staged / c.previousStaged;
    if (drop > t.maxCountDrop) {
      breaches.push({ rule: "count_drop", observed: round(drop), limit: t.maxCountDrop });
    }
  }
  if (c.activeBefore > 0) {
    const fraction = c.missing / c.activeBefore;
    if (fraction > t.maxMissingSet) {
      breaches.push({ rule: "missing_set", observed: round(fraction), limit: t.maxMissingSet });
    }
  }
  if (c.records > 0) {
    const rate = c.skipped / c.records;
    if (rate > t.maxErrorRate) {
      breaches.push({ rule: "error_rate", observed: round(rate), limit: t.maxErrorRate });
    }
  }
  return breaches;
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
