export interface BoardJob {
    id: string;
    command: string;
    attempts: number;
    leaseToken: string;
    leaseExpiresAt: string;
}

/** Whether the board still recognises this worker as the holder of the job. */
export type LeaseState = 'held' | 'lost';

export interface Board {
    /** Null means the queue is empty, which is the ordinary case, not an error. */
    claim(worker: string): Promise<BoardJob | null>;
    heartbeat(job: BoardJob): Promise<LeaseState>;
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
            return (await response.json()) as BoardJob;
        },

        async heartbeat(job) {
            const response = await post(`/api/jobs/${job.id}/heartbeat`, {
                leaseToken: job.leaseToken,
                leaseSeconds,
            });
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
