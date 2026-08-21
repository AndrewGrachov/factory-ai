import type { Stats } from '@factory-ai/core';
import { Card } from '../components/Card.js';
import { duration, num, pct } from '../format.js';

export function HeadlineCards({ stats }: { stats: Stats }) {
    const h = stats.headline;
    const { threads, meta } = stats;
    return (
        <section className="cards">
            <Card
                value={pct(h.unresolvedThreadRatio)}
                label="review threads unresolved"
                note={`${threads.total - threads.resolved} of ${threads.total}`}
            />
            <Card
                value={num(h.mergesPerWeek, 1)}
                label={`PRs merged to ${meta.baseBranch} / week`}
                note="median, full weeks"
            />
            <Card
                value={duration(h.cycleP50)}
                label="cycle time p50"
                note={`p90 ${duration(h.cycleP90)}`}
            />
            <Card
                value={pct(h.reworkAfterHumanReview)}
                label="PRs reworked after human review"
                note={`${pct(h.reworkAfterAnyReview)} after any review`}
            />
            <Card
                value={`${num(h.botThreadsPerPr, 1)} / ${num(h.humanThreadsPerPr, 2)}`}
                label="threads per PR, bot / human"
                note="line comments only"
            />
            <Card
                value={`${num(h.medianSize, 0)} LOC`}
                label="median PR size"
                note={`${num(stats.size.medianChangedFiles, 0)} files`}
            />
        </section>
    );
}
