import type { Sql } from 'postgres';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead';
/** What a worker may report. 'dead' is the board's verdict, never a worker's. */
export type JobOutcome = 'succeeded' | 'failed';

export interface Job {
    id: string;
    command: string;
    status: JobStatus;
    attempts: number;
    maxAttempts: number;
    claimedBy: string | null;
    exitCode: number | null;
    output: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
}

/** What a worker gets back from a successful claim. The lease token is its proof for later. */
export interface Claim {
    id: string;
    command: string;
    attempts: number;
    leaseToken: string;
    leaseExpiresAt: string;
}

/**
 * Why a write was refused.
 *
 * - `lost`    the job is no longer running under this token — the lease expired and someone else
 *             has it, or the board gave up on it. The caller must stop working.
 * - `missing` no such job in this organization.
 */
export type LeaseResult = 'ok' | 'lost' | 'missing';

export interface JobStore {
    create(command: string): Promise<{ id: string }>;
    /** The oldest claimable job, or null when there is none. Never blocks on a live lease. */
    claim(worker: string, leaseSeconds: number): Promise<Claim | null>;
    heartbeat(id: string, leaseToken: string, leaseSeconds: number): Promise<{ result: LeaseResult; leaseExpiresAt: string | null }>;
    complete(
        id: string,
        leaseToken: string,
        result: { status: JobOutcome; exitCode: number | null; output: string | null },
    ): Promise<LeaseResult>;
    get(id: string): Promise<Job | null>;
    /** Newest first. `output` is not selected — it is unbounded and no list view shows it. */
    list(filter: { status?: JobStatus | undefined; limit: number }): Promise<Job[]>;
}

interface JobRow {
    id: string;
    command: string;
    status: JobStatus;
    attempts: number;
    max_attempts: number;
    claimed_by: string | null;
    exit_code: number | null;
    output?: string | null;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

const toJob = (row: JobRow): Job => ({
    id: row.id,
    command: row.command,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    claimedBy: row.claimed_by,
    exitCode: row.exit_code,
    output: row.output ?? null,
    createdAt: row.created_at.toISOString(),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
});

/** The organization is bound at construction, for the reasons given on createPrStore. */
export function createJobStore({
    sql,
    orgId,
    ready,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown>;
}): JobStore {
    const gate = async () => {
        if (ready) await ready;
    };

    return {
        async create(command) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                insert into job (org_id, command) values (${orgId}, ${command})
                returning id
            `;
            return { id: rows[0]!.id };
        },

        async claim(worker, leaseSeconds) {
            await gate();

            // Retire what has burned its attempts, before looking for work. Without this a command
            // that kills its worker is reclaimed every time its lease expires, forever.
            await sql`
                update job set status = 'dead', finished_at = now(), lease_token = null
                where org_id = ${orgId} and status = 'running'
                  and lease_expires_at <= now() and attempts >= max_attempts
            `;

            const rows = await sql<
                {
                    id: string;
                    command: string;
                    attempts: number;
                    lease_token: string;
                    lease_expires_at: Date;
                }[]
            >`
                update job set
                    status           = 'running',
                    claimed_by       = ${worker},
                    lease_token      = gen_random_uuid(),
                    attempts         = attempts + 1,
                    -- Unconditional, not coalesce(started_at, now()): this must describe the
                    -- attempt that is about to run, or every duration is measured from attempt 1.
                    started_at       = now(),
                    lease_expires_at = now() + make_interval(secs => ${leaseSeconds}::int)
                where org_id = ${orgId} and id = (
                    select id from job
                    where org_id = ${orgId}
                      and status in ('queued','running')
                      and lease_expires_at <= now()
                      and attempts < max_attempts
                    order by created_at, id
                    limit 1
                    -- Below the limit in the plan, so a row another claimer holds is skipped
                    -- rather than counted and then discarded. The bare id = above is safe ONLY
                    -- because this subquery is holding the row lock.
                    for update skip locked
                )
                returning id, command, attempts, lease_token, lease_expires_at
            `;

            const row = rows[0];
            if (!row) return null;
            return {
                id: row.id,
                command: row.command,
                attempts: row.attempts,
                leaseToken: row.lease_token,
                leaseExpiresAt: row.lease_expires_at.toISOString(),
            };
        },

        async heartbeat(id, leaseToken, leaseSeconds) {
            await gate();
            const rows = await sql<{ lease_expires_at: Date }[]>`
                update job
                set lease_expires_at = now() + make_interval(secs => ${leaseSeconds}::int)
                where org_id = ${orgId} and id = ${id}
                  and status = 'running' and lease_token = ${leaseToken}
                returning lease_expires_at
            `;
            const row = rows[0];
            if (row) return { result: 'ok', leaseExpiresAt: row.lease_expires_at.toISOString() };
            return { result: (await exists(sql, orgId, id)) ? 'lost' : 'missing', leaseExpiresAt: null };
        },

        async complete(id, leaseToken, { status, exitCode, output }) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                update job set
                    status      = ${status},
                    exit_code   = ${exitCode},
                    output      = ${output},
                    finished_at = now(),
                    lease_token = null
                where org_id = ${orgId} and id = ${id}
                  and status = 'running' and lease_token = ${leaseToken}
                returning id
            `;
            if (rows[0]) return 'ok';
            // A report from a worker whose lease was reclaimed is refused, not merged: the job is
            // someone else's now, and the two runs did different work.
            return (await exists(sql, orgId, id)) ? 'lost' : 'missing';
        },

        async get(id) {
            await gate();
            const rows = await sql<JobRow[]>`
                select id, command, status, attempts, max_attempts, claimed_by, exit_code, output,
                       created_at, started_at, finished_at
                from job where org_id = ${orgId} and id = ${id}
            `;
            const row = rows[0];
            return row ? toJob(row) : null;
        },

        async list({ status, limit }) {
            await gate();
            const rows = await sql<JobRow[]>`
                select id, command, status, attempts, max_attempts, claimed_by, exit_code,
                       created_at, started_at, finished_at
                from job
                where org_id = ${orgId} ${status ? sql`and status = ${status}` : sql``}
                order by created_at desc, id
                limit ${limit}
            `;
            return rows.map(toJob);
        },
    };
}

/** Separates "no such job" from "the lease is not yours" once a guarded update matched nothing. */
async function exists(sql: Sql, orgId: string, id: string): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`select id from job where org_id = ${orgId} and id = ${id}`;
    return rows.length > 0;
}
