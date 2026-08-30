import pg from "pg";

const BASE = "http://localhost:3130";
const pool = new pg.Pool({
  connectionString: "postgres://postgres:postgres@localhost:55432/postgres",
});

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}  ${detail ?? ""}`);
  }
}

const feed = await pool.query(
  `select f.id, s.name as supplier from feeds f join suppliers s on s.id = f.supplier_id
   where f.active and f.format = 'xml' limit 1`,
);
const feedId = feed.rows[0].id;
const supplier = feed.rows[0].supplier;
const runsBefore = (await pool.query(`select count(*)::int as n from feed_runs`)).rows[0].n;

const post = (body, cookie) =>
  fetch(`${BASE}/api/admin/upload`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });

// --- unauthenticated -------------------------------------------------------
let r = await post({ action: "init", feedId, size: 100 });
check("A1 no session -> 401", r.status === 401, `got ${r.status}`);

r = await fetch(`${BASE}/api/admin/upload`, { method: "POST", redirect: "manual" });
check("A2 no session, no body -> 401 (auth before parse)", r.status === 401, `got ${r.status}`);

// --- sign in ---------------------------------------------------------------
const login = await fetch(`${BASE}/api/session`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ user: "admin", password: "localdev123" }),
  redirect: "manual",
});
const setCookie = login.headers.get("set-cookie") ?? "";
const cookie = setCookie.split(";")[0];
check("B1 login issues a session", /=/.test(cookie) && cookie.length > 20, cookie);

// --- validation ------------------------------------------------------------
r = await post({ action: "init", feedId: "not-a-uuid", size: 100 }, cookie);
check("C1 bad feedId -> 400", r.status === 400, `got ${r.status}`);

r = await post({ action: "init", feedId, size: 0 }, cookie);
check("C2 zero size -> 400", r.status === 400, `got ${r.status}`);

r = await post({ action: "init", feedId, size: -5 }, cookie);
check("C3 negative size -> 400", r.status === 400, `got ${r.status}`);

r = await post({ action: "init", feedId, size: 100 * 1024 * 1024 + 1 }, cookie);
check("C4 one byte over 100MB -> 413", r.status === 413, `got ${r.status}`);

r = await post({ action: "init", feedId, size: 100 * 1024 * 1024 }, cookie);
check("C5 exactly 100MB -> allowed", r.status === 200, `got ${r.status}`);

r = await post(
  { action: "init", feedId: "00000000-0000-4000-8000-000000000000", size: 100 },
  cookie,
);
check("C6 unknown feed -> 404", r.status === 404, `got ${r.status}`);

r = await post({ action: "nonsense" }, cookie);
check("C7 unknown action -> 400", r.status === 400, `got ${r.status}`);

// --- the signed URL --------------------------------------------------------
r = await post({ action: "init", feedId, size: 4096 }, cookie);
const init = await r.json();
check("D1 init -> 200", r.status === 200, `got ${r.status}`);
// The supplier in the key comes from the FEED, never from the request — that
// is what stops an upload landing in someone else's prefix.
check(
  "D2 object key is server-built from the feed's own supplier",
  init.objectKey === `feeds/${supplier}/${init.objectKey?.split("/")[2]}` &&
    new RegExp(`^feeds/${supplier}/\\d+\\.xml$`).test(init.objectKey ?? ""),
  init.objectKey,
);
const signed = new URL(init.url ?? "http://x/");
const sh = signed.searchParams.get("X-Amz-SignedHeaders") ?? "";
check("D3 content-length is a SIGNED header (binds the size)", sh.includes("content-length"), sh);
check("D4 url targets the bucket + key", signed.pathname.includes(init.objectKey), signed.pathname);
check("D5 url is presigned with an expiry", signed.searchParams.has("X-Amz-Expires"), "");
// Path-style, not virtual-host: R2 does not serve <bucket>.<account>.r2...,
// and getting this wrong fails only at PUT time, long after signing appears
// to have worked.
check(
  "D5b path-style addressing (bucket in the path, not the host)",
  signed.pathname.startsWith("/feedxml/") && !signed.host.startsWith("feedxml."),
  `host=${signed.host} path=${signed.pathname}`,
);

// A second init must not reuse the first key.
const init2 = await (await post({ action: "init", feedId, size: 4096 }, cookie)).json();
check("D6 each upload gets its own key", init2.objectKey !== init.objectKey, init2.objectKey);

// --- completion ------------------------------------------------------------
r = await post({ action: "complete", objectKey: "../../etc/passwd" }, cookie);
check("E1 traversal key -> 400", r.status === 400, `got ${r.status}`);

r = await post({ action: "complete", objectKey: "feeds/other/1.xml" }, cookie);
check(
  "E2 well-formed key with nothing stored -> 409, no run registered",
  r.status === 409,
  `got ${r.status}`,
);

const runsAfter = (await pool.query(`select count(*)::int as n from feed_runs`)).rows[0].n;
check(
  "E3 a failed completion registers no run at all",
  runsAfter === runsBefore,
  `before=${runsBefore} after=${runsAfter}`,
);

// --- audit -----------------------------------------------------------------
const audit = await pool.query(
  `select count(*)::int as n from audit_log where action = 'upload_init' and actor = 'admin:admin'`,
);
check("F1 inits are audited against the operator", audit.rows[0].n >= 3, `n=${audit.rows[0].n}`);

console.log(`\n${pass} passed, ${fail} failed`);
await pool.end();
process.exit(fail === 0 ? 0 : 1);
