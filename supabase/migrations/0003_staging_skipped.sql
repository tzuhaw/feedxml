-- Skipped product codes per Run, durable so that Skipped ≠ Missing survives
-- the process: a Halted run approved hours later must still exclude Skipped
-- products from the Deactivation Sweep. Evidence-bearing Record Issues are
-- capped samples; this table is the complete, cheap (2-column) truth.

create table staging_skipped (
  run_id uuid not null references feed_runs (id) on delete cascade,
  product_code text not null,
  primary key (run_id, product_code)
);

alter table staging_skipped enable row level security;
