import Link from "next/link";
import { notFound } from "next/navigation";
import { previewApply } from "@feedxml/domain";
import { getPool } from "@/lib/db";
import { Shell, Card, Table, Cell, Pill, StateBadge, Empty, Pager, paginate, ago, duration } from "../../ui";
import { requireAdmin } from "@/lib/guard";
import {
  approveRunAction,
  rejectRunAction,
  retryRunAction,
  reingestAction,
} from "../../actions";

export const dynamic = "force-dynamic";

function Button({
  children,
  tone = "normal",
}: {
  children: React.ReactNode;
  tone?: "normal" | "danger" | "primary";
}) {
  return (
    <button type="submit" className={`act act-${tone}`}>
      {children}
    </button>
  );
}

const ISSUES_PER_PAGE = 25;

export default async function RunDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  // Authorize before any data is fetched (see lib/guard.ts).
  await requireAdmin();

  const { id } = await params;
  const { page: rawPage } = await searchParams;
  // The id reaches a uuid column; anything else is a bad link, not a fault.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const pool = getPool();
  const res = await pool.query(
    `select r.*, f.supplier_id, f.skip_streak_limit, f.thresholds, s.name as supplier
     from feed_runs r
     join feeds f on f.id = r.feed_id
     join suppliers s on s.id = f.supplier_id
     where r.id = $1`,
    [id],
  );
  if (res.rowCount === 0) notFound();
  const run = res.rows[0];

  // A bad snapshot can raise thousands of Record Issues, so this pages rather
  // than truncating at a fixed 50 — silent truncation here reads as "that is
  // all of them", which is exactly wrong when triaging a broken feed.
  const issueCount = await pool.query(
    `select count(*)::int as n from issues where run_id = $1`,
    [id],
  );
  const issueTotal: number = issueCount.rows[0].n;
  const {
    page: issuePage,
    pageCount: issuePageCount,
    offset: issueOffset,
  } = paginate(issueTotal, rawPage, ISSUES_PER_PAGE);
  const issues = await pool.query(
    `select id, scope, status, product_code, reason, evidence, resolution
     from issues where run_id = $1
     order by scope, created_at, id
     limit ${ISSUES_PER_PAGE} offset ${issueOffset}`,
    [id],
  );

  // The preview is computable whenever this run's staging evidence survives.
  // An empty snapshot has no staged rows but IS still previewable (it would
  // deactivate everything) — check both staging tables before concluding the
  // evidence was purged.
  const awaitingVerdict = run.state === "awaiting_review";
  // A run whose worker stopped heartbeating is recoverable; a merge in flight
  // is never restarted (it would wipe the staging rows it is reading).
  const retryableStuck =
    ["downloading", "staging", "validating"].includes(run.state) &&
    Date.now() - new Date(run.updated_at).getTime() > 10 * 60_000;
  const preview = awaitingVerdict ? await previewApply(pool, id, run.supplier_id) : null;

  const counts = run.counts ?? {};

  return (
    <Shell title={`Run — ${run.supplier}`} nav="runs" sub={`Attempt ${run.attempt}`}>
      <div className="run-meta">
        <StateBadge state={run.state} />
        {run.manual_reingest && <Pill tone="info">manual re-ingest</Pill>}
        <span className="sep">·</span>
        <span>started {ago(run.created_at)}</span>
        <span className="sep">·</span>
        <span>took {duration(run.created_at, run.updated_at)}</span>
        {run.superseded_by && (
          <>
            <span className="sep">·</span>
            <span>
              superseded by <Link href={`/admin/runs/${run.superseded_by}`}>a newer run</Link>
            </span>
          </>
        )}
      </div>
      <p className="run-key mono">{run.object_key}</p>
      {run.error && <p className="run-error">{run.error}</p>}

      {preview && (
        <section className="preview-card">
          <h2>This snapshot needs review — here is exactly what approving does</h2>
          <ul className="preview-list">
            <li>
              <strong>{preview.deactivations.toLocaleString()}</strong> products deactivated
              (missing from this snapshot)
            </li>
            <li>
              <strong>{preview.creates.toLocaleString()}</strong> created,{" "}
              <strong>{preview.updates.toLocaleString()}</strong> updated,{" "}
              <strong>{preview.reactivations.toLocaleString()}</strong> reactivated
            </li>
            <li>
              {preview.skipped.toLocaleString()} skipped records keep their last known good
              state; {preview.pinnedProtected.toLocaleString()} pinned products are protected
              from the sweep; {preview.unpins.toLocaleString()} pins clear
            </li>
          </ul>
          {Array.isArray(counts.breaches) && (
            <p className="halted-on">
              Halted on:{" "}
              {counts.breaches
                .map((b: { rule: string; observed: number; limit: number }) =>
                  `${b.rule} ${b.observed} > ${b.limit}`,
                )
                .join(", ")}
            </p>
          )}
          {preview.creates + preview.updates === 0 && (
            <p className="run-error" style={{ marginTop: "0.75rem" }}>
              This snapshot staged no usable products at all — approving it would deactivate the
              entire catalog for this supplier. Almost certainly a truncated or broken export.
            </p>
          )}
          <div className="act-row" style={{ marginTop: "1rem" }}>
            <form action={approveRunAction}>
              <input type="hidden" name="runId" value={id} />
              <input
                type="hidden"
                name="previewedDeactivations"
                value={preview.deactivations}
              />
              <Button tone="primary">
                Approve — apply everything, deactivate{" "}
                {preview.deactivations.toLocaleString()}
              </Button>
            </form>
            <form action={rejectRunAction}>
              <input type="hidden" name="runId" value={id} />
              <Button tone="danger">Reject — discard this run</Button>
            </form>
          </div>
        </section>
      )}

      <Card title="Counts">
        <pre className="counts">{JSON.stringify(counts, null, 2)}</pre>
      </Card>

      <Card title="Actions">
        <div className="act-row">
          {awaitingVerdict && !preview && (
            <form action={rejectRunAction}>
              <input type="hidden" name="runId" value={id} />
              <Button tone="danger">Reject — discard this run</Button>
            </form>
          )}
          {(run.state === "failed" || retryableStuck) && (
            <form action={retryRunAction}>
              <input type="hidden" name="runId" value={id} />
              <Button>
                {run.state === "failed" ? "Retry this run" : `Retry — abandoned in ${run.state}`}
              </Button>
            </form>
          )}
          <form action={reingestAction}>
            <input type="hidden" name="runId" value={id} />
            <Button>Re-ingest this file as a new run</Button>
          </form>
        </div>
      </Card>

      <Card title={`Issues from this run (${issueTotal.toLocaleString()})`} flush>
        {issues.rowCount === 0 ? (
          <Empty title="No issues" hint="Every record in this snapshot parsed cleanly." />
        ) : (
          <Table head={["Scope", "Status", "Product", "Reason", "Evidence"]}>
            {issues.rows.map((i) => (
              <tr key={i.id}>
                <Cell>{i.scope}</Cell>
                <Cell>
                  <Pill tone={i.status === "open" ? "warn" : "muted"}>
                    {i.status === "open" ? "open" : `resolved (${i.resolution})`}
                  </Pill>
                </Cell>
                <Cell mono>{i.product_code ?? "—"}</Cell>
                <Cell>{i.reason}</Cell>
                <Cell mono>
                  {i.evidence?.raw_fragment
                    ? String(i.evidence.raw_fragment).slice(0, 300)
                    : "—"}
                </Cell>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Pager
        page={issuePage}
        pageCount={issuePageCount}
        total={issueTotal}
        perPage={ISSUES_PER_PAGE}
        href={(p) => (p > 1 ? `/admin/runs/${id}?page=${p}` : `/admin/runs/${id}`)}
      />
    </Shell>
  );
}
