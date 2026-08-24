import postgres from 'postgres';
import { buildApp } from './app.js';
import { resolveConfig } from './config-file.js';
import { migrate } from './db/migrate.js';
import { createPrStore } from './db/pr-store.js';
import { createPostgresTelemetryClient } from './telemetry/postgres-client.js';
import { createPostgresStore } from './telemetry/store.js';
import { createGitHubClient } from './github/client.js';
import { createFixtureClient } from './github/fixture-client.js';
import { envTokenProvider } from './github/token.js';
import { createStatsService } from './stats-service.js';
import { createFixtureTelemetryClient, createNullTelemetryClient } from './telemetry/fixture-client.js';

// `env` is the file merged under process.env. It has to reach envTokenProvider, which is the one
// place outside config.ts that reads the PAT and would otherwise ignore the file's copy of it.
const { config, env, source } = resolveConfig();
console.log(`[config] ${source ?? 'no config file; environment only'}`);

const client =
    config.dataSource === 'fixture'
        ? // Stamped with the first configured repo so the fixture agrees with the config it is
          // standing in for. The payload itself came from one capture, so one name is honest.
          // loadConfig rejects an empty repo list, so index 0 always exists.
          createFixtureClient({ repo: config.repoNames[0] as string })
        : createGitHubClient({ config, tokens: envTokenProvider(env) });

/**
 * One pool for both the telemetry store and the PR store, and one `migrate()` for both. They are
 * independent features but they share a schema, and two runners would race each other.
 */
function buildDatabase() {
    if (config.persistence === 'off' && config.telemetrySource !== 'postgres') return null;
    if (!config.databaseUrl) return null;

    const sql = postgres(config.databaseUrl, { max: 4 });
    // NOT awaited. Migrations retry with backoff for the better part of a minute while the
    // database container starts, and blocking on them here would hold the whole dashboard —
    // including the PR metrics, which need no database at all — hostage to it. Every consumer
    // gates its own queries on `ready` and reports unavailable until then.
    const ready = migrate(sql, { log: (m) => console.log(`[migrate] ${m}`) });
    ready.catch((e: Error) => console.error(`[migrate] giving up: ${e.message}`));
    return { sql, ready };
}

function buildTelemetry(db: { sql: postgres.Sql; ready: Promise<void> } | null) {
    if (config.telemetrySource === 'off') {
        return { telemetry: createNullTelemetryClient(), store: undefined };
    }
    if (config.telemetrySource === 'fixture') {
        // No store: without a database there is nowhere to put an export, and a route that
        // accepts data it then drops is worse than no route at all.
        return { telemetry: createFixtureTelemetryClient(), store: undefined };
    }

    const { sql, ready } = db as { sql: postgres.Sql; ready: Promise<void> };
    return {
        telemetry: createPostgresTelemetryClient({ sql, ready }),
        store: createPostgresStore({ sql }),
    };
}

const db = buildDatabase();
const { telemetry, store } = buildTelemetry(db);

// Fixture data is never persisted, and there is no flag that says otherwise. DATA_SOURCE
// defaults to fixture while docker-compose sets DATABASE_URL unconditionally, so the default
// path is precisely the one that would write 203 synthetic PRs into real history.
const prStore =
    config.persistence === 'postgres' && db
        ? createPrStore({ sql: db.sql, ready: db.ready })
        : undefined;
console.log(
    prStore
        ? '[persist] pull requests persisted to the configured database'
        : config.databaseUrl && config.dataSource === 'fixture'
          ? `[persist] disabled: DATA_SOURCE=fixture, nothing written to ${config.databaseUrl.replace(/\/\/[^@]*@/, '//')}`
          : '[persist] disabled: no DATABASE_URL, a restart re-fetches everything',
);

const service = createStatsService({ config, client, telemetry, store: prStore });
const app = await buildApp({ config, service, store, logger: true });

// Fired, not awaited: prime() waits on the migration promise, and awaiting it here would
// recreate exactly the hostage-taking that not awaiting migrate() avoids. ensureFresh() returns
// early while it is in flight, so the seed cannot lose a race with a full walk.
service.prime().catch((e: Error) => console.error(`[persist] prime failed: ${e.message}`));

// Warm the cache at boot so the first visitor does not eat the cold fetch.
service.ensureFresh();

await app.listen({ port: config.port, host: config.host });
