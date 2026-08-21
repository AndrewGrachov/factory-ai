import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createGitHubClient } from './github/client.js';
import { createFixtureClient } from './github/fixture-client.js';
import { envTokenProvider } from './github/token.js';
import { createStatsService } from './stats-service.js';

const config = loadConfig();
const client =
    config.dataSource === 'fixture'
        ? createFixtureClient()
        : createGitHubClient({ config, tokens: envTokenProvider() });

const service = createStatsService({ config, client });
const app = await buildApp({ config, service, logger: true });

// Warm the cache at boot so the first visitor does not eat the ~45s cold fetch.
service.ensureFresh();

await app.listen({ port: config.port, host: config.host });
