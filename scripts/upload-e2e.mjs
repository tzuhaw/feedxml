/**
 * End-to-end operator upload against a REAL bucket.
 *
 *   BASE=https://feedxml.vercel.app E2E_USER=admin E2E_PASS=… node scripts/upload-e2e.mjs
 *
 * This is the one path scripts/upload-check.mjs cannot cover: it verifies the
 * presigning, but stops short of the transfer because it never had a reachable
 * bucket. Here the bytes actually move — browser-equivalent PUT to the signed
 * URL, then the server's HEAD re-measure and run registration.
 *
 * It leaves a real run behind, deliberately: that is the evidence the path
 * works. Nothing is deleted.
 */
const BASE = process.env.BASE ?? "http://localhost:3130";
const USER = process.env.E2E_USER ?? "admin";
const PASS = process.env.E2E_PASS ?? "localdev";

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}  << ${detail ?? ""}`);
  }
};

// A tiny but genuinely valid snapshot, so the worker would have real work.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<products>
  <product code="E2E-001">
    <title>Upload path smoke product</title>
    <brand>feedxml</brand>
    <variants>
      <variant sku="E2E-001-A"><price>10.00</price><currency>EUR</currency><stock>3</stock></variant>
    </variants>
  </product>
</products>
`;
const bytes = Buffer.from(XML, "utf8");

const login = await fetch(`${BASE}/api/session`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ user: USER, password: PASS }),
  redirect: "manual",
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
check("signed in", /=[^;]{10,}/.test(cookie), `set-cookie: ${cookie}`);
if (!/=[^;]{10,}/.test(cookie)) process.exit(1);

const api = (body) =>
  fetch(`${BASE}/api/admin/upload`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });

// Which feed to upload into.
const feedsRes = await fetch(`${BASE}/admin/upload`, { headers: { cookie } });
const feedsHtml = await feedsRes.text();
const feedId = (/value="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/.exec(feedsHtml) ?? [])[1];
check("upload page offers a feed", Boolean(feedId), "no feed <option> in the page — storage unconfigured, or no active xml feed");
if (!feedId) process.exit(1);

// 1. init
const initRes = await api({ action: "init", feedId, size: bytes.length });
const init = await initRes.json().catch(() => ({}));
check("init returns a signed URL", initRes.status === 200 && Boolean(init.url), `${initRes.status} ${JSON.stringify(init)}`);
if (!init.url) process.exit(1);
check("object key is server-built", /^feeds\/[a-z0-9_-]+\/\d+\.xml$/.test(init.objectKey ?? ""), init.objectKey);

// 2. the actual transfer
const put = await fetch(init.url, { method: "PUT", body: bytes });
check("PUT to the bucket succeeds", put.ok, `${put.status} ${(await put.text()).slice(0, 300)}`);

// The size cap is bound into the signature: the SAME url must reject a
// different body length. This is the claim upload-check could only assert
// structurally, from the presence of content-length in SignedHeaders.
const wrong = await fetch(init.url, { method: "PUT", body: Buffer.concat([bytes, Buffer.from("x")]) });
check("signature rejects a different content-length", !wrong.ok, `expected failure, got ${wrong.status}`);

// 3. complete
const doneRes = await api({ action: "complete", objectKey: init.objectKey });
const done = await doneRes.json().catch(() => ({}));
check("complete registers a run", (doneRes.status === 201 || doneRes.status === 200) && Boolean(done.runId), `${doneRes.status} ${JSON.stringify(done)}`);

// 4. the run is real and reachable in the panel
if (done.runId) {
  const detail = await fetch(`${BASE}/admin/runs/${done.runId}`, { headers: { cookie } });
  check("run detail page renders", detail.status === 200, `status ${detail.status}`);
  console.log(`\n  run: ${BASE}/admin/runs/${done.runId}`);
  console.log(`  object: ${init.objectKey} (${bytes.length} bytes)`);
}

// 5. completing a key that was never stored must not register anything
const ghost = await api({ action: "complete", objectKey: `feeds/${init.objectKey.split("/")[1]}/1.xml` });
check("completing an absent object is refused", ghost.status === 409, `got ${ghost.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
