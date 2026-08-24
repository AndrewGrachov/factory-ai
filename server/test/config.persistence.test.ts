import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const DEV = 'postgres://factory:factory@127.0.0.1:5432/factory_dev';
const TEST = 'postgres://factory:factory@127.0.0.1:5432/factory_test';

describe('persistence is derived, not configured', () => {
    it('is off without a database', () => {
        expect(loadConfig({ DATA_SOURCE: 'github', GITHUB_TOKEN: 't' }).persistence).toBe('off');
    });

    it('is on for a real source with a database', () => {
        expect(
            loadConfig({ DATA_SOURCE: 'github', GITHUB_TOKEN: 't', DATABASE_URL: DEV }).persistence,
        ).toBe('postgres');
    });

    it('refuses to persist fixture data, and there is no flag that says otherwise', () => {
        // DATA_SOURCE defaults to fixture and docker-compose sets DATABASE_URL unconditionally,
        // so this is the default path — the one that would write 203 synthetic PRs into real
        // history. It must boot, and it must write nothing.
        const config = loadConfig({ DATABASE_URL: DEV });
        expect(config.dataSource).toBe('fixture');
        expect(config.persistence).toBe('off');
        expect(config.databaseUrl).toBe(DEV);
    });

    it('throws rather than persist real history into the disposable test database', () => {
        // server/test-db truncates that database, so anything expensively fetched into it is
        // lost on the next `npm run test:db` — silently, which is what makes it worth a guard.
        expect(() =>
            loadConfig({ DATA_SOURCE: 'github', GITHUB_TOKEN: 't', DATABASE_URL: TEST }),
        ).toThrow(/factory_test/);
    });

    it('leaves the test database alone when nothing would be persisted to it', () => {
        // The db suite itself runs with TELEMETRY_SOURCE=postgres against exactly this URL.
        expect(() => loadConfig({ TELEMETRY_SOURCE: 'postgres', DATABASE_URL: TEST })).not.toThrow();
    });
});

describe('the sync TTL floor', () => {
    it('defaults to a minute and scales with the repo count', () => {
        expect(loadConfig({}).syncTtlMs).toBe(60_000);
        expect(loadConfig({ GITHUB_REPOS: 'a,b,c' }).syncTtlMs).toBe(180_000);
    });

    it('rejects a value under the floor, so the cheap path stays cheap', () => {
        expect(() => loadConfig({ GITHUB_REPOS: 'a,b', SYNC_TTL_SECONDS: '60' })).toThrow(
            /at least 120/,
        );
    });

    it('is separate from the full-walk floor, which it must not weaken', () => {
        const config = loadConfig({});
        expect(config.syncTtlMs).toBeLessThan(config.cacheTtlMs);
        expect(config.cacheTtlMs).toBe(900_000);
    });
});
