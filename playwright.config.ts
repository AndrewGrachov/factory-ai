import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const root = fileURLToPath(new URL('.', import.meta.url));
const PORT = 8123;

/**
 * The built SPA is served by the API rather than by Vite, so the suite exercises the same
 * single-origin arrangement as production and needs no proxy rule.
 *
 * It stays offline — no token, no quota, no network — but no longer by replaying an HTTP payload.
 * The database is the only source the app reads, so the check seeds a disposable one and browses
 * that. Deliberately NO GITHUB_TOKEN: without it nothing is ever fetched (envTokenProvider throws
 * before a request is built), so the page renders purely from what was seeded, and `loadConfig`
 * permits the disposable database precisely because nothing can be lost to it.
 *
 * Requires a running container:  docker compose up -d timescale
 */
export default defineConfig({
    testDir: './e2e',
    outputDir: './artifacts/ui/trace',
    // A visual check that passes on a retry is not a visual check.
    retries: 0,
    reporter: [['list']],
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        viewport: { width: 1440, height: 1000 },
        screenshot: 'off',
        trace: 'retain-on-failure',
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: {
        // Seeded first, and every run: the assertions read the numbers the generator produces, and
        // a stale database from an older generator would fail in a way that looks like a UI bug.
        command: 'npm run build && npm run seed && node server/dist/index.js',
        // /api/health never touches GitHub or the database, so it reports ready immediately —
        // the cold fixture fetch is awaited in the spec instead.
        url: `http://127.0.0.1:${PORT}/api/health`,
        cwd: root,
        env: {
            PORT: String(PORT),
            WEB_ROOT: `${root}web/dist`,
            DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_e2e',
            TELEMETRY_SOURCE: 'postgres',
            // Pinned, because cwd is the repo root and a developer's gitignored factory.toml is
            // discovered from there. Environment wins over the file, so both the organization
            // assertion and the database the run seeds are deterministic whether or not that file
            // exists — and in particular a personal factory.toml cannot point this at factory_dev.
            ORG_ID: 'e2e-org',
            ORG_NAME: 'E2E Org',
            // Pins the config file, which is the only way to guarantee no token is in scope: an
            // EMPTY environment variable is not an override, so `GITHUB_TOKEN: ''` here would NOT
            // clear one set in a developer's personal factory.toml — and with a token this run
            // would fetch from GitHub and then refuse to boot against a disposable database.
            FACTORY_CONFIG: `${root}e2e/factory.e2e.toml`,
        },
        timeout: 180_000,
        // Never reuse: a server left over from a previous edit would verify stale code, which
        // is the one failure mode a visual check exists to catch.
        reuseExistingServer: false,
        stdout: 'ignore',
        stderr: 'pipe',
    },
});
