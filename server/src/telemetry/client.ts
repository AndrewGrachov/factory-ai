import type { TelemetryInput } from '@factory-ai/core';

export type TelemetrySource = 'postgres' | 'fixture' | 'off';

export interface TelemetryHealth {
    /**
     * 'empty' is deliberately distinct from 'unreachable': a wired-but-silent pipeline is the
     * normal state during setup, and collapsing the two makes it undiagnosable.
     */
    status: 'ok' | 'empty' | 'unreachable';
    reason: string | null;
}

/**
 * Mirrors GitHubClient, including the fixture/live split. The fixture implementation is the
 * default so `npm test` and a bare `npm run dev` need no database and no collector.
 */
export interface TelemetryClient {
    fetchRollups(options?: { repos?: readonly string[]; since?: string }): Promise<TelemetryInput>;
    /** Never throws — it is called on the degradation path. */
    health(): Promise<TelemetryHealth>;
}
