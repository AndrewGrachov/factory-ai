export interface BoardJob {
    id: string;
    command: string;
    attempts: number;
    leaseToken: string;
    leaseExpiresAt: string;
    /**
     * Set when this claim is picking a parked job back up: the runner restores that session rather
     * than starting one, and the command is not re-delivered — it is already in the transcript.
     * Absent on a board that predates standby, which is why it is read as `?? null`.
     */
    resumeSessionId: string | null;
}

/** Whether the board still recognises this worker as the holder of the job. */
export type LeaseState = 'held' | 'lost';

export interface Board {
    /** Null means the queue is empty, which is the ordinary case, not an error. */
    claim(worker: string): Promise<BoardJob | null>;
    heartbeat(job: BoardJob): Promise<LeaseState>;
    /**
     * Tells the board which agent session this attempt runs as. Called twice under Remote Control:
     * once at spawn with the local id alone, and again once the bridge has reported the remote one
     * the Claude UI addresses the session by.
     */
    session(job: BoardJob, sessionId: string, remoteSessionId: string | null): Promise<LeaseState>;
    /** Parks the job: its container is gone, but it is not finished and keeps its session. */
    suspend(job: BoardJob): Promise<LeaseState>;
    complete(
        job: BoardJob,
        result: { status: 'succeeded' | 'failed'; exitCode: number | null; output: string },
    ): Promise<LeaseState>;
}

type Fetch = typeof globalThis.fetch;

export function createBoard({
    url,
    leaseSeconds,
    fetch = globalThis.fetch,
}: {
    url: string;
    leaseSeconds: number;
    fetch?: Fetch;
}): Board {
    const post = async (path: string, body: unknown): Promise<Response> => {
        const response = await fetch(`${url}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        // 409 is a verdict, not a failure; everything else outside 2xx is the board being broken or
        // the driver being wrong, and neither should be swallowed into a silent no-op.
        if (!response.ok && response.status !== 409) {
            throw new Error(`${path} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
        }
        return response;
    };

    return {
        async claim(worker) {
            const response = await post('/api/jobs/claim', { worker, leaseSeconds });
            if (response.status === 204) return null;
            const claimed = (await response.json()) as Partial<BoardJob>;
            return { ...(claimed as BoardJob), resumeSessionId: claimed.resumeSessionId ?? null };
        },

        async heartbeat(job) {
            const response = await post(`/api/jobs/${job.id}/heartbeat`, {
                leaseToken: job.leaseToken,
                leaseSeconds,
            });
            return response.status === 409 ? 'lost' : 'held';
        },

        async session(job, sessionId, remoteSessionId) {
            const response = await post(`/api/jobs/${job.id}/session`, {
                leaseToken: job.leaseToken,
                sessionId,
                remoteSessionId,
            });
            return response.status === 409 ? 'lost' : 'held';
        },

        async suspend(job) {
            const response = await post(`/api/jobs/${job.id}/suspend`, { leaseToken: job.leaseToken });
            return response.status === 409 ? 'lost' : 'held';
        },

        async complete(job, { status, exitCode, output }) {
            const response = await post(`/api/jobs/${job.id}/complete`, {
                leaseToken: job.leaseToken,
                status,
                exitCode,
                output,
            });
            return response.status === 409 ? 'lost' : 'held';
        },
    };
}
