-- The `opencode` executor type.
--
-- This is the constraint rewrite 012's header warned about, the same rewrite 008 did for
-- `job_status_ck`. The value could not be predicted the way 'dead' was, so the check is dropped
-- and re-added; `add constraint` scans every row to validate it, and the table is small.
--
-- Idempotent by dropping first, which is what lets the file be re-applied after a crash between
-- running it and recording it.
alter table user_executor drop constraint if exists user_executor_type_ck;
alter table user_executor add constraint user_executor_type_ck
    check (type in ('claude-code', 'opencode'));

-- 012 remains the file that created the table and the first constraint; the live list is the pair
-- of this file and EXECUTOR_TYPES in core/src/executors.ts, which must name the same values.
