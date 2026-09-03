/**
 * The executor types a member may configure.
 *
 * The single list both the server's route check and the web UI's picker render from — two
 * hand-maintained lists are how a future type lands enabled in one and rejected by the other. The
 * `user_executor.type` check constraint in 012_user_executors.sql must list the same values; adding
 * one means editing that check AND this array in the same change, because altering a check on a
 * populated table is a rewrite (006's job_status_ck rule).
 */
export const EXECUTOR_TYPES = ['claude-code'] as const;

export type ExecutorType = (typeof EXECUTOR_TYPES)[number];
