# feedxml — product-feed ingestion

Ingests complete product-catalog Snapshots from supplier Feeds into Supabase, per [DESIGN.md](DESIGN.md).
Canonical vocabulary: [CONTEXT.md](CONTEXT.md). Delivery plan: [SPRINT-PLAN.md](SPRINT-PLAN.md).

## Layout

- `apps/web` — Next.js app on Vercel: trigger endpoints, later the admin panel
- `worker` — Cloud Run Job: streams a Snapshot from storage into staging, validates, merges
- `packages/shared` — domain types shared by both
- `supabase/migrations` — database schema
- `fixtures` — sample Snapshots used by tests and local demos

## Running it

Everything below runs locally. No cloud account is needed.

```bash
npm install
npm run dev:setup    # Postgres in Docker + build libs + apply migrations
```

Then watch a Snapshot go through the whole pipeline — it deliberately halts on
a bad fixture, shows the Consequence Preview, approves it, and prints the
resulting catalog:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres npm run demo -w worker
```

The full suite, including 25 integration scenarios against real Postgres:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres npm test
```

For the admin panel, copy `.env.example` to `apps/web/.env.local` and set
`DATABASE_URL`, `ADMIN_USER` and `ADMIN_PASSWORD` (the panel returns 503
without the last two, by design), then `npm run dev -w apps/web` and open
http://localhost:3000/admin.

Object storage is only needed to exercise the real push/pull/scrape channels:
`docker compose --profile storage up -d` starts a MinIO stand-in for object storage.
`npm run db:down` stops everything; `npm run db:reset` rebuilds the schema.

The worker reads a local file (`file:` source, demos and tests only) or the bucket via the
S3 API. Deployment targets are Vercel for `apps/web` and a Cloud Run Job for
`worker`, but neither is required to run or evaluate the system locally.

## Documents

- [DESIGN.md](DESIGN.md) — the architecture and a decision log of every choice
- [CONTEXT.md](CONTEXT.md) — the glossary; the words mean exactly these things
- [RUNBOOK.md](RUNBOOK.md) — how ops answers an alert, replays a feed, onboards a supplier
- [WALKTHROUGH.md](WALKTHROUGH.md) — the answer to the original question, file to catalog
- [TEST-PLAN.md](TEST-PLAN.md) — what is verified, how, and the results of the last run
- [SPRINT-PLAN.md](SPRINT-PLAN.md) — how the build was sequenced
