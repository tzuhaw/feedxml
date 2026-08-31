import Link from "next/link";
import { getPool } from "@/lib/db";
import { Shell, Card, Table, Cell, StateBadge, Empty, ago } from "../ui";
import { requireAdmin } from "@/lib/guard";
import { r2Configured } from "@/lib/r2";
import { MAX_UPLOAD_LABEL } from "@/lib/upload";
import UploadForm from "./UploadForm";

export const dynamic = "force-dynamic";

/**
 * Operator upload. Same destination, same key shape and same trigger as a
 * supplier push, so nothing downstream treats it differently — it just has a
 * person behind it instead of an API key.
 */
export default async function Upload() {
  // Authorize before any data is fetched (see lib/guard.ts).
  await requireAdmin();

  const configured = r2Configured();
  const pool = getPool();
  const [feeds, recent] = await Promise.all([
    pool.query(
      `select f.id, f.channel, s.name as supplier
       from feeds f join suppliers s on s.id = f.supplier_id
       where f.active and f.format = 'xml'
       order by s.name, f.channel`,
    ),
    pool.query(
      `select r.id, r.state, r.created_at, r.object_key, s.name as supplier
       from feed_runs r
       join feeds f on f.id = r.feed_id
       join suppliers s on s.id = f.supplier_id
       order by r.created_at desc limit 10`,
    ),
  ]);

  return (
    <Shell
      title="Upload a snapshot"
      nav="upload"
      sub={`XML, up to ${MAX_UPLOAD_LABEL} — larger feeds go through the supplier push channel`}
    >
      <Card title="New snapshot">
        {!configured ? (
          <Empty
            title="Object storage is not configured"
            hint={
              <>
                Set <code>R2_ENDPOINT</code>, <code>R2_ACCESS_KEY_ID</code>,{" "}
                <code>R2_SECRET_ACCESS_KEY</code> and <code>R2_BUCKET</code>, then redeploy.
                Despite the names, any S3-compatible bucket works — this deployment uses
                Supabase Storage. The bucket also needs a CORS rule allowing PUT from this
                origin, or uploads stall at 0%.
              </>
            }
          />
        ) : feeds.rowCount === 0 ? (
          <Empty
            title="No active XML feed to upload into"
            hint={
              <>
                A snapshot belongs to a feed. Add one with a migration, then it appears here —
                see <Link href="/admin/feeds">Feeds</Link>.
              </>
            }
          />
        ) : (
          <UploadForm feeds={feeds.rows} />
        )}
      </Card>

      <Card title="What happens next">
        <ol className="preview-list">
          <li>
            The file goes straight from this browser to object storage. It is never held in
            memory by the app.
          </li>
          <li>
            A run is registered against the feed and a worker starts streaming the XML into a
            staging table — flat memory, whatever the file size.
          </li>
          <li>
            Thresholds are checked before anything is applied. If the snapshot looks wrong the
            run <strong>halts</strong> and waits for you on its run page, with a preview of
            exactly what approving would do.
          </li>
          <li>
            Uploading the same file twice is safe: the object key carries a timestamp, so each
            upload is its own snapshot, and an older pending run is superseded rather than
            duplicated.
          </li>
        </ol>
      </Card>

      <Card title="Recent runs" flush>
        {recent.rowCount === 0 ? (
          <Empty title="No runs yet" hint="The first upload will show up here." />
        ) : (
          <Table head={["Supplier", "State", "Object", "When", ""]}>
            {recent.rows.map((r) => (
              <tr key={r.id}>
                <Cell>{r.supplier}</Cell>
                <Cell>
                  <StateBadge state={r.state} />
                </Cell>
                <Cell mono>{r.object_key}</Cell>
                <Cell>{ago(r.created_at)}</Cell>
                <Cell>
                  <Link href={`/admin/runs/${r.id}`}>Detail</Link>
                </Cell>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </Shell>
  );
}
