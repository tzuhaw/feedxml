import { describe, it, expect } from "vitest";
import { DEFAULT_THRESHOLDS } from "@feedxml/shared";
import { evaluateThresholds, type RunCounts } from "../src/validate.js";

const base: RunCounts = {
  records: 1000,
  staged: 990,
  skipped: 10,
  duplicates: 0,
  activeBefore: 1000,
  previousStaged: 1000,
  missing: 10,
};

describe("per-Feed threshold evaluation (CONTEXT.md: Halted)", () => {
  it("passes a healthy snapshot", () => {
    expect(evaluateThresholds(base, DEFAULT_THRESHOLDS)).toEqual([]);
  });

  it("halts on a count drop beyond the limit (the truncated-feed fuse)", () => {
    const breaches = evaluateThresholds(
      { ...base, staged: 700, missing: 0, skipped: 0 },
      DEFAULT_THRESHOLDS,
    );
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ rule: "count_drop", observed: 0.3, limit: 0.2 });
  });

  it("halts when the Missing set is too large a share of the catalog", () => {
    const breaches = evaluateThresholds(
      { ...base, missing: 100, skipped: 0 },
      DEFAULT_THRESHOLDS,
    );
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ rule: "missing_set", observed: 0.1 });
  });

  it("halts on a high error rate (the feed is broken, not the records)", () => {
    const breaches = evaluateThresholds(
      { ...base, skipped: 100, staged: 900, missing: 0 },
      DEFAULT_THRESHOLDS,
    );
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ rule: "error_rate", observed: 0.1 });
  });

  it("a Feed's first Run has no count-drop baseline and cannot breach it", () => {
    const breaches = evaluateThresholds(
      { ...base, previousStaged: null, activeBefore: 0, missing: 0, staged: 5, records: 5, skipped: 0 },
      DEFAULT_THRESHOLDS,
    );
    expect(breaches).toEqual([]);
  });

  it("reports multiple simultaneous breaches", () => {
    const breaches = evaluateThresholds(
      { ...base, staged: 400, skipped: 600, missing: 600 },
      DEFAULT_THRESHOLDS,
    );
    expect(breaches.map((b) => b.rule).sort()).toEqual([
      "count_drop",
      "error_rate",
      "missing_set",
    ]);
  });
});
