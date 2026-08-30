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
| E6 | Sweep, correct secret | 500 with per-step detail — R2 unconfigured locally, other four steps ran | PASS (by design: steps are independent, any failure alerts) |
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
| F8 | Panel loads live data | **BLOCKED** — `DATABASE_URL` uses Supabase's direct host, which is IPv6-only and unreachable from Vercel. Needs the transaction pooler string. | BLOCKED |

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

## F3. Adversarial suite — `scripts/e2e.mjs`

57 cases, weighted toward what must NOT work. Method: run three rounds; when a
round is clean, look for what it fails to cover, add those cases, run again.
Six product bugs found this way — see [BUGS.md](BUGS.md).

| Run | Result |
|---|---|
| Rounds 1–3 (local, current code) | **57/57, 57/57, 57/57** |
| Production | Blocked — see F8 |

```
BASE=http://localhost:3130 DATABASE_URL=… node scripts/e2e.mjs 3
```

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
| R2 channels end to end | Needs bucket credentials; `docker compose --profile storage up` provides a MinIO stand-in when wanted. |
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
