# From file to catalog

What happens to a 5GB supplier feed between the moment it lands and the moment a
million products are queryable — and, at each step, what stops a bad file from
quietly destroying a good catalog.

The reasoning behind each choice is in [DESIGN.md](DESIGN.md); the words mean
exactly what [CONTEXT.md](CONTEXT.md) says they mean.

| | |
|---|---|
| Feed size | 5 GB |
| Products | ~1,000,000 |
| Freshness target | under 1 hour |
| Measured parse | ~5 min (1M products, lab conditions) |

---

## 1. The file lands in object storage

`supplier → Cloudflare R2 · feeds/{supplier}/{timestamp}.xml`

Four channels deliver feeds, and every one ends at the same place: a single
immutable object in a bucket. Suppliers push through a pre-signed multipart
upload (authenticated with a bcrypt-hashed API key, with the object key chosen
by us, not them); or we pull from their server on a schedule; or — for suppliers
with no feed at all — a crawler produces one. SFTP has a reserved slot and no
code, because no supplier has asked for it.

**Why storage first.** A 5GB body cannot pass through a Vercel function (the
request limit is ~4.5MB). Landing the file in a bucket also makes it the audit
trail and the replay source: every run can be re-run from the exact bytes that
produced it.

**The scraper's contract.** It publishes one complete catalog or nothing. A
partial crawl is indistinguishable from a supplier who discontinued half their
range, so it refuses to publish if it loses more than 2% of product pages.

## 2. A run is registered, exactly once

`Next.js on Vercel · POST /api/feeds/ready`

Whoever uploaded the file reports it; independently, a sweep runs every five
minutes and lists the bucket for anything nobody registered. Both paths call the
same code, and both are safe to call repeatedly: the run row is keyed on the
object key, so the first caller creates it and the second sees it already exists.

The self-report is fast but skippable — a supplier uploading directly has no
reason to call us. The sweep is slow but catches everything. Together they mean
no file is silently ignored.

## 3. A worker streams the file, never holding it

`Cloud Run Job · SAX parser → per-supplier transform`

The app triggers a container job, because a 30-minute streaming parse is exactly
what a serverless function is not. The parser reads in chunks and materializes
only the current record — peak memory measured at 393MB while ingesting a million
products. The next chunk is not pulled until the current record has been written,
so a slow database slows the parse instead of filling memory with a backlog.

Each record passes through that supplier's transform — the only per-supplier
code, around 80 lines — producing a normalized product. XML and NDJSON go through
the same core via pluggable front-ends, so a supplier's transform is written once
regardless of what their channel delivers.

**Bad records don't stop the run.** A malformed record is *skipped*, not fatal:
the product keeps its last known good data, and an issue is recorded with the raw
XML fragment attached.

## 4. Everything lands in staging first

`Postgres · staging_products, scoped by run`

Nothing touches the live catalog yet. Rows are batched into a staging table
scoped to this run, so the whole file can be inspected before a single live
product changes — and a crashed run is cleaned up by deleting its own rows and
starting over.

**Restart-everything.** A failed run re-runs from zero rather than resuming from
a checkpoint. At ~5 minutes of compute that costs pennies, and it avoids the
hardest code in the system: resumable parser state.

## 5. The gate: does this file look like the truth?

`per-feed thresholds → halt, or proceed`

Now the whole snapshot is measurable, so it gets measured. Three questions, with
limits configured per feed:

| Check | Default | What it catches |
|---|---|---|
| Product count drop | > 20% | A truncated export that still parses as valid XML |
| Missing set | > 5% | A snapshot that would deactivate a large slice of the catalog |
| Error rate | > 2% | A feed whose format changed — broken feed, not broken records |

**Breach any of them and the run halts before applying anything.** The old catalog
keeps serving, one email goes to ops, and the panel shows a preview computed from
the staged data by the same predicates the apply uses — *this would deactivate
412,088 products* — so a reviewer approves the actual consequence rather than a
promise. Approving applies everything including deactivations; rejecting discards
the run and keeps the evidence.

If a corrected file arrives while the question is still open, the halted run is
superseded automatically and the question closes itself.

## 6. The merge, then the sweep

`set-based upsert → deactivation of what's genuinely gone`

Staged rows are merged into the live catalog in batches: new products created,
existing ones updated, and any product that had been deactivated returning to
active because the supplier is sending it again. Then the sweep marks as inactive
every product the snapshot did not mention.

**Missing is not the same as skipped.** The sweep only touches products with no
record at all. A product whose record arrived broken is protected — as is one an
admin has pinned after reversing an earlier deactivation, until the supplier sends
it again. Nothing is ever hard-deleted.

## 7. Products are live, and the run closes itself out

`issues resolved · staging retained · catalog serving`

The catalog is current. Issues for products that ingested cleanly this time
resolve themselves, so what remains open is what is still true. The previous
run's staging rows are dropped — the last successful run keeps its own as the
diff source — and the original file stays in the bucket for 180 days, replayable
at any time.

A product whose record has been broken for three consecutive runs stops being
routine and raises an issue of its own: the data has been stale that whole time,
and somebody should tell the supplier.

---

## When it goes wrong

- **The worker dies** — up to three attempts, each starting clean. After the last,
  exactly one email; never a second for the same run unless a human retries it.
- **Two files, one feed** — a newer snapshot supersedes older runs that haven't
  merged yet. A merge already in flight always finishes; it is never interrupted.
- **A worker is replaced** — each execution holds a fencing token. A superseded
  worker cannot merge, cannot halt, and cannot write failure. Elapsed time never
  proves a process is dead.
- **A run freezes** — workers heartbeat every 60 seconds. Silence past a feed's own
  p95 raises an issue, and the run becomes retryable.

## Where it runs, and why

The application runs on Vercel — trigger endpoints, the supplier upload API, and
the admin panel. The *ingestion* does not, and cannot: a multi-gigabyte parse
exceeds any serverless execution window, and "tomorrow's feed may be larger" makes
that ceiling the wrong thing to build against. So the heavy work is a container job
whose only scale knob is running longer, and the catalog lives in Supabase Postgres.
Snapshots live in R2, whose zero egress means the worker streams a 5GB file for free.

**What isn't built, deliberately.** Fan-out parallelism, checkpoint-resume, image
rehosting, cross-supplier product matching. Each has a recorded trigger. Fan-out's
is a feed trending toward the one-hour window — not the current measurement, which
has roughly an order of magnitude of headroom.
