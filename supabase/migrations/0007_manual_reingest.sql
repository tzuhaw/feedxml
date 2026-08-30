-- Manual re-ingest (DESIGN.md §7): an admin can replay any retained R2 file.
-- object_key uniqueness is what makes automatic triggers idempotent, so a
-- deliberate replay is marked and exempted from that constraint rather than
-- weakening it for everyone.
alter table feed_runs add column manual_reingest boolean not null default false;

alter table feed_runs drop constraint feed_runs_object_key_key;
create unique index feed_runs_object_key_auto
  on feed_runs (object_key) where not manual_reingest;
