import { readFileSync } from 'node:fs';
import type { RawPullRequest } from '../../src/types.js';

let cached: RawPullRequest[] | null = null;

/** Real API response covering 203 PRs, captured 2026-08-21. Already post-backfill. */
export function samplePayload(): RawPullRequest[] {
    if (!cached) {
        const raw = readFileSync(new URL('./sample-payload.json', import.meta.url), 'utf8');
        cached = JSON.parse(raw) as RawPullRequest[];
    }
    return cached;
}

/** The window the fixture was captured in, so `partial` week flags stay stable. */
export const FIXTURE_NOW = new Date('2026-08-21T12:00:00.000Z');
