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
     * The container is usually still starting when the app boots, and the dashboard must not
     * die waiting for a database it can serve PR metrics without.
     */
    attempts?: number;
    backoffMs?: number;
    log?: (message: string) => void;
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
export async function migrate(sql: Sql, options: MigrateOptions = {}): Promise<void> {
    const { attempts = 10, backoffMs = 1000, log = () => {} } = options;

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
