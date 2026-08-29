-- The job board.
--
-- A job is a text command waiting for a worker. This server hands them out and records the result;
-- it never spawns anything. The compose driver or the k8s operator claims a job, runs it in a
-- claude-executor container, and reports back.
--
-- LEASES, NOT A STATUS FLAG: a worker that dies mid-job cannot tell anyone. So a claim is a lease
-- with an expiry, and `lease_expires_at` is `not null` from insert — set to now(), already expired.
-- That makes "claimable" one predicate, `status in ('queued','running') and lease_expires_at <=
-- now()`, instead of `status = 'queued' or (status = 'running' and lease_expires_at < now())`. The
-- OR form is not implied by any partial index, so it can only ever be a scan plus a filter.
--
-- lease_token is a fencing token, and claimed_by cannot replace it: a restarted container comes
-- back with the same worker id, so the name alone cannot tell the live run from the stale one it
-- replaced. The token is regenerated on every claim, and a heartbeat or a completion carrying an
-- old one is refused.
--
-- max_attempts exists from the first migration rather than later: a command that kills its worker
-- is reclaimed the moment its lease expires, forever, and one poison job would occupy a worker slot
-- permanently. 'dead' is in the check constraint for the same reason — adding a value to it later
-- means rewriting the constraint on a populated table.
--
-- No `create extension`: gen_random_uuid() is core since PG13 and compose pins pg17. An extension
-- statement would also break the implicit transaction wrapping this file (see 005's header).

create table if not exists job (
    org_id           text not null,
    id               uuid not null default gen_random_uuid(),
    command          text not null,
    status           text not null default 'queued',
    attempts         int  not null default 0,
    max_attempts     int  not null default 3,
    claimed_by       text,
    lease_token      uuid,
    lease_expires_at timestamptz not null default now(),
    exit_code        int,
    output           text,
    created_at       timestamptz not null default now(),
    started_at       timestamptz,
    finished_at      timestamptz,
    constraint job_pk primary key (org_id, id),
    constraint job_status_ck check (status in ('queued','running','succeeded','failed','dead'))
);

-- The claim index. org_id leads, as everywhere else (see 005), and the partial predicate is exactly
-- the one the claim query uses. created_at, id trails lease_expires_at because the claim orders by
-- it: now() is transaction-constant, so a batch insert shares a timestamp and id is what keeps FIFO
-- from being arbitrary.
create index if not exists job_claimable
    on job (org_id, lease_expires_at, created_at, id)
    where status in ('queued','running');

-- The list route reads by status, newest first.
create index if not exists job_status_created
    on job (org_id, status, created_at desc);
