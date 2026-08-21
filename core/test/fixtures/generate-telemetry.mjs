/**
 * Regenerates telemetry-sessions.json:
 *
 *     node core/test/fixtures/generate-telemetry.mjs
 *
 * Committed so the fixture is reproducible and reviewable as intent rather than as 600 lines
 * of JSON. Unlike sample-payload.json, which is real captured data, this is SYNTHETIC — hence
 * the loud badge the UI shows when it is the active source.
 *
 * Every branch name below is a real headRefName from sample-payload.json, and every timestamp
 * is positioned against that PR's real window. Invented branch names would join to nothing and
 * prove nothing.
 *
 * The eight degradation cases are the point of this file. Each session is labelled with the
 * case it exercises; deleting one silently removes a test.
 */
import { writeFileSync } from 'node:fs';

const REPO = 'Leeloo-AI-RGA-OS/leeloo.ai';
const sessions = [];
const spans = [];
const splits = [];
const links = [];

/**
 * Shares are applied to the session totals exactly, so the conservation assertion in
 * telemetry.attribution.test.ts is testing a real property rather than a coincidence.
 */
function session(id, opts) {
    const {
        repo = REPO, from, to, tokens, linesAdded, linesRemoved, editsAccepted, editsRejected,
        activeSeconds, commits = 0, pullRequests = 0, granularity = 'window', parts = [],
    } = opts;

    sessions.push({
        sessionId: id, agent: 'claude-code', repo, firstSeen: from, lastSeen: to, tokens,
        linesAdded, linesRemoved, editsAccepted, editsRejected, activeSeconds, commits,
        pullRequests, granularity,
    });

    for (const part of parts) {
        if (repo !== null) {
            spans.push({
                sessionId: id, repo, branch: part.branch, headSha: part.sha ?? null,
                from: part.from, to: part.to, samples: part.samples ?? 3,
            });
        }
        const share = part.share;
        const scale = (v) => (share === null || v === null ? null : Math.round(v * share));
        splits.push({
            sessionId: id, branch: part.branch, from: part.from, to: part.to, share,
            tokens: {
                input: scale(tokens.input), output: scale(tokens.output),
                cacheRead: scale(tokens.cacheRead), cacheCreation: scale(tokens.cacheCreation),
            },
            linesAdded: scale(linesAdded), linesRemoved: scale(linesRemoved),
            editsAccepted: scale(editsAccepted), editsRejected: scale(editsRejected),
            activeSeconds: scale(activeSeconds),
        });
    }
}

const T = (input, output, cacheRead, cacheCreation) => ({ input, output, cacheRead, cacheCreation });

// Case 1: one session, one branch -> PR #204 'exact'.
session('s01-exact-single', {
    from: '2026-08-21T06:20:00Z', to: '2026-08-21T06:45:00Z',
    tokens: T(74000, 12000, 410000, 31000), linesAdded: 380, linesRemoved: 116,
    editsAccepted: 18, editsRejected: 2, activeSeconds: 1320, commits: 3, pullRequests: 1,
    parts: [{ branch: 'ci/pr-review-real-verification', from: '2026-08-21T06:20:00Z', to: '2026-08-21T06:45:00Z', share: 1, sha: 'a1b2c3d' }],
});

// Case 2: two sessions on one branch -> PR #183 aggregates both.
session('s02-multi-a', {
    from: '2026-08-17T08:20:00Z', to: '2026-08-17T08:45:00Z',
    tokens: T(51000, 9000, 288000, 17000), linesAdded: 240, linesRemoved: 90,
    editsAccepted: 11, editsRejected: 1, activeSeconds: 1080, commits: 2,
    parts: [{ branch: 'LEEL-11082', from: '2026-08-17T08:20:00Z', to: '2026-08-17T08:45:00Z', share: 1 }],
});
session('s03-multi-b', {
    from: '2026-08-17T08:46:00Z', to: '2026-08-17T09:02:00Z',
    tokens: T(33000, 6000, 190000, 8000), linesAdded: 300, linesRemoved: 44,
    editsAccepted: 7, editsRejected: 3, activeSeconds: 720, commits: 1, pullRequests: 1,
    parts: [{ branch: 'LEEL-11082', from: '2026-08-17T08:46:00Z', to: '2026-08-17T09:02:00Z', share: 1 }],
});

// Case 3: one session across two branches, divisible -> PRs #10 and #11 both 'exact'.
session('s04-split-window', {
    from: '2026-04-20T14:30:00Z', to: '2026-04-20T16:00:00Z',
    tokens: T(60000, 10000, 300000, 20000), linesAdded: 200, linesRemoved: 50,
    editsAccepted: 10, editsRejected: 5, activeSeconds: 3000, commits: 4,
    parts: [
        { branch: 'hotfix-0.79.5', from: '2026-04-20T14:30:00Z', to: '2026-04-20T15:02:00Z', share: 0.6 },
        { branch: 'hotfix-0.79.6', from: '2026-04-20T15:10:00Z', to: '2026-04-20T16:00:00Z', share: 0.4 },
    ],
});

// Case 4: one session across two branches, NOT divisible -> PRs #5 and #7 both 'shared'.
// LEEL-10674 is reused by #7 and #37, so this also pins that the from-time selects #7.
session('s05-shared-cumulative', {
    from: '2026-04-15T12:00:00Z', to: '2026-04-15T14:00:00Z',
    tokens: T(48000, 8000, 260000, 14000), linesAdded: 150, linesRemoved: 30,
    editsAccepted: 9, editsRejected: 2, activeSeconds: 2400, commits: 2, granularity: 'session',
    parts: [
        { branch: 'hotfix-0.79.3', from: '2026-04-15T12:00:00Z', to: '2026-04-15T12:35:00Z', share: null },
        { branch: 'LEEL-10674', from: '2026-04-15T12:40:00Z', to: '2026-04-15T14:00:00Z', share: null },
    ],
});

// Case 5: the same reused branch, a month later -> must select #37, not #7.
session('s06-reuse-second', {
    from: '2026-05-12T09:50:00Z', to: '2026-05-12T11:00:00Z',
    tokens: T(29000, 5000, 150000, 9000), linesAdded: 120, linesRemoved: 60,
    editsAccepted: 6, editsRejected: 1, activeSeconds: 3600, commits: 2, pullRequests: 1,
    parts: [{ branch: 'LEEL-10674', from: '2026-05-12T09:50:00Z', to: '2026-05-12T11:00:00Z', share: 1 }],
});

// Case 6: a branch that never had a PR -> 'unmatched', reported rather than dropped.
session('s07-no-pr', {
    from: '2026-07-10T09:00:00Z', to: '2026-07-10T09:30:00Z',
    tokens: T(12000, 2000, 60000, 3000), linesAdded: 40, linesRemoved: 10,
    editsAccepted: 3, editsRejected: 4, activeSeconds: 900,
    parts: [{ branch: 'chore/scratch-notes', from: '2026-07-10T09:00:00Z', to: '2026-07-10T09:30:00Z', share: 1 }],
});

// Case 7: detached HEAD -> in totals, matches no PR, never coerced onto one.
session('s08-detached', {
    from: '2026-07-11T09:00:00Z', to: '2026-07-11T09:20:00Z',
    tokens: T(7000, 1200, 30000, 1500), linesAdded: 12, linesRemoved: 4,
    editsAccepted: 1, editsRejected: 0, activeSeconds: 600,
    parts: [{ branch: null, from: '2026-07-11T09:00:00Z', to: '2026-07-11T09:20:00Z', share: 1 }],
});

// Case 8: another repo -> excluded from totals, counted in otherRepoSessions. Deliberately the
// largest session in the file, so a broken filter shows up as an obviously inflated total.
session('s09-other-repo', {
    repo: 'Leeloo-AI-RGA-OS/other-service', from: '2026-07-12T09:00:00Z', to: '2026-07-12T10:00:00Z',
    tokens: T(90000, 15000, 500000, 40000), linesAdded: 900, linesRemoved: 300,
    editsAccepted: 40, editsRejected: 5, activeSeconds: 3600, commits: 6, pullRequests: 2,
    parts: [{ branch: 'feat/other-thing', from: '2026-07-12T09:00:00Z', to: '2026-07-12T10:00:00Z', share: 1 }],
});

// Case 9: telemetry arrived but the hook never reported -> sessionsWithoutHook. No spans, no
// splits: without a branch there is nothing to attribute.
session('s10-no-hook', {
    repo: null, from: '2026-07-13T09:00:00Z', to: '2026-07-13T09:40:00Z',
    tokens: T(20000, 4000, 100000, 6000), linesAdded: 70, linesRemoved: 20,
    editsAccepted: 5, editsRejected: 1, activeSeconds: 1500, commits: 1,
});

// Case 10: cumulative but single-branch, so still exactly attributable -> PR #145 'exact'.
// Cumulative temporality alone does not make a session indivisible; holding two branches does.
session('s11-single-cumulative', {
    from: '2026-07-21T06:00:00Z', to: '2026-07-21T06:30:00Z',
    tokens: T(18000, 3000, 95000, 5000), linesAdded: 100, linesRemoved: 25,
    editsAccepted: 4, editsRejected: 0, activeSeconds: 1500, commits: 1, granularity: 'session',
    parts: [{ branch: 'hotfix-0.80.2', from: '2026-07-21T06:00:00Z', to: '2026-07-21T06:30:00Z', share: 1 }],
});

// Case 11: work on a branch after every PR on it merged -> 'unmatched', not back-dated onto #5.
session('s12-after-merge', {
    from: '2026-06-01T09:00:00Z', to: '2026-06-01T09:25:00Z',
    tokens: T(9000, 1500, 40000, 2000), linesAdded: 25, linesRemoved: 8,
    editsAccepted: 2, editsRejected: 1, activeSeconds: 780,
    parts: [{ branch: 'hotfix-0.79.3', from: '2026-06-01T09:00:00Z', to: '2026-06-01T09:25:00Z', share: 1 }],
});

// Case 12: a still-open PR -> matches, because an open PR is still accepting work.
session('s13-open-pr', {
    from: '2026-08-20T10:00:00Z', to: '2026-08-20T10:50:00Z',
    tokens: T(41000, 7000, 220000, 12000), linesAdded: 160, linesRemoved: 55,
    editsAccepted: 8, editsRejected: 2, activeSeconds: 2700, commits: 2,
    parts: [{ branch: 'LEEL-11013', from: '2026-08-20T10:00:00Z', to: '2026-08-20T10:50:00Z', share: 1 }],
});

// Case 13: a transcript pr-link names the PR outright -> 'linked', the strongest tier.
// Deliberately ALSO on a branch that matches a different PR (#40 used 'LEEL-10406'), to pin
// that the link wins and the branch split is not counted a second time.
session('s14-linked', {
    from: '2026-07-02T21:05:00Z', to: '2026-07-02T21:20:00Z',
    tokens: T(37000, 6500, 180000, 11000), linesAdded: 140, linesRemoved: 35,
    editsAccepted: 9, editsRejected: 1, activeSeconds: 900, commits: 2, pullRequests: 1,
    parts: [{ branch: 'LEEL-10995-e2e-stack-improvements', from: '2026-07-02T21:05:00Z', to: '2026-07-02T21:20:00Z', share: 1 }],
});
links.push({ sessionId: 's14-linked', repo: REPO, prNumber: 128, at: '2026-07-02T21:19:00Z' });

// Case 14: one session opened two PRs, so its usage cannot be placed on either -> both
// 'shared'. Same reasoning as a session holding two branches.
session('s15-linked-ambiguous', {
    from: '2026-06-29T20:58:00Z', to: '2026-06-29T21:06:00Z',
    tokens: T(22000, 4000, 110000, 7000), linesAdded: 80, linesRemoved: 20,
    editsAccepted: 5, editsRejected: 2, activeSeconds: 480, commits: 2, pullRequests: 2,
    parts: [{ branch: 'update-jira-automation', from: '2026-06-29T20:58:00Z', to: '2026-06-29T21:06:00Z', share: 1 }],
});
links.push({ sessionId: 's15-linked-ambiguous', repo: REPO, prNumber: 117, at: '2026-06-29T21:05:00Z' });
links.push({ sessionId: 's15-linked-ambiguous', repo: REPO, prNumber: 102, at: '2026-06-29T21:06:00Z' });

// Case 15: a link to a PR outside the fetch window falls back to branch matching rather than
// vanishing — the PR number is real but the dashboard has never heard of it.
links.push({ sessionId: 's01-exact-single', repo: REPO, prNumber: 99999, at: '2026-08-21T06:44:00Z' });

const ordered = [...sessions].sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
const payload = {
    sessions,
    spans,
    splits,
    links,
    coverage: {
        from: ordered[0].firstSeen,
        to: ordered[ordered.length - 1].lastSeen,
    },
};

const target = new URL('./telemetry-sessions.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(payload, null, 4)}\n`);
console.log(`wrote ${sessions.length} sessions, ${spans.length} spans, ${splits.length} splits`);
