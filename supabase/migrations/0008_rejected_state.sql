-- A human rejection and an infrastructure crash were both stored as 'failed',
-- distinguishable only by prose in the error column — so "retry a failed run"
-- could resurrect a snapshot a human had deliberately discarded. Rejection
-- gets its own terminal state.
alter type run_state add value if not exists 'rejected';
