# 05 — Job spec, in-pod runtime, and credentials

**Depends on:** [02-adapters](02-adapters.md) (the plan and envelope),
[03-controller](03-controller.md) (the `RunnerBackend` seam), [04-git-mirror](04-git-mirror.md) (what
the init container clones from).
**Blocks:** [08-deploy](08-deploy.md).

## Scope

The Kubernetes `RunnerBackend`: what a Job looks like, what runs inside the pod, how the result gets
back, how a short-lived git credential reaches the agent without ever being visible, and what image it
all runs in.

## Non-goals

Manifests, RBAC and NetworkPolicy ([08](08-deploy.md)); the controller loop ([03](03-controller.md));
adapter argv ([02](02-adapters.md)).

---

## 1. Files

```
executor/src/backend/kubernetes/client.ts        KubeConfig + BatchV1Api/CoreV1Api
executor/src/backend/kubernetes/job-spec.ts      buildJob(spec, config) -> V1Job.  PURE, no client.
executor/src/backend/kubernetes/secret-spec.ts   buildTaskSecret(spec) -> V1Secret. PURE.
executor/src/backend/kubernetes/backend.ts       RunnerBackend over batch/v1
executor/src/backend/kubernetes/watch.ts         Job watch -> early wake
executor/src/tokens/github-app.ts                App JWT -> per-repo installation token
executor/src/tokens/task-token.ts                per-task bearer: 32 random bytes, stored hashed
executor/src/http/routes/internal.ts             /internal/tasks/:id/{payload,session,git-credential,result}

executor/runner/entrypoint.mjs                   in-pod wrapper. NOT compiled by tsc.
executor/scripts/clone.sh                        init container
executor/scripts/git-credential-factory          credential helper
docker/Dockerfile.agent                          the agent image
```

`job-spec.ts` and `secret-spec.ts` are **pure builders** — they return objects and never touch a
client. That is what makes the security assertions in §7 writable offline.

---

## 2. Job and Pod shape

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: fx-<b32 digest>                  # deterministic, already persisted (03 §4)
  namespace: factory-agent
  labels:
    factory.dev/task: <task-id>
    factory.dev/attempt: "<n>"
    factory.dev/org: <org-id>
    factory.dev/tool: <tool>
spec:
  backoffLimit: 0                        # the controller owns retry (03 §7)
  activeDeadlineSeconds: <task timeout>  # default 3000 — see §5
  ttlSecondsAfterFinished: 3600          # backstop only; the controller deletes after collecting
  template:
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      serviceAccountName: factory-agent  # no permissions at all
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile: { type: RuntimeDefault }
      volumes:
        - name: work    { emptyDir: { sizeLimit: <EXECUTOR_WORKSPACE_SIZE> } }
        - name: home    { emptyDir: { sizeLimit: 2Gi } }
        - name: config  { secret: { secretName: fx-<digest>, defaultMode: 0400 } }
      initContainers:
        - name: clone   # /work, see §3
      containers:
        - name: agent
          command: ["node", "/opt/factory/entrypoint.mjs"]
          workingDir: /work
          terminationMessagePolicy: FallbackToLogsOnError
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: { drop: ["ALL"] }
            readOnlyRootFilesystem: false     # see below
          resources: { requests: {...}, limits: {...} }
```

### `emptyDir`, not a PVC

Per-pod, ephemeral, isolated. `sizeLimit` is not optional: an unbounded `emptyDir` fills the node's
disk and evicts unrelated pods, and the eviction shows up as an `infra` failure on a task that had
nothing to do with it.

Two volumes because **both CLIs need a writable `$HOME`** — caches, credentials, config. Mounting
`$HOME` inside `/work` would put it in the diff.

### `readOnlyRootFilesystem: false` — stated honestly

The agent runs `npm install` and project test suites; a read-only root breaks the thing this exists to
do. The achievable version is that `/work` and `$HOME` are the only writable mounts, plus dropped
capabilities, no privilege escalation, non-root, and `RuntimeDefault` seccomp.

**Residual risk, not solved:** a container is not a sandbox against code the model chose to run.
gVisor or Kata is the real answer for genuinely untrusted prompts and is out of scope here. What
actually holds the line is Flag A — only authenticated operators can submit tasks, and the repo is
allowlisted so the request can never carry an attacker-controlled clone URL.

`automountServiceAccountToken: false` and a ServiceAccount with **no** permissions: a compromised
agent must not be able to create more Jobs or read other tasks' Secrets.

### Env — what is *not* there matters most

Present: `OTEL_EXPORTER_OTLP_ENDPOINT`, `EXECUTOR_TASK_ID`, `EXECUTOR_CONTROLLER_URL`,
`EXECUTOR_OTEL_FLUSH_MS`, the adapter plan's `env`.

**Absent, deliberately: the prompt and the git token.** `kubectl get job -o yaml` prints `args` and
`env`, and etcd is unencrypted by default (Flag C). The prompt arrives as a **file in the Secret**;
the git token arrives through the credential helper in §4 and never exists as an environment variable
at all.

### The per-task Secret

`buildTaskSecret()` produces a Secret named `fx-<digest>` with an `ownerReferences` entry pointing at
the Job, so deleting the Job with `propagationPolicy: Background` garbage-collects it. Contents:

| Key | Purpose |
| --- | --- |
| `prompt.txt` | the prompt text |
| `claude-settings.json` / `opencode.json` | the adapter's materialised config |
| `mcp.json` | when the task named MCP servers |
| `task-token` | the per-task bearer (§4) |

Mounted read-only at `/etc/factory` with `defaultMode: 0400`.

Create the Secret **before** the Job. The reconciler's sixth case ([03](03-controller.md) §5) sweeps a
labelled Secret with no owner reference older than 10 minutes, which covers a crash in between.

---

## 3. Init container

`executor/scripts/clone.sh`, running the **agent image** (so git and the CA bundle are already there):

```sh
git clone --filter=blob:none --no-checkout \
          --branch "$BASE_BRANCH" "$MIRROR_URL" /work
cd /work
git checkout "$BASE_SHA"
git switch -c "$TASK_BRANCH"
git config user.name  "$AGENT_NAME"
git config user.email "$AGENT_EMAIL"
git config credential.helper '/opt/factory/git-credential-factory'
git remote set-url --push origin "$FORGE_URL"
```

- `--filter=blob:none` is the monorepo mitigation: history and trees come down, blobs arrive on
  demand. `--no-checkout` then `checkout <sha>` pins the run to the SHA the controller resolved, not
  to whatever the branch moved to between resolve and clone.
- `--branch` is still passed so the clone is narrow; `$BASE_SHA` is what makes it reproducible.
- The push remote is the **real forge**, not the mirror. The mirror is `upload-pack` only
  ([04](04-git-mirror.md)).
- Init failure classifies as `infra` and is retryable ([03](03-controller.md) §7).

---

## 4. Short-lived git token

The repo today has one fine-grained PAT with `Metadata: read`, `Pull requests: read`,
`Contents: read`. **Pushing needs something new.**

### Minting

**GitHub App installation token.** Sign a JWT with the App private key (`RS256`, `iat`/`exp` ≤ 10 min,
`iss` = App id), exchange it at
`POST /app/installations/<id>/access_tokens` with `repositories: [<name>]` and
`permissions: { contents: write, pull_requests: write, metadata: read }`. Cache per repo for < 55
minutes.

| Rejected | Why |
| --- | --- |
| Widen the existing PAT | One credential for every repo and every task, no expiry, no per-task audit — and the dashboard's read path would inherit write scope. |
| Deploy keys | Per-repo key management, no expiry, no audit trail, and rotation is manual. |

`server/src/github/token.ts` already defines a `TokenProvider` interface *explicitly so an App
installation token can replace the PAT without touching call sites* — this is that hook being used.
Keep the minting in `executor/`: it does HTTPS and RSA signing, which is exactly the I/O `core`
forbids.

### Delivery — the constraint is absolute

**The token must never appear in a Job manifest, in `kubectl describe`, or in agent-visible env.**

1. The per-task Secret carries a **per-task bearer token** — 32 random bytes, stored **sha256-hashed**
   in the database — not the git credential.
2. `git-credential-factory` is registered as `credential.helper`. On `get`, it reads the bearer from
   `/etc/factory/task-token`, POSTs it to `/internal/tasks/:id/git-credential`, and prints
   `username=x-access-token` / `password=<token>` on **stdout**. Git consumes it directly; it is never
   written to disk and never enters the environment.
3. The controller mints the installation token **at that moment**, and refuses if the attempt is
   terminal or if the requested host/repo does not match the task's `repo`.

### Expiry interaction

Installation tokens last 1 hour. `activeDeadlineSeconds` defaults to **3000s (50 min)** so a task
cannot outlive its credential mid-push. The helper re-mints on the next `get` anyway, so the real
constraint is only that a single `git push` completes inside the window.

---

## 5. `entrypoint.mjs` and result capture

`ttlSecondsAfterFinished` races log collection, so **do not depend on pod logs.**

`executor/runner/entrypoint.mjs`, in order:

1. `git rev-parse HEAD` → `baseSha`; record the branch name.
2. Fetch the task payload from `/internal/tasks/:id/payload` (or read it from `/etc/factory`), run the
   adapter's planned argv with the prompt on stdin.
3. Capture the exit code.
4. **Sleep `EXECUTOR_OTEL_FLUSH_MS`** so the CLI's last metric export actually leaves the pod.
5. `git rev-parse HEAD` → `headSha`; `git rev-list --count base..head` → `commits`;
   `git diff --name-only base..head | wc -l` → `filesChanged`.
6. Write the `RunEnvelope` ([02](02-adapters.md) §5) to `/dev/termination-log`, **and** print it on one
   line prefixed `##FACTORY_RESULT##`.

### Which capture path wins, and why the order matters

The controller reads `pod.status.containerStatuses[].state.terminated.message` **first**, and only
falls back to scanning the log tail for the sentinel.

**The log path is forgeable by the model** — the agent's own output can contain `##FACTORY_RESULT##`.
Termination message first, log scan as a fallback that takes the **last** occurrence only. Kubernetes
caps the termination message at 4096 bytes, hence `final_message` truncation and the
`final_message_truncated` flag.

`terminationMessagePolicy: FallbackToLogsOnError` is set so a crash with no written message still
yields the log tail.

| Rejected | Why |
| --- | --- |
| Read pod logs via the API before delete | Races `ttlSecondsAfterFinished`, and it is the forgeable path. |
| A sidecar that ships the result | A second container's lifecycle to get wrong, and it still has to survive the same OOM. |

**If the agent is OOM-killed mid-run and never writes an envelope:** `classify.ts` sees `OOMKilled` on
the pod and reports `infra`, and `result_parse = 'missing'`. The git-measured facts are lost for that
attempt, which is correct — nothing measured them. Null, not zero.

### Large logs

No object store exists, and `executor.store_logs` defaults false ([07](07-config.md)), so slice 1
stores none. `GET /api/tasks/:id` returns `logs.available: false` plus a `hint` the CLI prints as a
ready-made `kubectl logs` command ([06](06-api-and-auth.md)).

Deferred to `008_agent_task_logs.sql` behind the default-false switch, with a per-attempt byte cap:
agent stdout contains source code and assistant text, which is a **bigger** privacy exposure than the
prompt column.

---

## 6. Agent image

`docker/Dockerfile.agent`. **One image with both tools.**

- Base `node:24-bookworm-slim`, **not alpine**: the agent runs project test suites, and musl breaks
  prebuilt native modules — a failure that looks like the agent being bad at its job.
- `apt-get install git ca-certificates python3 build-essential` plus `postgresql-client` (this repo's
  own `test:db` needs one).
- Both CLIs at pinned versions via `npm i -g`, recorded as `EXECUTOR_CLAUDE_VERSION_PIN` /
  `EXECUTOR_OPENCODE_VERSION_PIN`.
- `COPY executor/runner executor/scripts /opt/factory/` — **by directory**, because `tsc` compiles
  neither, the same trap the existing Dockerfile documents for `server/migrations/`.
- Build gate: run `executor/scripts/verify-cli-flags.sh` ([02](02-adapters.md) §6) as a build step, so
  a flag rename fails the image rather than the first task.
- **Do not install the agent-telemetry plugin.** The controller writes `session_branch`; two writers
  is Flag E.

*Rejected:* one image per tool — doubles the build matrix, and the CLIs are ~100 MB against a ~700 MB
base either way.

---

## 7. Acceptance criteria

### `npm test` — offline, against the pure builders

| File | Must assert |
| --- | --- |
| `executor/test/job-spec.test.ts` | **The prompt appears in neither `args` nor `env` of the returned `V1Job`** (sentinel string, searched over the whole serialised object). **No git token appears anywhere in the object.** `backoffLimit === 0`. `activeDeadlineSeconds` comes from the task. `automountServiceAccountToken === false`. `runAsNonRoot`, dropped capabilities, seccomp profile all present. Both `emptyDir`s carry a `sizeLimit`. Labels match the selector the controller queries with. Name ≤ 52 chars. |
| `executor/test/secret-spec.test.ts` | `ownerReferences` points at the Job. `defaultMode: 0400`. The bearer token is present in the Secret and **its hash, not the token, is what the store is asked to persist.** |
| `executor/test/adapter.result.test.ts` | (Owned by [02](02-adapters.md).) Includes the adversarial `##FACTORY_RESULT##` case that pins the capture ordering specified here. |

The first two assertions are the security regression tests for Flag C. Write them as a search over the
serialised object, not as a field-by-field check — a field-by-field check passes when someone adds a
new field.

### Local, no cluster

`entrypoint.mjs` is exercised end to end by the **local backend** ([03](03-controller.md) §2), which
spawns the same script against a temp checkout. That covers steps 1–6 above including the envelope
and the flush sleep.

### Cluster-only ([08](08-deploy.md))

`terminationMessage` really arriving; `FallbackToLogsOnError` behaving on a crash; the pod reaching
the OTEL collector; the init container reaching the mirror Service under the NetworkPolicy; the
credential helper round-trip; `OOMKilled` appearing where `classify.ts` expects it.

## Files

**Create:** the eleven files in §1.

**Modify:** nothing outside `executor/` and `docker/`. (`server/src/github/token.ts` is *referenced*
as the pattern; it is not changed.)
