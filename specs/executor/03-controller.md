# 03 — Controller

**Depends on:** [01-schema-and-store](01-schema-and-store.md) (the store and its claim),
[02-adapters](02-adapters.md) (the pure adapters).
**Blocks:** [05-job-and-runtime](05-job-and-runtime.md), [08-deploy](08-deploy.md).

## Scope

The long-running process that turns queued rows into running agents. The `RunnerBackend` seam, the
**local** backend (so this whole spec is exercisable with no cluster), the tick loop, launch ordering,
boot reconciliation, leases, the two timeouts, retry classification, cancellation, and shutdown.

## Non-goals

The Kubernetes backend's Job/Pod spec and the in-pod runner are [05](05-job-and-runtime.md). The git
mirror is [04](04-git-mirror.md). Config validation is [07](07-config.md). This spec assumes
`RUNNER_BACKEND=local` works first — that is the point of the seam.

---

## 1. Package layout

```
executor/src/index.ts                  entrypoint: config, pool, wait for migration, pick backend,
                                       start HTTP + loop, SIGTERM drain
executor/src/db/ready.ts               poll schema_migrations; refuse to claim before 006 exists
executor/src/controller/loop.ts        the tick; injectable clock
executor/src/controller/claim.ts       lease heartbeat, expiry sweep, concurrency caps
executor/src/controller/launch.ts      ordering-critical launch
executor/src/controller/observe.ts     backend status -> state-machine event
executor/src/controller/finalize.ts    terminal write, result capture, explicit Job delete
executor/src/controller/adopt.ts       boot reconciliation
executor/src/controller/heartbeat.ts   lease renewal for claimed/running attempts

executor/src/backend/backend.ts        the RunnerBackend interface
executor/src/backend/local/backend.ts  child_process.spawn of the same wrapper script
executor/src/backend/local/state.ts    on-disk handle map so dev restarts reconcile
```

The Kubernetes files under `executor/src/backend/kubernetes/` are listed by
[05](05-job-and-runtime.md).

---

## 2. `RunnerBackend` — the seam

This is what keeps `npm test` cluster-free and what makes local development possible at all. Model it
on `server/src/forge.ts`: **the interface lives outside every adapter**, so a second backend is a
sibling rather than a fork.

```ts
export interface LaunchSpec {
    readonly org: string;
    readonly taskId: string;
    readonly attemptNo: number;
    readonly jobName: string;            // deterministic, already persisted
    readonly repo: string;
    readonly baseBranch: string;
    readonly baseSha: string;
    readonly branch: string;
    readonly tool: string;
    readonly sessionId: string | null;
    readonly plan: AgentRunPlan;          // from the adapter, already computed
    readonly promptText: string;          // goes into the Secret as a file, never into argv
    readonly taskToken: string;           // per-task bearer, plaintext only here
    readonly timeoutSeconds: number;
}

export type RunPhase = 'pending' | 'running' | 'succeeded' | 'failed';

export interface RunStatus {
    readonly phase: RunPhase;
    readonly podName: string | null;
    readonly failureKind: 'agent' | 'timeout' | 'infra' | null;
    readonly exitCode: number | null;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
}

export interface RunnerBackend {
    readonly kind: 'kubernetes' | 'local';
    /** Idempotent. An already-exists response is SUCCESS, not an error — see §4. */
    launch(spec: LaunchSpec): Promise<{ podName: string | null }>;
    status(jobName: string): Promise<RunStatus | null>;   // null == not found
    /** The envelope, or null if nothing was captured. Called BEFORE destroy. */
    collect(jobName: string): Promise<RunEnvelope | null>;
    destroy(jobName: string): Promise<void>;
    /** Every run this backend currently knows about, for boot reconciliation. */
    list(): Promise<readonly { jobName: string; status: RunStatus }[]>;
    /** Resolves when something changed, or after ms. Lets the loop wake early without polling
     *  faster. The local backend can just sleep. */
    wait(ms: number): Promise<void>;
}
```

### The local backend

`child_process.spawn`s **the same `executor/runner/entrypoint.mjs`** a pod would run, with `/work`
replaced by a temp directory and the per-task Secret replaced by files in a temp config dir. It
writes a handle map (`{ jobName -> { pid, dir, startedAt } }`) to disk under
`$EXECUTOR_LOCAL_STATE_DIR` so a controller restart in dev reconciles exactly like the real one.

**This is not a mock.** It runs the real CLI against a real git checkout. The only things it does not
exercise are Job admission, RBAC, `terminationMessage` delivery and the mirror Service — which is
precisely the list in [08](08-deploy.md)'s cluster-only section.

---

## 3. Tick loop

`executor/src/controller/loop.ts`, one tick:

1. **sweep leases** — `reclaimExpired({ graceSeconds, limit })`; for each returned ref, `destroy()`
   the run **before** the task is allowed back into the queue (see Flag G).
2. **cancellations** — `pendingCancellations()`; `destroy()` then `completeAttempt(… 'cancelled')`.
3. **claim** — `claimTasks({ limit: budget, owner, leaseSeconds })`.
4. **launch** — §4, for each claimed task.
5. **observe** — `status()` for every non-terminal attempt this controller holds; map to a
   state-machine event.
6. **finalize** — `collect()`, write the terminal row, then `destroy()`.

Wake-up policy:

- **Poll every `EXECUTOR_POLL_INTERVAL_MS` (default 2000) — the reconciler of record.**
- `backend.wait()` gives the Kubernetes backend a `Watch` on Jobs by label selector, for ms-latency
  completion. On watch error: log, back off, re-establish. A full `list()` reconcile runs every 60s
  regardless. *Rejected:* informer-only, because a missed relist strands a task in `running` with no
  independent path out.
- **Decline `LISTEN/NOTIFY` on the task table.** A NOTIFY missed while the controller restarts is a
  task that sits forever, so the poll has to exist anyway; NOTIFY would be an optimisation with a
  second, silent failure mode. *Rejected explicitly because it is tempting.*

### Concurrency caps

`limit` comes from `EXECUTOR_MAX_CONCURRENT` minus `count(*) where status in ('claimed','running')`,
applied globally, per-repo (the mirror fetch serialises per repo anyway) and per-org. The backstop is
a `ResourceQuota` on the agent namespace ([08](08-deploy.md)), so a wrong cap becomes a rejected
create rather than a cluster outage.

---

## 4. Launch ordering — the most important invariant here

```
job_name = 'fx-' + b32(sha256(org_id | task_id | attempt_no)).slice(0, 12)
```

whole name ≤ 52 characters (the pod's generated suffix needs the rest of the 63-character budget).

**`recordLaunch()` writes `job_name` to the database BEFORE any backend call.** Consequences:

- A `launch()` that reports **already-exists is treated as success.** For the Kubernetes backend that
  is a 409 from `create`; API-server object-name uniqueness is the authoritative "one Job per attempt"
  lock, and it is stronger than anything the controller can do itself.
- The boot reconciler can always *name* the Job for a claimed attempt, even if the controller died
  between claim and create.

Reversed — create, then record the name — produces the one unrecoverable state: **a running Job the
database cannot identify.** Nothing can clean that up, and it holds push credentials.

Every non-claim update carries `and revision = $seen`. Zero rows affected means someone else moved
the task: log, re-read, **do not clobber**. It also makes "did my cancel land" answerable.

### The cancel/launch race

Cancel arriving between claim and create. `launch.ts` re-reads `cancel_requested_at` **in the same
transaction that stamps the launch** and skips the backend call if it is set. The claim's `where`
already excludes cancelled rows, so the window is only claim→create — and this closes it.

### No leader election

`for update skip locked` + deterministic job names + revision CAS are already correct for N replicas.
*Rejected:* a `coordination.k8s.io/Lease` election — it makes one elected replica the only worker *by
design*, and it puts the Kubernetes API on the liveness path of a database loop.

**Flag B from [00](00-overview.md) still applies:** the RWO mirror volume pins the controller to
`replicas: 1` regardless of how correct the claim is. The claim design is ready for multi-replica; the
volume is what is not.

---

## 5. Boot reconciliation

`executor/src/controller/adopt.ts` reads the backend, then the database, then diffs.

**Hard rule: never delete anything if either read failed.** A database outage must not look like "no
tasks exist".

| DB | Backend | Action |
| --- | --- | --- |
| non-terminal | run exists | **Adopt.** Status from the run, resume observing, re-lease under this controller's id. |
| `queued` | no run | Leave. Normal. |
| `claimed`/`running` | no run | Retryable class and `attempt < max_attempts` → `queued` + backoff. Else `failed` with `failure_kind = 'lost'`. |
| terminal | run exists | **Reap.** `collect()` if no result was recorded, then `destroy()`. |
| no row | run exists | Loud log; annotate `factory.dev/orphan-since`; delete **only after a 1h grace window** — an immediate delete would destroy live work after a database restore from an older snapshot. |
| — | labelled Secret with no `ownerReferences`, age > 10 min | Delete. Covers a crash between create-Secret and create-Job. |

---

## 6. The two timeouts

Both exist, and they cover different failures.

1. **Backend-enforced** — `activeDeadlineSeconds` on the Job (default 3000s = 50 min; see
   [05](05-job-and-runtime.md) on the 1-hour token cap). Kubelet-enforced, yields
   `Failed`/`DeadlineExceeded`. It counts `Pending` time, so `ImagePullBackOff` and `Unschedulable`
   are already bounded — **no separate scheduling timeout is needed.**
2. **Controller-side** — `activeDeadlineSeconds + 120s` measured from the recorded launch time. If
   exceeded while the backend still reports active, `destroy()` and write
   `failed` / `failure_kind = 'timeout'`. Covers what the first cannot: the controller cannot see the
   run at all (watch dead, API throttled) but the row is aging.

**Flag G is the coupling:** if the lease reaper marks an attempt `lost` while the pod is still running
and holding push credentials, a retry launches a **second** agent on the same branch. The invariants,
validated in `loadExecutorConfig` ([07](07-config.md)):

- `graceSeconds ≥ 2 × leaseSeconds`
- `leaseSeconds < taskTimeoutSeconds`
- the controller **destroys the run before requeueing**, never after.

---

## 7. Retry

`backoffLimit: 0` on the Job. **The controller owns retry, not the backend.** *Rejected:*
`backoffLimit: 3` — the Job controller would spawn a second pod the database never recorded,
re-running an expensive agent under the same `attempt_no` and the same push credential: two agents
racing on one branch.

`executor/src/backend/kubernetes/classify.ts` is **pure**, over `job.status.conditions` plus
`pod.status.containerStatuses[0].state.terminated`:

| Signal | `failure_kind` | Retry |
| --- | --- | --- |
| exit ≠ 0 and the agent actually ran | `agent` | **No** |
| `DeadlineExceeded` | `timeout` | No |
| `OOMKilled` | `infra` | Yes, once, with a raised memory limit |
| `Evicted` / `DisruptionTarget` / node drained | `infra` | Yes |
| `ErrImagePull` / `CreateContainerConfigError` | `infra` | Yes |
| init container (clone) failed | `infra` | Yes |
| lease expired with no run present | `lost` | Yes |

**Auto-retrying a failed *agent* is wrong** — non-deterministic, costs real money, and may re-push. So
the *classifier* decides, not the counter. Default `max_attempts = 1`
([07](07-config.md)).

Backoff: `least(30s × 2^attempt, 15min)` with ±20% jitter.

`OOMKilled` is only visible on the **pod**, not the Job, so RBAC needs `pods` get/list and not just
`jobs` — and it is the classification that most changes what the controller should do.
[08](08-deploy.md) carries the verb list.

---

## 8. Session and telemetry wiring

At claim time, for an adapter with `acceptsSessionId`, generate the session uuid and call
`recordAttemptSession(ref, { sessionId, assigned: true, repo, branch, at })` **before** launching.
That call writes both the attempt's `session_id` **and** the `session_branch` row.

**The `session_branch` write is load-bearing** (Flag E): `metric_point` has no `org_id`, so without it
the pod's metrics belong to no organization — invisible with one org, wrong with two — and the work
also silently misses the existing `branch_field_total` panels. It also means the agent-telemetry
plugin must **not** be installed in the agent image: one writer.

For an adapter with `acceptsSessionId: false`, the session id arrives in the envelope at finalize
time; `assigned: false`.

---

## 9. Shutdown

SIGTERM: stop claiming, stop the watch, flush pending writes, **do not destroy runs**, exit within
10s. `terminationGracePeriodSeconds: 30`.

Running agents deliberately outlive the controller and are re-adopted on boot. That is what makes
Flag B ("controller is a single point of failure") true for *launching* and false for *running*.

---

## 10. Acceptance criteria

### `npm test` — offline

| File | Must assert |
| --- | --- |
| `executor/test/naming.test.ts` | `job_name` is deterministic for `(org, task, attempt)`, ≤ 52 chars, and DNS-1123-label-safe for pathological org ids and long repo names. |
| `executor/test/classify.test.ts` | Every row of the retry table, from real fixture Job+Pod JSON in `executor/test/fixtures/`. `OOMKilled` → `infra`; `DeadlineExceeded` → `timeout`; a clean non-zero exit → `agent` and **not retryable**. |
| `executor/test/adopt.test.ts` | All six reconciliation cases against a fake backend and `memoryTaskStore()`. Specifically: **nothing is deleted when either read throws**; an orphan younger than the grace window survives; a terminal-with-run case collects before destroying. |
| `executor/test/loop.test.ts` | Against a fake backend + `memoryTaskStore`: a queued task reaches `succeeded`; `job_name` is persisted **before** `launch()` is called (assert call order); an already-exists `launch()` is treated as success; a cancel arriving between claim and launch prevents the launch; a lease sweep destroys before requeueing. |
| `executor/test/config.test.ts` | (Shared with [07](07-config.md).) `grace ≥ 2 × lease`, `lease < timeout`, poll floor. |

The call-order assertion in `loop.test.ts` is the one that protects §4. Write it as a recorded call
log, not as a spy on one function.

### Manual / local, no cluster

`RUNNER_BACKEND=local npm run dev -w executor` against `factory_dev`, with a task submitted by the
CLI ([06](06-api-and-auth.md)) — the task should clone, run the agent, and land `succeeded` with a
non-null `head_sha`. **This is the acceptance gate for the whole spec**, and it needs no Kubernetes.

### Cluster-only, deferred

Job admission, RBAC, watch behaviour under API throttling. [08](08-deploy.md).

## Files

**Create:** every file in §1, plus `executor/src/backend/kubernetes/classify.ts` and
`executor/src/git/naming.ts` (shared with [04](04-git-mirror.md) and [05](05-job-and-runtime.md)), plus
the five test files and their fixtures.

**Modify:** nothing outside `executor/`.
