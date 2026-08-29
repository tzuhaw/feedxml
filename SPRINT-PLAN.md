# Feed Ingestion — Sprint Plan

> Derived from [DESIGN.md](DESIGN.md) and [CONTEXT.md](CONTEXT.md) (agreed 2026-08-29).
> Assumes 1–2 engineers, 2-week sprints. Each sprint ends with a runnable demo; nothing waits for a "big bang" integration at the end.
> Scale target throughout: 5GB / 1M products per Snapshot, merge inside the ~1-hour freshness window.

## Guiding sequence

Walking skeleton first (Sprint 1), then correctness (Sprint 2), then resilience (Sprint 3), then humans (Sprint 4), then production (Sprint 5). The admin panel comes *after* the run lifecycle because the panel is a view over the state machine — building it earlier means building it twice.

## Definition of done — every sprint

A sprint is not finished until, in addition to its demo:

1. **`/code-review`** has been run over the sprint's changes, and every confirmed finding is either fixed or explicitly triaged with a reason.
2. **`/security-review`** has been run over the sprint's branch, with the same fix-or-triage rule. Highest-stakes sprints: Sprint 3 (API-key auth, pre-signed URL issuance, upload scoping) and Sprint 4 (admin actions that mutate the live catalog) — findings there block the demo.
3. Fixture/test suite green in CI for both deploy targets.

Run the reviews *before* the sprint demo, not after — a demo on unreviewed code is a rehearsal, not a finish line.

---

## Sprint 1 — Walking skeleton

**Goal:** a fixture XML file dropped in R2 becomes queryable products in Supabase, end to end, happy path only.

- Repo layout: Next.js app + `worker/` (Node/TS, SAX streaming parser) + shared types package; CI for both deploy targets (Vercel, Cloud Run).
- Supabase migrations: `suppliers`, `feeds` (per-feed config incl. thresholds + skip-streak limit), `feed_runs` (state machine enum), `staging_products` (scoped by `run_id`), `products` (identity `(supplier_id, product_code)`, `jsonb` variants/images, GTIN fallback column), `issues` (one entity, Record/Product/Run scope), audit table.
- R2 bucket `feeds/{supplier_id}/{timestamp}.{xml|ndjson}` + 180-day lifecycle rule.
- Cloud Run Job scaffold: reads an object key from env/args, streams from R2, parses via the shared streaming core (file → node events → transform → staging writer), one fixture-supplier transform function with fixture tests.
- Trigger endpoint `POST /api/feeds/ready`: idempotent `feed_runs` insert keyed on object key → kick Cloud Run Job.
- Minimal merge: batched upsert staging → products. No sweep, no validation, no thresholds yet.

**Demo:** upload fixture → run row progresses → products queryable with variants in jsonb (implicit default Variant for variant-less records).
**External action (blocking Sprint 2 fixtures):** chase the supplier for a real sample feed or spec — every week without one raises rework risk on the transform.

## Sprint 2 — Correctness: validation, issues, the sweep

**Goal:** the domain rules from CONTEXT.md are true in code. Broken fixtures produce the right Issues; a truncated fixture halts.

- Record validation → **Skipped** semantics: last-known-good retained, Record Issue with raw fragment + parsed values + reason; seen-set tracking so Skipped ≠ Missing.
- Duplicate Product Code: last-wins + Record Issue.
- Skip streak counter → Product Issue at per-feed limit (default 3).
- Aggregate checks after full staging: count-drop / missing-set / error-rate vs per-feed thresholds → **Halted** state + Run Issue; nothing applied.
- Deactivation Sweep: Missing-only, never Skipped, never Pinned; inactive not deleted; audit rows.
- Auto-reactivation on reappearance; **pin** as side effect of reversing a deactivation (self-clearing on reappearance) — data model + logic (UI comes Sprint 4).
- Issue auto-resolution: Record/Product Issues close on clean ingest of the same product.
- Fixture suite: malformed records, duplicate codes, truncated file, shrunken catalog, reappearing product, pinned-then-reappears.

**Demo:** each fixture produces exactly the Issues and states the glossary predicts.

## Sprint 3 — Resilience: lifecycle, retries, channels

**Goal:** the system survives worker death, overlapping files, and real 5GB scale — and files arrive through real channels.

- Restart-everything retries: truncate-run-staging on start, `maxRetries: 3`, → `failed`; stuck-run detector (>2× historical p95).
- Supersede: same-feed newer Snapshot cancels pre-merge runs (incl. Halted — Run Issue auto-closes as "superseded"); cross-supplier parallelism verified.
- Safety-net cron (5-min R2 listing) alongside self-report — idempotency proven by firing both.
- **Push channel:** per-supplier API key (bcrypt, `supplier_id` + key contract), `POST /api/feeds/upload-url` issuing scoped pre-signed multipart URLs, issuance audit log.
- **Pull channel:** per-feed schedule config; worker streams supplier URL → R2, then normal flow.
- Email notifications (Resend or similar): `awaiting_review` and `failed` only, one email, no reminders.
- Synthetic 5GB/1M load test: measure wall-clock, memory ceiling, staging COPY throughput; record per-run duration metrics from day one.
- Retention jobs: purge prior successful staging after next success; resolved Issues after 90 days.

**Demo:** kill the worker at minute 5 → clean retry; drop two files 30s apart → supersede; 5GB synthetic inside the window.

## Sprint 4 — The admin panel

**Goal:** the small ops team can run the system without touching a database console.

- Issue inbox: one list, filterable by Record / Product / Run scope, evidence view (raw fragment, parsed values, reason), resolution history.
- Run history: all states incl. `failed` (with error) and `superseded`; per-run duration trend.
- Approve/Reject for Halted runs behind a mandatory **Consequence Preview** (creates / updates / deactivations computed from staging).
- Retry failed run; manual re-ingest of any retained R2 file; reverse-deactivation (creating a Pin); standing Pinned count.
- Read-only view of per-feed config (thresholds, schedule, channel, skip-streak limit).
- Spartan-but-functional bar: server components + tables, no design system investment.

**Demo:** ops-team walkthrough of every scenario from Sprint 2's fixture suite, driven entirely from the panel.

## Sprint 5 — Production: scraper, first real supplier, hardening

**Goal:** real supplier data flowing in production.

- Scrape channel: crawler accumulates a complete catalog, writes one NDJSON Snapshot to R2 (producer only — no DB writes); NDJSON front-end for the streaming core (should already exist from the shared-core design — verify, don't assume).
- First real supplier onboarded: transform function against the real feed (or the sample obtained in Sprint 1), fixtures cut from real data, per-feed thresholds tuned with the ops team.
- Runbook: failure playbook (what each email means, what Approve commits you to), replay procedure, supplier-onboarding checklist.
- Production cutover + first supervised live runs; alarms on ingest-duration trend.

**Demo:** live supplier Snapshot → products in production, ops team handling a deliberately-injected halt.

---

## Explicitly out of all sprints (deferred by design)

SFTP bridge · fan-out / checkpoint-resume · image rehost pipeline · variant child tables · mapping DSL · per-feed config editing UI · cross-supplier entity resolution · daily issue digest.

## Risks to watch

1. **No sample feed exists** — the single biggest unknown; every transform/validation assumption is provisional until Sprint 1's chase lands. Mitigation: shared streaming core keeps rework contained to one transform function.
2. **5GB throughput assumption** (~15–30 min sequential) — validated no later than Sprint 3's load test; if it misses, the fan-out slot opens early.
3. **Supabase direct-connection COPY throughput** under merge load — measure in Sprint 3, before the panel work builds on timing assumptions.
4. **Consumer still undesigned** — jsonb-first protects against this, but any consumer decision landing mid-build should be checked against CONTEXT.md vocabulary before it invents its own.
