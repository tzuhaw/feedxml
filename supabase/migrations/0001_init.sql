-- Sprint 1 schema. Vocabulary: /CONTEXT.md. Design: /DESIGN.md.
-- Columns for Sprint 2 rules (pins, skip streaks, issues) are present so the
-- domain model is stable from the first migration.

create extension if not exists pgcrypto;

create type channel as enum ('push', 'pull', 'sftp', 'scrape');
create type snapshot_format as enum ('xml', 'ndjson');
create type run_state as enum (
  'pending', 'downloading', 'staging', 'validating',
  'awaiting_review', 'merging', 'done', 'failed', 'superseded'
);
create type issue_scope as enum ('record', 'product', 'run');
create type issue_status as enum ('open', 'resolved');
create type product_status as enum ('active', 'inactive');

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  -- bcrypt hash; lookup contract is (supplier_id, api_key), never by hash
  api_key_hash text,
  created_at timestamptz not null default now()
);

-- The Feed is the standing arrangement; all ingestion config attaches here,
-- not to the Supplier (CONTEXT.md: Feed).
create table feeds (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers (id),
  channel channel not null,
  format snapshot_format not null,
  schedule text,
  thresholds jsonb not null default '{"maxCountDrop":0.2,"maxMissingSet":0.05,"maxErrorRate":0.02}',
  skip_streak_limit int not null default 3,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (supplier_id, channel)
);

create table feed_runs (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid not null references feeds (id),
  -- The R2 object key of the Snapshot. Uniqueness is the idempotency guarantee
  -- for the hybrid trigger (self-report + safety-net cron).
  object_key text not null unique,
  state run_state not null default 'pending',
  attempt int not null default 0,
  error text,
  -- populated at validation: {records, staged, skipped, missing, creates, updates, deactivations}
  counts jsonb,
  superseded_by uuid references feed_runs (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index feed_runs_feed_state on feed_runs (feed_id, state);

create table staging_products (
  run_id uuid not null references feed_runs (id) on delete cascade,
  product_code text not null,
  title text not null,
  description text,
  brand text,
  gtin text, -- product-level fallback only; canonical GTIN lives per-variant
  variants jsonb not null default '[]',
  images jsonb not null default '[]',
  attributes jsonb not null default '{}',
  primary key (run_id, product_code)
);

create table products (
  supplier_id uuid not null references suppliers (id),
  product_code text not null,
  status product_status not null default 'active',
  -- Pinned: exempt from the Deactivation Sweep; side effect of an admin
  -- reversal; clears itself when the product reappears in a Snapshot.
  pinned boolean not null default false,
  title text not null,
  description text,
  brand text,
  gtin text,
  variants jsonb not null default '[]',
  images jsonb not null default '[]',
  attributes jsonb not null default '{}',
  -- Skip streak: consecutive Runs in which this product was Skipped.
  skip_streak int not null default 0,
  first_seen_run uuid references feed_runs (id),
  last_seen_run uuid references feed_runs (id),
  deactivated_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (supplier_id, product_code)
);

create index products_status on products (supplier_id, status);

-- One Issue entity, three scopes (CONTEXT.md: Issue).
create table issues (
  id uuid primary key default gen_random_uuid(),
  scope issue_scope not null,
  status issue_status not null default 'open',
  run_id uuid references feed_runs (id),
  supplier_id uuid references suppliers (id),
  product_code text,
  reason text not null,
  -- Record scope: {raw_fragment, parsed}; Run scope: {thresholds, counts}
  evidence jsonb not null default '{}',
  resolution text, -- e.g. 'resolved by run <id>', 'approved', 'rejected', 'superseded'
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index issues_open on issues (status, scope, created_at);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  actor text not null, -- 'system' or 'admin:<email>'
  action text not null, -- e.g. 'deactivate', 'reactivate', 'pin', 'approve_run'
  subject jsonb not null,
  created_at timestamptz not null default now()
);
