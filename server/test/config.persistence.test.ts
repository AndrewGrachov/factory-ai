import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const DEV = 'postgres://factory:factory@127.0.0.1:5432/factory_dev';
const TEST = 'postgres://factory:factory@127.0.0.1:5432/factory_test';
const SEED = 'postgres://factory:factory@127.0.0.1:5432/factory_seed';

/** A syntactically valid App, so a case about the database is not also a case about credentials. */
const APP = {
    GITHUB_MODE: 'app',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nnot-parsed-here\n-----END RSA PRIVATE KEY-----',
};
const NONE = { GITHUB_MODE: 'none' };

describe('the database is required', () => {
    it('refuses to boot without one', () => {
        // There is no in-memory mode any more. A process that forgot its DATABASE_URL used to
        // start, serve, and lose everything on restart; now it says so before it listens.
        expect(() => loadConfig({})).toThrow(/DATABASE_URL is required/);
    });

    it('names the two ways to fill it', () => {
        // The message has to answer "so what do I do", because the honest answer is two different
        // things depending on whether the reader has a token.
        expect(() => loadConfig({})).toThrow(/npm run seed/);
    });

    it('boots with a database and no credential, serving what is already stored', () => {
        // The browser check and a seeded demo both run this way: no credentials, no network, and
        // whatever is in the database still renders.
        expect(() => loadConfig({ DATABASE_URL: DEV, ...NONE })).not.toThrow();
    });
});

describe('a fetching process refuses a disposable database', () => {
    /*
     * The pairing that has to stay impossible. A disposable database is one `npm run test:db`
     * truncates and `npm run seed` fills with invented pull requests — so real fetched history put
     * there is either destroyed on the next test run or interleaved with synthetic rows that no
     * later query can separate. Both failures are silent.
     */
    // Keyed on GITHUB_MODE now, where it used to be keyed on GITHUB_TOKEN. Same guard, same
    // reasoning; the name of "this process fetches" changed when the credential did.
    it('throws in app mode', () => {
        expect(() => loadConfig({ ...APP, DATABASE_URL: TEST })).toThrow(/factory_test/);
        expect(() => loadConfig({ ...APP, DATABASE_URL: SEED })).toThrow(/factory_seed/);
    });

    it('names the way out that does not involve moving the database', () => {
        expect(() => loadConfig({ ...APP, DATABASE_URL: TEST })).toThrow(/GITHUB_MODE=none/);
    });

    it('allows it in none mode, because then nothing is fetched to lose', () => {
        // This is exactly how verify:ui and `npm run seed` run.
        expect(() => loadConfig({ ...NONE, DATABASE_URL: TEST })).not.toThrow();
        expect(() => loadConfig({ ...NONE, DATABASE_URL: SEED })).not.toThrow();
    });

    it('leaves a real database alone', () => {
        expect(() => loadConfig({ ...APP, DATABASE_URL: DEV })).not.toThrow();
    });
});

describe('removed settings are fatal, not ignored', () => {
    it('refuses DATA_SOURCE', () => {
        // It used to decide what the whole page was made of, so an ignored one would boot a
        // dashboard showing something other than what its operator believes.
        expect(() => loadConfig({ DATABASE_URL: DEV, ...NONE, DATA_SOURCE: 'fixture' })).toThrow(
            /DATA_SOURCE is no longer supported/,
        );
        expect(() => loadConfig({ DATABASE_URL: DEV, ...NONE, DATA_SOURCE: 'github' })).toThrow(
            /DATA_SOURCE is no longer supported/,
        );
    });

    it('refuses CACHE_TTL_SECONDS', () => {
        // A deployment that had raised it to protect its quota would otherwise silently drop to
        // the 60s-per-repo sync floor.
        expect(() => loadConfig({ DATABASE_URL: DEV, ...NONE, CACHE_TTL_SECONDS: '1800' })).toThrow(
            /CACHE_TTL_SECONDS is no longer supported/,
        );
    });
});

describe('the sync TTL floor', () => {
    it('defaults to one repo\'s worth, which is all this validator can check', () => {
        // It used to be MIN_SYNC_TTL_SECONDS_PER_REPO × the configured repo count. There is no
        // configured repo count any more — the App installation reports it — so the per-repo floor
        // moved to the stats service, which is the only thing that knows the number. See
        // stats.sync-ttl.test.ts.
        expect(loadConfig({ DATABASE_URL: DEV, ...NONE }).syncTtlMs).toBe(60_000);
    });

    it('rejects a value under the floor, so the cheap path stays cheap', () => {
        expect(() => loadConfig({ DATABASE_URL: DEV, ...NONE, SYNC_TTL_SECONDS: '30' })).toThrow(
            /at least 60/,
        );
    });

    it('is the only cache floor there is', () => {
        // The 300s-per-repo full-walk floor is gone with the full-walk-every-refresh behaviour it
        // protected. A full reconciliation is now gated on its own 24h schedule and on the
        // provider's reported remaining budget, which is strictly stronger than a clock.
        const config = loadConfig({ DATABASE_URL: DEV, ...NONE, SYNC_TTL_SECONDS: '900' });
        expect(config.syncTtlMs).toBe(900_000);
        expect('cacheTtlMs' in config).toBe(false);
    });
});
