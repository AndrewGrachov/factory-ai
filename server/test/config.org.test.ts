import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/** Required now, and none of these cases is about it. */
const DB = 'postgres://factory:factory@127.0.0.1:5432/factory_dev';
const env = (extra: NodeJS.ProcessEnv = {}) => ({ DATABASE_URL: DB, ...extra });

describe('the organization', () => {
    it('defaults the id to a literal, never to the github owner', () => {
        // Deriving the id from the owner would silently re-key every persisted row the day the
        // owner changed: the dashboard comes back empty and reads as data loss, not as a config
        // change. The name is derived for exactly the opposite reason — nothing keys on a label.
        expect(loadConfig(env()).orgId).toBe('default');
        expect(loadConfig(env({ GITHUB_OWNER: 'acme' })).orgId).toBe('default');
    });

    it('labels the organization with the github owner when no name is given', () => {
        expect(loadConfig(env()).orgName).toBe('Bellows-AI');
        expect(loadConfig(env({ GITHUB_OWNER: 'acme' })).orgName).toBe('acme');
        expect(loadConfig(env({ ORG_NAME: 'Bellows AI' })).orgName).toBe('Bellows AI');
    });

    it('treats an empty ORG_NAME as unset, so the selector is never blank', () => {
        expect(loadConfig(env({ ORG_NAME: '   ' })).orgName).toBe('Bellows-AI');
    });

    it('treats an empty ORG_ID as unset, consistent with every other empty value', () => {
        expect(loadConfig(env({ ORG_ID: '' })).orgId).toBe('default');
        expect(loadConfig(env({ ORG_ID: '  ' })).orgId).toBe('default');
    });

    it('rejects an id that cannot be a database key or a URL parameter', () => {
        // Rejected rather than normalised. A case-insensitive collision in a key is invisible:
        // "Bellows" and "bellows" would be two partitions that read as one.
        for (const id of [
            'Bellows AI',
            'BELLOWS',
            'Bellows',
            'bellows/front',
            'bellows.ai',
            '-bellows',
            '_bellows',
            'a'.repeat(40),
        ]) {
            expect(() => loadConfig(env({ ORG_ID: id })), id).toThrow(/ORG_ID must be/);
        }
    });

    it('refuses an id inside the reserved namespace the migration parks rows in', () => {
        // 005_organizations.sql backfills pre-organization rows to '__unclaimed__' and adopts them
        // once. A configured id in that namespace would make the adoption a no-op that looks like
        // it worked.
        expect(() => loadConfig(env({ ORG_ID: '__unclaimed__' }))).toThrow(/ORG_ID must be/);
        expect(() => loadConfig(env({ ORG_ID: '__anything' }))).toThrow(/ORG_ID must be/);
    });

    it('accepts the ids it should', () => {
        for (const id of ['bellows', 'a', 'bellows-ai', 'bellows_ai', '9to5', 'a'.repeat(39)]) {
            expect(loadConfig(env({ ORG_ID: id })).orgId, id).toBe(id);
        }
    });

    it('derives repos and repoNames from the organization list', () => {
        const config = loadConfig(env({ ORG_REPOS: 'widgets,other-owner/gadgets', GITHUB_OWNER: 'acme' }));
        expect(config.repos).toEqual([
            { owner: 'acme', name: 'widgets' },
            { owner: 'other-owner', name: 'gadgets' },
        ]);
        // One organization can span several GitHub owners: a Factory organization is not a GitHub
        // organization, and orgId has nothing to do with github.owner.
        expect(config.repoNames).toEqual(['acme/widgets', 'other-owner/gadgets']);
    });

    it('refuses GITHUB_REPOS instead of silently reverting to one repo', () => {
        // The one deliberate exception to "an unknown environment variable is ignored". A variable
        // that WAS meaningful and is now dropped reverts a two-repo dashboard to one repo and still
        // renders, indistinguishable from a repo genuinely removed.
        expect(() => loadConfig(env({ GITHUB_REPOS: 'a,b' }))).toThrow(/GITHUB_REPOS has moved to ORG_REPOS/);
    });

    it('treats an empty GITHUB_REPOS as unset, so a stale .env line still boots', () => {
        expect(() => loadConfig(env({ GITHUB_REPOS: '' }))).not.toThrow();
    });
});
