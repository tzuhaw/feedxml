import Link from "next/link";
import { getPool } from "@/lib/db";
import {
  Shell,
  StatusBand,
  Tiles,
  Tile,
  Card,
  Table,
  Cell,
  StateBadge,
  Empty,
  ago,
} from "./ui";
import { requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

export default async function Overview() {
  // Authorize before any data is fetched (see lib/guard.ts).
  await requireAdmin();

  const pool = getPool();
  const [attention, feeds, issueCounts, totals] = await Promise.all([
    pool.query(
      `select r.id, r.state, r.updated_at, r.error, s.name as supplier
       from feed_runs r
       join feeds f on f.id = r.feed_id
       join suppliers s on s.id = f.supplier_id
       where r.state in ('awaiting_review', 'failed')
       order by r.updated_at desc limit 20`,
    ),
    pool.query(
      `select s.name as supplier, f.channel, f.format, f.active,
              (select max(created_at) from feed_runs r where r.feed_id = f.id) as last_run,
              (select count(*)::int from products p
               where p.supplier_id = f.supplier_id and p.status = 'active') as active_products
       from feeds f join suppliers s on s.id = f.supplier_id
       order by s.name`,
    ),
    pool.query(
      `select scope, count(*)::int as n from issues where status = 'open' group by scope`,
    ),
    // One round trip for the headline figures.
    pool.query(
      `select (select count(*)::int from products where status = 'active') as active_products,
              (select count(*)::int from products where status = 'inactive') as inactive_products,
              (select count(*)::int from feeds where active) as active_feeds,
              (select max(updated_at) from feed_runs where state = 'done') as last_success`,
    ),
  ]);

  const counts = Object.fromEntries(issueCounts.rows.map((r) => [r.scope, r.n]));
  const t = totals.rows[0];
  const waiting = attention.rows.filter((r) => r.state === "awaiting_review").length;
  const failed = attention.rows.filter((r) => r.state === "failed").length;
  const openIssues = (counts.run ?? 0) + (counts.product ?? 0) + (counts.record ?? 0);

  return (
    <Shell
      title="Overview"
      nav="overview"
      sub={
        t.last_success
          ? `Last successful run ${ago(t.last_success)}`
          : "No successful run yet"
      }
    >
      {attention.rowCount === 0 ? (
        <StatusBand tone="clear">
          <strong>All clear.</strong> No snapshot is waiting on a decision, and no run has
          failed.
        </StatusBand>
      ) : (
        <StatusBand tone="attention">
          <strong>
            {waiting > 0 &&
              `${waiting} snapshot${waiting === 1 ? "" : "s"} awaiting review`}
            {waiting > 0 && failed > 0 && ", "}
            {failed > 0 && `${failed} run${failed === 1 ? "" : "s"} failed`}.
          </strong>{" "}
          Nothing has been applied to the catalog until you decide.
        </StatusBand>
      )}

      <Tiles>
        <Tile
          label="Active products"
          figure={t.active_products.toLocaleString()}
          note={
            t.inactive_products > 0
              ? `${t.inactive_products.toLocaleString()} deactivated`
              : "none deactivated"
          }
          href="/admin/products"
        />
        <Tile
          label="Open issues"
          figure={openIssues.toLocaleString()}
          note="across all scopes"
          href="/admin/issues"
          hot={openIssues > 0}
        />
        <Tile
          label="Run issues"
          figure={(counts.run ?? 0).toLocaleString()}
          note="halted snapshots"
          href="/admin/issues?scope=run"
          hot={(counts.run ?? 0) > 0}
        />
        <Tile
          label="Record issues"
          figure={(counts.record ?? 0).toLocaleString()}
          note="unparseable records"
          href="/admin/issues?scope=record"
        />
        <Tile
          label="Active feeds"
          figure={t.active_feeds.toLocaleString()}
          note="ingesting"
          href="/admin/feeds"
        />
      </Tiles>

      <Card title="Needs attention" flush>
        {attention.rowCount === 0 ? (
          <Empty
            title="Nothing waiting"
            hint="Halted snapshots and failed runs appear here for a decision."
          />
        ) : (
          <Table head={["Supplier", "State", "When", "Error", ""]}>
            {attention.rows.map((r) => (
              <tr key={r.id}>
                <Cell>{r.supplier}</Cell>
                <Cell>
                  <StateBadge state={r.state} />
                </Cell>
                <Cell>{ago(r.updated_at)}</Cell>
                <Cell>{r.error ?? "—"}</Cell>
                <Cell>
                  <Link href={`/admin/runs/${r.id}`}>Review</Link>
                </Cell>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Feeds" flush>
        {feeds.rowCount === 0 ? (
          <Empty
            title="No feeds configured"
            hint={
              <>
                A feed is a standing arrangement with a supplier. Add one with a migration,
                then <Link href="/admin/upload">upload a snapshot</Link>.
              </>
            }
          />
        ) : (
          <Table head={["Supplier", "Channel", "Format", "Active", "Last run", "Products"]}>
            {feeds.rows.map((f, i) => (
              <tr key={i}>
                <Cell>{f.supplier}</Cell>
                <Cell>{f.channel}</Cell>
                <Cell>{f.format}</Cell>
                <Cell>{f.active ? "yes" : "no"}</Cell>
                <Cell>{f.last_run ? ago(f.last_run) : "never"}</Cell>
                <Cell>{f.active_products.toLocaleString()}</Cell>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </Shell>
  );
}
