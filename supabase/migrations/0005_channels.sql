-- Sprint 3: channels and supersession support.

-- Pull channel: where the supplier hosts the feed, and how often we poll.
alter table feeds add column source_url text;
alter table feeds add column schedule_minutes int;

-- Supersede and newest-run lookups walk a feed's runs by recency.
create index feed_runs_feed_created on feed_runs (feed_id, created_at desc);
