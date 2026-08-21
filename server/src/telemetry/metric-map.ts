/**
 * Vendor metric name -> canonical field, in one table.
 *
 * This is the seam that keeps the feature from being Claude-specific. opencode and other
 * agents also speak OTLP but use their own metric names, so adding one is adding rows here —
 * not a schema change, not a type change. `agent` is a plain string for the same reason.
 *
 * An unmapped metric resolves to null and is stored anyway, so a new tool's data accumulates
 * before support for it is written.
 */

/** Fields the aggregation understands. Deliberately no cost field: see AGENTS.md. */
export type CanonicalField =
    | 'tokens_input'
    | 'tokens_output'
    | 'tokens_cacheRead'
    | 'tokens_cacheCreation'
    | 'lines_added'
    | 'lines_removed'
    | 'edits_accept'
    | 'edits_reject'
    | 'active_seconds'
    | 'commits'
    | 'pull_requests'
    | 'sessions';

interface Rule {
    /** Resolves the field, possibly using a datapoint attribute to disambiguate. */
    field: (attrs: Record<string, string>) => CanonicalField | null;
}

/** Resolves the field from one attribute, e.g. token.usage's `type`. */
const enumerated = (attr: string, values: Record<string, CanonicalField>): Rule => ({
    field: (attrs) => values[attrs[attr] ?? ''] ?? null,
});

const RULES: Record<string, Rule> = {
    'claude_code.token.usage': enumerated('type', {
        input: 'tokens_input',
        output: 'tokens_output',
        cacheRead: 'tokens_cacheRead',
        cacheCreation: 'tokens_cacheCreation',
    }),
    'claude_code.lines_of_code.count': enumerated('type', {
        added: 'lines_added',
        removed: 'lines_removed',
    }),
    'claude_code.code_edit_tool.decision': enumerated('decision', {
        accept: 'edits_accept',
        reject: 'edits_reject',
    }),
    'claude_code.active_time.total': { field: () => 'active_seconds' },
    'claude_code.commit.count': { field: () => 'commits' },
    'claude_code.pull_request.count': { field: () => 'pull_requests' },
    'claude_code.session.count': { field: () => 'sessions' },
};

/** The agent that produced a metric, from its name prefix. */
export function agentOf(metric: string): string {
    return metric.startsWith('claude_code.') ? 'claude-code' : 'unknown';
}

export function canonicalField(
    metric: string,
    attrs: Record<string, string>,
): CanonicalField | null {
    return RULES[metric]?.field(attrs) ?? null;
}
