import type { Board, BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import type { Runner } from './docker.js';

export interface Loop {
    /** Resolves once `stop()` has been called and every in-flight job has finished. */
    start(): Promise<void>;
    stop(): void;
}

export interface LoopDeps {
    board: Board;
    runner: Runner;
    config: DriverConfig;
    log?: (message: string) => void;
    sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface JobState {
    finished: boolean;
    lost: boolean;
    /** Resolves the moment the run ends, so the heartbeat can stop waiting out its period. */
    woken: Promise<void>;
    wake: () => void;
}

function newJobState(): JobState {
    let wake = () => {};
    const woken = new Promise<void>((resolve) => {
        wake = resolve;
    });
    return { finished: false, lost: false, woken, wake };
}

export function createLoop({ board, runner, config, log = () => {}, sleep = wait }: LoopDeps): Loop {
    let running = true;
    const active = new Set<Promise<void>>();

    /**
     * Beats until the run finishes.
     *
     * A 409 means the lease was reclaimed while this container was still working: the job belongs
     * to another worker now, so this one is killed rather than left to finish and report. The board
     * would refuse the report anyway — but by then the two runs have both been writing to the same
     * checkout, which is the thing actually worth preventing.
     */
    function heartbeat(job: BoardJob, state: JobState): Promise<void> {
        const every = Math.max(1_000, Math.floor((config.leaseSeconds * 1000) / 3));
        return (async () => {
            while (!state.finished && !state.lost) {
                // Raced against the run finishing, not simply awaited. The beat period is a third
                // of the lease — 100s at the default — and a plain sleep would hold every finished
                // job for the remainder of it before its result could be reported.
                await Promise.race([sleep(every), state.woken]);
                if (state.finished) return;
                let verdict;
                try {
                    verdict = await board.heartbeat(job);
                } catch (e) {
                    // A board that is briefly unreachable is not a lost lease. Keep working: the
                    // lease outlives several missed beats, and giving up here would kill a run
                    // over one failed request.
                    log(`job ${job.id}: heartbeat failed, continuing: ${(e as Error).message}`);
                    continue;
                }
                if (verdict === 'lost') {
                    state.lost = true;
                    log(`job ${job.id}: lease lost, killing the runner`);
                    await runner.kill(job);
                }
            }
        })();
    }

    async function runJob(job: BoardJob): Promise<void> {
        const state = newJobState();
        const beating = heartbeat(job, state);

        const settle = async () => {
            state.finished = true;
            state.wake();
            await beating;
        };

        try {
            log(`job ${job.id}: attempt ${job.attempts} starting`);
            const outcome = await runner.run(job);
            await settle();

            if (state.lost) return;

            const status = outcome.exitCode === 0 && !outcome.timedOut ? 'succeeded' : 'failed';
            const output = outcome.timedOut
                ? `${outcome.output}\n[driver] killed after ${config.jobTimeoutMs}ms`
                : outcome.output;

            const verdict = await board.complete(job, { status, exitCode: outcome.exitCode, output });
            log(
                verdict === 'lost'
                    ? `job ${job.id}: finished ${status}, but the board had already reclaimed it`
                    : `job ${job.id}: ${status} (exit ${outcome.exitCode})`,
            );
        } catch (e) {
            // The container never ran — docker is missing, or the daemon refused. Deliberately NOT
            // reported as a failed job: that would blame the command for the driver's problem. The
            // lease simply expires and the job is offered again, which is visible in `attempts`.
            await settle();
            log(`job ${job.id}: could not run, leaving it to the lease: ${(e as Error).message}`);
        }
    }

    function track(job: BoardJob): void {
        const promise = runJob(job).finally(() => active.delete(promise));
        active.add(promise);
    }

    return {
        stop() {
            running = false;
        },

        async start() {
            log(
                `polling ${config.boardUrl} every ${config.pollMs}ms as "${config.worker}", ` +
                    `${config.concurrency} at a time, image ${config.image}`,
            );

            while (running) {
                if (active.size >= config.concurrency) {
                    await Promise.race(active);
                    continue;
                }

                let job: BoardJob | null;
                try {
                    job = await board.claim(config.worker);
                } catch (e) {
                    log(`claim failed, retrying: ${(e as Error).message}`);
                    await sleep(config.pollMs);
                    continue;
                }

                if (!job) {
                    await sleep(config.pollMs);
                    continue;
                }
                track(job);
            }

            // Claiming has stopped; let what is already running finish rather than orphaning
            // containers that are mid-edit in a checkout.
            if (active.size) log(`draining ${active.size} running job(s)`);
            await Promise.all(active);
        },
    };
}
