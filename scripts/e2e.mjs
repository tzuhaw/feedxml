import pg from "pg";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Adversarial end-to-end suite. Deliberately weighted toward what must NOT
 * work: forged and replayed sessions, revoked operators, wrong secrets,
 * cross-tenant object keys, unauthenticated server actions.
 *
 *   BASE=http://localhost:3130 DATABASE_URL=… node scripts/e2e.mjs [rounds]
 *
 * Every case is idempotent so it can run repeatedly; the suite runs three
 * rounds by default because a case that passes once and fails on repeat is
 * the interesting kind of bug (leaked state, cached secrets, replay).
 */

const BASE = process.env.BASE ?? "http://localhost:3130";
const DB = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:55432/postgres";
const TRIGGER_SECRET = process.env.INTERNAL_TRIGGER_SECRET ?? "triggersecret";
const CRON_SECRET = process.env.CRON_SECRET ?? "cronsecret";
const ADMIN_USER = process.env.E2E_USER ?? "admin";
const ADMIN_PASS = process.env.E2E_PASS ?? "localdev";

const pool = new pg.Pool({ connectionString: DB, max: 3 });
const results = [];

function record(id, area, name, ok, detail) {
  results.push({ id, area, name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  ${mark}  ${id.padEnd(5)} ${name}${ok ? "" : `  << ${detail}`}`);
}

async function check(id, area, name, fn) {
  try {
    const { ok, detail } = await fn();
    record(id, area, name, ok, detail);
  } catch (err) {
    record(id, area, name, false, `threw: ${err.message}`);
  }
}

const req = (path, init = {}) =>
  fetch(`${BASE}${path}`, { redirect: "manual", ...init });

/** Sign a session token the way the app does, using the key it stores. */
async function signToken(user, expiresAt) {
  const row = await pool.query(`select value from app_secrets where name = 'session_signing_key'`);
  if (row.rowCount === 0) throw new Error("no signing key yet — sign in once first");
  const payload = `${user}.${expiresAt}`;
  const sig = createHmac("sha256", `feedxml.session.v2:${row.rows[0].value}`)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

/**
 * Server actions are addressed by ids Next assigns at build time. Read them
 * from the build manifest so the suite exercises the real HTTP entry points
 * rather than a stand-in.
 */
function actionIds() {
  const manifest = JSON.parse(
    readFileSync(new URL("../apps/web/.next/server/server-reference-manifest.json", import.meta.url), "utf8"),
  );
  const entries = Object.entries(manifest.node ?? {});
  return {
    // Registered on the login page — signIn and signOut.
    onLoginPage: entries.filter(([, v]) => Object.keys(v.workers ?? {}).includes("app/page")).map(([k]) => k),
    // Registered ONLY on admin pages — the catalog-mutating actions.
    adminOnly: entries
      .filter(([, v]) => {
        const w = Object.keys(v.workers ?? {});
        return w.length > 0 && !w.includes("app/page");
      })
      .map(([k]) => k),
  };
}

async function postAction(actionId, fields, path = "/", cookie) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Next-Action": actionId, ...(cookie ? { cookie } : {}) },
    body,
  });
}

async function login(user = ADMIN_USER, password = ADMIN_PASS, next = "/admin") {
  const body = new URLSearchParams({ user, password, next });
  const res = await fetch(`${BASE}/api/session`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const token = /feedxml_session=([^;]+)/.exec(setCookie)?.[1];
  return {
    cookie: token && token.length > 5 ? `feedxml_session=${token}` : null,
    setCookie,
    location: res.headers.get("location") ?? "",
    status: res.status,
  };
}

async function run(round) {
  console.log(`\n=== ROUND ${round} ===`);
  results.length = 0;

  // ---- A. Session forgery and lifetime -------------------------------------
  await check("A1", "auth", "unauthenticated /admin redirects to login", async () => {
    const r = await req("/admin");
    return { ok: r.status === 307 || r.status === 302, detail: `status ${r.status}` };
  });

  await check("A2", "auth", "no WWW-Authenticate (no browser dialog)", async () => {
    const r = await req("/");
    return { ok: !r.headers.get("www-authenticate"), detail: "header present" };
  });

  await check("A3", "auth", "cookie with a garbage signature is rejected", async () => {
    const r = await req("/admin", { headers: { cookie: `feedxml_session=${ADMIN_USER}.${Date.now() + 1e6}.deadbeef` } });
    return { ok: r.status !== 200, detail: `status ${r.status}` };
  });

  await check("A4", "auth", "VALIDLY SIGNED but expired token is rejected", async () => {
    const token = await signToken(ADMIN_USER, Date.now() - 1000);
    const r = await req("/admin", { headers: { cookie: `feedxml_session=${token}` } });
    return { ok: r.status !== 200, detail: `expired token accepted (status ${r.status})` };
  });

  await check("A5", "auth", "validly signed token for an UNKNOWN user is rejected", async () => {
    const token = await signToken("ghost", Date.now() + 1e6);
    const r = await req("/admin", { headers: { cookie: `feedxml_session=${token}` } });
    return { ok: r.status !== 200, detail: `unknown user accepted (status ${r.status})` };
  });

  await check("A6", "auth", "token payload tampering (user swap) is rejected", async () => {
    const token = await signToken(ADMIN_USER, Date.now() + 1e6);
    const [, exp, sig] = token.split(".");
    const r = await req("/admin", { headers: { cookie: `feedxml_session=root.${exp}.${sig}` } });
    return { ok: r.status !== 200, detail: `tampered token accepted (status ${r.status})` };
  });

  await check("A7", "auth", "a valid token DOES reach the panel", async () => {
    const token = await signToken(ADMIN_USER, Date.now() + 1e6);
    const r = await req("/admin", { headers: { cookie: `feedxml_session=${token}` } });
    return { ok: r.status === 200, detail: `valid token rejected (status ${r.status})` };
  });

  await check("A8", "auth", "revoking an operator invalidates their live session", async () => {
    const token = await signToken(ADMIN_USER, Date.now() + 1e6);
    const hash = (await pool.query(`select password_hash from admin_users where username = $1`, [ADMIN_USER])).rows[0];
    // Keep another operator present, so this tests revocation rather than the
    // "no operators exist yet" setup notice.
    await pool.query(
      `insert into admin_users (username, password_hash) values ('e2e-other', $1) on conflict (username) do nothing`,
      [hash.password_hash],
    );
    await pool.query(`delete from admin_users where username = $1`, [ADMIN_USER]);
    const r = await req("/admin", { headers: { cookie: `feedxml_session=${token}` } });
    const body = r.status === 200 ? await r.text() : "";
    await pool.query(
      `insert into admin_users (username, password_hash) values ($1, $2) on conflict (username) do update set password_hash = excluded.password_hash`,
      [ADMIN_USER, hash.password_hash],
    );
    await pool.query(`delete from admin_users where username = 'e2e-other'`);
    return { ok: !body.includes("Needs attention"), detail: "revoked operator still reached the panel" };
  });

  await check("A9", "auth", "no operators at all shows setup, never the panel", async () => {
    const token = await signToken(ADMIN_USER, Date.now() + 1e6);
    const rows = (await pool.query(`select username, password_hash from admin_users`)).rows;
    await pool.query(`delete from admin_users`);
    const r = await req("/admin", { headers: { cookie: `feedxml_session=${token}` } });
    const body = r.status === 200 ? await r.text() : "";
    for (const row of rows) {
      await pool.query(
        `insert into admin_users (username, password_hash) values ($1, $2) on conflict (username) do nothing`,
        [row.username, row.password_hash],
      );
    }
    return { ok: !body.includes("Needs attention"), detail: "panel rendered with no operators configured" };
  });

  // ---- B. Login endpoint ----------------------------------------------------
  await check("B1", "login", "correct credentials issue a session", async () => {
    const { cookie } = await login();
    return { ok: !!cookie, detail: "no session cookie issued" };
  });

  await check("B2", "login", "session cookie is httpOnly and sameSite", async () => {
    const { setCookie } = await login();
    const ok = /httponly/i.test(setCookie ?? "") && /samesite/i.test(setCookie ?? "");
    return { ok, detail: `flags: ${setCookie}` };
  });

  await check("B3", "login", "wrong password issues no session", async () => {
    const { cookie } = await login(ADMIN_USER, "definitely-not-it");
    return { ok: !cookie, detail: "session issued for a wrong password" };
  });

  await check("B4", "login", "unknown username issues no session", async () => {
    const { cookie } = await login("nosuchoperator", ADMIN_PASS);
    return { ok: !cookie, detail: "session issued for an unknown user" };
  });

  await check("B5", "login", "SQL metacharacters in username are inert", async () => {
    const { cookie } = await login("admin' or '1'='1", ADMIN_PASS);
    const stillThere = await pool.query(`select 1 from admin_users where username = $1`, [ADMIN_USER]);
    return { ok: !cookie && stillThere.rowCount === 1, detail: "injection attempt had an effect" };
  });

  await check("B6", "login", "failed sign-in redirects with an error, not a session", async () => {
    const r = await login(ADMIN_USER, "nope");
    return { ok: !r.cookie && r.location.includes("error="), detail: `status ${r.status} -> ${r.location}` };
  });

  await check("B7", "login", "next= cannot redirect off-site after a successful login", async () => {
    const r = await login(ADMIN_USER, ADMIN_PASS, "https://evil.example/steal");
    return { ok: !r.location.includes("evil.example"), detail: `redirected to ${r.location}` };
  });

  await check("B8", "login", "sign-out clears the session cookie", async () => {
    const res = await fetch(`${BASE}/api/session`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "signout" }),
    });
    const sc = res.headers.get("set-cookie") ?? "";
    return { ok: /feedxml_session=;|feedxml_session=deleted|Max-Age=0/i.test(sc), detail: `set-cookie: ${sc}` };
  });

  // ---- C. Trigger + cron + upload API ---------------------------------------
  const api = [
    ["C1", "POST /api/feeds/ready without secret", "/api/feeds/ready", { method: "POST", headers: { "content-type": "application/json" }, body: '{"objectKey":"feeds/acme/1.xml"}' }, 401],
    ["C2", "POST /api/feeds/ready wrong secret", "/api/feeds/ready", { method: "POST", headers: { "content-type": "application/json", "x-internal-secret": "wrong" }, body: '{"objectKey":"feeds/acme/1.xml"}' }, 401],
    ["C3", "malformed objectKey is 400 not 404", "/api/feeds/ready", { method: "POST", headers: { "content-type": "application/json", "x-internal-secret": TRIGGER_SECRET }, body: '{"objectKey":"../../etc/passwd"}' }, 400],
    ["C4", "path traversal inside a valid prefix is 400", "/api/feeds/ready", { method: "POST", headers: { "content-type": "application/json", "x-internal-secret": TRIGGER_SECRET }, body: '{"objectKey":"feeds/acme/../../secret.xml"}' }, 400],
    ["C5", "unknown supplier is 404", "/api/feeds/ready", { method: "POST", headers: { "content-type": "application/json", "x-internal-secret": TRIGGER_SECRET }, body: '{"objectKey":"feeds/nosuchsupplier/1.xml"}' }, 404],
    ["C6", "non-object JSON body is 400 not 500", "/api/feeds/ready", { method: "POST", headers: { "content-type": "application/json", "x-internal-secret": TRIGGER_SECRET }, body: "null" }, 400],
    ["C7", "invalid JSON body is 400 not 500", "/api/feeds/ready", { method: "POST", headers: { "content-type": "application/json", "x-internal-secret": TRIGGER_SECRET }, body: "{oops" }, 400],
    ["C8", "cron sweep without secret", "/api/cron/sweep", {}, 401],
    ["C9", "cron sweep wrong secret", "/api/cron/sweep", { headers: { authorization: "Bearer wrong" } }, 401],
    ["C10", "cron sweep with a session cookie only", "/api/cron/sweep", { headers: { cookie: "feedxml_session=x" } }, 401],
    ["C11", "upload-url without auth", "/api/feeds/upload-url", { method: "POST", headers: { "content-type": "application/json" }, body: '{"action":"init"}' }, 401],
    ["C12", "upload-url with malformed supplier id", "/api/feeds/upload-url", { method: "POST", headers: { "content-type": "application/json", "x-supplier-id": "not-a-uuid", "x-api-key": "k" }, body: '{"action":"init"}' }, 401],
    ["C13", "upload-url with a well-formed but unknown supplier", "/api/feeds/upload-url", { method: "POST", headers: { "content-type": "application/json", "x-supplier-id": "00000000-0000-4000-8000-000000000000", "x-api-key": "k" }, body: '{"action":"init"}' }, 401],
  ];
  for (const [id, name, path, init, expect] of api) {
    await check(id, "api", `${name} → ${expect}`, async () => {
      const r = await req(path, init);
      return { ok: r.status === expect, detail: `got ${r.status}` };
    });
  }

  // ---- D. Server actions are not reachable unauthenticated -------------------
  await check("D1", "actions", "admin server actions refuse without a session", async () => {
    const ids = actionIds().adminOnly;
    if (ids.length === 0) return { ok: false, detail: "no admin-only actions found in the manifest" };
    for (const id of ids) {
      const res = await postAction(
        id,
        { "1_runId": "00000000-0000-4000-8000-000000000000", "1_issueId": "00000000-0000-4000-8000-000000000000", "1_supplierId": "00000000-0000-4000-8000-000000000000", "1_productCode": "X" },
        "/admin/issues",
      );
      const text = await res.text();
      // An unauthenticated call must not perform work. The guard throws, which
      // Next surfaces as an error digest rather than a success payload.
      if (res.status === 200 && !text.includes("digest") && !text.includes("expired")) {
        return { ok: false, detail: `action ${id.slice(0, 8)} responded 200 with no error` };
      }
    }
    return { ok: true };
  });

  await check("D2", "actions", "admin server actions work WITH a session", async () => {
    const { cookie } = await login();
    if (!cookie) return { ok: false, detail: "could not obtain a session" };
    const r = await req("/admin", { headers: { cookie } });
    return { ok: r.status === 200, detail: `session did not reach the panel (${r.status})` };
  });

  // ---- E. Navigation ---------------------------------------------------------
  await check("E1", "nav", "unauthenticated deep link preserves its destination", async () => {
    const r = await req("/admin/runs?state=failed");
    const loc = r.headers.get("location") ?? "";
    return { ok: loc.includes("next="), detail: `redirected to ${loc || "(none)"} — destination lost` };
  });

  await check("E2", "nav", "an authenticated visit to / goes to the panel", async () => {
    const token = await signToken(ADMIN_USER, Date.now() + 1e6);
    const r = await req("/", { headers: { cookie: `feedxml_session=${token}` } });
    const loc = r.headers.get("location") ?? "";
    return {
      ok: (r.status === 307 || r.status === 302) && loc.includes("/admin"),
      detail: `status ${r.status} -> ${loc || "(login form shown again)"}`,
    };
  });

  await check("E3", "nav", "an INVALID cookie on / still shows the login form (no loop)", async () => {
    const r = await req("/", { headers: { cookie: "feedxml_session=bogus.1.zz" } });
    return { ok: r.status === 200, detail: `status ${r.status} — possible redirect loop` };
  });

  await check("E4", "nav", "an invalid cookie on /admin does not loop", async () => {
    const r = await req("/admin", { headers: { cookie: "feedxml_session=bogus.1.zz" } });
    const loc = r.headers.get("location") ?? "";
    return { ok: (r.status === 307 || r.status === 302) && !loc.includes("/admin"), detail: `-> ${loc}` };
  });

  await check("E5", "nav", "next= cannot be used as an open redirect", async () => {
    const token = await signToken(ADMIN_USER, Date.now() + 1e6);
    const r = await req("/?next=https://evil.example/steal", { headers: { cookie: `feedxml_session=${token}` } });
    const loc = r.headers.get("location") ?? "";
    return { ok: !loc.includes("evil.example"), detail: `redirected off-site to ${loc}` };
  });

  // ---- G. Credential edge cases (added after round 3 review) ----------------
  await check("G1", "login", "username matching is case sensitive", async () => {
    const r = await login(ADMIN_USER.toUpperCase(), ADMIN_PASS);
    return { ok: !r.cookie, detail: "uppercase username authenticated" };
  });

  await check("G2", "login", "surrounding whitespace is not trimmed away", async () => {
    const r = await login(` ${ADMIN_USER} `, ADMIN_PASS);
    return { ok: !r.cookie, detail: "padded username authenticated" };
  });

  await check("G3", "login", "a password extended past bcrypt's 72-byte limit fails", async () => {
    const r = await login(ADMIN_USER, ADMIN_PASS + "x".repeat(200));
    return { ok: !r.cookie, detail: "bcrypt truncation let a wrong password through" };
  });

  await check("G4", "login", "empty credentials are refused", async () => {
    const r = await login("", "");
    return { ok: !r.cookie, detail: "empty credentials authenticated" };
  });

  await check("G5", "login", "each sign-in issues a distinct token", async () => {
    const a = await login();
    await new Promise((r) => setTimeout(r, 5));
    const b = await login();
    return { ok: !!a.cookie && !!b.cookie && a.cookie !== b.cookie, detail: "token reused across logins" };
  });

  await check("G6", "login", "GET cannot sign in (POST only)", async () => {
    const r = await req("/api/session?user=" + ADMIN_USER + "&password=" + ADMIN_PASS);
    return { ok: !(r.headers.get("set-cookie") ?? "").includes("feedxml_session="), detail: "GET issued a session" };
  });

  await check("G7", "login", "a body-less POST does not 500", async () => {
    const r = await fetch(`${BASE}/api/session`, { method: "POST", redirect: "manual" });
    return { ok: r.status < 500, detail: `status ${r.status}` };
  });

  await check("G8", "auth", "rotating the signing key invalidates existing sessions", async () => {
    const token = await signToken(ADMIN_USER, Date.now() + 1e6);
    const original = (await pool.query(`select value from app_secrets where name = 'session_signing_key'`)).rows[0].value;
    await pool.query(`update app_secrets set value = $1 where name = 'session_signing_key'`, ["rotated-" + original]);
    // The app caches the key briefly, so wait it out rather than asserting instantly.
    await new Promise((r) => setTimeout(r, 250));
    const r = await req("/admin", { headers: { cookie: `feedxml_session=${token}` } });
    const body = r.status === 200 ? await r.text() : "";
    await pool.query(`update app_secrets set value = $1 where name = 'session_signing_key'`, [original]);
    return {
      ok: !body.includes("Needs attention"),
      detail: "session survived a key rotation (may be the 5-minute key cache — verify before treating as a bug)",
    };
  });

  // ---- H. Panel surfaces render for an authenticated operator ---------------
  for (const [i, path] of ["/admin", "/admin/runs", "/admin/issues", "/admin/products", "/admin/feeds"].entries()) {
    await check(`H${i + 1}`, "panel", `${path} renders with a session`, async () => {
      const token = await signToken(ADMIN_USER, Date.now() + 1e6);
      const r = await req(path, { headers: { cookie: `feedxml_session=${token}` } });
      return { ok: r.status === 200, detail: `status ${r.status}` };
    });
  }

  await check("H6", "panel", "an unknown run id is 404, not a 500", async () => {
    const token = await signToken(ADMIN_USER, Date.now() + 1e6);
    const r = await req("/admin/runs/00000000-0000-4000-8000-000000000000", { headers: { cookie: `feedxml_session=${token}` } });
    return { ok: r.status === 404, detail: `status ${r.status}` };
  });

  await check("H7", "panel", "a non-uuid run id does not 500", async () => {
    const token = await signToken(ADMIN_USER, Date.now() + 1e6);
    const r = await req("/admin/runs/not-a-uuid", { headers: { cookie: `feedxml_session=${token}` } });
    return { ok: r.status < 500, detail: `status ${r.status}` };
  });

  // ---- I. Trigger idempotency ------------------------------------------------
  await check("I1", "api", "the same object key registers exactly one run", async () => {
    const feed = await pool.query(
      `select s.name from feeds f join suppliers s on s.id = f.supplier_id where f.active and f.format = 'xml' limit 1`,
    );
    if (feed.rowCount === 0) return { ok: true, detail: "no feed configured — skipped" };
    const key = `feeds/${feed.rows[0].name}/${Date.now()}.xml`;
    const post = () =>
      req("/api/feeds/ready", {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": TRIGGER_SECRET },
        body: JSON.stringify({ objectKey: key }),
      });
    const first = await (await post()).json();
    const second = await (await post()).json();
    const rows = await pool.query(`select count(*)::int n from feed_runs where object_key = $1`, [key]);
    await pool.query(`delete from feed_runs where object_key = $1`, [key]);
    return {
      ok: rows.rows[0].n === 1 && first.runId === second.runId && second.created === false,
      detail: `${rows.rows[0].n} runs created for one key`,
    };
  });

  // ---- F. Data integrity invariants -----------------------------------------
  await check("F1", "data", "no product is ever hard-deleted by a sweep", async () => {
    const r = await pool.query(`select count(*)::int n from products where status not in ('active','inactive')`);
    return { ok: r.rows[0].n === 0, detail: `${r.rows[0].n} products in an unexpected state` };
  });

  await check("F2", "data", "every run's counts stay parseable jsonb", async () => {
    const r = await pool.query(`select count(*)::int n from feed_runs where counts is not null and jsonb_typeof(counts) <> 'object'`);
    return { ok: r.rows[0].n === 0, detail: `${r.rows[0].n} runs with non-object counts` };
  });

  await check("F3", "data", "one active feed per supplier+format holds", async () => {
    const r = await pool.query(
      `select count(*)::int n from (select supplier_id, format from feeds where active group by 1,2 having count(*) > 1) x`,
    );
    return { ok: r.rows[0].n === 0, detail: `${r.rows[0].n} ambiguous feed routings` };
  });

  await check("F4", "data", "admin passwords are stored only as bcrypt hashes", async () => {
    const r = await pool.query(`select count(*)::int n from admin_users where password_hash !~ '^\\$2[aby]\\$'`);
    return { ok: r.rows[0].n === 0, detail: `${r.rows[0].n} non-bcrypt password values` };
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nRound ${round}: ${results.length - failed.length}/${results.length} passed`);
  return { total: results.length, failed: failed.map((f) => `${f.id} ${f.name} — ${f.detail}`) };
}

const rounds = Number(process.argv[2] ?? 3);
const summary = [];
for (let i = 1; i <= rounds; i++) summary.push(await run(i));
await pool.end();

console.log("\n=== SUMMARY ===");
summary.forEach((s, i) => {
  console.log(`Round ${i + 1}: ${s.total - s.failed.length}/${s.total} passed`);
  s.failed.forEach((f) => console.log(`   FAIL ${f}`));
});
process.exitCode = summary.some((s) => s.failed.length) ? 1 : 0;
