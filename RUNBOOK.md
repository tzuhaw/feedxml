# feedxml — Operations Runbook

For the ops team. Vocabulary is [CONTEXT.md](CONTEXT.md); the reasoning behind
every rule is [DESIGN.md](DESIGN.md).

The one thing to internalise: **the system never destroys catalog data on its
own.** Products go inactive, never deleted. Anything it is unsure about it
halts and asks you. Your job is to answer those questions well.

---

## 1. You got an email

There are exactly two, ever. Nothing else emails you.

### "snapshot needs review"

A Snapshot arrived, staged cleanly, and then tripped one of the Feed's
thresholds. **Nothing has been applied.** The old catalog is still serving.

1. Open the run from the link (or Admin → Overview → Needs attention).
2. Read the **Consequence Preview**. It is computed from the staged data by the
   same predicates the apply uses, so it is exactly what will happen.
3. Decide:
   - The shrinkage is **real** (supplier discontinued a range, seasonal
     clear-out) → **Approve**. Everything applies, including deactivations.
   - The shrinkage is **wrong** (truncated export, supplier bug) → **Reject**,
     then contact the supplier. Rejecting discards the run and keeps the staged
     evidence.
   - **Not sure?** Do nothing yet. A halted run costs you stale data, not
     wrong data. Ask the supplier whether they intended it.

Two things that decide themselves, so don't wait on them:
- If a corrected Snapshot arrives before you act, the halted run is
  **superseded** automatically and its question closes. Nothing to clean up.
- If the preview shows **0 created and 0 updated**, the panel says so loudly:
  the file staged nothing usable. That is a broken export, not a catalog
  change. Reject it.

### "run failed after N attempts"

Infrastructure, not data: the worker crashed, the download failed, the database
was unreachable. It already retried up to `MAX_ATTEMPTS` (default 3).

1. Open the run; the error is on the page.
2. Transient (timeout, connection reset)? → **Retry this run**.
3. Persistent? Check, in order: is the object still in R2; is the database
   reachable; did the supplier serve something that isn't a feed (an HTML error
   page saved as `.xml` is the classic). Then Retry.
4. Still failing after a retry → escalate to engineering with the run id.

---

## 2. The panel, by page

| Page | What it is for |
|---|---|
| **Overview** | Start here. Runs needing attention, open issues by scope, feed health. |
| **Runs** | Full history, filterable by state. Duration trend for the last 20 successful runs. |
| **Run detail** | Preview, verdicts, retry, re-ingest, and this run's issues with evidence. |
| **Issues** | The inbox. Filter by scope; resolved are hidden by default. |
| **Products** | Deactivated and pinned products; where you reverse a sweep decision. |
| **Feeds** | Read-only per-feed config. Changing it means a migration. |

### The three Issue scopes

- **Record** — one record in one Snapshot failed validation. The product keeps
  its last known good state and stays live. Usually nothing to do: it resolves
  itself when that product ingests cleanly. Chase the supplier if the same
  products keep appearing.
- **Product** — the same product has been Skipped for N consecutive runs (per
  feed, default 3). The data has been stale that whole time. Worth chasing.
- **Run** — a Snapshot needs a verdict. **These never resolve by hand** — the
  panel won't let you. They close when you Approve or Reject, or when a newer
  Snapshot supersedes the run. A Run Issue sitting open means a feed is frozen.

### Reversing a deactivation

Products → find it → **reactivate & pin**. The pin exempts it from the sweep
until the supplier sends it again, at which point the pin clears itself. Check
the pinned list occasionally: a pin that never clears means the supplier has
genuinely stopped selling that product, and it should be allowed to go inactive.

---

## 3. Replaying a Snapshot

Every Snapshot is kept in R2 for 180 days, so any run can be replayed.

- **Retry** re-executes the *same* run. Use it after an infrastructure failure.
  Only available for `failed` runs — a `rejected` run is a human decision and
  cannot be retried.
- **Re-ingest** creates a *new* run over the same file. Use it after fixing a
  transform or thresholds, or to revive a run that is too old to retry. It
  supersedes older pending and halted runs of that feed, like any new Snapshot.

Both are on the run detail page.

---

## 4. Onboarding a supplier

1. **Get a real sample feed first.** Everything below is guesswork without one.
2. `DATABASE_URL=… node worker/dist/keygen.js <supplier-name>` — names must be
   lowercase `a–z 0–9 - _` (they become bucket paths; the database enforces it).
   The API key prints **once**; give it to the supplier over a secure channel.
3. Insert the `feeds` row (migration): channel, format, thresholds,
   `skip_streak_limit`; for `pull`, also `source_url` and `schedule_minutes`.
4. Write the transform: `worker/src/transforms/<supplier>.ts`, register it in
   `registry.ts`, and cut fixtures from the real sample. One transform serves
   every format that supplier uses — XML and NDJSON converge on the same shape.
5. Start thresholds **loose**, watch a week of real runs, then tighten. Feeds
   halt on the difference between snapshots, so you need a baseline first.
6. Tell the supplier how to send:
   - **Push**: `POST /api/feeds/upload-url` with `x-supplier-id` and
     `x-api-key`; `init` → `sign-part` per part → `complete`. Object keys are
     ours, not theirs.
   - **Pull**: they host it; we fetch on the schedule.
   - **Scrape**: no supplier action; see §4.1.

### 4.1 The scrape channel

A scrape runs as a **second Cloud Run job** on the same image, overriding the
command:

```
node worker/dist/scrape-cli.js
```

Environment: `SCRAPE_ADAPTER` (the adapter key), whatever that adapter needs
(the reference one takes `SCRAPE_BASE_URL`), `SCRAPE_USER_AGENT`, the `R2_*`
variables, and — to skip the discovery wait — `TRIGGER_URL` plus
`INTERNAL_TRIGGER_SECRET`. No `DATABASE_URL`: the scraper never touches the
catalog database.

Writing an adapter (`worker/src/scrapers/`): yield every product URL, parse a
page into plain JSON whose keys mirror that supplier's XML element names (so
one transform serves both channels), and **set `minimumProducts` from the real
catalog size**. That floor is the safeguard: a crawl that ends early because
the site's pagination markup changed publishes nothing rather than asserting a
2%-sized catalog is complete. Register the adapter in `scrape-cli.ts`, and
register the supplier's transform in `registry.ts` — `runScrape` refuses to
start without one, so you find out in seconds instead of after a long crawl.

**The scrape blind spot.** If a crawl aborts or falls under its floor, nothing
is published — so there is no run, no Issue, and **no email** (the two emails
only ever come from runs). A scrape supplier's catalog can therefore go stale
silently. Until a "feed produced nothing in N hours" detector exists, watch the
scrape job's own history in the scheduler, and check Admin → Feeds for a
`Last run` that has stopped advancing.

**Sizing.** The crawl is serial and polite by design: at a 1.5s delay, 100k
products is over a day of wall-clock, past Cloud Run's 24h task ceiling, and
resume is deliberately not built. Keep scrape suppliers small, or shard the
adapter by category into several jobs. The Snapshot is buffered to `os.tmpdir()`,
which on Cloud Run is memory-backed — budget roughly 1KB per product against
the job's memory limit.

---

## 5. When something looks stuck

- **A run sits in `staging`/`merging` for ages** — the sweep raises a Run Issue
  once that run has made no progress for `max(30 min, 2× that feed's own recent
  p95)`. Nothing retries it automatically: a killed worker leaves a run nothing
  will ever move again, and for a pull feed that also blocks all future
  scheduling. Check the Cloud Run logs for the run id, then use **Retry** on
  the run — in-flight runs become retryable once stuck for 30 minutes, and
  retrying closes the stuck Issue. Retrying is safe: it restarts the run from
  scratch (restart-everything).
- **No runs at all for a feed** — check Admin → Feeds (`active`?), then that
  the sweep is running (GitHub Actions → sweep workflow), then that
  `CLOUD_RUN_JOB_URL` is set. The sweep relaunches runs stuck in `pending`.
- **The sweep workflow is red** — it returns 500 when any step fails; the body
  names the step. Steps are independent, so the others still ran.
- **Ingestion is slow** — the design target is **15–30 minutes for 1M
  products**, and the freshness SLA is one hour. Judge against *that*, not
  against the lab number: the load test ingests 1M products in ~5 minutes, but
  it reads a local file into a local Postgres with validation thresholds
  disabled, so it excludes object-storage streaming and the remote database
  round trips that dominate production. Treat it as a floor for the parsing
  path, not a production baseline. The signal to revisit fan-out is a feed
  trending toward the one-hour window, not a gap from 5 minutes.
  (The Runs page's duration figure is a global average across feeds, so
  compare a feed against its own history rather than that number.)

---

## 6. Deliberately not built

Don't wait for these; they are choices, not gaps. SFTP channel · fan-out
parallelism · checkpoint/resume · image rehosting · variant child tables ·
mapping DSL · config editing in the UI · cross-supplier product matching ·
daily issue digest. Each has a trigger recorded in DESIGN.md.
