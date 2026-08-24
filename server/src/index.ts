import postgres from 'postgres';
import { buildApp } from './app.js';
import { resolveConfig } from './config-file.js';
import { migrate } from './db/migrate.js';
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

function buildTelemetry() {
    if (config.telemetrySource === 'off') {
        return { telemetry: createNullTelemetryClient(), store: undefined };
    }
    if (config.telemetrySource === 'fixture') {
        // No store: without a database there is nowhere to put an export, and a route that
        // accepts data it then drops is worse than no route at all.
        return { telemetry: createFixtureTelemetryClient(), store: undefined };
    }

    const sql = postgres(config.databaseUrl as string, { max: 4 });
    // NOT awaited. Migrations retry with backoff for the better part of a minute while the
    // database container starts, and blocking on them here would hold the whole dashboard —
    // including the PR metrics, which need no database at all — hostage to it. The client
    // gates its own queries on `ready` and reports unreachable until then.
    const ready = migrate(sql, { log: (m) => console.log(`[migrate] ${m}`) });
    ready.catch((e: Error) => console.error(`[migrate] giving up: ${e.message}`));
    return {
        telemetry: createPostgresTelemetryClient({ sql, ready }),
        store: createPostgresStore({ sql }),
    };
}

const { telemetry, store } = buildTelemetry();
const service = createStatsService({ config, client, telemetry });
const app = await buildApp({ config, service, store, logger: true });

// Warm the cache at boot so the first visitor does not eat the ~45s cold fetch.
service.ensureFresh();

await app.listen({ port: config.port, host: config.host });
