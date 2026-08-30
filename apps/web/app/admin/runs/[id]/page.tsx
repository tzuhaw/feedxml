import Link from "next/link";
import { notFound } from "next/navigation";
import { previewApply } from "@feedxml/domain";
import { getPool } from "@/lib/db";
import { Shell, Table, Cell, StateBadge, ago, duration, palette } from "../../ui";
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
  const colours = {
    normal: { bg: "#fff", fg: "#16181d" },
    danger: { bg: "#fff", fg: palette.danger },
    primary: { bg: palette.ok, fg: "#fff" },
  }[tone];
  return (
    <button
      type="submit"
      style={{
        background: colours.bg,
        color: colours.fg,
        border: `1px solid ${palette.border}`,
        borderRadius: 4,
        padding: "0.4rem 0.9rem",
        cursor: "pointer",
        font: "inherit",
      }}
    >
      {children}
    </button>
  );
}

export default async function RunDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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

  // The Consequence Preview is only meaningful while staging still exists
  // (retention purges older runs' staging).
  const hasStaging = await pool.query(
    `select exists (select 1 from staging_products where run_id = $1) as present`,
    [id],
  );
  const preview =
    run.state === "awaiting_review" && hasStaging.rows[0].present
      ? await previewApply(pool, id, run.supplier_id)
      : null;

  const counts = run.counts ?? {};

  return (
    <Shell title={`Run — ${run.supplier}`}>
      <p style={{ color: palette.muted }}>
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
      <p style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.82rem" }}>{run.object_key}</p>
      {run.error && <p style={{ color: palette.danger }}>{run.error}</p>}

      {preview && (
        <section
          style={{
            border: `2px solid ${palette.warn}`,
            borderRadius: 6,
            padding: "1rem",
            margin: "1.5rem 0",
            background: palette.bg,
          }}
        >
          <h2 style={{ fontSize: "1rem", marginTop: 0 }}>
            This snapshot needs review — here is exactly what approving does
          </h2>
          <ul style={{ lineHeight: 1.7 }}>
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
            <p style={{ color: palette.warn }}>
              Halted on:{" "}
              {counts.breaches
                .map((b: { rule: string; observed: number; limit: number }) =>
                  `${b.rule} ${b.observed} > ${b.limit}`,
                )
                .join(", ")}
            </p>
          )}
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
            <form action={approveRunAction}>
              <input type="hidden" name="runId" value={id} />
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

      {run.state === "awaiting_review" && !preview && (
        <p style={{ color: palette.danger }}>
          Staging evidence for this run has been purged, so no preview can be computed. Reject it
          and re-ingest the file instead.
        </p>
      )}

      <section style={{ margin: "1.5rem 0" }}>
        <h2 style={{ fontSize: "1rem" }}>Counts</h2>
        <pre
          style={{
            background: palette.bg,
            border: `1px solid ${palette.border}`,
            padding: "0.75rem",
            overflowX: "auto",
            fontSize: "0.8rem",
          }}
        >
          {JSON.stringify(counts, null, 2)}
        </pre>
      </section>

      <section style={{ margin: "1.5rem 0", display: "flex", gap: "0.75rem" }}>
        {run.state === "failed" && (
          <form action={retryRunAction}>
            <input type="hidden" name="runId" value={id} />
            <Button>Retry this run</Button>
          </form>
        )}
        <form action={reingestAction}>
          <input type="hidden" name="runId" value={id} />
          <Button>Re-ingest this file as a new run</Button>
        </form>
      </section>

      <section>
        <h2 style={{ fontSize: "1rem" }}>Issues from this run ({issues.rowCount})</h2>
        {issues.rowCount === 0 ? (
          <p style={{ color: palette.muted }}>None.</p>
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
