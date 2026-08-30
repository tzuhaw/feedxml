import Link from "next/link";
import { notFound } from "next/navigation";
import { previewApply } from "@feedxml/domain";
import { getPool } from "@/lib/db";
import { Shell, Table, Cell, StateBadge, ago, duration, palette } from "../../ui";
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

export default async function RunDetail({ params }: { params: Promise<{ id: string }> }) {
  // Authorize before any data is fetched (see lib/guard.ts).
  await requireAdmin();

  const { id } = await params;
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

  const issues = await pool.query(
    `select id, scope, status, product_code, reason, evidence, resolution
     from issues where run_id = $1 order by scope, created_at limit 50`,
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
    <Shell title={`Run — ${run.supplier}`}>
      <p className="run-meta">
        <StateBadge state={run.state} /> · started {ago(run.created_at)} · took{" "}
        {duration(run.created_at, run.updated_at)} · attempt {run.attempt}
        {run.manual_reingest && " · manual re-ingest"}
        {run.superseded_by && (
          <>
            {" "}
            · superseded by <Link href={`/admin/runs/${run.superseded_by}`}>a newer run</Link>
          </>
        )}
      </p>
      <p className="run-key mono">{run.object_key}</p>
      {run.error && <p className="run-error">{run.error}</p>}

      {preview && (
        <section className="preview-card">
          <h2 className="card-h">
            This snapshot needs review — here is exactly what approving does
          </h2>
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
            <p className="run-error">
              This snapshot staged no usable products at all — approving it would deactivate the
              entire catalog for this supplier. Almost certainly a truncated or broken export.
            </p>
          )}
          <div className="act-row">
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

      <section className="run-section">
        <h2 className="card-h">Counts</h2>
        <pre className="counts">
          {JSON.stringify(counts, null, 2)}
        </pre>
      </section>

      <section className="run-section act-row">
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
      </section>

      <section>
        <h2 className="card-h">Issues from this run ({issues.rowCount})</h2>
        {issues.rowCount === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <Table head={["Scope", "Status", "Product", "Reason", "Evidence"]}>
            {issues.rows.map((i) => (
              <tr key={i.id}>
                <Cell>{i.scope}</Cell>
                <Cell>{i.status === "open" ? "open" : `resolved (${i.resolution})`}</Cell>
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
      </section>
    </Shell>
  );
}
