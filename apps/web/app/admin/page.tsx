import Link from "next/link";
import { getPool } from "@/lib/db";
import { Shell, Table, Cell, StateBadge, Empty, ago, palette } from "./ui";

export const dynamic = "force-dynamic";

export default async function Overview() {
  const pool = getPool();
  const [attention, feeds, issueCounts] = await Promise.all([
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
  ]);

  const counts = Object.fromEntries(issueCounts.rows.map((r) => [r.scope, r.n]));

  return (
    <Shell title="Overview">
      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem" }}>Needs attention</h2>
        {attention.rowCount === 0 ? (
          <Empty what="runs awaiting review or failed" />
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
                  <Link href={`/admin/runs/${r.id}`}>open</Link>
                </Cell>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section style={{ marginBottom: "2rem" }}>
        <h2 style={{ fontSize: "1rem" }}>Open issues</h2>
        <p style={{ color: palette.muted }}>
          <Link href="/admin/issues?scope=run">Run: {counts.run ?? 0}</Link>
          {" · "}
          <Link href="/admin/issues?scope=product">Product: {counts.product ?? 0}</Link>
          {" · "}
          <Link href="/admin/issues?scope=record">Record: {counts.record ?? 0}</Link>
        </p>
      </section>

      <section>
        <h2 style={{ fontSize: "1rem" }}>Feeds</h2>
        {feeds.rowCount === 0 ? (
          <Empty what="feeds configured" />
        ) : (
          <Table head={["Supplier", "Channel", "Format", "Active", "Last run", "Active products"]}>
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
      </section>
    </Shell>
  );
}
