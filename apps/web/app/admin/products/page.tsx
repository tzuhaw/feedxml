import Link from "next/link";
import { getPool } from "@/lib/db";
import { Shell, Card, Chips, Chip, Table, Cell, Pill, Empty, Pager, paginate, ago } from "../ui";
import { reverseDeactivationAction } from "../actions";
import { requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

const VIEWS = ["catalog", "deactivated", "pinned"] as const;
type View = (typeof VIEWS)[number];

const PER_PAGE = 25;

/**
 * The catalog, and the two review queues cut from it.
 *
 * `catalog` is the plain browsable list of everything ingested — an operator
 * asking "did the feed actually land?" starts here. `deactivated` is where a
 * sweep decision gets reversed (which pins the product, exempting it from the
 * sweep until the supplier sends it again), and `pinned` is what is currently
 * held that way.
 *
 * The count is fetched BEFORE the rows so the requested page can be clamped to
 * one that exists, and so the pager knows how many pages there are.
 */
export default async function Products({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; q?: string; page?: string }>;
}) {
  // Authorize before any data is fetched (see lib/guard.ts).
  await requireAdmin();

  const { view: rawView, q, page: rawPage } = await searchParams;
  const view: View = VIEWS.includes(rawView as View) ? (rawView as View) : "catalog";
  const search = q?.trim() || null;
  const pool = getPool();

  // The view is whitelisted above, so these fragments are never user input.
  const where =
    view === "deactivated"
      ? "p.status = 'inactive'"
      : view === "pinned"
        ? "p.pinned"
        : "true";
  const order =
    view === "deactivated" ? "p.deactivated_at desc nulls last" : "p.updated_at desc";

  // `updated_at` is not unique, so a tiebreak on the primary key is what stops
  // a row appearing on two pages (or on neither) as Postgres reorders ties.
  const tiebreak = "p.supplier_id, p.product_code";

  const filter = `where ${where}
       and ($1::text is null
            or p.product_code ilike '%' || $1 || '%'
            or p.title ilike '%' || $1 || '%')`;

  const [countRes, tallies] = await Promise.all([
    pool.query(
      `select count(*)::int as n
       from products p join suppliers s on s.id = p.supplier_id
       ${filter}`,
      [search],
    ),
    pool.query(
      `select count(*)::int as all_products,
              count(*) filter (where status = 'active')::int as active,
              count(*) filter (where status = 'inactive')::int as inactive,
              count(*) filter (where pinned)::int as pinned
       from products`,
    ),
  ]);

  const total: number = countRes.rows[0].n;
  const { page, pageCount, offset } = paginate(total, rawPage, PER_PAGE);

  const rows = await pool.query(
    `select p.supplier_id, p.product_code, p.title, p.brand, p.status, p.pinned,
            p.deactivated_at, p.skip_streak, p.updated_at, s.name as supplier,
            case when jsonb_typeof(p.variants) = 'array'
                 then jsonb_array_length(p.variants) else 0 end as variant_count,
            case when jsonb_typeof(p.images) = 'array'
                 then jsonb_array_length(p.images) else 0 end as image_count
     from products p join suppliers s on s.id = p.supplier_id
     ${filter}
     order by ${order}, ${tiebreak}
     limit ${PER_PAGE} offset ${offset}`,
    [search],
  );

  const n = tallies.rows[0];
  // Changing view or search resets to page 1; paging preserves both.
  const qs = (v: View) =>
    `/admin/products?view=${v}${search ? `&q=${encodeURIComponent(search)}` : ""}`;
  const pageHref = (p: number) => `${qs(view)}${p > 1 ? `&page=${p}` : ""}`;

  return (
    <Shell
      title="Products"
      nav="products"
      sub={
        total === 0
          ? undefined
          : `${total.toLocaleString()} ${total === 1 ? "product" : "products"}${
              pageCount > 1 ? ` · page ${page} of ${pageCount}` : ""
            }`
      }
    >
      <Chips>
        <Chip href={qs("catalog")} active={view === "catalog"}>
          catalog ({n.all_products.toLocaleString()})
        </Chip>
        <Chip href={qs("deactivated")} active={view === "deactivated"}>
          deactivated ({n.inactive.toLocaleString()})
        </Chip>
        <Chip href={qs("pinned")} active={view === "pinned"}>
          pinned ({n.pinned.toLocaleString()})
        </Chip>
      </Chips>

      <form method="get" style={{ marginBottom: "1.1rem" }}>
        <input type="hidden" name="view" value={view} />
        <input
          type="text"
          name="q"
          defaultValue={search ?? ""}
          placeholder="Filter by product code or title"
          aria-label="Filter by product code or title"
          style={{ width: "min(24rem, 100%)" }}
        />
      </form>

      <Card flush>
        {rows.rowCount === 0 ? (
          <Empty
            title={search ? `Nothing matches “${search}”` : emptyTitle(view)}
            hint={search ? "Try part of a product code or title." : emptyHint(view)}
          />
        ) : (
          <Table
            head={["Code", "Title", "Supplier", "Status", "Variants", "Images", "Updated", ""]}
          >
            {rows.rows.map((p, i) => (
              <tr key={i}>
                <Cell mono>{p.product_code}</Cell>
                <Cell>
                  {p.title}
                  {p.brand && <div className="cell-sub">{p.brand}</div>}
                </Cell>
                <Cell>{p.supplier}</Cell>
                <Cell>
                  <div className="cell-actions">
                    <Pill tone={p.status === "active" ? "ok" : "muted"}>{p.status}</Pill>
                    {p.pinned && <Pill tone="info">pinned</Pill>}
                    {p.skip_streak > 0 && <Pill tone="warn">skipped ×{p.skip_streak}</Pill>}
                  </div>
                </Cell>
                <Cell>{p.variant_count}</Cell>
                <Cell>{p.image_count}</Cell>
                <Cell>{ago(p.deactivated_at ?? p.updated_at)}</Cell>
                <Cell>
                  <div className="cell-actions">
                    <Link
                      href={`/admin/products/${p.supplier_id}/${encodeURIComponent(p.product_code)}`}
                    >
                      Detail
                    </Link>
                    {p.status === "inactive" && (
                      <form action={reverseDeactivationAction}>
                        <input type="hidden" name="supplierId" value={p.supplier_id} />
                        <input type="hidden" name="productCode" value={p.product_code} />
                        <button type="submit" className="linkbtn">
                          Reactivate &amp; pin
                        </button>
                      </form>
                    )}
                  </div>
                </Cell>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Pager page={page} pageCount={pageCount} total={total} perPage={PER_PAGE} href={pageHref} />

      {view === "pinned" && (
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.9rem" }}>
          A pin clears itself when the supplier sends the product again.
        </p>
      )}
    </Shell>
  );
}

function emptyTitle(view: View): string {
  if (view === "deactivated") return "Nothing deactivated";
  if (view === "pinned") return "Nothing pinned";
  return "No products yet";
}

function emptyHint(view: View): React.ReactNode {
  if (view === "deactivated") {
    return "Products missing from an approved snapshot are deactivated here — never deleted.";
  }
  if (view === "pinned") {
    return "Reversing a deactivation pins the product, exempting it from the sweep.";
  }
  return (
    <>
      The catalog fills once a snapshot is ingested and applied.{" "}
      <Link href="/admin/upload">Upload one</Link>.
    </>
  );
}
