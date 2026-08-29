# Job board

Read before: touching `server/src/routes/jobs.ts`, `server/src/db/job-store.ts`,
`server/migrations/006_jobs.sql` or anything under `driver/`.

A job is a text command waiting for a worker — read as a Claude prompt, since the runner's
`ENTRYPOINT` is the `claude` wrapper and the driver passes the command as `-p <command>`.

**The server hands jobs out and records results. It never spawns anything.** The driver claims a
job, runs it in a `claude-executor` container against the org's workspace checkout, and reports
back. The docker socket lives with the driver, never with the dashboard: the dashboard's port is
unauthenticated, and a socket on that process would make it root on the host.

## The driver contract

```
POST /api/jobs/claim {worker}         -> 200 {id, command, leaseToken, leaseExpiresAt} | 204
  spawn claude-executor with the command
  POST /api/jobs/:id/heartbeat {leaseToken}     every leaseSeconds/3, while it runs
POST /api/jobs/:id/complete {leaseToken, status, exitCode, output}
```

**A `409` from heartbeat means the container must be killed.** Its lease expired, the job was
handed to someone else, and nothing it reports will be accepted. The board cannot stop a worker —
it can only refuse it — so double execution is prevented by the driver acting on that 409, not by
the database. This is the single most important line in this file.

## The driver (`driver/`)

A fourth workspace, with no dependency on `core` and none at run time at all. It is a client of the
HTTP board, never of the database — which is what lets it run anywhere the board is reachable.

```bash
docker build -t claude-executor docker/claude-executor   # the runner image, once
npm run driver                                           # against a board on 127.0.0.1:8080

docker compose --profile driver up -d driver             # or in the stack
```

| Variable | Default | Notes |
| --- | --- | --- |
| `JOB_BOARD_URL` | `http://127.0.0.1:8080` | Must be http(s); the scheme is checked, because `new URL('dashboard:8080')` parses. |
| `ORG_ID` | `default` | Only builds the runner's `WORKDIR`. The driver reads no `factory.toml`, so an org set only in the file must be set here too. |
| `EXECUTOR_IMAGE` | `claude-executor` | |
| `WORKSPACE_VOLUME` | `factory-ai_workspaces` | A volume **name**, not a host path — see below. |
| `RUNNER_NETWORK` | unset | Join the compose network or the runner's telemetry reaches nothing. |
| `DRIVER_CONCURRENCY` | `2` | |
| `DRIVER_POLL_MS` | `5000` | |
| `DRIVER_LEASE_SECONDS` | `300` | Heartbeat is a third of this. |
| `DRIVER_JOB_TIMEOUT_MS` | `1800000` | The container is `docker kill`ed and the job reported failed, with a note. |
| `RUNNER_SKIP_PERMISSIONS` | off | Appends `--dangerously-skip-permissions`. Read the paragraph below. |
| `RUNNER_ENV` | `CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY` | Names forwarded to the runner. |

**The workspace is passed as a volume name, not a path.** The driver's runners are *siblings*, not
children: it talks to the host's daemon over a socket, so a path inside the driver container means
nothing to that daemon, and there is no host path to give either — the dashboard writes its
checkouts into a named volume precisely to avoid one.

**Credentials are passed as `-e NAME`, never `-e NAME=value`.** The value then comes from the
driver's own environment instead of a `docker run` argv that every `ps` on the host can read. This
is the same distinction the workspace reconcile makes for the git token.

**`RUNNER_SKIP_PERMISSIONS` is a real decision, not a nuisance flag.** Off, a headless agent stalls
at permission prompts nobody can answer and the job burns its timeout. On, it edits and runs
whatever it likes inside the container — which is also mounted onto the org's checkouts. It stays
off by default so that turning it on is something somebody typed.

**A run that never started is not a failed job.** If `docker` is missing or the daemon refuses, the
driver logs and says nothing to the board: reporting `failed` would blame the command for the
driver's problem and burn an attempt. The lease expires and the job is offered again, which is
visible in `attempts`.

**The heartbeat is raced against the run finishing, not simply slept.** The beat period is a third
of the lease — 100s by default — and awaiting it before reporting left every finished job sitting
in `running` for a minute and a half. Found by running the driver for real; a unit test with an
instant fake clock cannot see it, so `loop.test.ts` models a period that never elapses.

## Decisions

**Leases, not a status flag.** A worker that dies mid-job cannot tell anyone, so a claim expires.
`lease_expires_at` is `not null` from insert, set to `now()` — already expired. That makes
claimable one predicate, `status in ('queued','running') and lease_expires_at <= now()`, which a
partial index implies. The obvious alternative,
`status = 'queued' or (status = 'running' and lease_expires_at < now())`, is implied by no index at
all and can only ever be a scan plus a filter.

**A fencing token, not `claimed_by`.** A restarted container comes back with the same worker id, so
the name cannot distinguish the live run from the stale one it replaced. `lease_token` is
regenerated on every claim and must be presented on heartbeat and complete. A report carrying an
old one is refused, not merged: the two runs did different work, and merging them writes one run's
exit code next to another's output.

**`max_attempts` and `dead` exist from the first migration.** A command that kills its worker is
otherwise reclaimed the moment its lease expires, forever, and one poison job permanently occupies
a worker slot. Adding a value to `job_status_ck` later means rewriting the constraint on a
populated table, so `'dead'` is in it now.

**`started_at` resets on every claim.** It has to describe the attempt that ran; keeping it from
the first attempt makes every duration measure from a run that died.

**The claim's row lock sits inside the subquery, below the `LIMIT`.** `for update skip locked` there
means a row another claimer holds is skipped rather than counted against the limit and then
discarded — the difference between a busy queue handing out work and one returning `204` while jobs
wait. The outer `update … where id = (…)` is safe only because that subquery holds the lock; do not
flatten it.

**`order by created_at, id`.** `now()` is transaction-constant, so a batch insert shares a
timestamp and FIFO without the id tiebreaker is arbitrary.

## Deliberately absent

- **No idempotency key on create.** A `POST /api/jobs` that times out and is retried creates a
  second job, and the command runs twice. Add a client-supplied id with `on conflict do nothing`
  when a driver actually retries creates.
- **No cancel, no priority, no scheduling.** A dead job is reaped; a queued one is taken in order.
- **No auth** — see [security.md](security.md), which is where the consequence is written down.

## Testing

The lease rules are tested against a real database only (`server/test-db/job-store.test.ts`,
`npm run test:db`) — a second implementation of them in a stub would only ever agree with itself.
`server/test/routes.jobs.test.ts` covers the HTTP contract with a stub that fakes verdicts, and
pins that the board is **not** registered when `buildApp` gets no job store.

Lease expiry is simulated by ageing `lease_expires_at` with SQL, never by sleeping.

`driver/test/` injects both the board and docker, so it spawns nothing and needs no daemon.
`dockerArgs()` is exported and pinned separately: everything security-relevant about a runner is
decided in that one array.

`npm run test:jobs` (`scripts/test-jobs.sh`) is the end-to-end: a real board, a real database, a
real driver and real containers, with no Claude and no credential. The runners are two stub images
whose entrypoints echo and exit — the job's `output` comes back as the arguments the container was
given, which is what proves the prompt, the mount and the completion path all line up. It creates a
`*_test` database, two images and a volume, and drops all of them on exit.

Two things it does that are not decoration:

- **It truncates `job` before the board phase.** The queue is FIFO, so a job left by an earlier run
  hands the claim a different job than the one under test — which reads as a broken lease rather
  than a dirty fixture. That misdiagnosis cost real time the first time this script ran.
- **It starts the board with an empty `factory.toml`.** The repo's own config would otherwise reach
  the run: its token makes `loadConfig` refuse a `*_test` database outright, and its
  `workspace_root` starts cloning repositories.

The reclaim and fencing checks age `lease_expires_at` with `psql` rather than waiting a lease out,
so the script stays a few seconds rather than a few minutes.
