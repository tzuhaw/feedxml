import Link from "next/link";
import { getPool } from "@/lib/db";
import {
  Shell,
  Card,
  Chips,
  Chip,
  Table,
  Cell,
  StateBadge,
  Empty,
  ago,
  duration,
} from "../ui";
import { requireAdmin } from "@/lib/guard";

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
  // Authorize before any data is fetched (see lib/guard.ts).
  await requireAdmin();

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
  const stats = durations.rows[0];

  return (
    <Shell
      title="Runs"
      nav="runs"
      sub={
        stats.n > 0
          ? `Last ${stats.n} successful runs averaged ${stats.avg_secs}s`
          : undefined
      }
    >
      <Chips>
        {filters.map((f) => (
          <Chip
            key={f}
            href={f === "all" ? "/admin/runs" : `/admin/runs?state=${f}`}
            active={f === "all" ? !state : state === f}
          >
            {f.replace(/_/g, " ")}
          </Chip>
        ))}
      </Chips>

      <Card flush>
        {runs.rowCount === 0 ? (
          <Empty
            title="No runs"
            hint={
              state
                ? "No run is in this state right now."
                : "A run appears here the moment a snapshot is registered."
            }
          />
        ) : (
          <Table head={["Supplier", "State", "Started", "Took", "Staged", "Applied", "Att.", ""]}>
            {runs.rows.map((r) => {
              const c = r.counts ?? {};
              return (
                <tr key={r.id}>
                  <Cell>
                    {r.supplier}
                    {r.manual_reingest && <div className="cell-sub">re-ingest</div>}
                  </Cell>
                  <Cell>
                    <StateBadge state={r.state} />
                    {r.error && <div className="cell-sub is-error">{r.error}</div>}
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
                    <Link href={`/admin/runs/${r.id}`}>Detail</Link>
                  </Cell>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </Shell>
  );
}
