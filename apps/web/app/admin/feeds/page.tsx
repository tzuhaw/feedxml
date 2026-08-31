import Link from "next/link";
import { getPool } from "@/lib/db";
import { Shell, Card, Table, Cell, Pill, Empty, Pager, paginate } from "../ui";
import { requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

const PER_PAGE = 25;

/**
 * Per-feed configuration, read-only in v1 (config-in-code, DESIGN.md
 * decision 13): the panel shows what the thresholds are, migrations change them.
 */
export default async function Feeds({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  // Authorize before any data is fetched (see lib/guard.ts).
  await requireAdmin();

  const { page: rawPage } = await searchParams;
  const pool = getPool();

  const countRes = await pool.query(`select count(*)::int as n from feeds`);
  const total: number = countRes.rows[0].n;
  const { page, pageCount, offset } = paginate(total, rawPage, PER_PAGE);

  const feeds = await pool.query(
    `select s.name as supplier, f.channel, f.format, f.active, f.thresholds,
            f.skip_streak_limit, f.schedule_minutes, f.source_url,
            s.api_key_hash is not null as has_key
     from feeds f join suppliers s on s.id = f.supplier_id
     order by s.name, f.channel, f.id
     limit ${PER_PAGE} offset ${offset}`,
  );

  return (
    <Shell
      title="Feeds"
      nav="feeds"
      sub={
        pageCount > 1
          ? `${total.toLocaleString()} feeds · page ${page} of ${pageCount}`
          : "Configuration is code: change thresholds with a migration, not here."
      }
    >
      <Card flush>
        {feeds.rowCount === 0 ? (
          <Empty
            title="No feeds configured"
            hint={
              <>
                A feed is the standing arrangement with a supplier — channel, format and the
                thresholds that decide when a snapshot halts. Add one with a migration, then{" "}
                <Link href="/admin/upload">upload a snapshot</Link>.
              </>
            }
          />
        ) : (
          <Table
            head={[
              "Supplier",
              "Channel",
              "Format",
              "Active",
              "Count drop",
              "Missing set",
              "Error rate",
              "Skip streak",
              "Schedule",
              "API key",
            ]}
          >
            {feeds.rows.map((f, i) => {
              const t = f.thresholds ?? {};
              const pct = (v: unknown) =>
                typeof v === "number" ? `${(v * 100).toFixed(0)}%` : "default";
              return (
                <tr key={i}>
                  <Cell>{f.supplier}</Cell>
                  <Cell>{f.channel}</Cell>
                  <Cell>{f.format}</Cell>
                  <Cell>
                    <Pill tone={f.active ? "ok" : "muted"}>{f.active ? "active" : "paused"}</Pill>
                  </Cell>
                  <Cell>{pct(t.maxCountDrop)}</Cell>
                  <Cell>{pct(t.maxMissingSet)}</Cell>
                  <Cell>{pct(t.maxErrorRate)}</Cell>
                  <Cell>{f.skip_streak_limit}</Cell>
                  <Cell>
                    {f.channel === "pull"
                      ? f.schedule_minutes
                        ? `every ${f.schedule_minutes}m`
                        : "unscheduled"
                      : "—"}
                  </Cell>
                  <Cell>{f.has_key ? "issued" : "—"}</Cell>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Pager
        page={page}
        pageCount={pageCount}
        total={total}
        perPage={PER_PAGE}
        href={(p) => (p > 1 ? `/admin/feeds?page=${p}` : "/admin/feeds")}
      />
    </Shell>
  );
}
