-- Snapshots are routed to a Feed by (supplier, format) parsed from the object
-- key — the key cannot express which CHANNEL produced it. Two active feeds of
-- the same format for one supplier (say a push NDJSON feed and a scrape feed)
-- are therefore indistinguishable at routing time, and every scraped Snapshot
-- would be validated against the wrong feed's thresholds while the real feed
-- showed no runs at all.
--
-- Rather than let that ambiguity exist and resolve it by guessing, make it
-- unrepresentable: one active feed per (supplier, format).
create unique index feeds_one_active_per_format
  on feeds (supplier_id, format) where active;
