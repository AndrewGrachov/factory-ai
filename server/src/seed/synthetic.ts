/**
 * A synthetic dataset, shaped like a real one.
 *
 * This exists because the database is now the only source a running dashboard reads from, so
 * "run it without touching GitHub" has to mean "run it against a database somebody filled in"
 * rather than "run it against a replayed HTTP payload". The generator emits `CanonicalPr` — the
 * same provider-neutral shape the adapter produces — so seeded data goes through the real write
 * path and exercises the real store rather than routing around it.
 *
 * DETERMINISTIC ON PURPOSE. A fresh random dataset per run would make the browser check's
 * assertions unstable and every screenshot diff meaningless, so the PRNG is seeded and the output
 * is a pure function of `SeedOptions`. Change anything here and the numbers move — which is why
 * the browser spec asserts on structure and on a couple of pinned landmarks, never on a figure
 * that this file is free to change.
 *
 * This data is SYNTHETIC and must never be mistaken for measurement. Nothing here is a real PR,
 * a real review or a real token count. The seeding CLI refuses any database whose name does not
 * mark it disposable, which is the mechanical half of that promise; `meta.synthetic` on the
 * payload is the half the reader sees.
 */
import type { CanonicalCommit, CanonicalPr, CanonicalReview, CanonicalReviewThread } from '@factory-ai/core';
import type { BranchCommit } from '../forge.js';

export interface SeedOptions {
    /** "owner/name". Every generated PR is stamped with it, exactly as the adapter would. */
    readonly repo: string;
    /** Where merged PRs land, and the branch whose history carries the reverts. */
    readonly baseBranch: string;
    /** The dataset ends here. Everything is generated backwards from it. */
    readonly now: Date;
    /** How far back to generate. 26 weeks gives the weekly charts a real shape. */
    readonly weeks?: number;
    /** PRs per week. The generator varies the real count around this. */
    readonly perWeek?: number;
    /** Changing this reshuffles the whole dataset while keeping it reproducible. */
    readonly seed?: number;
}

export interface SyntheticData {
    readonly prs: CanonicalPr[];
    /** Base-branch history, the input to the revert rate. */
    readonly branchCommits: BranchCommit[];
    /** How far back `branchCommits` reaches — `branch_history.covered_from`. */
    readonly coveredFrom: string;
    readonly sessions: SyntheticSession[];
}

/**
 * One agent session, in the shape the two telemetry tables want.
 *
 * Not `TelemetryInput`: that is the *read* model, assembled by SQL views out of raw datapoints.
 * Seeding has to write what the views read, or the seeded database would disagree with a real one
 * about its own schema.
 */
export interface SyntheticSession {
    readonly sessionId: string;
    readonly repo: string;
    readonly branch: string;
    readonly firstSeen: string;
    readonly lastSeen: string;
    readonly samples: number;
    /** Null when this session's work was never opened as a PR — the unmatched bucket. */
    readonly prNumber: number | null;
    /** field -> value, already summed. Written as delta datapoints. */
    readonly fields: Readonly<Record<string, number>>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const AUTHORS = ['ann', 'bruno', 'chi', 'dev', 'eli', 'fen'] as const;
const REVIEWERS = ['bruno', 'chi', 'dev', 'ann', 'claude[bot]', 'github-actions[bot]'] as const;
const BOTS = new Set(['claude[bot]', 'github-actions[bot]']);
const LABELS = ['bug', 'feature', 'chore', 'refactor', 'docs', 'infra'] as const;
const AREAS = ['auth', 'billing', 'search', 'ingest', 'ui', 'api', 'metrics', 'cache'] as const;
const VERBS = ['fix', 'add', 'refactor', 'tidy', 'harden', 'speed up', 'document'] as const;

/**
 * mulberry32. Small, fast, and — the only property that matters here — identical across Node
 * versions and platforms, which `Math.random()` seeded by anything is not.
 */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
}

export function generate(options: SeedOptions): SyntheticData {
    const { repo, baseBranch, now } = options;
    const weeks = options.weeks ?? 26;
    const perWeek = options.perWeek ?? 8;
    const random = rng(options.seed ?? 20_260_824);

    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
    const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
    const chance = (p: number) => random() < p;

    const start = new Date(now.getTime() - weeks * 7 * DAY);
    const prs: CanonicalPr[] = [];
    const sessions: SyntheticSession[] = [];
    let number = 100;

    for (let week = 0; week < weeks; week += 1) {
        // Varied per week, or every bar on the throughput chart is the same height and the
        // median-merges figure is indistinguishable from a constant.
        //
        // The occasional dead week is deliberate. `weeklySeries()` seeds every week in the window
        // including the empty ones — a median over only the weeks that had a merge overstates
        // throughput — and a dataset where every single week is busy never exercises that.
        const count = chance(0.08) ? 0 : Math.max(1, perWeek + between(-3, 3));

        for (let i = 0; i < count; i += 1) {
            number += 1;
            const createdAt = new Date(start.getTime() + week * 7 * DAY + between(0, 6) * DAY + between(9, 18) * HOUR);
            if (createdAt >= now) continue;

            const author = pick(AUTHORS);
            const area = pick(AREAS);
            const headRef = `${pick(['feat', 'fix', 'chore'])}/${area}-${number}`;

            // Cycle time is lognormal-ish in practice: most PRs land in a day or two, a few sit
            // for a fortnight. A uniform spread would make p50 and p90 nearly equal and hide the
            // long tail the cycle panel exists to show.
            const cycleHours = chance(0.75) ? between(1, 40) : between(60, 380);
            const closesAt = new Date(createdAt.getTime() + cycleHours * HOUR);
            const settled = closesAt < now;

            // The tail of the window stays open on purpose: a dataset where everything is merged
            // reports an unresolved-thread ratio of ~0 and an empty "open PRs" count.
            const state: CanonicalPr['state'] = !settled
                ? 'open'
                : chance(0.08)
                  ? 'closed'
                  : 'merged';

            const mergedAt = state === 'merged' ? closesAt.toISOString() : null;
            const closedAt = state === 'open' ? null : closesAt.toISOString();
            const isDraft = state === 'open' && chance(0.12);
            const readyAt = chance(0.25)
                ? new Date(createdAt.getTime() + between(1, 8) * HOUR).toISOString()
                : null;

            // A long tail matters here: the size histogram's top bucket and the "oversized PR"
            // story are both invisible if nothing ever exceeds a few hundred lines.
            const additions = chance(0.7) ? between(5, 240) : chance(0.9) ? between(300, 1800) : between(3_000, 9_000);
            const deletions = Math.floor(additions * (0.15 + random() * 0.6));
            const changedFiles = Math.max(1, Math.round((additions + deletions) / between(40, 120)));

            const span = cycleHours * HOUR;
            const at = (fraction: number) => new Date(createdAt.getTime() + Math.round(span * fraction));

            /*
             * Ordering here is the whole point, not decoration.
             *
             * `rework.afterAnyReview` counts PRs with a commit dated after their first review, so
             * interleaving commits and reviews evenly across one window makes almost every PR
             * rework — 98.8% on the first run of this generator, against a plausible 30-40%. So
             * the work happens first, review follows it, and only some PRs get follow-up commits.
             */
            const reviewCount = state === 'open' && chance(0.4) ? 0 : between(0, 6);
            const firstReviewAt = 0.55 + random() * 0.25;

            const commitCount = between(1, 14);
            const commits: CanonicalCommit[] = Array.from({ length: commitCount }, (_, c) => ({
                sha: sha(`${repo}#${number}c${c}`),
                // Pushed before review opens.
                committedAt: at((firstReviewAt * (c + 1)) / (commitCount + 1)).toISOString(),
            }));

            const reviews: CanonicalReview[] = Array.from({ length: reviewCount }, (_, r) => {
                const reviewer = pick(REVIEWERS);
                const providerState = pick(['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED']);
                return {
                    reviewKey: `${repo}#${number}r${r}`,
                    author: { login: reviewer },
                    state:
                        providerState === 'APPROVED'
                            ? 'approved'
                            : providerState === 'COMMENTED'
                              ? 'commented'
                              : 'changes_requested',
                    providerState,
                    submittedAt: at(
                        firstReviewAt + ((0.98 - firstReviewAt) * r) / Math.max(1, reviewCount),
                    ).toISOString(),
                };
            });

            // The rework itself: a follow-up push answering the review. Only for some PRs, and
            // only where there was a review to answer.
            if (reviewCount > 0 && chance(0.38)) {
                const extra = between(1, 3);
                for (let e = 0; e < extra; e += 1) {
                    commits.push({
                        sha: sha(`${repo}#${number}rw${e}`),
                        committedAt: at(firstReviewAt + (0.99 - firstReviewAt) * ((e + 1) / (extra + 1))).toISOString(),
                    });
                }
            }

            const threadCount = reviewCount === 0 ? 0 : between(0, 9);
            const threads: CanonicalReviewThread[] = Array.from({ length: threadCount }, (_, t) => {
                // A merged PR has usually had its threads resolved; an open one usually has not.
                // Flat resolution would make the headline unresolved ratio a constant.
                const isResolved = state === 'merged' ? chance(0.82) : chance(0.35);
                const commenter = pick(REVIEWERS);
                return {
                    threadKey: `${repo}#${number}t${t}`,
                    isResolved,
                    isOutdated: !isResolved && chance(0.3),
                    firstCommentAuthor: { login: commenter },
                    firstCommentAt: new Date(
                        createdAt.getTime() + Math.round((cycleHours * HOUR * (t + 1)) / (threadCount + 1)),
                    ).toISOString(),
                    // Some threads are opened outside any review, which is what makes
                    // bodyOnlyReviews a real number rather than always zero.
                    parentReviewKey: reviews.length && chance(0.75) ? (pick(reviews).reviewKey as string) : null,
                };
            });

            const labels = Array.from(new Set(Array.from({ length: between(0, 3) }, () => pick(LABELS))));

            prs.push({
                provider: 'github',
                repo,
                number,
                title: `${pick(VERBS)} ${area} ${pick(['handling', 'path', 'flow', 'guard', 'limits'])}`,
                state,
                isDraft,
                baseRef: baseBranch,
                headRef,
                createdAt: createdAt.toISOString(),
                mergedAt,
                closedAt,
                updatedAt: (closedAt ?? new Date(createdAt.getTime() + between(1, 20) * HOUR).toISOString()),
                additions,
                deletions,
                changedFiles,
                author: { login: author },
                // The authoritative total, and it has to be recomputed rather than reuse the
                // `commitCount` the loop started from: the rework commits above are appended
                // after the fact, and a total that disagreed with its own complete list would be
                // a wrong number this generator invented for itself.
                commitCount: commits.length,
                reviewCount,
                threadCount,
                issueCommentCount: between(0, 5),
                // A real number, not null: the synthetic provider "observes" force pushes, and a
                // null here would make the rework panel report unavailable across the whole set.
                forcePushCount: chance(0.25) ? between(1, 3) : 0,
                readyAt,
                commits,
                reviews,
                threads,
                labels,
                // Nothing is truncated: the generator never emits more children than it lists, so
                // claiming otherwise would put a caveat on the page that the data contradicts.
                truncated: [],
            });

            // Most, not all, PRs get a session. The gap is what makes prsWithoutTelemetry and the
            // "attribution starts when the plugin was installed" story visible.
            if (chance(0.72)) {
                sessions.push(session(repo, headRef, number, createdAt, cycleHours, random));
            }
        }
    }

    // A few sessions on branches that never became a PR — the unmatched bucket, which is a real
    // state and reads as a bug when it is always empty.
    for (let i = 0; i < 6; i += 1) {
        const at = new Date(now.getTime() - between(1, weeks * 7) * DAY);
        sessions.push(session(repo, `spike/${pick(AREAS)}-${i}`, null, at, between(2, 20), random));
    }

    const { commits: branchCommits, coveredFrom } = history(repo, baseBranch, prs, start, random);

    return { prs, branchCommits, coveredFrom, sessions };
}

function session(
    repo: string,
    branch: string,
    prNumber: number | null,
    createdAt: Date,
    cycleHours: number,
    random: () => number,
): SyntheticSession {
    const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
    const from = new Date(createdAt.getTime() - between(1, 6) * HOUR);
    const activeSeconds = between(600, 9000);
    const to = new Date(from.getTime() + Math.min(cycleHours * HOUR, activeSeconds * 1000 * between(2, 5)));
    const input = between(4_000, 60_000);

    return {
        sessionId: sha(`${repo}:${branch}:${createdAt.toISOString()}`).slice(0, 32),
        repo,
        branch,
        firstSeen: from.toISOString(),
        lastSeen: to.toISOString(),
        // Sampled roughly every 20s, so the count follows the span rather than being invented.
        samples: Math.max(1, Math.round((to.getTime() - from.getTime()) / 20_000)),
        prNumber,
        fields: {
            tokens_input: input,
            tokens_output: between(1_000, 18_000),
            // Cache reads dwarf fresh input on a long conversation, which is what makes the token
            // panel's split worth drawing at all.
            tokens_cacheRead: input * between(8, 30),
            tokens_cacheCreation: between(2_000, 40_000),
            lines_added: between(10, 700),
            lines_removed: between(2, 300),
            edits_accept: between(2, 60),
            edits_reject: between(0, 12),
            active_seconds: activeSeconds,
        },
    };
}

/**
 * Base-branch history: one commit per merged PR, plus a scattering of reverts.
 *
 * The headline is what gets stored, never a precomputed verdict, so these have to *read* as
 * reverts to `isRevertHeadline` rather than being flagged out of band — same contract the real
 * scanner works under.
 */
function history(
    repo: string,
    baseBranch: string,
    prs: readonly CanonicalPr[],
    start: Date,
    random: () => number,
): { commits: BranchCommit[]; coveredFrom: string } {
    const commits: BranchCommit[] = [];
    const merged = prs.filter((pr) => pr.mergedAt !== null);

    for (const pr of merged) {
        commits.push({
            sha: sha(`${repo}:${baseBranch}:${pr.number}`),
            committedAt: pr.mergedAt as string,
            messageHeadline: `${pr.title} (#${pr.number})`,
        });
        // ~4%, which lands the revert rate in the low single digits — the range where the metric
        // is informative. A rate of 0 is indistinguishable from a broken scanner.
        if (random() < 0.04) {
            commits.push({
                sha: sha(`${repo}:${baseBranch}:revert:${pr.number}`),
                committedAt: new Date(Date.parse(pr.mergedAt as string) + 6 * HOUR).toISOString(),
                messageHeadline: `Revert "${pr.title} (#${pr.number})"`,
            });
        }
    }

    commits.sort((a, b) => a.committedAt.localeCompare(b.committedAt));
    return { commits, coveredFrom: start.toISOString() };
}

/** Not cryptographic and never claims to be — it only has to be stable and look like a sha. */
function sha(input: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < input.length; i += 1) {
        const ch = input.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2_654_435_761);
        h2 = Math.imul(h2 ^ ch, 1_597_334_677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507) ^ Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507) ^ Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);
    const a = (h2 >>> 0).toString(16).padStart(8, '0');
    const b = (h1 >>> 0).toString(16).padStart(8, '0');
    return `${a}${b}${a}${b}${a}`.slice(0, 40);
}

export const SYNTHETIC_BOTS = BOTS;
