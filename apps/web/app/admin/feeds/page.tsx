import { getPool } from "@/lib/db";
import { Shell, Table, Cell, Empty, palette } from "../ui";

export const dynamic = "force-dynamic";

/**
 * Per-feed configuration, read-only in v1 (config-in-code, DESIGN.md
 * decision 13): the panel shows what the thresholds are, migrations change them.
 */
export default async function Feeds() {
  const pool = getPool();
  const feeds = await pool.query(
    `select s.name as supplier, f.channel, f.format, f.active, f.thresholds,
            f.skip_streak_limit, f.schedule_minutes, f.source_url,
            s.api_key_hash is not null as has_key
     from feeds f join suppliers s on s.id = f.supplier_id
     order by s.name, f.channel`,
  );

  return (
    <Shell title="Feeds">
      <p style={{ color: palette.muted }}>
        Configuration is code: change thresholds with a migration, not here.
      </p>
      {feeds.rowCount === 0 ? (
        <Empty what="feeds" />
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
                <Cell>{f.active ? "yes" : "no"}</Cell>
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
    </Shell>
  );
}
