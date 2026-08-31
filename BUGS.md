# Bugs found by testing, and their fixes

A record of defects the adversarial suite (`scripts/e2e.mjs`) surfaced, what
caused each, and how it was closed. Every entry has a permanent test so it
cannot come back silently.

Method: run the suite three rounds; when a round passes clean, look for what it
does *not* cover, add those cases, and run again. Each expansion found more.

---

## Round 1 — 27/32

### BUG-1 · Information disclosure: panel data served to an unauthorized viewer
**Severity: high.** With authorization enforced in `app/admin/layout.tsx`, the
visible HTML correctly showed a setup notice — but the response *also* carried
the panel's content, including real supplier names, inside the streaming RSC
payload in `<script>` tags.

Cause: Next.js renders layouts and pages **in parallel**. A layout that
withholds `children` does not stop the page from running its queries, and that
output is still serialized into the response. A layout is not a safe place to
enforce authorization.

Fix: `lib/guard.ts` exposes `requireAdmin()`, called as the first `await` in
every admin page, so nothing is fetched before the caller is known. The layout
keeps its check as a second line of defense, and server actions check again.
Tests: `A9`, plus `H1`–`H5` proving authorized rendering still works.

### BUG-2 · Deep links lost their destination
Following `/admin/runs?state=failed` while signed out landed on the overview
after login instead of the requested page. Removing the Edge middleware (which
had carried `?next=`) dropped it.

Fix: a minimal middleware that only redirects when the session cookie is
*absent*, adding `next=`. It performs no verification, so it cannot loop with
the page-level guard. Tests: `E1`, `E3`, `E4`.

### BUG-3 · An authenticated visit to `/` showed the login form again
Reported from the browser: after signing in, returning to the site presented
the sign-in page rather than the panel.

Fix: the login page verifies any existing session and redirects to the panel.
Verified against the database, so an expired or revoked session still lands on
the form. Tests: `E2`, plus `E5` proving `next=` cannot become an open redirect.

---

## Round 2 — 34/37 (after fixes; three harness defects)

Not product bugs, but they made the suite lie:

- `A8` asserted "status ≠ 200", which failed on the legitimate *setup notice*
  page. Rewritten to assert the **panel content** is absent, and split into
  `A8` (one operator revoked, others present) and `A9` (no operators at all).
- `B1`/`B2`/`D1` could not invoke server actions over HTTP, so the login cases
  passed vacuously — they would have passed even with login completely broken.
  A test that cannot fail is worse than no test.

Fix: the suite reads Next's `server-reference-manifest.json` to address real
actions, and login moved to a plain route handler (below).

### CHANGE · Login moved from a server action to `POST /api/session`
Prompted by the harness being unable to reach the action, but justified on its
own: the form now works without JavaScript, and the most security-critical path
in the app is testable over plain HTTP instead of only through React's internal
wire format. It also removed a client component.

---

## Round 4 — 54/57 (after expanding the suite by 12 cases)

### BUG-4 · A body-less POST to the login endpoint returned 500
`req.formData()` throws when there is no body. A malformed request is a client
error, not a server fault, and a 500 invites alerting noise.
Fix: caught, redirected with an error. Test: `G7`.

### BUG-5 · A non-UUID run id returned 500
`/admin/runs/not-a-uuid` reached a `uuid` column and Postgres raised a type
error. A bad link must be a 404.
Fix: the id is validated before the query. Test: `H7`.

### BUG-6 · Rotating the signing key did not end sessions for five minutes
The key was cached for five minutes, so the emergency lever for invalidating
every live session was delayed by that long.
Fix: the cache is gone — it is a primary-key lookup on a one-row table, and
correct revocation is worth more than the saved query. Test: `G8`.

---

## Round 5 — 57/57, three consecutive clean rounds

---

## Round 6 — building the operator upload page

### BUG-7 · Every presigned R2 URL pointed at a host that does not exist
**Severity: high — the whole object-storage layer was inert.** Both S3 clients
(`apps/web/lib/r2.ts` and `worker/src/source.ts`) were constructed with an
endpoint but no addressing mode, so the AWS SDK defaulted to **virtual-host**
style and produced `https://<bucket>.<account>.r2.cloudflarestorage.com/<key>`.
R2 serves the bucket in the **path**, not as a subdomain, so that host does not
resolve.

Why it survived five rounds: presigning is local crypto. Signing succeeds and
hands back a perfectly well-formed URL; nothing fails until something actually
performs the PUT or GET. The suite never had bucket credentials, so no test ever
reached that point — TEST-PLAN.md §H recorded "R2 channels end to end" as
uncovered, and this is exactly the class of bug that gap was hiding.

Found by asserting on the *shape* of the signed URL rather than only on the
status code that returned it.

Fix: `forcePathStyle: true` on both clients, which is what R2 documents and also
what lets the MinIO stand-in work. Test: `D5b` in `scripts/upload-check.mjs`
asserts the bucket is in the path and not in the host.

---

## Round 7 — the safety net was never running

The `sweep` GitHub Actions schedule had failed on **every run since it was
created** — five runs, five failures, none ever green. Two independent faults,
stacked, which is why fixing either alone would not have helped.

### BUG-8 · Absent object storage made the sweep permanently red
**Severity: high — the safety net was inoperative.** Step 1 calls
`listFeedObjectKeys()`, which throws when `R2_*` is unset. The catch marked the
whole response `failed`, so the endpoint returned 500 on every invocation.
Production has no `R2_*` configured, so the sweep could never succeed there.

This is the wrong reading of the situation: DESIGN.md makes object storage
optional, the upload page already treats its absence as a *state* rather than a
fault, and the sweep's other four steps (relaunch, pull scheduling, stuck-run
detection, retention) neither know nor care about a bucket. A monitor that
alarms on every single run is one nobody reads — the alarm had stopped carrying
information.

Fix: skip step 1 when `r2Configured()` is false and report
`discovered: "skipped: object storage not configured"`. Storage that IS
configured but unreachable still fails loudly — that distinction is the point.

### BUG-9 · Failed sweep steps reported `error: ` with no message
Found while fixing BUG-8. AWS SDK network errors are an `AggregateError` whose
`.message` is the empty string, with the real reason on `.code`
(`ECONNREFUSED`). `fail()` read only `err.message`, so a genuinely broken sweep
rendered as `{"discovered":"error: "}` — an alert that says only that something
somewhere went wrong.

Fix: `detail()` falls through message → cause → code → name until something is
actually said.

### The workflow could not report either of them
`curl -fsS` fails with `curl: (22) The requested URL returned error: 401` and
nothing else — it cannot distinguish a secret mismatch from a wrong URL from a
sweep step genuinely failing. The workflow now captures the status and body and
names the cause. Recorded here because the diagnosis took three tool calls that
a one-line error message would have made unnecessary.

Test: `C14` asserts the contract rather than a status code — every step present,
and no step may fail *without saying why*. It passes with storage absent (200)
and with storage broken (500), and fails on a blank `error:`.

### Still outstanding (not a code fix)
The schedule is **401** in production: the `CRON_SECRET` repo secret does not
match the deployment's. That is a credential to re-sync, not a bug — see the
summary in the runbook.

Also observed: GitHub throttles `*/5` schedules hard. Five runs landed in ~10.5
hours (roughly one every two hours), not one every five minutes. The sweep is
idempotent so correctness holds, but "5-minute safety net" overstates it, and
the workflow now says so in a comment.

---

## Round 8 — the merge was planning against statistics that said "empty"

### BUG-10 · Stale planner statistics made the merge superlinear, and bimodal
**Severity: high — it was the scaling ceiling, and it was invisible.**
`applyRun` runs immediately after the staging INSERTs commit. Autovacuum is
asynchronous, so `staging_products` still carried the statistics it had when it
was empty. Every merge statement therefore planned as though it would touch ~0
staging rows and chose nested loops over what was actually tens of thousands.

The symptom was not a constant slowdown. It was a cliff, and the cliff moved:

| records | merge, stale stats | merge, ANALYZE first |
|---|---|---|
| 25,000 | 36.8s – 39.5s | 1.19s – 1.34s |

Measured three reps each on identical input. A ~30x difference from one
statement. It also removed the variance: a 50k snapshot had been swinging
between 3s and 312s run to run, purely on which plan the optimiser happened to
pick.

Why it mattered more than the raw seconds: end-to-end throughput was *falling*
as snapshots grew — 1,274 rec/s at 10k, 579 at 25k, 292 at 50k. A pipeline whose
throughput degrades with size does not scale by any means, and no amount of
fan-out rescues it, because the part that was blowing up is the serial part.
After the fix throughput is flat at ~4,200 rec/s across all three sizes, and the
parallelisable share of a run goes from 5% to 75% at 50k.

Fix: `analyze staging_products` as the first statement in `applyRun`, before any
query plans against those rows. Reproduce with `scripts/bench-phases.mjs`.

Found by measuring the phase split for the fan-out design question, not by any
test — every correctness test passed throughout, because nothing was wrong with
the *answers*, only with how long they took.

### Not a product bug, but worth recording
Two of the new upload checks initially failed on a second run because they
asserted against fixture specifics — a literal supplier name, and a run count of
exactly one — which the adversarial suite legitimately changes. Rewritten to
assert the *rule* (the supplier in the key comes from the feed; a failed
completion adds no runs) rather than the fixture. A test that only passes on a
clean database is a test that will lie later.

## What the suite now covers

| Area | Cases | Weighted toward |
|---|---|---|
| Session forgery | A1–A9 | Tampered, expired, unknown-user and validly-signed-but-revoked tokens |
| Login | B1–B8, G1–G8 | Wrong credentials, case sensitivity, whitespace, bcrypt's 72-byte truncation, empty input, GET, body-less POST, token freshness, key rotation |
| API surface | C1–C13, I1 | Missing and wrong secrets, path traversal, malformed JSON, unknown suppliers, trigger idempotency |
| Server actions | D1–D2 | Unauthenticated invocation of catalog-mutating actions |
| Navigation | E1–E5 | Deep links, redirect loops, open redirects |
| Panel | H1–H7 | Every surface renders; bad ids are 404 not 500 |
| Data invariants | F1–F4 | No product outside its state set, parseable counts, unambiguous feed routing, bcrypt-only passwords |

## Still not covered

Real supplier feeds (none exist), R2 channels end to end (needs bucket
credentials), the scrape adapter against a live site, Cloud Run execution, and
email delivery. Each is recorded in TEST-PLAN.md with the reason.
