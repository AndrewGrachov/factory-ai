import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { attribute, compute, deriveAll } from '@factory-ai/core';
import { readFileSync } from 'node:fs';
import type { CanonicalPr, PrTelemetryKey, TelemetryInput, TelemetryStats } from '@factory-ai/core';
import type { TelemetryMeta } from '../src/api/useStats.js';
import { AiUsagePanel } from '../src/panels/AiUsagePanel.js';
import { TokenUsagePanel } from '../src/panels/TokenUsagePanel.js';
import { PrTokenPanel } from '../src/panels/PrTokenPanel.js';
import { UsageVsOutcomePanel } from '../src/panels/UsageVsOutcomePanel.js';
import { DataQualityPanel } from '../src/panels/DataQualityPanel.js';
import { tokens } from '../src/format.js';

/**
 * A render smoke test, not a UI test. It exists because the null-not-zero contract is only
 * real if it survives to the markup: everything upstream can be correct and a single `?? 0`
 * in a panel still puts "0 tokens" on the page next to a PR nobody used an agent on.
 *
 * react-dom/server needs no DOM, so this stays in the default offline suite.
 */

const REPO = 'Leeloo-AI-RGA-OS/leeloo.ai';

const raw = JSON.parse(
    readFileSync(new URL('../../core/test/fixtures/sample-canonical.json', import.meta.url), 'utf8'),
) as CanonicalPr[];
const input = JSON.parse(
    readFileSync(new URL('../../core/test/fixtures/telemetry-sessions.json', import.meta.url), 'utf8'),
) as TelemetryInput;

const NOW = new Date('2026-08-21T12:00:00.000Z');
const derived = deriveAll(raw);
const stats = compute(derived, { baseBranch: 'dev', now: NOW });
const keys: PrTelemetryKey[] = derived.map((pr) => ({
    repo: pr.repo, number: pr.number, author: pr.author, headRefName: pr.headRefName, createdAt: pr.createdAt,
    mergedAt: pr.mergedAt, size: pr.size, cycleHours: pr.cycleHours,
    commitsAfterHumanReview: pr.commitsAfterHumanReview,
}));
const telemetry = attribute(keys, input, { repos: [REPO], now: NOW });
const empty = attribute(keys, { sessions: [], spans: [], splits: [], links: [], coverage: { from: null, to: null } }, { repos: [REPO], now: NOW });

const meta = (over: Partial<TelemetryMeta> = {}): TelemetryMeta => ({
    status: 'ok', reason: null, source: 'fixture', fetchedAt: NOW.toISOString(),
    ageSeconds: 0, stale: false, repoFilter: [REPO], otherRepoSessions: 1, sessionsWithoutHook: 1,
    ...over,
});

const render = (t: TelemetryStats, m: TelemetryMeta) =>
    [
        renderToStaticMarkup(<AiUsagePanel telemetry={t} meta={m} mergedPrs={stats.quality.mergedPrs} />),
        renderToStaticMarkup(<TokenUsagePanel telemetry={t} meta={m} />),
        renderToStaticMarkup(<PrTokenPanel telemetry={t} meta={m} repoCount={1} />),
        renderToStaticMarkup(<UsageVsOutcomePanel telemetry={t} meta={m} repoCount={1} />),
    ].join('\n');

describe('telemetry panels render', () => {
    it('renders real figures on the happy path', () => {
        const html = render(telemetry, meta());
        expect(html).toContain('441k');
        expect(html).toContain('#204');
        expect(html).toContain('shared — not divisible');
        expect(html).toContain('synthetic fixture');
        expect(html).not.toContain('NaN');
        expect(html).not.toContain('Infinity');
        expect(html).not.toContain('undefined');
    });

    it('renders em dashes, never zeros, on an empty store', () => {
        const html = render(empty, meta({ status: 'empty' }));
        expect(html).toContain('—');
        expect(html).not.toContain('NaN');
        expect(html).not.toContain('0 tokens');
        expect(html).toContain('No sessions in the coverage window yet');
        expect(html).toContain('No session has been matched to a PR yet');
    });

    it('plots linked PRs, not just branch-matched ones', () => {
        // Regression: the scatter filtered on 'exact' alone, so a dataset where every PR came
        // from a transcript pr-link rendered "nothing to plot" while the table beside it was
        // full. Types passed and the fixture passed; only a browser showed it.
        const linkedOnly: TelemetryStats = {
            ...telemetry,
            prs: telemetry.prs.map((r) =>
                r.attribution === 'exact' ? { ...r, attribution: 'linked' as const } : r,
            ),
        };
        const html = renderToStaticMarkup(
            <UsageVsOutcomePanel telemetry={linkedOnly} meta={meta()} />,
        );
        expect(html).not.toContain('nothing to plot');
        expect(html).toContain('<circle');
    });

    it('renders billions as B rather than thousands of M', () => {
        // A real run reported 4.5e9 cache-read tokens, which rendered as "4543.89M".
        expect(tokens(4_543_894_453)).toBe('4.54B');
        expect(tokens(20_300_494)).toBe('20.3M');
        expect(tokens(null)).toBe('—');
    });

    it('renders a reason and no numbers when unreachable', () => {
        const html = render(empty, meta({ status: 'unreachable', reason: 'connection refused' }));
        expect(html).toContain('panel bad');
        expect(html).toContain('connection refused');
        expect(html).not.toContain('NaN');
    });

    it('surfaces both setup failures in data quality', () => {
        const html = renderToStaticMarkup(
            <DataQualityPanel
                stats={stats}
                meta={{
                    fetchedAt: NOW.toISOString(), ageSeconds: 0, stale: false, source: 'fixture',
                    rateLimit: null, revert: { status: 'unavailable', reason: 'no token' },
                    organization: {
                        mode: 'config', current: { id: 'x-org', name: 'X Org' },
                        available: [{ id: 'x-org', name: 'X Org' }],
                    },
                    repos: [{ owner: 'x', name: 'y' }], baseBranch: 'dev',
                    range: { preset: 'all', from: null, to: null }, telemetry: meta(),
                }}
            />,
        );
        expect(html).toContain('agent-telemetry@factory-ai');
        expect(html).toContain('happened in another repo');
        expect(html).toContain('synthetic fixture data');
    });
});
