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
  Pager,
  paginate,
  ago,
  duration,
} from "../ui";
import { requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

const PER_PAGE = 25;

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
  searchParams: Promise<{ state?: string; page?: string }>;
}) {
  // Authorize before any data is fetched (see lib/guard.ts).
  await requireAdmin();

  const { state: rawState, page: rawPage } = await searchParams;
  // Params reach an enum cast, so only known values pass — a stale bookmark
  // must render an empty list, not a 500.
  const state = STATES.includes(rawState as (typeof STATES)[number]) ? rawState : undefined;
  const pool = getPool();

  const [countRes, durations] = await Promise.all([
    pool.query(
      `select count(*)::int as n from feed_runs r
       where ($1::text is null or r.state = $1::run_state)`,
      [state ?? null],
    ),
    pool.query(
      `select round(avg(extract(epoch from updated_at - created_at)))::int as avg_secs,
              count(*)::int as n
       from (select created_at, updated_at from feed_runs
             where state = 'done' order by updated_at desc limit 20) recent`,
    ),
  ]);

  const total: number = countRes.rows[0].n;
  const { page, pageCount, offset } = paginate(total, rawPage, PER_PAGE);

  const runs = await pool.query(
    `select r.id, r.state, r.created_at, r.updated_at, r.attempt, r.error,
            r.counts, r.manual_reingest, r.superseded_by, s.name as supplier
     from feed_runs r
     join feeds f on f.id = r.feed_id
     join suppliers s on s.id = f.supplier_id
     where ($1::text is null or r.state = $1::run_state)
     order by r.created_at desc, r.id
     limit ${PER_PAGE} offset ${offset}`,
    [state ?? null],
  );

  const filters = ["all", "done", "awaiting_review", "failed", "rejected", "superseded"];
  const stats = durations.rows[0];
  const base = (f: string) => (f === "all" ? "/admin/runs" : `/admin/runs?state=${f}`);
  const pageHref = (p: number) => {
    const b = base(state ?? "all");
    if (p <= 1) return b;
    return `${b}${b.includes("?") ? "&" : "?"}page=${p}`;
  };

  return (
    <Shell
      title="Runs"
      nav="runs"
      sub={
        stats.n > 0
          ? `Last ${stats.n} successful runs averaged ${stats.avg_secs}s${
              pageCount > 1 ? ` · page ${page} of ${pageCount}` : ""
            }`
          : pageCount > 1
            ? `Page ${page} of ${pageCount}`
            : undefined
      }
    >
      <Chips>
        {filters.map((f) => (
          <Chip key={f} href={base(f)} active={f === "all" ? !state : state === f}>
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

      <Pager page={page} pageCount={pageCount} total={total} perPage={PER_PAGE} href={pageHref} />
    </Shell>
  );
}
