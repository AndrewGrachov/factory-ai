/**
 * Regenerates `core/test/fixtures/sample-canonical.json` from the raw GitHub capture.
 *
 * `core` cannot import from `server`, and the raw capture belongs beside the adapter that
 * describes it — so the canonical fixture the core tests read is derived here and committed.
 * Run this after any change to `toCanonical()`; the core suite is measuring its output.
 *
 *   npx tsx server/scripts/capture-canonical.ts
 */
import { writeFileSync } from 'node:fs';
import { FIXTURE_REPO, fixturePayload } from '../src/github/fixture-payload.js';
import { toCanonical } from '../src/github/map.js';

const OUT = new URL('../../core/test/fixtures/sample-canonical.json', import.meta.url);

const prs = fixturePayload().map((pr) => toCanonical(pr, FIXTURE_REPO));
writeFileSync(OUT, `${JSON.stringify(prs, null, 2)}\n`);
console.log(`wrote ${prs.length} canonical PRs to ${OUT.pathname}`);
