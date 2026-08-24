import { describe, expect, it } from 'vitest';
import { attribute } from '../src/telemetry.js';
import { FIXTURE_NOW, FIXTURE_REPO, joinKeys, samplePayload, sampleTelemetry } from './fixtures/load.js';

/**
 * Recomputes the headline telemetry figures from the raw fixtures without importing anything
 * from telemetry.ts, so a mistake on either side shows up as a mismatch rather than as two
 * agreeing wrong numbers. Same reasoning as metrics.independent.test.ts.
 *
 * The attribution rules are restated by hand below, deliberately. Importing the helpers would
 * make a wrong number invisible, which is the whole point of this file.
 */

const telemetry = sampleTelemetry();
const stats = attribute(joinKeys(), telemetry, { repos: [FIXTURE_REPO], now: FIXTURE_NOW });

// ---- hand-rolled reimplementation -------------------------------------------------------

const mine = telemetry.sessions.filter((s) => s.repo === FIXTURE_REPO);

/** Every merged-or-open PR, restated from the payload rather than from deriveAll(). */
const payloadPrs = samplePayload().map((pr) => ({
    number: pr.number,
    branch: pr.headRef,
    closesAt: pr.mergedAt ?? '9999',
}));

/** The owner of a piece of work: the first PR on that branch still open when it happened. */
function ownerOf(branch: string | null, from: string): number | null {
    if (branch === null) return null;
    const candidates = payloadPrs
        .filter((pr) => pr.branch === branch)
        .sort((a, b) => a.closesAt.localeCompare(b.closesAt));
    return candidates.find((pr) => pr.closesAt >= from)?.number ?? null;
}

const myIds = new Set(mine.map((s) => s.sessionId));
const payloadNumbers = new Set(payloadPrs.map((pr) => pr.number));

/** Sessions whose PR is named outright, restated by hand: link wins over branch. */
const linkedBySession = new Map<string, number[]>();
for (const link of telemetry.links) {
    if (!myIds.has(link.sessionId)) continue;
    if (link.repo !== FIXTURE_REPO) continue;
    if (!payloadNumbers.has(link.prNumber)) continue;
    linkedBySession.set(link.sessionId, [...(linkedBySession.get(link.sessionId) ?? []), link.prNumber]);
}
const singlyLinked = new Set(
    [...linkedBySession.entries()].filter(([, ns]) => ns.length === 1).map(([sid]) => sid),
);

// A linked session is attributed by number, so it leaves the branch partition entirely.
const mySplits = telemetry.splits.filter(
    (s) => myIds.has(s.sessionId) && !linkedBySession.has(s.sessionId),
);

// ---- assertions -------------------------------------------------------------------------

describe('totals, recomputed by hand', () => {
    it('matches on each token type', () => {
        const add = (pick: (t: (typeof mine)[number]['tokens']) => number | null) =>
            mine.reduce((sum, s) => sum + (pick(s.tokens) ?? 0), 0);
        expect(stats.totals.tokens.input).toBe(add((t) => t.input));
        expect(stats.totals.tokens.output).toBe(add((t) => t.output));
        expect(stats.totals.tokens.cacheRead).toBe(add((t) => t.cacheRead));
        expect(stats.totals.tokens.cacheCreation).toBe(add((t) => t.cacheCreation));
    });

    it('matches on session count, lines, and active hours', () => {
        expect(stats.totals.sessions).toBe(mine.length);
        expect(stats.totals.linesAdded).toBe(mine.reduce((s, x) => s + (x.linesAdded ?? 0), 0));
        expect(stats.totals.linesRemoved).toBe(mine.reduce((s, x) => s + (x.linesRemoved ?? 0), 0));
        const seconds = mine.reduce((s, x) => s + (x.activeSeconds ?? 0), 0);
        expect(stats.totals.activeHours).toBeCloseTo(seconds / 3600, 9);
    });

    it('matches on the edit accept ratio', () => {
        const accepted = mine.reduce((s, x) => s + (x.editsAccepted ?? 0), 0);
        const rejected = mine.reduce((s, x) => s + (x.editsRejected ?? 0), 0);
        expect(stats.totals.acceptRatio).toBeCloseTo(accepted / (accepted + rejected), 12);
    });
});

describe('the branch join, recomputed by hand', () => {
    it('agrees on which PR owns each piece of work', () => {
        const expected = new Map<number, number>();
        for (const [sid, numbers] of linkedBySession) {
            if (!singlyLinked.has(sid)) continue;
            const only = numbers[0] as number;
            expected.set(only, (expected.get(only) ?? 0) + 1);
        }
        for (const split of mySplits) {
            const owner = ownerOf(split.branch, split.from);
            if (owner === null) continue;
            expected.set(owner, (expected.get(owner) ?? 0) + 1);
        }
        const actual = new Map(
            stats.prs.filter((r) => r.sessions > 0).map((r) => [r.number, r.sessions]),
        );
        expect([...actual.keys()].sort((a, b) => a - b)).toEqual(
            [...expected.keys()].sort((a, b) => a - b),
        );
        for (const [number, count] of expected) expect(actual.get(number)).toBe(count);
    });

    it('agrees on the top three PRs by token usage', () => {
        const totals = new Map<number, number>();
        for (const split of mySplits) {
            if (split.share === null) continue;
            const owner = ownerOf(split.branch, split.from);
            if (owner === null) continue;
            const used = (split.tokens.input ?? 0) + (split.tokens.output ?? 0);
            totals.set(owner, (totals.get(owner) ?? 0) + used);
        }
        const expected = [...totals.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([number]) => number);

        const actual = stats.prs
            .filter((r) => r.tokens.input !== null)
            .sort((a, b) => ((b.tokens.input ?? 0) + (b.tokens.output ?? 0)) - ((a.tokens.input ?? 0) + (a.tokens.output ?? 0)))
            .slice(0, 3)
            .map((r) => r.number);

        expect(actual).toEqual(expected);
    });

    it('agrees on how many PRs have no telemetry at all', () => {
        const touched = new Set<number>();
        for (const numbers of linkedBySession.values()) for (const n of numbers) touched.add(n);
        for (const split of mySplits) {
            const owner = ownerOf(split.branch, split.from);
            if (owner !== null) touched.add(owner);
        }
        expect(stats.prsWithoutTelemetry).toBe(payloadPrs.length - touched.size);
    });

    it('agrees on the work that reaches no PR', () => {
        const orphans = mySplits.filter((s) => ownerOf(s.branch, s.from) === null);
        expect(stats.unmatched.sessions).toBe(new Set(orphans.map((s) => s.sessionId)).size);
        expect(stats.unmatched.tokens.input).toBe(
            orphans.reduce((sum, s) => sum + (s.tokens.input ?? 0), 0),
        );
    });
});

describe('landmarks pinned against the payload', () => {
    it('confirms the reused-branch hazard this join exists to handle', () => {
        // If this ever becomes 0, the time-containment matching is no longer load-bearing and
        // the simpler branch-only join would be correct. Until then it is not.
        const merged = samplePayload().filter((pr) => pr.mergedAt && pr.baseRef === 'dev');
        const counts = new Map<string, number>();
        for (const pr of merged) counts.set(pr.headRef, (counts.get(pr.headRef) ?? 0) + 1);
        const reused = [...counts.values()].filter((n) => n > 1).length;
        expect(reused).toBe(9);
    });

    it('pins the fixture shape, so a silent regeneration is caught', () => {
        expect(telemetry.sessions).toHaveLength(15);
        expect(telemetry.splits).toHaveLength(16);
        expect(telemetry.links).toHaveLength(4);
        expect(mine).toHaveLength(13);
        expect(telemetry.coverage.from).toBe('2026-04-15T12:00:00Z');
        expect(telemetry.coverage.to).toBe('2026-08-21T06:45:00Z');
    });
});
