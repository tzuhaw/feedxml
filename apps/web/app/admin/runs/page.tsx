import Link from "next/link";
import { getPool } from "@/lib/db";
import { Shell, Table, Cell, StateBadge, Empty, ago, duration, palette } from "../ui";

export const dynamic = "force-dynamic";

const STATES = [
  "pending",
  "downloading",
  "staging",
  "validating",
  "awaiting_review",
  "merging",
  "done",
  "failed",
  "rejected",
  "superseded",
] as const;

/** Run history: every state, including failed (with error) and superseded. */
export default async function Runs({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { state: rawState } = await searchParams;
  // Params reach an enum cast, so only known values pass — a stale bookmark
  // must render an empty list, not a 500.
  const state = STATES.includes(rawState as (typeof STATES)[number]) ? rawState : undefined;
  const pool = getPool();
  const runs = await pool.query(
    `select r.id, r.state, r.created_at, r.updated_at, r.attempt, r.error,
            r.counts, r.manual_reingest, r.superseded_by, s.name as supplier
     from feed_runs r
     join feeds f on f.id = r.feed_id
     join suppliers s on s.id = f.supplier_id
     where ($1::text is null or r.state = $1::run_state)
     order by r.created_at desc limit 100`,
    [state ?? null],
  );
  const durations = await pool.query(
    `select round(avg(extract(epoch from updated_at - created_at)))::int as avg_secs,
            count(*)::int as n
     from (select created_at, updated_at from feed_runs
           where state = 'done' order by updated_at desc limit 20) recent`,
  );

  const filters = ["all", "done", "awaiting_review", "failed", "rejected", "superseded"];

  return (
    <Shell title="Runs">
      <p style={{ color: palette.muted }}>
        {filters.map((f) => (
          <span key={f}>
            <Link href={f === "all" ? "/admin/runs" : `/admin/runs?state=${f}`}>{f}</Link>
            {f === filters[filters.length - 1] ? "" : " · "}
          </span>
        ))}
        {durations.rows[0].n > 0 && (
          <> — last {durations.rows[0].n} successful runs averaged {durations.rows[0].avg_secs}s</>
        )}
      </p>
      {runs.rowCount === 0 ? (
        <Empty what="runs" />
      ) : (
        <Table head={["Supplier", "State", "Started", "Duration", "Staged", "Applied", "Att.", ""]}>
          {runs.rows.map((r) => {
            const c = r.counts ?? {};
            return (
              <tr key={r.id}>
                <Cell>
                  {r.supplier}
                  {r.manual_reingest && (
                    <span style={{ color: palette.muted }}> (re-ingest)</span>
                  )}
                </Cell>
                <Cell>
                  <StateBadge state={r.state} />
                  {r.error && (
                    <div style={{ color: palette.danger, fontSize: "0.8rem" }}>{r.error}</div>
                  )}
                </Cell>
                <Cell>{ago(r.created_at)}</Cell>
                <Cell>{duration(r.created_at, r.updated_at)}</Cell>
                <Cell>{c.staged?.toLocaleString?.() ?? "—"}</Cell>
                <Cell>
                  {c.deactivated !== undefined
                    ? `+${c.creates ?? 0} ~${c.updates ?? 0} -${c.deactivated}`
                    : "—"}
                </Cell>
                <Cell>{r.attempt}</Cell>
                <Cell>
                  <Link href={`/admin/runs/${r.id}`}>detail</Link>
                </Cell>
              </tr>
            );
          })}
        </Table>
      )}
    </Shell>
  );
}
