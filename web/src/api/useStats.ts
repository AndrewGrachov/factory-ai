import { useCallback, useEffect, useRef, useState } from 'react';
import type { Stats } from '@factory-ai/core';

export interface RateLimit {
    remaining: number;
    resetAt: string;
}

export interface StatsPayload {
    stats: Stats;
    meta: {
        fetchedAt: string;
        ageSeconds: number;
        stale: boolean;
        source: 'live' | 'fixture';
        rateLimit: RateLimit | null;
        revert: { status: 'ok' | 'unavailable'; reason: string | null };
        repo: { owner: string; name: string };
        baseBranch: string;
    };
}

export interface FetchState {
    state: 'idle' | 'loading' | 'error';
    phase: 'prs' | 'backfill' | 'history' | null;
    prsFetched: number | null;
    backfillingPr: number | null;
    historyScanned: number | null;
    error: { message: string; code: string } | null;
}

export interface UseStats {
    data: StatsPayload | null;
    /** True only before anything has ever rendered. */
    loading: boolean;
    refreshing: boolean;
    progress: FetchState | null;
    error: string | null;
    refresh: () => void;
}

const POLL_MS = 2000;

export function useStats(): UseStats {
    const [data, setData] = useState<StatsPayload | null>(null);
    const [progress, setProgress] = useState<FetchState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(true);
    const timer = useRef<number | null>(null);

    const poll = useCallback(async (signal: AbortSignal) => {
        try {
            // No client-side timeout: aborting a cold fetch would waste the ~243
            // rate-limit points the server already spent.
            const response = await fetch('/api/stats', { signal });

            if (response.status === 202) {
                const body = (await response.json()) as { fetch: FetchState };
                setProgress(body.fetch);
                setPending(true);
                timer.current = window.setTimeout(() => void poll(signal), POLL_MS);
                return;
            }

            if (!response.ok) {
                const body = (await response.json().catch(() => ({}))) as { error?: string };
                // Deliberately does not clear `data`: a rate limit or an outage leaves
                // whatever is on screen the most accurate view available.
                setError(body.error ?? `Request failed (${response.status})`);
                setPending(false);
                return;
            }

            const body = (await response.json()) as StatsPayload;
            if (!body?.stats?.meta) throw new Error('Malformed /api/stats response');
            setData(body);
            setProgress(null);
            setError(null);
            setPending(false);
        } catch (e) {
            if (signal.aborted) return;
            setError((e as Error).message);
            setPending(false);
        }
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        void poll(controller.signal);
        return () => {
            controller.abort();
            if (timer.current !== null) window.clearTimeout(timer.current);
        };
    }, [poll]);

    const refresh = useCallback(() => {
        const controller = new AbortController();
        setPending(true);
        void fetch('/api/refresh', { method: 'POST' })
            .then(() => poll(controller.signal))
            .catch((e: Error) => {
                setError(e.message);
                setPending(false);
            });
    }, [poll]);

    return {
        data,
        loading: pending && data === null,
        refreshing: pending && data !== null,
        progress,
        error,
        refresh,
    };
}
