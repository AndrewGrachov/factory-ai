import type { Stats } from '@factory-ai/core';
import type { StatsPayload } from '../api/useStats.js';
import { pct } from '../format.js';

export function DataQualityPanel({ stats, meta }: { stats: Stats; meta: StatsPayload['meta'] }) {
    const q = stats.quality;
    const items: string[] = [
        `AI pipeline labels cover ${q.labelledPrs} of ${q.mergedPrs} merged PRs — authorship is not measurable from metadata.`,
        // Never "0 reverts in 0 commits": that reads as a real answer.
        q.history
            ? `${q.history.reverts} reverts in ${q.history.commits} commits on ${q.history.branch} since ${q.history.since.slice(0, 10)} (${pct(q.revertRatio)}).`
            : `Revert rate unavailable — ${meta.revert.reason ?? 'branch history could not be read'}.`,
        `${stats.meta.counts.open} open PRs and ${stats.meta.counts.closedUnmerged} closed unmerged are excluded from every metric above.`,
        `${q.instantMerges} of ${q.mergedPrs} merged PRs went from opened to merged in under two minutes — release and merge-forward PRs. They count as merges and pull every latency median down.`,
    ];

    const truncated = stats.meta.truncated;
    if (truncated.length) {
        items.push(
            `Distributions are incomplete for PRs ${truncated
                .map((t) => `#${t.number}`)
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
