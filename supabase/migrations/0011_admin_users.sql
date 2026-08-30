-- Admin credentials move out of environment variables and into the database:
-- env vars cannot be rotated without a redeploy, cannot hold more than one
-- operator, and put a password in the deployment platform's config.
--
-- Passwords are bcrypt-hashed. Lookup is by username, so the hash is never
-- searched by value.
create table admin_users (
  username text primary key check (username ~ '^[a-z0-9][a-z0-9_.-]{1,62}$'),
  password_hash text not null,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

-- Server-side secrets that must outlive a deployment and stay identical across
-- instances — currently the session signing key, generated on first use.
create table app_secrets (
  name text primary key,
  value text not null,
  created_at timestamptz not null default now()
);

alter table admin_users enable row level security;
alter table app_secrets enable row level security;
