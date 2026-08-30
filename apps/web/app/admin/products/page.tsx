import Link from "next/link";
import { getPool } from "@/lib/db";
import { Shell, Table, Cell, Empty, ago, palette } from "../ui";
import { reverseDeactivationAction } from "../actions";

export const dynamic = "force-dynamic";

/**
 * Deactivated and pinned products: where an admin reverses a sweep decision.
 * Reversing pins the product — sweep-exempt until the supplier sends it again.
 */
export default async function Products({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; q?: string }>;
}) {
  const { view, q } = await searchParams;
  const pinned = view === "pinned";
  const pool = getPool();

  const rows = await pool.query(
    `select p.supplier_id, p.product_code, p.title, p.status, p.pinned,
            p.deactivated_at, p.skip_streak, p.updated_at, s.name as supplier
     from products p join suppliers s on s.id = p.supplier_id
     where ($2::text is null or p.product_code ilike '%' || $2 || '%')
       and case when $1 then p.pinned else p.status = 'inactive' end
     order by p.updated_at desc limit 200`,
    [pinned, q || null],
  );
  const pinnedCount = await pool.query(
    `select count(*)::int as n from products where pinned`,
  );

  return (
    <Shell title="Products">
      <p style={{ color: palette.muted }}>
        <Link href="/admin/products">deactivated</Link>
        {" · "}
        <Link href="/admin/products?view=pinned">pinned ({pinnedCount.rows[0].n})</Link>
      </p>
      <form method="get" style={{ marginBottom: "1rem" }}>
        {pinned && <input type="hidden" name="view" value="pinned" />}
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="filter by product code"
          style={{
            padding: "0.35rem 0.5rem",
            border: `1px solid ${palette.border}`,
            borderRadius: 4,
            font: "inherit",
          }}
        />
      </form>
      {rows.rowCount === 0 ? (
        <Empty what={pinned ? "pinned products" : "deactivated products"} />
      ) : (
        <Table head={["Supplier", "Code", "Title", "Status", "Pinned", "Since", ""]}>
          {rows.rows.map((p, i) => (
            <tr key={i}>
              <Cell>{p.supplier}</Cell>
              <Cell mono>{p.product_code}</Cell>
              <Cell>{p.title}</Cell>
              <Cell>{p.status}</Cell>
              <Cell>{p.pinned ? "yes" : "no"}</Cell>
              <Cell>{ago(p.deactivated_at ?? p.updated_at)}</Cell>
              <Cell>
                {p.status === "inactive" && (
                  <form action={reverseDeactivationAction}>
                    <input type="hidden" name="supplierId" value={p.supplier_id} />
                    <input type="hidden" name="productCode" value={p.product_code} />
                    <button
                      type="submit"
                      style={{
                        background: "none",
                        border: "none",
                        color: "#0b5cad",
                        cursor: "pointer",
                        font: "inherit",
                        padding: 0,
                      }}
                    >
                      reactivate &amp; pin
                    </button>
                  </form>
                )}
              </Cell>
            </tr>
          ))}
        </Table>
      )}
      {pinned && (
        <p style={{ color: palette.muted, marginTop: "1rem" }}>
          A pin clears itself when the supplier sends the product again.
        </p>
      )}
    </Shell>
  );
}
