# Feed Ingestion System — Design

> E-commerce product-feed ingestion: Next.js on Vercel + Supabase, worker on Cloud Run, files in Cloudflare R2.
> Feeds today: ~5GB XML, ~1M products, full snapshots. Designed to scale by "running longer," multi-supplier from day one.
>
> Status: **agreed design** (architecture grilling + domain-modeling sessions, 2026-08-29). Canonical vocabulary lives in [CONTEXT.md](CONTEXT.md).

## The one-sentence architecture

Every channel delivers a complete snapshot file into one R2 bucket; an idempotent trigger records a run and starts a Cloud Run Job that streams the file into a Supabase staging table, validates it under per-feed thresholds, and — if it passes — merges it into production in batches, with every anomaly and action surfaced in an admin panel.

> Vocabulary note: this document uses the canonical terms defined in [CONTEXT.md](CONTEXT.md) — Feed (standing arrangement), Snapshot (one delivered file), Run (one ingestion attempt), Missing vs Skipped, Pinned, Issue (Record/Product/Run scope).

## 1. Arrival — four channels, one convergence point

- **Push (A):** supplier calls `POST /api/feeds/upload-url` on the Vercel app with their `supplier_id` + API key (bcrypt-compared against the `suppliers` row; the two-credential contract is required because bcrypt hashes can't be looked up by value). The app returns a pre-signed R2 multipart URL scoped to `feeds/{supplier}/`; the 5GB file goes straight to R2, never through Vercel (request body limit ~4.5MB).
- **Pull (B):** Vercel cron fires a lightweight trigger; the actual multi-minute download streams inside the Cloud Run worker (supplier server → R2), not in a Vercel function.
- **SFTP (C):** **reserved slot, not built.** When a real SFTP supplier appears: SFTPGo bridge (container/VM) writing to R2 via its S3 API — ~2–3 days of work, purely additive because all channels converge on "file in bucket."
- **Scrape (D):** the scrape job crawls the supplier's site, accumulates a **complete** catalog, and writes one NDJSON file to the same bucket. It is a feed *producer*, not a second ingestion path — no crawl-in-progress writes to the database, ever.

Bucket layout: `feeds/{supplier}/{timestamp}.{xml|ndjson}` (supplier = `suppliers.name`; the extension names the Snapshot format and disambiguates same-supplier feeds of different formats) — immutable audit trail and replay source.

## 2. Trigger — hybrid, idempotent

- Channels we control call `POST /api/feeds/ready` on upload completion (instant path).
- A 5-minute Vercel cron lists the bucket as a safety net — covers supplier-direct uploads and any missed self-report.
- Both paths converge on one operation: insert into `feed_runs` keyed on the R2 object key — first caller wins, the second sees the row and no-ops — then kick the Cloud Run Job.
- The trigger endpoint does nothing else; all intelligence lives in the worker.

## 3. The worker — one Cloud Run Job, sequential, boring on purpose

Streams the file from R2 (zero egress) through a shared streaming core:

```
file → node events → per-supplier transform → validation → staging writer
```

- Each supplier contributes only a ~50–100-line transform function (node → normalized record) behind a common interface, with fixture tests. XML and NDJSON are different front-ends to the same core.
- No mapping DSL until repetition across many supplier transforms earns it (zero sample feeds exist today — a DSL now would be invented requirements).
- Target: 5GB / 1M products in ~15–30 minutes, inside the ~1-hour freshness expectation ("reasonably fresh"; no business event gates ingestion).
- The only scale knob is "runs longer" (Cloud Run Jobs allow up to 24h). Fan-out parallelism is a future optimization behind the same interface — revisit together with checkpoint/resume when full-rerun stops fitting the window.

## 4. Staging, validation, and the tiered issue model

- Rows land in `staging_products`, scoped by `run_id` — never production directly.
- **Identity:** `(supplier_id, product_code)` — "SKU" is reserved for Variants (see CONTEXT.md). GTIN/EAN captured per-variant in the jsonb (product-level GTIN column only as fallback), for a future cross-supplier matching layer (entity resolution is explicitly *not* ingestion's job).
- **Shape:** nested. Variants and images ride in `jsonb` on the product row; promote to child tables only when a real query needs relational variants (consumer isn't fully designed yet). A product with no declared variants gets one implicit default Variant. Each image is an object `{source_url, cdn_url: null, fetched_at: null}` so the async rehost pipeline bolts on later without a migration.
- **Images:** store supplier URLs in v1; serve from supplier origin. Rehost pipeline (R2 + CDN) is deferred until a real problem (hotlink block, page-speed) demands it.
- **Duplicate Product Code within one Snapshot:** last occurrence wins; earlier occurrences logged as data issues.

Aggregate checks run after the file is fully staged, under **per-feed configurable thresholds** (config attaches to the Feed, not the Supplier — a `feeds` table referencing `suppliers`, seeded by migration; the panel displays but does not edit config in v1):

| Defect scope | Example | Action |
|---|---|---|
| Record | bad price, missing Product Code, unparseable fragment | **Skip** the record: product retains last known good state and stays active; Record Issue written with raw fragment, parsed values, reason |
| Product | Skip streak — same product Skipped 3 consecutive Runs (per-feed config) | Product Issue raised for review |
| Run | product count drop >20%, missing-set >5% of catalog, error rate >2% (defaults; per feed) | **Halt before applying anything**; Run Issue raised: approve/reject in the panel |

**Missing ≠ Skipped.** Missing = no record at all in the Snapshot (the only condition the sweep acts on). Skipped = record present but invalid (kept alive on last known good state). All Issues live in one entity with a scope field; Record and Product Issues **auto-resolve** when the product ingests cleanly in a later Run, Run Issues resolve only by verdict (Approve / Reject / Superseded).

## 5. Merge — set-based, batched, then the sweep

On pass (or admin approval of a halted run):

1. Batched `INSERT … ON CONFLICT UPDATE` from staging into `products`. A previously-inactive product reappearing in the Snapshot **auto-reactivates** (ordinary merge behavior, audit row, no human approval).
2. Deactivation Sweep: **Missing** products (no record at all — never Skipped, never Pinned ones) → `inactive`. **Never hard-delete.**
3. Every automatic action writes an audit row, reversible from the panel.

Reversing a deactivation **pins** the product: the sweep exempts it until it reappears in a Snapshot, at which point the pin clears itself. Pins exist only as this side effect (no standalone pin action) and show as a standing count in the panel. The domain rule: *the Snapshot is the source of truth; a pin is a deliberate, visible, self-expiring human exception.*

A few seconds of mixed state during merge batches is accepted; the old catalog serves until the merge starts.

## 6. Run lifecycle — one state machine, two consumers

```
pending → downloading → staging → validating → [awaiting_review] → merging → done | failed | superseded
```

The same `feed_runs` rows drive orchestration and the panel's run history.

- **Failure:** restart-everything (truncate this run's staging, re-run), `maxRetries: 3`, then mark `failed` and email the ops team. Merge-phase failures also restart-everything in v1 (resume-the-merge deferred).
- **Stuck-run detector:** anything in `staging` beyond ~2× historical p95 duration gets flagged in the panel rather than holding the queue as a zombie.
- **Same-supplier collision:** a newer file **supersedes** the in-flight run — cancel only before merge starts; once merging, finish, then run the newer file. Superseded runs are visible in the panel. Supersession applies to **Halted** runs too: a corrected Snapshot auto-closes the halted run's Run Issue as "superseded" (evidence retained).
- **Cross-supplier:** fully parallel; isolated by `run_id` / `supplier_id`; no shared state except Supabase capacity.

## 7. Admin panel + notifications

Lives in the Next.js app. Small ops team; functional-but-spartan is the bar.

Capabilities:
- Issue inbox (one list, filterable by Record / Product / Run scope) with evidence (raw fragment + parsed values + reason)
- Approve/reject halted runs — **Approve applies everything including the sweep**, behind a mandatory Consequence Preview (creates / updates / deactivations computed from staging); Reject discards the run. Partial applies don't exist — the escape hatch is approve, then reverse-and-pin.
- Run history, including `failed` (with error) and `superseded`
- Retry a failed run
- Reverse auto-deactivations
- Manual re-ingest of any retained R2 file (invaluable during supplier onboarding)

Notifications: email (e.g. Resend) on exactly two events — `awaiting_review` and `failed`. One email per event, no reminders. Never on success (success-spam trains people to ignore the address). Daily digest of open issues: later, if volume warrants.

## 8. Retention

| Data | Policy |
|---|---|
| Raw feed files (R2) | 180-day lifecycle rule (no compliance driver identified) |
| Staging rows | Keep only the last **successful** run per supplier (purged when the next succeeds); failed/halted runs keep staging as evidence until resolved |
| Run ledger | Forever |
| Resolved issues | Purge after 90 days |

## Deferred by design (slots reserved, zero build today)

- SFTP bridge
- Fan-out parallelism / checkpoint-resume
- Image rehost pipeline
- Variant/image child tables (promote from jsonb on demand)
- Mapping DSL
- Per-supplier config editing UI
- Cross-supplier entity resolution

## Standing assumptions (flagged, not explicitly ruled on)

- Worker in Node/TS (shares types with the app) using a SAX-style streaming parser
- Staging loads via Postgres `COPY` / batched inserts over a direct connection (not the pooler)
- Admin panel inside the existing Next.js app
- Scraper cadence/politeness is its own design, out of this document's scope

## Decision log

| # | Decision | Choice |
|---|---|---|
| 1 | Arrival channels | Push (pre-signed) + Pull + SFTP (stub) + Scrape |
| 1b | Scraper output | Writes one complete NDJSON feed file; single pipeline |
| 2 | Feed semantics | Full snapshot; tiered issue handling; thresholds per supplier |
| 3 | Freshness | Within the hour; single sequential streaming worker |
| 4 | Mid-ingest visibility | Staging table + set-based merge; seconds of mixed state OK |
| 5 | Compute | Cloud Run Jobs |
| 6 | Object storage | Cloudflare R2 (zero egress) |
| 7 | Trigger | Hybrid self-report + safety-net cron; idempotent via `feed_runs` |
| 8 | Identity & shape | `(supplier_id, product_code)` + per-variant GTIN captured; nested records |
| 9 | Variant storage | jsonb now, promote to child tables later |
| 10 | Images | URLs now as structured objects; async rehost later |
| 11 | Run overlap | Supersede same-supplier; parallel cross-supplier; visible in panel |
| 12 | Failure | Restart-everything, max 3 retries, then escalate to human |
| 13 | Panel & alerts | Full capability list; config-in-code; email on review/fail only |
| 14 | SFTP timing | Stub until a real supplier needs it |
| 15 | Supplier auth | Per-supplier API key, bcrypt-hashed |
| 16 | Retention | R2 180d / staging last-success / ledger forever / issues 90d |
| 17 | Parser strategy | Shared streaming core + per-supplier transform functions |
| 18 | Missing vs Skipped | Sweep acts only on Missing (no record at all); Skipped keeps last known good; skip streak of 3 (per-feed config) raises a Product Issue |
| 19 | Admin override | Reversing a deactivation pins the product (sweep-exempt, self-clearing on reappearance); pin is side-effect-only; reappearing products auto-reactivate |
| 20 | Approving a halted run | Approve = full apply including sweep, behind a mandatory Consequence Preview; Reject = discard; one email, no reminders |
| 21 | Supersede vs Halted | A newer Snapshot supersedes a Halted run; its Run Issue auto-closes as "superseded" |
| 22 | Identity vocabulary | "SKU" reserved for Variants; parents identified by Product Code; per-variant GTIN; variant-less products get an implicit default Variant |
| 23 | Feed as arrangement | Feed = supplier + channel + format + schedule; all thresholds/config attach to Feed (a `feeds` table), not Supplier |
| 24 | Issue taxonomy | One Issue entity with Record/Product/Run scope; Record and Product Issues auto-resolve on clean ingest; Run Issues resolve only by verdict |
