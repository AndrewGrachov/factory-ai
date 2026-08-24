import type { Stats } from '@factory-ai/core';
import type { StatsPayload } from '../api/useStats.js';
import { pct, prLabel } from '../format.js';

export function DataQualityPanel({ stats, meta }: { stats: Stats; meta: StatsPayload['meta'] }) {
    const q = stats.quality;
    const range = meta.range;
    const repoCount = meta.repos.length;
    const items: string[] = [
        // The window bounds shown elsewhere are what the fetch returned, not what was asked
        // for; without this line a narrowed range looks like a shrinking repository.
        ...(range.from || range.to
            ? [
                  `Every figure above covers ${range.from?.slice(0, 10) ?? 'the start of the window'} to ${range.to?.slice(0, 10) ?? 'now'} only. PRs outside that range are excluded.`,
              ]
            : []),
        `AI pipeline labels cover ${q.labelledPrs} of ${q.mergedPrs} merged PRs — authorship is not measurable from metadata.`,
        // Never "0 reverts in 0 commits": that reads as a real answer.
        q.history
            ? `${q.history.reverts} reverts in ${q.history.commits} commits on ${q.history.branch} since ${q.history.since.slice(0, 10)} (${pct(q.revertRatio)}).`
            : `Revert rate unavailable — ${meta.revert.reason ?? 'branch history could not be read'}.`,
        `${stats.meta.counts.open} open PRs and ${stats.meta.counts.closedUnmerged} closed unmerged are excluded from every metric above.`,
        `${q.instantMerges} of ${q.mergedPrs} merged PRs went from opened to merged in under two minutes — release and merge-forward PRs. They count as merges and pull every latency median down.`,
    ];

    // Two counters, not one: "wrong repo" and "no hook" present identically on the page
    // otherwise — an empty telemetry panel with a healthy backend.
    const t = meta.telemetry;
    if (t.status === 'disabled') {
        items.push('Claude Code telemetry is not configured, so no AI usage is reported.');
    } else {
        if (t.sessionsWithoutHook > 0) {
            items.push(
                `${t.sessionsWithoutHook} agent session(s) sent telemetry but no branch, so they cannot reach a PR — install the agent-telemetry plugin with "claude plugin install agent-telemetry@factory-ai".`,
            );
        }
        if (t.otherRepoSessions > 0) {
            items.push(
                `${t.otherRepoSessions} agent session(s) happened in another repo and are excluded; this dashboard only counts ${t.repoFilter.join(', ')}.`,
            );
        }
        if (t.source === 'fixture') {
            items.push(
                'AI usage figures are synthetic fixture data, not measurements. Set TELEMETRY_SOURCE=postgres to report real sessions.',
            );
        }
    }

    const truncated = stats.meta.truncated;
    if (truncated.length) {
        items.push(
            `Distributions are incomplete for PRs ${truncated
                .map((t) => prLabel(t.repo, t.number, repoCount))
                .join(', ')} — more than 100 items in ${truncated[0]?.connections.join(', ')}. Totals are still exact.`,
        );
    }

    return (
        <section className="panel warn">
            <h2>Data quality</h2>
            <ul>
                {items.map((text) => (
                    <li key={text}>{text}</li>
                ))}
            </ul>
        </section>
    );
}
