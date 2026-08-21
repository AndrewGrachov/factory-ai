import type { Sql } from 'postgres';
import type {
    SessionBranchSpan,
    SessionRollup,
    SessionSpanSplit,
    TelemetryInput,
    TokenTotals,
} from '@factory-ai/core';
import type { TelemetryClient, TelemetryHealth } from './client.js';
import { TelemetryError } from './errors.js';
import type { CanonicalField } from './metric-map.js';

interface SummaryRow {
    agent: string;
    session_id: string;
    repo: string | null;
    branch_count: number;
    first_seen: Date;
    last_seen: Date;
    granularity: 'window' | 'session';
}

interface FieldRow {
    session_id: string;
    field: CanonicalField;
    value: number;
}

interface BranchFieldRow extends FieldRow {
    branch: string | null;
}

interface PrLinkRow {
    session_id: string;
    repo: string;
    pr_number: number;
    first_seen: Date;
}

interface SliceRow {
    agent: string;
    session_id: string;
    repo: string;
    branch: string | null;
    head_sha: string | null;
    samples: number;
    first_seen: Date;
    last_seen: Date;
}

/** Fields absent from a query stay null: nothing measured is not the same as zero. */
function pick(values: Map<CanonicalField, number>) {
    const get = (field: CanonicalField) => values.get(field) ?? null;
    const tokens: TokenTotals = {
        input: get('tokens_input'),
        output: get('tokens_output'),
        cacheRead: get('tokens_cacheRead'),
        cacheCreation: get('tokens_cacheCreation'),
    };
    return {
        tokens,
        linesAdded: get('lines_added'),
        linesRemoved: get('lines_removed'),
        editsAccepted: get('edits_accept'),
        editsRejected: get('edits_reject'),
        activeSeconds: get('active_seconds'),
    };
}

function group<T extends { session_id: string }>(rows: T[]): Map<string, T[]> {
    const out = new Map<string, T[]>();
    for (const row of rows) {
        const list = out.get(row.session_id) ?? [];
        list.push(row);
        out.set(row.session_id, list);
    }
    return out;
}

export interface PostgresTelemetryDeps {
    sql: Sql;
    /**
     * Resolves when migrations have been applied. Awaited per query rather than at
     * construction so the process can start serving before the database is up — the PR
     * metrics need no database, and must not wait for one.
     */
    ready?: Promise<unknown>;
}

export function createPostgresTelemetryClient({
    sql,
    ready,
}: PostgresTelemetryDeps): TelemetryClient {
    return {
        async fetchRollups(): Promise<TelemetryInput> {
            try {
                if (ready) await ready;
                // Not filtered by repo here: attribute() applies the filter, and the counts of
                // other-repo and hook-less sessions are what diagnose a bad setup.
                const [summaries, sessionFields, branchFields, slices, prLinks] = await Promise.all([
                    sql<SummaryRow[]>`select * from session_summary`,
                    sql<FieldRow[]>`select session_id, field, value from session_field_total`,
                    sql<BranchFieldRow[]>`select session_id, branch, field, value from branch_field_total`,
                    sql<SliceRow[]>`select * from session_branch_slice`,
                    sql<PrLinkRow[]>`select session_id, repo, pr_number, first_seen from session_pr`,
                ]);

                const byField = group(sessionFields);
                const byBranchField = group(branchFields);

                const sessions: SessionRollup[] = summaries.map((s) => {
                    const values = new Map<CanonicalField, number>(
                        (byField.get(s.session_id) ?? []).map((r) => [r.field, Number(r.value)]),
                    );
                    return {
                        sessionId: s.session_id,
                        agent: s.agent,
                        repo: s.repo,
                        firstSeen: s.first_seen.toISOString(),
                        lastSeen: s.last_seen.toISOString(),
                        commits: values.get('commits') ?? null,
                        pullRequests: values.get('pull_requests') ?? null,
                        granularity: s.granularity,
                        ...pick(values),
                    };
                });

                const spans: SessionBranchSpan[] = slices.map((s) => ({
                    sessionId: s.session_id,
                    repo: s.repo,
                    branch: s.branch,
                    headSha: s.head_sha,
                    from: s.first_seen.toISOString(),
                    to: s.last_seen.toISOString(),
                    samples: s.samples,
                }));

                const branchCount = new Map(summaries.map((s) => [s.session_id, s.branch_count]));
                const granularity = new Map(summaries.map((s) => [s.session_id, s.granularity]));

                const splits: SessionSpanSplit[] = slices.map((slice) => {
                    const rows = (byBranchField.get(slice.session_id) ?? []).filter(
                        (r) => r.branch === slice.branch,
                    );
                    const values = new Map<CanonicalField, number>(
                        rows.map((r) => [r.field, Number(r.value)]),
                    );
                    const parts = pick(values);

                    // A cumulative-only session has no per-datapoint positions to divide, so it
                    // is attributable only when it held exactly one branch. Two branches and no
                    // time-sliced increments is genuinely indivisible, and must read as null
                    // rather than as a plausible half.
                    const indivisible =
                        granularity.get(slice.session_id) === 'session' &&
                        (branchCount.get(slice.session_id) ?? 0) > 1;

                    if (indivisible) {
                        return {
                            sessionId: slice.session_id,
                            branch: slice.branch,
                            from: slice.first_seen.toISOString(),
                            to: slice.last_seen.toISOString(),
                            share: null,
                            tokens: { input: null, output: null, cacheRead: null, cacheCreation: null },
                            linesAdded: null,
                            linesRemoved: null,
                            editsAccepted: null,
                            editsRejected: null,
                            activeSeconds: null,
                        };
                    }

                    // Single-branch: the whole session belongs to it, whatever the temporality,
                    // so fall back to the session totals rather than the time-sliced ones.
                    if ((branchCount.get(slice.session_id) ?? 0) === 1) {
                        const sessionValues = new Map<CanonicalField, number>(
                            (byField.get(slice.session_id) ?? []).map((r) => [r.field, Number(r.value)]),
                        );
                        return {
                            sessionId: slice.session_id,
                            branch: slice.branch,
                            from: slice.first_seen.toISOString(),
                            to: slice.last_seen.toISOString(),
                            share: 1,
                            ...pick(sessionValues),
                        };
                    }

                    const sessionInput =
                        (byField.get(slice.session_id) ?? []).find((r) => r.field === 'tokens_input')
                            ?.value ?? 0;
                    return {
                        sessionId: slice.session_id,
                        branch: slice.branch,
                        from: slice.first_seen.toISOString(),
                        to: slice.last_seen.toISOString(),
                        share: sessionInput ? (parts.tokens.input ?? 0) / Number(sessionInput) : 1,
                        ...parts,
                    };
                });

                const times = summaries.flatMap((s) => [s.first_seen, s.last_seen]);
                return {
                    sessions,
                    spans,
                    splits,
                    links: prLinks.map((l) => ({
                        sessionId: l.session_id,
                        repo: l.repo,
                        prNumber: Number(l.pr_number),
                        at: l.first_seen.toISOString(),
                    })),
                    coverage: {
                        from: times.length
                            ? new Date(Math.min(...times.map((t) => t.getTime()))).toISOString()
                            : null,
                        to: times.length
                            ? new Date(Math.max(...times.map((t) => t.getTime()))).toISOString()
                            : null,
                    },
                };
            } catch (e) {
                // A migration failure keeps its own code: "the schema is not there" and "the
                // query is wrong" want different fixes.
                if (e instanceof TelemetryError) throw e;
                throw new TelemetryError((e as Error).message, 'QUERY');
            }
        },

        async health(): Promise<TelemetryHealth> {
            try {
                if (ready) await ready;
                const [row] = await sql<{ n: number }[]>`select count(*)::int as n from metric_point`;
                if ((row?.n ?? 0) === 0) {
                    return { status: 'empty', reason: 'No telemetry datapoints have arrived yet' };
                }
                return { status: 'ok', reason: null };
            } catch (e) {
                return { status: 'unreachable', reason: (e as Error).message };
            }
        },
    };
}
