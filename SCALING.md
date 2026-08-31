# Scaling: 5GB and 50GB in the same wall-clock

The question this answers: if a 5GB feed costs 100 processing units and a 50GB
feed costs 1,000, why might both finish in roughly the same elapsed time — what
would prevent that, and how would you build for it?

Companion diagrams (use case, flow, structure, for both the system as built and
the sharded version):

- Scaling analysis — <https://claude.ai/code/artifact/7d296749-c0b4-43be-b725-acd9e4469637>
- Six diagrams — <https://claude.ai/code/artifact/39a03359-8d59-4826-9b4c-c027ec168b12>

---

## 1. Why it can be the same

Wall-clock is work ÷ parallelism. A processing unit here is *work*, not time.

A 50GB snapshot is ten times the records, and each record is parsed, validated
and transformed without reference to any other — nothing in that stage needs to
see the whole file. So if the file can be cut into ten pieces and each given to
its own worker, the pieces are processed concurrently and elapsed time is
roughly what one piece takes.

You have spent ten times the compute to buy back the time. **Cost scales with
data; wall-clock does not.** That is the ideal, and everything interesting is in
the gap between it and what actually happens.

## 2. What this system does today

It deliberately does not fan out. Decision 3 in [DESIGN.md](DESIGN.md) is a
single sequential streaming worker, and §3 says it plainly: *"the only scale
knob is runs longer; fan-out parallelism is a future optimization."*

So today, ten times the data is ten times the wall-clock. The rest of this
document is what measuring that assumption turned up.

## 3. What the measurement said

`scripts/bench-phases.mjs` separates the three phases: parse and transform with
no database in the path, the same work writing to Postgres, and the
staging → products merge on its own. Three sizes, three repetitions each, every
size merging into an identically empty catalog.

**Before** — as the pipeline shipped:

| Records | Size | Parse | DB write | Merge | Merge range | Total | Throughput | Parallelisable |
|---|---|---|---|---|---|---|---|---|
| 10,000 | 33 MB | 708 ms | 819 ms | 6,318 ms | 6.3–6.7 s | 7.8 s | 1,274/s | 19% |
| 25,000 | 83 MB | 1,506 ms | 2,595 ms | 39,048 ms | 1.4–41.6 s | 43.1 s | 579/s | 10% |
| 50,000 | 167 MB | 4,011 ms | 4,618 ms | 162,317 ms | 3.0–311.6 s | 170.9 s | 292/s | 5% |

Two things are wrong, and the second is worse.

**Throughput falls as snapshots grow** — 1,274 → 579 → 292 records per second.
That is superlinear cost. A pipeline shaped like this does not scale by *any*
mechanism; more workers cannot fix a phase whose cost grows faster than its
input.

**The merge was bimodal.** Identical input, same machine, same starting state:
3.0 s on one run and 311.6 s on the next. A hundredfold swing is not load noise.

### Root cause — BUG-10

`applyRun` executes milliseconds after the staging inserts commit. Autovacuum is
asynchronous and had not been near the table, so `staging_products` still
carried the statistics it had when it was **empty**. Every merge statement
planned for ~0 staging rows and chose nested loops over tens of thousands.

One statement — `analyze staging_products` before the merge — on identical
input, three reps each:

| | Merge time |
|---|---|
| stale statistics | 36.8 – 39.5 s |
| `ANALYZE` first | 1.19 – 1.34 s |

A ~30× difference, and the variance disappears with it. Fixed in
`packages/domain/src/apply.ts`; recorded in [BUGS.md](BUGS.md) as BUG-10.

**After** — one added statement:

| Records | Size | Parse | DB write | Merge | Merge range | Total | Throughput | Parallelisable |
|---|---|---|---|---|---|---|---|---|
| 10,000 | 33 MB | 586 ms | 1,052 ms | 791 ms | 0.76–0.95 s | 2.4 s | 4,117/s | 67% |
| 25,000 | 83 MB | 1,499 ms | 2,260 ms | 2,183 ms | 1.9–3.0 s | 5.9 s | 4,207/s | 63% |
| 50,000 | 167 MB | 4,081 ms | 4,540 ms | 2,888 ms | 2.7–3.0 s | 11.5 s | 4,344/s | 75% |

Throughput going from *falling with size* to *flat* is the whole point. The
first shape cannot be rescued by adding workers; the second can.

**This is the part worth keeping.** Before touching the architecture, the
parallelisable share of a 50k run was 5%. Fan-out at any worker count would have
bought almost nothing, and a fan-out project would have been judged a failure
for reasons that had nothing to do with fan-out.

## 4. What fan-out actually buys — measured, not predicted

Amdahl at 75% parallel *predicts* this:

| Workers | Predicted speed-up |
|---|---|
| 1 | 1.0× |
| 4 | 2.3× |
| 10 | 3.1× |
| ∞ | 4.0× |

An earlier version of this document stopped there, and flagged the untested
assumption underneath it: Amdahl assumes the parallel phase *is* parallel. That
assumption has now been tested with a real sharded worker
(`scripts/bench-shards.mjs`, `scripts/shard-worker.mjs`) — a split pass that
locates record boundaries, N child processes each ingesting its own byte range,
all writing to **one** Postgres.

| shards | stage ms | speed-up | efficiency | staged | shard skew |
|---|---|---|---|---|---|
| 1 | 9,987 | 1.00× | 100% | 50,000 | 1.00× |
| 2 | 7,126 | 1.40× | 70% | 50,000 | 1.01× |
| 4 | 5,941 | 1.68× | 42% | 50,000 | 1.03× |
| 8 | **3,826** | **2.61×** | 33% | 50,000 | 1.04× |
| 12 | 4,042 | 2.47× | 21% | 50,000 | 1.13× |
| 16 | 5,131 | 1.95× | 12% | 50,000 | 1.24× |

**It peaks at 8 shards and then goes backwards.** N=16 is slower than N=8 — a
shape Amdahl does not predict, because Amdahl has no term for contention. The
curve reproduced across three independent sweeps: N=8 consistently 3.8–4.1 s,
N=16 consistently no better and usually worse.

Two things are worth more than the numbers:

- **Correctness held at every N.** Exactly 50,000 rows staged whether the file
  was read by one worker or sixteen. Sharding XML at record boundaries does not
  drop or duplicate records — asserted on every run, so a boundary bug would
  surface as a wrong count rather than a plausible-looking speed-up.
- **The split pass is nearly free.** 138 ms to locate 50,000 record offsets in a
  167 MB file, against ~4,000 ms for a full parse — about **29× cheaper**, not
  the ~10× this document previously guessed. The price XML charges for being
  splittable is small.

### Where the ceiling comes from

Sampling `pg_stat_activity` during a 16-shard run, client backends only, with
autovacuum settled first:

| wait | share |
|---|---|
| (running) / cpu | 81.1% |
| Client / ClientRead | 4.7% |
| IO / WALSync | 4.3% |
| **Lock / extend** | 4.1% |
| LWLock / WALWrite | 3.2% |

Backends are **CPU-saturated, not blocked**. `Lock / extend` is the interesting
one: every shard is appending to the same `staging_products` relation, so they
serialise on extending its file. That is the textbook many-writers-one-table
bottleneck, and it is the direct argument for **per-shard staging partitions** —
separate relations mean no shared extend lock.

**An important limit on this experiment:** workers and Postgres share one
machine here, so 16 parser processes plus 16 database backends oversubscribe 20
cores. Some of the measured ceiling is that co-location, not Postgres. On
separated compute the knee should move right — but the extend and WAL contention
is the durable part and will still bound it.

**Ten workers buy about 2.5×, not 10× and not the predicted 3.1×.** Constant
wall-clock at 10× data therefore needs the serial part to shrink too, not just
the parallel part to widen.

- **The merge is one writer.** Staging → products is a set-based statement whose
  cost tracks row count, not worker count. The fix is to make it *smaller*:
  partition `products` by `supplier_id` so different suppliers never contend.
  Within one supplier it stays serial. That is the floor.
- **The database is a shared bottleneck — measured above.** N workers writing to
  one instance contend on relation extension and WAL. Postgres does not get 10×
  faster because you added 10 clients, and past its ceiling more workers make
  runs *slower*: N=16 was worse than N=8, reproducibly.
- **XML does not split.** NDJSON cuts at any newline; XML is a nested tree, so
  byte offset *N* lands mid-element with no way to know the enclosing context.
  Sharding XML needs a boundary pass that scans for record-start offsets without
  parsing — or a supplier willing to send NDJSON. The pluggable front-ends
  (decision 25) already make the second option cheap. Measured cost of that pass:
  138 ms for 167 MB, ~29× cheaper than parsing.
- **Skew.** Elapsed time is the slowest shard, not the average. Splitting by
  record count (not bytes) kept skew at 1.01–1.04× up to 8 shards; it only grew
  to 1.24× at 16, where shards are small enough for startup and contention to
  dominate. Skew is not what limits this — contention is.
- **Read bandwidth and egress.** Every shard pulls from the same bucket. 50GB per
  run, re-pulled on every retry, is a real bill on a metered provider — this is
  where the zero-egress argument for R2 earns its keep (see decision 6).
- **Cost and failure surface.** Same elapsed time, ten times the compute-seconds.
  Ten workers is also ten chances to fail, so each shard needs its own idempotent
  retry and its own fencing token.

## 5. How it would be built

Five phases, with the barrier and the serial tail explicit:

1. **Split.** One sequential scan producing record-start byte offsets — no
   parsing, no transform, so roughly an order of magnitude cheaper than a full
   pass. Shard count from file size, capped. NDJSON skips this entirely.
2. **Map.** N workers, each streaming its own byte range into its own staging
   partition. `COPY` rather than the current 500-row multi-row `INSERT` — the
   DB-write phase is ~40% of a run now, and `COPY` is typically several times
   faster.
3. **Barrier.** Thresholds need global counts; you cannot know what is missing
   until every shard has reported.
4. **Validate.** Unchanged — this is where a bad snapshot halts before touching
   the catalog.
5. **Merge.** Serial, single writer, `ANALYZE`d first, partitioned by supplier so
   concurrent suppliers do not contend.

Per-shard fencing tokens extend the mechanism already in place for whole runs
(decision 28), so a retried shard replaces only its own rows. Staging
partitioned by shard means a failed shard re-runs without disturbing siblings.

## 6. Server spec requirements

Current deployment verified from the Vercel and Supabase APIs, not assumed. The
production database is currently 11 MB.

| Constraint | Current | 5GB / 1M products | 50GB / 10M products |
|---|---|---|---|
| Database size | **500 MB cap** (Supabase free — read-only beyond) | ~4–5 GB peak (catalog + staging) | ~40–50 GB peak |
| Postgres compute | shared, free tier | 4 vCPU / 16 GB, gp3 | 8–16 vCPU / 32–64 GB, provisioned IOPS |
| Ingest worker | **none deployed**; uploads ≤10 MB run inline | 1 job · 2 vCPU / 2 GB · 60 min | 8–16 shards · 2 vCPU / 2 GB each |
| Worker memory | 393 MB measured, flat | 2 GB (6× headroom) | 2 GB per shard — streaming keeps it flat |
| Object storage | Supabase Storage, 1 GB free | ~50 GB with 180-day retention | ~500 GB + lifecycle rules |
| Egress | **5 GB/month** free | 5 GB *per run* — zero-egress store needed | 50 GB per run |
| Vercel functions | Hobby, 300 s max | unchanged — control plane only | unchanged |

**The binding constraint is storage, not compute.** Supabase's free plan puts a
project into read-only mode above 500 MB of database. At the 2,164 bytes per
product measured in production, that is roughly 240,000 products — and a 5GB
feed is a million. The current deployment is about 10× short of the *smaller*
target before any conversation about workers.

## 7. How much to trust these numbers

Measured on Docker Postgres 17 on Windows, single machine, local disk — not
production hardware. Absolute figures are a floor, and the environment is
demonstrably noisy: an early single-sample run produced a non-monotonic curve
that was entirely artefact, which is why everything here is three reps with the
range shown.

**Trustworthy:** the before/after ratios and the phase split. Identical inputs,
same machine, minutes apart, and the 30× `ANALYZE` effect reproduced on every
repetition. Independent support from CI, where 1M products through the same
pipeline took 305 s at 3,276 rec/s with 393 MB peak RSS — the same order as the
4,344 rec/s measured here.

**Now known, and it was worse than predicted.** The sharded worker in §4 was
built and measured: the parallel phase saturates at ~8 shards on this hardware
and degrades beyond it. The earlier projection of 3.1× at 10 workers was
optimistic, exactly as suspected.

**Still not known:** where the knee sits when workers and Postgres are on
separate machines. This experiment co-locates them, so CPU oversubscription is
mixed into the measured ceiling. The wait profile says the durable limits are
relation extension and WAL, not CPU — so the knee should move right on split
hardware, but not indefinitely.

Projections assume the design's own figures (5GB ≈ 1M products) and linear
extrapolation of measured throughput. Real feeds are not synthetic ones.

## Reproducing

```bash
node worker/dist/genfeed.js 50000 /tmp/f50k.xml 0
BENCH_DB=postgres://postgres:postgres@localhost:55432/postgres \
  REPS=3 node scripts/bench-phases.mjs /tmp/f50k.xml
```
