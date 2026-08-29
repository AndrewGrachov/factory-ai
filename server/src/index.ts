import postgres from 'postgres';
import { buildApp } from './app.js';
import { resolveConfig } from './config-file.js';
import { migrate } from './db/migrate.js';
import { createPrStore } from './db/pr-store.js';
import { createPostgresTelemetryClient } from './telemetry/postgres-client.js';
import { createPostgresStore } from './telemetry/store.js';
import { createGitHubClient } from './github/client.js';
import { envTokenProvider } from './github/token.js';
import { createStatsService } from './stats-service.js';
import { createFixtureTelemetryClient, createNullTelemetryClient } from './telemetry/fixture-client.js';
import { ensureWorkspace } from './workspace/reconcile.js';

// `env` is the file merged under process.env. It has to reach envTokenProvider, which is the one
// place outside config.ts that reads the PAT and would otherwise ignore the file's copy of it.
const { config, env, source } = resolveConfig();
console.log(`[config] ${source ?? 'no config file; environment only'}`);
// The id, not just the name: it is the partition every stored row lands in, and a boot pointed at
// an unexpected one is otherwise silent — the dashboard renders empty and looks like data loss.
console.log(`[org] ${config.orgName} (${config.orgId})`);

// A token is optional. Without one this process does not fetch — envTokenProvider throws before a
// request is ever built — and the dashboard serves whatever is already stored, reporting the fetch
// failure in `meta` rather than pretending. That is what lets a seeded database be browsed with no
// credentials and no network.
const client = createGitHubClient({ config, tokens: envTokenProvider(env) });
console.log(
    env.GITHUB_TOKEN
        ? '[fetch] syncing from GitHub'
        : '[fetch] no GITHUB_TOKEN: serving stored data only, nothing will be fetched',
);

// One pool, and one `migrate()`, for both the telemetry store and the PR store. They are
// independent features sharing a schema, and two runners would race each other.
const sql = postgres(config.databaseUrl, { max: 4 });
// NOT awaited. Migrations retry with backoff for the better part of a minute while the database
// container starts, and blocking here would hold the whole dashboard hostage to it. Every consumer
// gates its own queries on `ready` and reports unavailable until then.
//
// orgId is required: migrate() also adopts pre-organization rows into it, and that adoption is the
// only thing standing between a warm database and an empty dashboard.
const ready = migrate(sql, { orgId: config.orgId, log: (m) => console.log(`[migrate] ${m}`) });
ready.catch((e: Error) => console.error(`[migrate] giving up: ${e.message}`));

// `off` is a product choice — render no AI panels — not a way to avoid the database, which is why
// it survives while the fixture source did not.
const telemetry =
    config.telemetrySource === 'off'
        ? createNullTelemetryClient()
        : config.telemetrySource === 'fixture'
          ? createFixtureTelemetryClient()
          : createPostgresTelemetryClient({ sql, orgId: config.orgId, ready });

// The ingest route is registered off this, so it exists whenever there is somewhere to put an
// export — which is now always, unless telemetry is switched off outright.
const store = config.telemetrySource === 'postgres' ? createPostgresStore({ sql, orgId: config.orgId }) : undefined;

const prStore = createPrStore({ sql, orgId: config.orgId, ready });
console.log(`[persist] ${config.databaseUrl.replace(/\/\/[^@]*@/, '//')}`);

const service = createStatsService({ config, client, telemetry, store: prStore });
const app = await buildApp({ config, service, store, logger: true });

// Fired, not awaited: prime() waits on the migration promise, and awaiting it here would
// recreate exactly the hostage-taking that not awaiting migrate() avoids. ensureFresh() returns
// early while it is in flight, so the seed cannot lose a race with a full walk.
service.prime().catch((e: Error) => console.error(`[persist] prime failed: ${e.message}`));

// Warm the cache at boot so the first visitor does not eat the cold fetch.
service.ensureFresh();

// Also fired, not awaited: a clone is minutes of network for something no route reads, so blocking
// listen() on it would make the dashboard unavailable for a feature it does not use.
//
// The token is read off the merged record directly rather than through envTokenProvider, which
// throws when there is none. Here that is not an error: without a token the public repos still
// clone and the private ones report a named failure.
if (config.workspaceRoot) {
    ensureWorkspace({
        root: config.workspaceRoot,
        orgId: config.orgId,
        repos: config.repos,
        token: env.GITHUB_TOKEN,
        log: (m) => console.log(`[workspace] ${m}`),
    }).catch((e: Error) => console.error(`[workspace] ${e.message}`));
}

await app.listen({ port: config.port, host: config.host });
