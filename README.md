# feedxml — product-feed ingestion

Ingests complete product-catalog Snapshots from supplier Feeds into Supabase, per [DESIGN.md](DESIGN.md).
Canonical vocabulary: [CONTEXT.md](CONTEXT.md). Delivery plan: [SPRINT-PLAN.md](SPRINT-PLAN.md).

## Layout

- `apps/web` — Next.js app on Vercel: trigger endpoints, later the admin panel
- `worker` — Cloud Run Job: streams a Snapshot from storage into staging, validates, merges
- `packages/shared` — domain types shared by both
- `supabase/migrations` — database schema
- `fixtures` — sample Snapshots used by tests and local demos

## Walking-skeleton demo (Sprint 1)

```
npm install
npm test                      # streaming core against fixtures, no DB needed
npm run demo -w worker        # fixture XML -> staging -> merge against DATABASE_URL
```

The worker reads either a local file (`file:` source, demos/tests) or R2 via the S3 API
(`R2_*` env vars). `DATABASE_URL` points at Supabase Postgres (direct connection).
