import { readFileSync, readdirSync } from 'node:fs';
import type { Sql } from 'postgres';
import { TelemetryError } from '../telemetry/errors.js';

/**
 * The .sql files are not compiled by tsc, so the Dockerfile has to copy them explicitly.
 * That failure only appears in the container, never in dev.
 */
const DIR = new URL('../../migrations/', import.meta.url);

export interface MigrateOptions {
    /**
     * The organization every pre-organization row is adopted into. Required, not defaulted: a
     * default here would be a second place that decides what the configured org is, and the two
     * disagreeing produces an empty dashboard with no error.
     */
    orgId: string;
    /**
     * The container is usually still starting when the app boots, and the dashboard must not
     * die waiting for a database it can serve PR metrics without.
     */
    attempts?: number;
    backoffMs?: number;
    log?: (message: string) => void;
}

/**
 * The namespace 005_organizations.sql parks pre-organization rows in. Kept in step with
 * RESERVED_ORG_PREFIX in config.ts, which refuses any configured id that could collide with it.
 */
const UNCLAIMED_ORG = '__unclaimed__';

/**
 * The tables adoptOrg() has to update directly.
 *
 * metric_point is absent because it has no org_id at all — see the header of
 * 005_organizations.sql. The four pull_request child tables (pr_review, pr_review_thread,
 * pr_commit, pr_label) are absent for the opposite reason: org_id is part of their foreign key, so
 * `on update cascade` moves them with their parent. Listing them here as well is not merely
 * redundant, it is *wrong* — updating a child before its parent violates the constraint, and
 * updating one after is a statement that matches nothing.
 */
const ORG_OWNED = [
    'pull_request',
    'branch_commit',
    'branch_history',
    'sync_state',
    'session_branch',
    'session_pr',
] as const;

/**
 * Claims every row 005 parked in the reserved namespace for the configured organization.
 *
 * This is the other half of the migration, and it cannot live in the .sql file because that file
 * cannot see the config. Without it a deployment that sets ORG_ID=leeloo reads an empty partition:
 * 200 OK, zero PRs, no log line, indistinguishable from data loss.
 *
 * Runs on every boot, and is a no-op after the first: nothing writes '__unclaimed__' once the
 * column default has been consumed, so the update matches nothing.
 */
async function adoptOrg(sql: Sql, orgId: string, log: (message: string) => void): Promise<void> {
    if (orgId.startsWith('__')) {
        // config.ts already refuses this. Asserted again because the DB layer must not trust its
        // caller with a value that decides which partition every row lands in.
        throw new TelemetryError(`orgId "${orgId}" is inside the reserved "__" namespace`, 'MIGRATION');
    }

    let moved = 0;
    for (const table of ORG_OWNED) {
        const result = await sql`
            update ${sql(table)} set org_id = ${orgId} where org_id = ${UNCLAIMED_ORG}
        `;
        moved += result.count;
    }
    // Undercounts by however many child rows the cascade carried along, which is the honest thing
    // to report: the count is a signal that adoption happened, not an inventory.
    if (moved) log(`adopted ${moved} pre-organization rows into "${orgId}"`);
}

/**
 * A `.repeatable.sql` file is re-applied on every boot instead of being recorded.
 *
 * Without this a fix to a view would never land: the version is already in
 * schema_migrations, so the file is skipped and the old definition survives until someone
 * deletes the volume. Every repeatable file must therefore be `create or replace` only.
 */
const isRepeatable = (name: string) => name.endsWith('.repeatable.sql');

function files(): { version: string; sql: string; repeatable: boolean }[] {
    const all = readdirSync(DIR)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) => ({
            version: name,
            sql: readFileSync(new URL(name, DIR), 'utf8'),
            repeatable: isRepeatable(name),
        }));

    // Versioned first, repeatable last, regardless of filename order. Repeatable files define
    // views over the finished schema, so a new versioned file that adds a column the views read
    // would otherwise fail purely because it sorts after them.
    return [...all.filter((f) => !f.repeatable), ...all.filter((f) => f.repeatable)];
}

/**
 * Applies pending migrations. Idempotent: every statement is `if not exists` or
 * `create or replace`, and applied versions are recorded, so a second run is a no-op.
 */
export async function migrate(sql: Sql, options: MigrateOptions): Promise<void> {
    const { orgId, attempts = 10, backoffMs = 1000, log = () => {} } = options;

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            await sql`
                create table if not exists schema_migrations (
                    version    text primary key,
                    applied_at timestamptz not null default now()
                )
            `;

            // A file that used to be versioned and is now repeatable leaves a row behind. The
            // runner ignores it, so this is hygiene rather than a fix — but leaving it makes
            // "repeatable files are never recorded" true only of new writes, not of the table.
            await sql`delete from schema_migrations where version like '%.repeatable.sql'`;

            const applied = new Set(
                (await sql<{ version: string }[]>`select version from schema_migrations`).map(
                    (r) => r.version,
                ),
            );

            for (const { version, sql: body, repeatable } of files()) {
                if (!repeatable && applied.has(version)) continue;
                log(`applying ${repeatable ? 'repeatable ' : ''}migration ${version}`);
                // Not wrapped in a transaction with the insert: create_hypertable and
                // create extension behave badly inside one, and every file is idempotent
                // anyway, so a crash between the two costs one harmless re-run.
                await sql.unsafe(body);
                if (repeatable) continue;
                await sql`insert into schema_migrations (version) values (${version})
                          on conflict (version) do nothing`;
            }

            // After the files, so the column and its default exist. Inside the retry loop, so a
            // database that was not up for the first attempt gets adopted on the one that works.
            await adoptOrg(sql, orgId, log);
            return;
        } catch (e) {
            lastError = e;
            if (attempt === attempts) break;
            log(`migration attempt ${attempt} failed, retrying: ${(e as Error).message}`);
            await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
        }
    }

    throw new TelemetryError(
        `Migrations failed after ${attempts} attempts: ${(lastError as Error)?.message}`,
        'MIGRATION',
    );
}
