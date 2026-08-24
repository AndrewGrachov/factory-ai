import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const root = fileURLToPath(new URL('.', import.meta.url));
const PORT = 8123;

/**
 * The built SPA is served by the API rather than by Vite, so the suite exercises the same
 * single-origin arrangement as production and needs no proxy rule. Fixture data on both
 * pipelines keeps it offline: no token, no quota, no database.
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
        command: 'npm run build && node server/dist/index.js',
        // /api/health never touches GitHub or the database, so it reports ready immediately —
        // the cold fixture fetch is awaited in the spec instead.
        url: `http://127.0.0.1:${PORT}/api/health`,
        cwd: root,
        env: {
            PORT: String(PORT),
            WEB_ROOT: `${root}web/dist`,
            DATA_SOURCE: 'fixture',
            TELEMETRY_SOURCE: 'fixture',
            // Pinned, because cwd is the repo root and a developer's gitignored factory.toml is
            // discovered from there. Environment wins over the file, so the organization assertion
            // in the spec is deterministic whether or not that file exists.
            ORG_ID: 'e2e-org',
            ORG_NAME: 'E2E Org',
        },
        timeout: 180_000,
        // Never reuse: a server left over from a previous edit would verify stale code, which
        // is the one failure mode a visual check exists to catch.
        reuseExistingServer: false,
        stdout: 'ignore',
        stderr: 'pipe',
    },
});
