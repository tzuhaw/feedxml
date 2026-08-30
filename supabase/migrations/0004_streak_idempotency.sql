-- Skip-streak idempotency: a Cloud Run retry of the same Run must not bump a
-- product's streak twice (restart-everything, DESIGN.md decision 12). The
-- last Run that bumped each product is recorded and re-bumps are refused.
alter table products add column last_skipped_run uuid references feed_runs (id);

-- The run-entry wipe and per-run issue lookups seq-scanned an append-only table.
create index issues_run on issues (run_id);
-- Auto-resolution probes only open issues per product.
create index issues_open_product on issues (supplier_id, product_code) where status = 'open';
