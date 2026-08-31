# Test plan

What is verified, how, and what was actually observed. Last executed
2026-08-31 against commit `db.ts` guard (HEAD) with a local Postgres 16 and the
production deployment at https://feedxml.vercel.app.

Legend: **PASS** observed and correct · **BLOCKED** cannot run yet, with the
reason · **N/A** deliberately out of scope.

---

## A. Automated suite

`TEST_DATABASE_URL=… npm test` — 4 files, **42 tests, all passing**.

| | Covers | Result |
|---|---|---|
| `pipeline.test.ts` (8) | XML streaming core: record counting, unique-staged, Skipped with evidence, duplicate last-wins, implicit default Variant, image objects, mixed-content text | PASS |
| `ndjson.test.ts` (3) | NDJSON front-end parity with XML through one transform, malformed line becomes a Skip, default Variant | PASS |
| `validate.test.ts` (6) | Threshold evaluation: healthy feed, each of the three breaches, first-run baseline absence, multiple simultaneous breaches | PASS |
| `integration.test.ts` (25) | Every domain rule against real Postgres — see B | PASS |

## B. Domain rules (integration, real Postgres)

Each row is an executable scenario, not a description.

| Rule | Scenario | Result |
|---|---|---|
| Happy path | First run stages, merges, finishes `done` | PASS |
| Record Issues | Duplicates and unparseable records recorded with raw fragment; last occurrence wins | PASS |
| Skipped ≠ Missing | A broken record keeps last known good state and stays active | PASS |
| Deactivation Sweep | Missing products go inactive with an audit row; never deleted | PASS |
| Halt before apply | Threshold breach halts; nothing applied; Run Issue opened | PASS |
| Approve | Applies everything including the sweep; Issue resolves as `approved` | PASS |
| Reject | Discards the run, keeps staging as evidence | PASS |
| Error-rate breach | Halts on its own | PASS |
| Skip streak | Raises one Product Issue at the per-feed limit; no duplicates; resolves on clean ingest | PASS |
| Pins | Survive the sweep, clear on reappearance, audited | PASS |
| Reactivation | A deactivated product returns to active when the supplier sends it again | PASS |
| Auto-resolution | Record Issues close when the product ingests cleanly later | PASS |
| Consequence Preview | Preview numbers equal what Approve then does | PASS |
| Manual re-ingest | Replay allowed; automatic re-registration still refused | PASS |
| Halted run re-execution | Refused — no Issue wipe, no duplicate email | PASS |
| Superseded staging | Purged by the next successful run | PASS |
| Retention | A successful run purges only the previous successful run's staging | PASS |
| Fencing | A bumped attempt blocks a stale worker's merge claim | PASS |
| Supersede | A newer Snapshot supersedes a Halted run and closes its Issue | PASS |
| Dead run | Executing a superseded run is a no-op that claims no attempt | PASS |
| Partial thresholds | Fall back to defaults instead of disabling rules | PASS |
| Code-less Issues | Resolve as superseded rather than accumulating | PASS |
| Error clearing | A retried run clears its stale error | PASS |
| Streak idempotency | A retry does not double-bump | PASS |
| Valid + malformed same product | Does not streak | PASS |

## C. End-to-end ingestion (fresh schema)

`node scripts/migrate.mjs --reset` then `node worker/dist/demo.js`.

| Step | Observed | Result |
|---|---|---|
| Stage a 5-record fixture | 2 unique staged, 2 skipped, 1 duplicate | PASS |
| Halt | `error_rate 0.4 > 0.02` → halted, nothing applied | PASS |
| Issues | 3 Record Issues with evidence + 1 Run Issue | PASS |
| Preview | creates 2, updates 0, deactivations 0, skipped 1 | PASS |
| Approve | Applied; counts match the preview exactly | PASS |
| Catalog | ACME-001 (2 variants, 2 images), ACME-002 last-wins title | PASS |
| Final state | `done`, `approvedBy: admin:demo` | PASS |

## D. Authentication and access control

Production build served locally.

| # | Check | Observed | Result |
|---|---|---|---|
| C1 | `/admin` unauthenticated | 307 → login | PASS |
| C2 | No `WWW-Authenticate` header | absent (no browser dialog) | PASS |
| C3 | Deep link preserved through login | `?next=/admin/runs?state=failed` | PASS |
| D1 | Forged session cookie | 307 → login | PASS |
| D2 | Malformed signature | 307 → login | PASS |
| D3 | Empty cookie | 307 → login | PASS |
| — | Wrong password | Inline "Those credentials weren't recognised." — identical for wrong username | PASS |
| — | Correct credentials | Lands in the panel with data; Sign out present | PASS |

## E. API surface

| # | Check | Observed | Result |
|---|---|---|---|
| E1 | Trigger, no secret | 401 | PASS |
| E2 | Trigger, wrong secret | 401 | PASS |
| E3 | Trigger, malformed object key | 400 (client bug, distinct from 404) | PASS |
| E4 | Trigger, unknown supplier | 404 (provisioning gap) | PASS |
| E5 | Sweep, no secret | 401 | PASS |
| E6 | Sweep, correct secret, storage **unconfigured** | 200, `discovered: "skipped: object storage not configured"`, other four steps ran | PASS |
| E6b | Sweep, correct secret, storage **configured but unreachable** | 500, `discovered: "error: code: ECONNREFUSED"` — a real fault still alerts, and now says why | PASS |
| E7 | Upload API, no auth | 401 | PASS |

## F. Production smoke — https://feedxml.vercel.app

| # | Check | Observed | Result |
|---|---|---|---|
| F1 | Login page | 200 | PASS |
| F2 | No browser auth dialog | absent | PASS |
| F3 | `/admin` unauthenticated | 307 → login | PASS |
| F4 | Form in shipped HTML | present | PASS |
| F5 | Sweep rejects no secret | 401 | PASS |
| F6 | Upload API rejects no auth | 401 | PASS |
| F7 | Trigger rejects no secret | 401 | PASS |
| F8 | Panel loads live data | Fixed by switching `DATABASE_URL` to the transaction pooler (`aws-0-<region>.pooler.supabase.com:6543`, user `postgres.<ref>`). The direct host `db.<ref>.supabase.co` is IPv6-only and unreachable from Vercel; `lib/db.ts` now refuses it with an explanation, and `scripts/check-db.mjs` finds the working string. | PASS |

## F2. Browser-driven UI (Claude browser automation)

Driven through a real browser against the running app, not HTTP alone.

| Check | Observed | Result |
|---|---|---|
| Sign-in form renders with the ambient stream behind it | Both themes correct | PASS |
| Wrong password | Inline message in the halt colour; no browser dialog | PASS |
| Correct credentials | Lands in the panel, "Sign out" present | PASS |
| Deep link survives login | Requested `/admin/issues?scope=record` signed out, arrived there after login with the filter applied | PASS |
| Issue inbox | Three Record Issues with raw XML evidence inline | PASS |
| Run history | State, duration, staged/applied counts, attempt | PASS |
| Run detail | Full counts incl. the breach that halted it and `approvedBy` | PASS |
| Sign out | Returns to the sign-in page | PASS |
| Overview after the redesign | Status band, five metric tiles, cards; band reads "All clear" on a clean database and turns amber with a live count when snapshots await review | PASS |
| Product catalog | Lists ingested products with status, variant and image counts — previously the page showed only deactivated and pinned products, so it read as empty on a healthy catalog | PASS |
| Product detail | Variants (SKU, GTIN, price, stock), images, attributes and per-product issues | PASS |
| Upload page, storage unconfigured | Says so plainly instead of erroring | PASS |
| Nav active state | Current section is marked, and `aria-current="page"` is set | PASS |
| Phone, 375×812 | Nav scrolls sideways, tiles reflow to two columns, tables become labelled cards | PASS |

## F3. Adversarial suite — `scripts/e2e.mjs`

58 cases, weighted toward what must NOT work. Method: run three rounds; when a
round is clean, look for what it fails to cover, add those cases, run again.
Six product bugs found this way — see [BUGS.md](BUGS.md).

| Run | Result |
|---|---|
| Rounds 1–3 (local, current code) | **57/57, 57/57, 57/57** |
| Rounds 1–3 (local, after the panel redesign + upload page) | **57/57, 57/57, 57/57** |
| Production | **57/57** once F8 was fixed |

```
BASE=http://localhost:3130 DATABASE_URL=… node scripts/e2e.mjs 3
```

Run it against a **production build** (`next build && next start`), not `next
dev`: cases D1/D2 address server actions through
`.next/server/server-reference-manifest.json`, and the suite needs
`INTERNAL_TRIGGER_SECRET` and `CRON_SECRET` set on the server or the API cases
see 401 where they expect 400/404.

## F4. Operator upload — `scripts/upload-check.mjs`

21 cases against `POST /api/admin/upload`, weighted toward the size cap and the
key-ownership rule. Found BUG-7 (see [BUGS.md](BUGS.md)).

| Area | Cases | Covers |
|---|---|---|
| Authorization | A1–A2 | 401 without a session, and auth is checked *before* the body is parsed |
| Size cap | C2–C5 | zero, negative, exactly at the cap, and one byte over → 413 (the cap is read from `lib/upload.ts`, so these track it) |
| Feed binding | C1, C6, D2 | bad uuid, unknown feed, and the object key built from the **feed's** supplier rather than anything the client sent |
| Signed URL | D3, D5, D5b, D6 | `content-length` is a signed header (so the cap is enforced by the signature), an expiry is present, addressing is path-style, and each upload gets a distinct key |
| Completion | E1–E3 | path traversal → 400, nothing stored → 409, and a failed completion registers no run |
| Audit | F1 | every init is recorded against the operator |

```
DATABASE_URL=… node scripts/upload-check.mjs
```

## F5. The transfer itself — `scripts/upload-e2e.mjs`

This closes the gap F4 could not: `upload-check` verifies presigning and the
guards around it, but never moved a byte, because no bucket was reachable.
Run against **production on Supabase Storage** — 9/9.

| Check | Observed |
|---|---|
| `init` returns a signed URL | 200, key `feeds/acme/{timestamp}.xml` built from the **feed's** supplier |
| **PUT to the bucket** | succeeds — the first time this path has ever actually run |
| **Same URL, one extra byte** | rejected by storage. The size cap is enforced by the *signature*, not merely present in `SignedHeaders` as F4 could only assert structurally |
| `complete` | registers a run; run detail page renders |
| `complete` on a key with nothing stored | 409, and no run registered |
| Size cap on production | 10 MB → 200, 10 MB + 1 → 413, 11 MB → 413 |
| CORS preflight from the app origin | 200, `allow-origin` present — so the *browser* upload works, not just a server-side PUT |

```
BASE=https://feedxml.vercel.app E2E_USER=admin E2E_PASS=… node scripts/upload-e2e.mjs
```

It leaves a real run behind on purpose — that run is the evidence.

**The uploaded run now executes immediately**, inline in the request, because no
Cloud Run worker is configured and a `pending` run would otherwise never move.
Observed on production, and it is the whole design demonstrating itself in one
request:

| Step | Observed |
|---|---|
| Executed | `attempt=1`, `started_at` set, **took 4s** — no worker, no cron wait |
| Halted | `count_drop 0.5 > 0.2` and `missing_set 1 > 0.05` — the 1-product test snapshot would have deactivated the 2-product catalog |
| Applied | **nothing** — active products still 2 |
| Panel | Consequence Preview offers Approve (*"deactivate 2"*) / Reject, with a Run Issue open |
| Prior pending run | correctly `superseded` by the newer snapshot |

That is the halt-before-apply rule catching a real destructive snapshot, not a
contrived one: a small file uploaded against a bigger catalog is exactly the
truncated-export case the thresholds exist for.

**Still not covered:** a browser-driven upload through the actual file input.
The CORS preflight and the signed PUT are verified independently, which is the
substance of it, but no test drives the `<input type="file">` end to end.

## G. Performance

`.github/workflows/loadtest.yml`, 1M synthetic products through the real pipeline.

| Measure | Observed | Result |
|---|---|---|
| Duration | 305 s | PASS |
| Throughput | 3,276 records/s | PASS |
| Peak RSS | 393 MB — flat, independent of file size | PASS |
| Correctness at scale | 999,800 staged, 200 skipped, all in the catalog | PASS |

Caveat recorded in DESIGN.md: this reads a local file into a local Postgres
with thresholds disabled, so it measures the parsing path only. It is a floor,
not a production baseline; the design target remains 15–30 minutes for 1M.

## H. Not covered, deliberately

| Area | Why |
|---|---|
| Real supplier feed | None exists yet. Every transform and threshold stays provisional until one does — the largest open risk. |
| R2 channels end to end | Needs bucket credentials; `docker compose --profile storage up` provides a MinIO stand-in when wanted. **This gap hid a real bug for five rounds** — see BUG-7 — so it is the most valuable one left to close. |
| Scrape adapter | The reference adapter targets no real site; `runScrape` is exercised only through its guards. |
| Cloud Run execution | The worker is verified locally and in CI; the container image itself is unbuilt. |
| Email delivery | Unconfigured; `notifyOps` logs instead, and the two trigger points are asserted in integration. |
| Browser/device matrix | Single-viewport check only. |

## How to re-run

```bash
npm run dev:setup                 # Postgres + schema
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres npm test
DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres npm run demo -w worker
```

Sections D–F are `curl` checks against a running server; the exact commands are
in this file's git history.
