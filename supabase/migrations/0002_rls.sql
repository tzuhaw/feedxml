-- Security: deny-by-default for Supabase API roles (anon/authenticated).
-- No policies are defined on purpose: nothing in this system is served through
-- PostgREST. The worker and the app connect as the direct Postgres role
-- (DATABASE_URL), which is unaffected by RLS. When the Sprint-4 admin panel
-- needs API access, it gets explicit policies — never a disabled-RLS table.

alter table suppliers enable row level security;
alter table feeds enable row level security;
alter table feed_runs enable row level security;
alter table staging_products enable row level security;
alter table products enable row level security;
alter table issues enable row level security;
alter table audit_log enable row level security;
