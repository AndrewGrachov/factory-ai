import { median } from '@factory-ai/core';
import type { Stats } from '@factory-ai/core';

/**
 * A checkout's pull-request figures, joined from the payload the dashboard already fetched.
 *
 * The honest version of "show this repo's metrics", and the honesty is the whole point of the file.
 * `Stats` has NO per-repo aggregate: every headline number is computed across the measured set and
 * cannot be split back apart. What does carry a repo is `stats.size.scatter`, one row per merged PR
 * with a measured cycle — so that is what this counts, and the label says exactly that rather than
 * borrowing `mergedPrs`, which is an org-wide total.
 *
 * This is the path docs/repos.md sanctions: filter `meta.repos` and the `repo` field on each row
 * rather than refetching.
 */

export interface RepoMetrics {
    /**
     * Why there are no figures, or null when there are.
     *
     * Not a boolean. "Still cloning" and "outside what this dashboard measures" send the reader to
     * completely different places, and both are different again from "measured, and there is
     * nothing".
     */
    unavailable: string | null;
    /**
     * Merged PRs with a measured cycle time. A real 0 when the repo is in scope and had none —
     * distinct from `null`, which means nobody counted.
     */
    mergedWithCycle: number | null;
    /** Median hours from open to merge. Null for an empty set: the median of nothing is not zero. */
    medianCycleHours: number | null;
    /** Median changed lines. Null for the same reason. */
    medianSize: number | null;
}

// `median` comes from core, and that is not a convenience: a metric definition that exists twice
// is one that can drift, and nothing would fail when it did. Core's also takes `(number | null)[]`,
// where a hand-rolled one sorts a null as `undefined`.

export interface JoinInput {
    readonly owner: string;
    readonly name: string;
    /** The repos the figures on screen were measured over, from `meta.repos`. */
    readonly measured: readonly { owner: string; name: string }[];
    readonly stats: Stats | null;
}

export function repoMetrics({ owner, name, measured, stats }: JoinInput): RepoMetrics {
    const absent: RepoMetrics = {
        unavailable: '',
        mergedWithCycle: null,
        medianCycleHours: null,
        medianSize: null,
    };

    if (!stats) return { ...absent, unavailable: 'No figures have been fetched yet' };

    // A repo can be checked out and not measured: the dashboard aggregates what the App
    // installation reports, and somebody may hold a checkout of something outside that. Reported
    // as its own reason, because "0 pull requests" would be a measurement nobody made.
    const inScope = measured.some((repo) => repo.owner === owner && repo.name === name);
    if (!inScope) return { ...absent, unavailable: 'Not part of the figures on the dashboard' };

    const rows = stats.size.scatter.filter((row) => row.repo === `${owner}/${name}`);
    return {
        unavailable: null,
        // A real count, zero included: the repo IS measured, and "no merged PRs in this range" is
        // a fact rather than an absence.
        mergedWithCycle: rows.length,
        medianCycleHours: median(rows.map((row) => row.hours)),
        medianSize: median(rows.map((row) => row.size)),
    };
}
