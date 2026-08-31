import Link from "next/link";
import { getPool } from "@/lib/db";
import { Shell, Card, Chips, Chip, Table, Cell, Pill, Empty, Pager, paginate, ago } from "../ui";
import { resolveIssueAction } from "../actions";
import { requireAdmin } from "@/lib/guard";

export const dynamic = "force-dynamic";

const PER_PAGE = 25;

const SCOPES = ["all", "run", "product", "record"] as const;

/**
 * The Issue inbox: one list, three scopes, evidence inline. Resolved issues
 * are hidden by default — what remains open is what is still true.
 */
export default async function Issues({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; status?: string; page?: string }>;
}) {
  // Authorize before any data is fetched (see lib/guard.ts).
  await requireAdmin();

  const { scope: rawScope, status, page: rawPage } = await searchParams;
  // Params reach an enum cast — unknown values must not 500 the inbox.
  const scope = SCOPES.includes(rawScope as (typeof SCOPES)[number]) ? rawScope : "all";
  const showResolved = status === "resolved";
  const pool = getPool();

  const args = [scope && scope !== "all" ? scope : null, showResolved ? "resolved" : "open"];
  const filter = `where i.status = $2::issue_status
       and ($1::text is null or i.scope = $1::issue_scope)`;

  const countRes = await pool.query(
    `select count(*)::int as n from issues i ${filter}`,
    args,
  );
  const total: number = countRes.rows[0].n;
  const { page, pageCount, offset } = paginate(total, rawPage, PER_PAGE);

  const issues = await pool.query(
    `select i.id, i.scope, i.status, i.product_code, i.reason, i.evidence,
            i.resolution, i.created_at, i.run_id, s.name as supplier
     from issues i
     left join suppliers s on s.id = i.supplier_id
     ${filter}
     order by i.created_at desc, i.id
     limit ${PER_PAGE} offset ${offset}`,
    args,
  );

  const base = (s: string, resolved: boolean) =>
    `/admin/issues?scope=${s}${resolved ? "&status=resolved" : ""}`;
  const pageHref = (p: number) =>
    `${base(scope ?? "all", showResolved)}${p > 1 ? `&page=${p}` : ""}`;

  return (
    <Shell
      title="Issues"
      nav="issues"
      sub={
        pageCount > 1
          ? `${total.toLocaleString()} issues · page ${page} of ${pageCount}`
          : "Record issues keep the last known good product; they never drop it."
      }
    >
      <Chips>
        {SCOPES.map((s) => (
          <Chip key={s} href={base(s, showResolved)} active={scope === s}>
            {s}
          </Chip>
        ))}
        <Chip href={base(scope ?? "all", !showResolved)} active={showResolved}>
          {showResolved ? "resolved" : "show resolved"}
        </Chip>
      </Chips>

      <Card flush>
        {issues.rowCount === 0 ? (
          <Empty
            title={showResolved ? "No resolved issues" : "No open issues"}
            hint={
              showResolved
                ? "Issues close automatically when the product ingests cleanly."
                : "Anything the pipeline could not parse or trust shows up here with its evidence."
            }
          />
        ) : (
          <Table head={["Scope", "Supplier", "Product", "Reason", "Evidence", "When", ""]}>
            {issues.rows.map((i) => (
              <tr key={i.id}>
                <Cell>
                  <Pill tone={i.scope === "run" ? "warn" : i.scope === "product" ? "info" : "muted"}>
                    {i.scope}
                  </Pill>
                </Cell>
                <Cell>{i.supplier ?? "—"}</Cell>
                <Cell mono>{i.product_code ?? "—"}</Cell>
                <Cell>
                  {i.reason}
                  {i.resolution && <div className="cell-sub">{i.resolution}</div>}
                </Cell>
                <Cell mono>
                  {i.evidence?.raw_fragment
                    ? String(i.evidence.raw_fragment).slice(0, 200)
                    : i.evidence?.breaches
                      ? JSON.stringify(i.evidence.breaches)
                      : "—"}
                </Cell>
                <Cell>{ago(i.created_at)}</Cell>
                <Cell>
                  <div className="cell-actions">
                    {i.run_id && <Link href={`/admin/runs/${i.run_id}`}>Run</Link>}
                    {i.status === "open" && i.scope !== "run" && (
                      <form action={resolveIssueAction}>
                        <input type="hidden" name="issueId" value={i.id} />
                        <button type="submit" className="linkbtn">
                          Resolve
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
    </Shell>
  );
}
