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

```
npm install
npm run build -w packages/shared && npm run build -w packages/domain
npm test                      # streaming core + thresholds; no database needed
```

Copy `.env.example` to `.env.local` and fill in `DATABASE_URL`, `ADMIN_USER`,
`ADMIN_PASSWORD`, then:

```
npm run dev -w apps/web       # admin panel at http://localhost:3000/admin
npm run demo -w worker        # fixture XML -> staging -> merge, prints the result
```

The integration suite needs a disposable Postgres (it rebuilds the schema from
`supabase/migrations/`), which is why CI runs it against a service container:

```
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

The worker reads a local file (`file:` source, demos and tests only) or R2 via the
S3 API. Deployment targets are Vercel for `apps/web` and a Cloud Run Job for
`worker`, but neither is required to run or evaluate the system locally.

## Documents

- [DESIGN.md](DESIGN.md) — the architecture and a decision log of every choice
- [CONTEXT.md](CONTEXT.md) — the glossary; the words mean exactly these things
- [RUNBOOK.md](RUNBOOK.md) — how ops answers an alert, replays a feed, onboards a supplier
- [SPRINT-PLAN.md](SPRINT-PLAN.md) — how the build was sequenced
