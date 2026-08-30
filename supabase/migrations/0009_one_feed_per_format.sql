-- Snapshots are routed to a Feed by (supplier, format) parsed from the object
-- key — the key cannot express which CHANNEL produced it. Two active feeds of
-- the same format for one supplier (say a push NDJSON feed and a scrape feed)
-- are therefore indistinguishable at routing time, and every scraped Snapshot
-- would be validated against the wrong feed's thresholds while the real feed
-- showed no runs at all.
--
-- Rather than let that ambiguity exist and resolve it by guessing, make it
-- unrepresentable: one active feed per (supplier, format).
-- Existing installations may already hold the configuration this outlaws (the
-- schema permitted a push and a pull feed of the same format). Deactivate the
-- newer duplicates first so the index can be created, rather than aborting the
-- migration with an opaque unique violation and no remediation path.
update feeds f set active = false
where f.active
  and exists (
    select 1 from feeds keep
    where keep.active and keep.supplier_id = f.supplier_id
      and keep.format = f.format and keep.created_at < f.created_at
  );

create unique index if not exists feeds_one_active_per_format
  on feeds (supplier_id, format) where active;
