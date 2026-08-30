import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import {
  connect,
  migrate,
  seedFeed,
  runSnapshot,
  product,
  testDatabaseUrl,
  LOOSE,
  type FixtureProduct,
} from "./helpers/harness.js";
import { approveRun, rejectRun, reverseDeactivation } from "../src/admin.js";
import { executeRun } from "../src/run.js";

process.env.ALLOW_FILE_SOURCE = "1";

const good = (code: string, title = `Product ${code}`): FixtureProduct => ({ code, title });
const badTitle = (code: string): FixtureProduct => ({ code }); // missing title → Skipped, code known
const badPrice = (code: string): FixtureProduct => ({
  code,
  title: `Product ${code}`,
  variants: [{ sku: `${code}-V1`, price: "CALL US" }],
});

describe.skipIf(!testDatabaseUrl())("Sprint 2 domain rules against real Postgres", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = connect();
    await migrate(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("happy path: first Run stages, merges, and finishes done", async () => {
    const feed = await seedFeed(pool, "s-happy");
    const { runId, halted } = await runSnapshot(pool, feed, [good("A"), good("B")]);
    expect(halted).toBe(false);

    const run = await pool.query(`select state, counts from feed_runs where id = $1`, [runId]);
    expect(run.rows[0].state).toBe("done");
    expect(run.rows[0].counts).toMatchObject({ staged: 2, creates: 2, deactivated: 0 });
    expect((await product(pool, feed, "A"))?.status).toBe("active");
  });

  it("duplicates and unparseable records become Record Issues with evidence; last occurrence wins", async () => {
    const feed = await seedFeed(pool, "s-issues", LOOSE);
    const { runId, halted } = await runSnapshot(pool, feed, [
      good("A", "first title"),
      { title: "no code at all" },
      good("A", "second title"),
    ]);
    expect(halted).toBe(false);
    expect((await product(pool, feed, "A"))?.title).toBe("second title");

    const issues = await pool.query(
      `select scope, product_code, reason, evidence from issues where run_id = $1 order by reason`,
      [runId],
    );
    expect(issues.rowCount).toBe(2);
    const dup = issues.rows.find((i) => i.reason.includes("duplicate"));
    expect(dup).toMatchObject({ scope: "record", product_code: "A" });
    const noCode = issues.rows.find((i) => i.reason.includes("missing product code"));
    expect(noCode.evidence.raw_fragment).toContain("no code at all");
  });

  it("Skipped keeps last known good state and is never swept (Missing ≠ Skipped)", async () => {
    const feed = await seedFeed(pool, "s-lkg", LOOSE);
    await runSnapshot(pool, feed, [good("A"), good("X", "good X title")]);
    const { halted } = await runSnapshot(pool, feed, [good("A"), badTitle("X")]);
    expect(halted).toBe(false);

    const x = await product(pool, feed, "X");
    expect(x).toMatchObject({ status: "active", title: "good X title", skip_streak: 1 });
  });

  it("the Deactivation Sweep marks Missing products inactive with an audit row, never deleting", async () => {
    const feed = await seedFeed(pool, "s-sweep", LOOSE);
    await runSnapshot(pool, feed, [good("A"), good("B")]);
    const { runId } = await runSnapshot(pool, feed, [good("A")]);

    expect((await product(pool, feed, "B"))?.status).toBe("inactive");
    const audit = await pool.query(
      `select 1 from audit_log where action = 'deactivate' and subject->>'run_id' = $1 and subject->>'product_code' = 'B'`,
      [runId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it("a threshold breach halts before anything is applied; Approve applies everything including the sweep", async () => {
    const feed = await seedFeed(pool, "s-halt"); // default (tight) thresholds
    await runSnapshot(pool, feed, [good("A"), good("B"), good("C"), good("D"), good("E")]);
    const { runId, halted } = await runSnapshot(pool, feed, [good("A")]);
    expect(halted).toBe(true);

    const run = await pool.query(`select state, counts from feed_runs where id = $1`, [runId]);
    expect(run.rows[0].state).toBe("awaiting_review");
    expect(run.rows[0].counts.breaches.map((b: { rule: string }) => b.rule).sort()).toEqual([
      "count_drop",
      "missing_set",
    ]);
    // Halt-before-apply: the shrunken snapshot has touched nothing.
    expect((await product(pool, feed, "B"))?.status).toBe("active");
    const runIssue = await pool.query(
      `select status from issues where run_id = $1 and scope = 'run'`,
      [runId],
    );
    expect(runIssue.rows[0].status).toBe("open");

    await approveRun(pool, runId, "admin:test@example.com");
    const after = await pool.query(`select state, counts from feed_runs where id = $1`, [runId]);
    expect(after.rows[0].state).toBe("done");
    expect(after.rows[0].counts.deactivated).toBe(4);
    expect((await product(pool, feed, "B"))?.status).toBe("inactive");
    const resolved = await pool.query(
      `select status, resolution from issues where run_id = $1 and scope = 'run'`,
      [runId],
    );
    expect(resolved.rows[0]).toMatchObject({ status: "resolved", resolution: "approved" });
  });

  it("Reject discards the Run: nothing applied, staging kept as evidence", async () => {
    const feed = await seedFeed(pool, "s-reject");
    await runSnapshot(pool, feed, [good("A"), good("B"), good("C"), good("D"), good("E")]);
    const { runId } = await runSnapshot(pool, feed, [good("A")]);

    await rejectRun(pool, runId, "admin:test@example.com");
    const run = await pool.query(`select state, error from feed_runs where id = $1`, [runId]);
    expect(run.rows[0]).toMatchObject({ state: "failed", error: "rejected by admin" });
    expect((await product(pool, feed, "B"))?.status).toBe("active");
    const staging = await pool.query(
      `select count(*)::int as n from staging_products where run_id = $1`,
      [runId],
    );
    expect(staging.rows[0].n).toBe(1); // evidence retained
  });

  it("an error-rate breach halts a Run on its own", async () => {
    const feed = await seedFeed(pool, "s-errors"); // default 2% error rate
    const products = Array.from({ length: 50 }, (_, i) => good(`P${i}`));
    const { halted, runId } = await runSnapshot(pool, feed, [
      ...products,
      badTitle("P90"),
      badTitle("P91"),
    ]);
    expect(halted).toBe(true);
    const issue = await pool.query(
      `select reason from issues where run_id = $1 and scope = 'run'`,
      [runId],
    );
    expect(issue.rows[0].reason).toContain("error_rate");
  });

  it("a skip streak reaching the per-Feed limit raises one Product Issue, resolved by clean ingest", async () => {
    const feed = await seedFeed(pool, "s-streak", LOOSE, 2);
    await runSnapshot(pool, feed, [good("A"), good("X")]);
    await runSnapshot(pool, feed, [good("A"), badTitle("X")]); // streak 1
    await runSnapshot(pool, feed, [good("A"), badTitle("X")]); // streak 2 → Product Issue

    expect((await product(pool, feed, "X"))?.skip_streak).toBe(2);
    const open = await pool.query(
      `select id from issues where supplier_id = $1 and scope = 'product' and product_code = 'X' and status = 'open'`,
      [feed.supplierId],
    );
    expect(open.rowCount).toBe(1);

    // A third Skipped run must NOT open a second Product Issue.
    await runSnapshot(pool, feed, [good("A"), badTitle("X")]);
    const stillOne = await pool.query(
      `select count(*)::int as n from issues where supplier_id = $1 and scope = 'product' and product_code = 'X'`,
      [feed.supplierId],
    );
    expect(stillOne.rows[0].n).toBe(1);

    // Clean ingest: streak resets, Issue auto-resolves.
    await runSnapshot(pool, feed, [good("A"), good("X")]);
    expect((await product(pool, feed, "X"))?.skip_streak).toBe(0);
    const resolved = await pool.query(
      `select status, resolution from issues where supplier_id = $1 and scope = 'product' and product_code = 'X'`,
      [feed.supplierId],
    );
    expect(resolved.rows[0].status).toBe("resolved");
    expect(resolved.rows[0].resolution).toContain("resolved by run");
  });

  it("a Pin survives the sweep and clears itself on reappearance", async () => {
    const feed = await seedFeed(pool, "s-pin", LOOSE);
    await runSnapshot(pool, feed, [good("A"), good("B")]);
    await runSnapshot(pool, feed, [good("A")]); // sweep deactivates B

    await reverseDeactivation(pool, feed.supplierId, "B", "admin:test@example.com");
    expect(await product(pool, feed, "B")).toMatchObject({ status: "active", pinned: true });

    await runSnapshot(pool, feed, [good("A")]); // B Missing again — but Pinned
    expect(await product(pool, feed, "B")).toMatchObject({ status: "active", pinned: true });

    await runSnapshot(pool, feed, [good("A"), good("B")]); // supplier truth resumes
    expect(await product(pool, feed, "B")).toMatchObject({ status: "active", pinned: false });
    const unpin = await pool.query(
      `select 1 from audit_log where action = 'unpin' and subject->>'product_code' = 'B'`,
    );
    expect(unpin.rowCount).toBe(1);
  });

  it("a deactivated product auto-reactivates on reappearance with an audit row", async () => {
    const feed = await seedFeed(pool, "s-react", LOOSE);
    await runSnapshot(pool, feed, [good("A"), good("B")]);
    await runSnapshot(pool, feed, [good("A")]);
    expect((await product(pool, feed, "B"))?.status).toBe("inactive");

    await runSnapshot(pool, feed, [good("A"), good("B")]);
    expect((await product(pool, feed, "B"))?.status).toBe("active");
    const audit = await pool.query(
      `select 1 from audit_log where action = 'reactivate' and subject->>'product_code' = 'B'`,
    );
    expect(audit.rowCount).toBe(1);
  });

  it("a product with a valid AND a malformed record in one Snapshot does not streak", async () => {
    const feed = await seedFeed(pool, "s-both", LOOSE, 1);
    await runSnapshot(pool, feed, [good("A"), good("X", "old")]);
    await runSnapshot(pool, feed, [good("A"), good("X", "new"), badTitle("X")]);

    const x = await product(pool, feed, "X");
    expect(x).toMatchObject({ status: "active", title: "new", skip_streak: 0 });
    const issues = await pool.query(
      `select count(*)::int as n from issues where supplier_id = $1 and scope = 'product'`,
      [feed.supplierId],
    );
    expect(issues.rows[0].n).toBe(0); // even at skip_streak_limit = 1
  });

  it("retrying the same Run does not double-bump skip streaks (restart-everything idempotency)", async () => {
    const feed = await seedFeed(pool, "s-retry", LOOSE);
    await runSnapshot(pool, feed, [good("A"), good("X")]);
    const { ctx } = await runSnapshot(pool, feed, [good("A"), badTitle("X")]);
    expect((await product(pool, feed, "X"))?.skip_streak).toBe(1);

    // Simulate a Cloud Run retry: re-execute the same Run from scratch —
    // its streak contribution must not be counted twice.
    await executeRun(pool, ctx);
    expect((await product(pool, feed, "X"))?.skip_streak).toBe(1);
  });

  it("approving a stale Halted run is refused once a newer run exists", async () => {
    const feed = await seedFeed(pool, "s-stale");
    await runSnapshot(pool, feed, [good("A"), good("B"), good("C"), good("D"), good("E")]);
    const { runId: staleId, halted } = await runSnapshot(pool, feed, [good("A")]);
    expect(halted).toBe(true);
    await runSnapshot(pool, feed, [good("A"), good("B"), good("C"), good("D"), good("E")]);

    // Since Sprint 3, the newer run's execution usually supersedes the halted
    // one outright; the stale guard covers the not-yet-executed window.
    // Either way, approving must be refused and nothing applied.
    await expect(approveRun(pool, staleId, "admin:test@example.com")).rejects.toThrow(
      /stale|superseded/,
    );
    expect((await product(pool, feed, "B"))?.status).toBe("active");
  });

  it("partial per-feed thresholds fall back to defaults instead of disabling rules", async () => {
    const feed = await seedFeed(pool, "s-partial", { maxErrorRate: 0.9 }); // count-drop key absent
    await runSnapshot(pool, feed, [good("A"), good("B"), good("C"), good("D"), good("E")]);
    const { halted, runId } = await runSnapshot(pool, feed, [good("A")]);
    expect(halted).toBe(true); // default maxCountDrop 0.2 still applies
    const issue = await pool.query(
      `select reason from issues where run_id = $1 and scope = 'run'`,
      [runId],
    );
    expect(issue.rows[0].reason).toContain("count_drop");
  });

  it("code-less Record Issues resolve as superseded once a later run applies", async () => {
    const feed = await seedFeed(pool, "s-codeless", LOOSE);
    const { runId: first } = await runSnapshot(pool, feed, [good("A"), { title: "no code" }]);
    const open = await pool.query(
      `select id from issues where run_id = $1 and product_code is null and status = 'open'`,
      [first],
    );
    expect(open.rowCount).toBe(1);

    await runSnapshot(pool, feed, [good("A")]);
    const resolved = await pool.query(
      `select status, resolution from issues where run_id = $1 and product_code is null`,
      [first],
    );
    expect(resolved.rows[0].status).toBe("resolved");
    expect(resolved.rows[0].resolution).toContain("superseded by run");
  });

  it("a successfully retried run clears its stale error message", async () => {
    const feed = await seedFeed(pool, "s-error-clear", LOOSE);
    const { runId, ctx } = await runSnapshot(pool, feed, [good("A")]);
    await pool.query(`update feed_runs set state = 'failed', error = 'connect ETIMEDOUT' where id = $1`, [runId]);

    await executeRun(pool, ctx);
    const run = await pool.query(`select state, error from feed_runs where id = $1`, [runId]);
    expect(run.rows[0]).toMatchObject({ state: "done", error: null });
  });

  it("a newer Snapshot supersedes a Halted run and closes its Run Issue", async () => {
    const feed = await seedFeed(pool, "s-supersede");
    await runSnapshot(pool, feed, [good("A"), good("B"), good("C"), good("D"), good("E")]);
    const { runId: haltedId, halted } = await runSnapshot(pool, feed, [good("A")]);
    expect(halted).toBe(true);
    const { runId: newerId } = await runSnapshot(pool, feed, [
      good("A"), good("B"), good("C"), good("D"), good("E"),
    ]);

    const old = await pool.query(
      `select state, superseded_by from feed_runs where id = $1`,
      [haltedId],
    );
    expect(old.rows[0]).toMatchObject({ state: "superseded", superseded_by: newerId });
    const issue = await pool.query(
      `select status, resolution from issues where run_id = $1 and scope = 'run'`,
      [haltedId],
    );
    expect(issue.rows[0]).toMatchObject({ status: "resolved", resolution: "superseded" });
    // The stale verdict is gone from the review queue: approve now refuses.
    await expect(approveRun(pool, haltedId, "admin:test@example.com")).rejects.toThrow(
      /superseded|not awaiting_review/,
    );
  });

  it("executing a superseded run is a no-op that keeps its evidence", async () => {
    const feed = await seedFeed(pool, "s-dead-run");
    await runSnapshot(pool, feed, [good("A"), good("B"), good("C"), good("D"), good("E")]);
    const { runId: haltedId, ctx } = await runSnapshot(pool, feed, [good("A")]);
    await runSnapshot(pool, feed, [good("A"), good("B"), good("C"), good("D"), good("E")]);

    const outcome = await executeRun(pool, ctx);
    expect(outcome.superseded).toBe(true);
    expect(outcome.result).toBeNull();
    const run = await pool.query(`select state, attempt from feed_runs where id = $1`, [haltedId]);
    expect(run.rows[0].state).toBe("superseded");
    expect(run.rows[0].attempt).toBe(1); // the no-op never claimed an attempt
  });

  it("re-executing a Halted run is refused (no Issue wipe, no duplicate review email)", async () => {
    const feed = await seedFeed(pool, "s-rehalt");
    await runSnapshot(pool, feed, [good("A"), good("B"), good("C"), good("D"), good("E")]);
    const { runId, ctx, halted } = await runSnapshot(pool, feed, [good("A")]);
    expect(halted).toBe(true);

    const outcome = await executeRun(pool, ctx); // raced relaunch of the same run
    expect(outcome.result).toBeNull();
    expect(outcome.superseded).toBe(false);
    const run = await pool.query(`select state from feed_runs where id = $1`, [runId]);
    expect(run.rows[0].state).toBe("awaiting_review");
    const issues = await pool.query(
      `select count(*)::int as n from issues where run_id = $1 and scope = 'run' and status = 'open'`,
      [runId],
    );
    expect(issues.rows[0].n).toBe(1); // still exactly one, not wiped-and-recreated
  });

  it("a superseded run's staging is purged by the next successful run", async () => {
    const feed = await seedFeed(pool, "s-sup-purge");
    await runSnapshot(pool, feed, [good("A"), good("B")]);
    const { runId: haltedId } = await runSnapshot(pool, feed, [good("A")]); // halts
    await runSnapshot(pool, feed, [good("A"), good("B")]); // supersedes + completes

    const run = await pool.query(`select state from feed_runs where id = $1`, [haltedId]);
    expect(run.rows[0].state).toBe("superseded");
    const staging = await pool.query(
      `select count(*)::int as n from staging_products where run_id = $1`,
      [haltedId],
    );
    expect(staging.rows[0].n).toBe(0); // no orphaned staging accumulating forever
  });

  it("retention: a successful run purges the PREVIOUS successful run's staging only", async () => {
    const feed = await seedFeed(pool, "s-retention", LOOSE);
    const { runId: first } = await runSnapshot(pool, feed, [good("A")]);
    const { runId: second } = await runSnapshot(pool, feed, [good("A"), good("B")]);

    const firstStaging = await pool.query(
      `select count(*)::int as n from staging_products where run_id = $1`,
      [first],
    );
    const secondStaging = await pool.query(
      `select count(*)::int as n from staging_products where run_id = $1`,
      [second],
    );
    expect(firstStaging.rows[0].n).toBe(0); // purged once the next run succeeded
    expect(secondStaging.rows[0].n).toBe(2); // the last successful run keeps its staging
  });

  it("a Record Issue auto-resolves when the product later ingests cleanly", async () => {
    const feed = await seedFeed(pool, "s-resolve", LOOSE);
    await runSnapshot(pool, feed, [good("A"), badPrice("Y")]);
    const open = await pool.query(
      `select id from issues where supplier_id = $1 and scope = 'record' and product_code = 'Y' and status = 'open'`,
      [feed.supplierId],
    );
    expect(open.rowCount).toBe(1);

    await runSnapshot(pool, feed, [good("A"), good("Y")]);
    const resolved = await pool.query(
      `select status from issues where supplier_id = $1 and scope = 'record' and product_code = 'Y'`,
      [feed.supplierId],
    );
    expect(resolved.rows[0].status).toBe("resolved");
  });
});
