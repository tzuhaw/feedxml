-- Fencing and honest progress tracking for runs.
--
-- `attempt` becomes the fencing token: it is monotonic (a retry bumps it, and
-- never resets it), the execution claim returns it, and the worker asserts it
-- still owns that value before anything destructive. A superseded worker
-- therefore cannot wipe staging or merge underneath the worker that replaced
-- it — elapsed time is not evidence that a process is dead, but a bumped
-- attempt is proof it has been replaced.
--
-- `failure_notified` re-arms the ops email across retries without resetting
-- `attempt` (which was the only generation counter we had).
--
-- `started_at` is when a run began EXECUTING, so stuck-run baselines measure
-- work rather than queue time.
alter table feed_runs add column failure_notified boolean not null default false;
alter table feed_runs add column started_at timestamptz;
