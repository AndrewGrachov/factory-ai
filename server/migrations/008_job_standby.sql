-- Standby: a running job whose container has been parked, waiting to be picked up again.
--
-- This is the constraint rewrite 006's header warned about. It was avoided for 'dead' by putting
-- that value in from the first migration; 'standby' could not be predicted the same way, so the
-- table is rewritten now while it is small. `add constraint` scans every row to validate it.
--
-- Idempotent by dropping first, which is what lets the file be re-applied after a crash between
-- running it and recording it.
alter table job drop constraint if exists job_status_ck;
alter table job add constraint job_status_ck
    check (status in ('queued','running','standby','succeeded','failed','dead'));

-- No index change, and that is the point: `job_claimable` is partial on
-- `status in ('queued','running')`, so a standby job is invisible to the claim without a single
-- extra predicate. Parking a job and resuming it are writes to `status`, and the claim goes on
-- asking exactly what it asked before. A standby job that were claimable would be resumed
-- instantly by the next idle poll, which is the opposite of parking it.
