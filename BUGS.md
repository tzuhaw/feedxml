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
