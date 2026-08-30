import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { Shell, Card, Table, Cell, Pill, Empty, ago } from "../../../ui";
import { reverseDeactivationAction } from "../../../actions";
import { requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Variant {
  sku?: string;
  gtin?: string;
  price?: number | string;
  currency?: string;
  stock?: number;
  attributes?: Record<string, unknown>;
}

/**
 * One product as the database actually holds it: the merged result of every
 * snapshot that has carried it. This is the surface for "what did we ingest
 * for this code, and why does it look like that" — the variants and images
 * are shown as stored, not as the supplier sent them.
 */
export default async function ProductDetail({
  params,
}: {
  params: Promise<{ supplierId: string; code: string }>;
}) {
  // Authorize before any data is fetched (see lib/guard.ts).
  await requireAdmin();

  const { supplierId, code: rawCode } = await params;
  // The id reaches a uuid column; anything else is a bad link, not a fault.
  if (!UUID.test(supplierId)) notFound();
  const code = decodeURIComponent(rawCode);

  const pool = getPool();
  const res = await pool.query(
    `select p.*, s.name as supplier
     from products p join suppliers s on s.id = p.supplier_id
     where p.supplier_id = $1 and p.product_code = $2`,
    [supplierId, code],
  );
  if (res.rowCount === 0) notFound();
  const p = res.rows[0];

  const issues = await pool.query(
    `select id, scope, status, reason, evidence, resolution, created_at, run_id
     from issues
     where supplier_id = $1 and product_code = $2
     order by created_at desc limit 50`,
    [supplierId, code],
  );

  const variants: Variant[] = Array.isArray(p.variants) ? p.variants : [];
  const images: unknown[] = Array.isArray(p.images) ? p.images : [];
  const attributes: Record<string, unknown> =
    p.attributes && typeof p.attributes === "object" ? p.attributes : {};

  return (
    <Shell title={p.title || code} nav="products" sub={`${p.supplier} · ${code}`}>
      <div className="run-meta">
        <Pill tone={p.status === "active" ? "ok" : "muted"}>{p.status}</Pill>
        {p.pinned && <Pill tone="info">pinned</Pill>}
        {p.skip_streak > 0 && <Pill tone="warn">skipped ×{p.skip_streak}</Pill>}
        <span className="sep">·</span>
        <span>updated {ago(p.updated_at)}</span>
        {p.deactivated_at && (
          <>
            <span className="sep">·</span>
            <span>deactivated {ago(p.deactivated_at)}</span>
          </>
        )}
      </div>

      {p.status === "inactive" && (
        <div className="act-row" style={{ marginBottom: "1.25rem" }}>
          <form action={reverseDeactivationAction}>
            <input type="hidden" name="supplierId" value={supplierId} />
            <input type="hidden" name="productCode" value={code} />
            <button type="submit" className="act act-primary">
              Reactivate &amp; pin
            </button>
          </form>
        </div>
      )}

      <Card title="Product">
        <Table head={["Field", "Value"]}>
          <tr>
            <Cell>Code</Cell>
            <Cell mono>{code}</Cell>
          </tr>
          <tr>
            <Cell>Title</Cell>
            <Cell>{p.title}</Cell>
          </tr>
          <tr>
            <Cell>Brand</Cell>
            <Cell>{p.brand ?? "—"}</Cell>
          </tr>
          <tr>
            <Cell>GTIN</Cell>
            <Cell mono>{p.gtin ?? "—"}</Cell>
          </tr>
          <tr>
            <Cell>First seen</Cell>
            <Cell>
              {p.first_seen_run ? (
                <Link href={`/admin/runs/${p.first_seen_run}`}>that run</Link>
              ) : (
                "—"
              )}
            </Cell>
          </tr>
          <tr>
            <Cell>Last seen</Cell>
            <Cell>
              {p.last_seen_run ? (
                <Link href={`/admin/runs/${p.last_seen_run}`}>that run</Link>
              ) : (
                "—"
              )}
            </Cell>
          </tr>
        </Table>
      </Card>

      {p.description && (
        <Card title="Description">
          <p>{p.description}</p>
        </Card>
      )}

      <Card title={`Variants (${variants.length})`} flush>
        {variants.length === 0 ? (
          <Empty
            title="No variants"
            hint="A product with no variant in the feed is given one implicit default."
          />
        ) : (
          <Table head={["SKU", "GTIN", "Price", "Stock", "Attributes"]}>
            {variants.map((v, i) => (
              <tr key={i}>
                <Cell mono>{v.sku ?? "—"}</Cell>
                <Cell mono>{v.gtin ?? "—"}</Cell>
                <Cell>
                  {v.price !== undefined && v.price !== null
                    ? `${v.price}${v.currency ? ` ${v.currency}` : ""}`
                    : "—"}
                </Cell>
                <Cell>{v.stock ?? "—"}</Cell>
                <Cell mono>
                  {v.attributes && Object.keys(v.attributes).length > 0
                    ? JSON.stringify(v.attributes)
                    : "—"}
                </Cell>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title={`Images (${images.length})`}>
        {images.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          /*
           * Image URLs are supplier-controlled and nothing rehosts them yet
           * (DESIGN.md defers image rehosting), so they are listed as text
           * rather than loaded — the panel does not fetch third-party assets.
           */
          <pre className="counts">{JSON.stringify(images, null, 2)}</pre>
        )}
      </Card>

      <Card title="Attributes">
        {Object.keys(attributes).length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <pre className="counts">{JSON.stringify(attributes, null, 2)}</pre>
        )}
      </Card>

      <Card title={`Issues for this product (${issues.rowCount})`} flush>
        {issues.rowCount === 0 ? (
          <Empty title="No issues" hint="Nothing about this product has ever failed to parse." />
        ) : (
          <Table head={["Scope", "Status", "Reason", "Evidence", "When", ""]}>
            {issues.rows.map((i) => (
              <tr key={i.id}>
                <Cell>{i.scope}</Cell>
                <Cell>
                  <Pill tone={i.status === "open" ? "warn" : "muted"}>
                    {i.status === "open" ? "open" : `resolved (${i.resolution})`}
                  </Pill>
                </Cell>
                <Cell>{i.reason}</Cell>
                <Cell mono>
                  {i.evidence?.raw_fragment
                    ? String(i.evidence.raw_fragment).slice(0, 200)
                    : "—"}
                </Cell>
                <Cell>{ago(i.created_at)}</Cell>
                <Cell>{i.run_id && <Link href={`/admin/runs/${i.run_id}`}>Run</Link>}</Cell>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </Shell>
  );
}
