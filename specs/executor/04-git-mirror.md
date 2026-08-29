# 04 — Git mirror and HTTP transport

**Depends on:** [00-overview](00-overview.md) for decision 2.
**Blocks:** [05-job-and-runtime](05-job-and-runtime.md) (the init container clones from here),
[08-deploy](08-deploy.md) (the PVC and Service).

## Scope

The controller owns a bare git mirror on its own `ReadWriteOnce` PVC and serves it over HTTP so agent
pods can clone it. This spec covers mirror lifecycle, locking, maintenance, ref resolution, the
`git-http-backend` CGI bridge, and the upload-pack-only enforcement.

## Non-goals

The Job spec that consumes this ([05](05-job-and-runtime.md)); the PVC and Service manifests
([08](08-deploy.md)); the forge credential used to push ([05](05-job-and-runtime.md) §Token).

---

## 1. Why this exists, and what it replaced

The original framing was "controller fetches latest repository state and branches off a worktree on a
shared volume". That needs an RWX volume, and it means every task's worktree shares one `.git` — an
agent running `git gc`, `git worktree prune` or just `rm -rf .git` corrupts every concurrent task.

So instead: **the controller is a git remote.** Pods clone from it over HTTP into their own
`emptyDir`. Git's own protocol does the transfer, so no filesystem semantics are faked.

| Rejected | Why |
| --- | --- |
| RWX PVC (NFS/EFS/Longhorn) with `git worktree` per task | Needs an RWX storage class; one shared `.git` across untrusted agents; NFS + git index locking is a known source of flake. |
| MinIO mounted via s3fs/goofys | Git needs atomic rename and `flock`; s3fs has neither. Index corruption under concurrent worktrees. |
| MinIO holding a bare-repo tarball, hydrated per pod | Two systems doing one job; the tarball is stale between refreshes so you still need a fetch; a whole extra stateful service. |
| Clone from the forge every task | Bandwidth and rate limits per task; needs cluster egress to the forge for *reads*; no offline story; contradicts "controller fetches latest repository state". |

**What is lost by not using `git worktree`: nothing that matters.** Worktrees were only a way to avoid
re-copying objects, and `--filter=blob:none` against an in-cluster mirror is cheaper than that anyway.

### Who creates the task branch, and when

- **Controller**: keeps the mirror current, then resolves `base_branch` → a **concrete SHA** and
  records it on the attempt (`base_sha`). That is what makes a run reproducible and what makes
  `base_sha..head_sha` a meaningful commit range.
- **Pod, in the init container**: `git clone --filter=blob:none --no-checkout --branch <base>` from the
  mirror Service, then `git checkout <base_sha>`, then `git switch -c fx/<task-id-short>`.

Branch creation moves into the pod. The mirror never sees the task branch — the push goes to the real
forge. This is why the mirror can be strictly read-only to pods.

---

## 2. Files

```
executor/src/git/git.ts             execFile wrapper. GIT_TERMINAL_PROMPT=0, GIT_ASKPASS, no token on
                                    argv, no token in a stored remote URL.
executor/src/git/naming.ts          mirrorPath(repo), branchName(taskId), jobName(...). PURE.
executor/src/git/lock.ts            per-repo in-process serializer + flock on /mirror/<key>.lock
executor/src/git/mirror.ts          ensureMirror / refreshMirror / resolveRef / maintain
executor/src/git/http-backend.ts    CGI bridge: spawn git-http-backend, stream body both ways
executor/src/git/cgi-headers.ts     PURE CGI response-header parser
executor/src/http/routes/git.ts     /git/:org/:repo.git/*  — authenticated, upload-pack only
```

---

## 3. Mirror lifecycle

Path: `/mirror/<owner>-<name>.git`, from `naming.ts` — sanitised, and rejected rather than normalised
if it does not match `^[A-Za-z0-9._-]+$` after the slash split. A repo name that needs escaping to be
a path is a repo name that should not have passed intake ([06](06-api-and-auth.md) validates against
`config.repoNames`).

**Create:** `git clone --mirror <upstream> /mirror/<key>.git`. *Rejected:* `git init --bare` +
`git remote add` + fetch — equivalent, but `--mirror` sets `remote.origin.mirror` and the
`+refs/*:refs/*` refspec correctly in one step, and hand-rolling the refspec is how you end up with a
mirror missing tags.

**Refresh:**

```
git fetch --prune --prune-tags origin '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'
```

`--prune` matters: without it a deleted upstream branch stays clonable forever, so a task can be
launched against a branch that no longer exists and nothing reports why.

**Upstream auth without a token on argv or on disk:** set `GIT_ASKPASS` to a tiny script that echoes
the credential, supplied via the environment of that one `execFile` call. A token on argv is visible
in `/proc/<pid>/cmdline` to anything in the pod; a token baked into `remote.origin.url` is written to
`.git/config` on the PVC and survives restarts and backups. Also set `GIT_TERMINAL_PROMPT=0` so a
credential failure is an error rather than a hang.

**Staleness policy:** a TTL, `MIRROR_TTL_SECONDS` (default 60), mirroring the dashboard's `syncTtlMs`
— plus a **forced fetch when the task's `base_branch` ref is absent from the mirror.** Every task
forcing a fetch makes the mirror the bottleneck at concurrency; never fetching means a task runs
against yesterday's base.

**Maintenance:** `git gc --auto` after every N fetches (N configurable, default 20). An unmaintained
mirror accumulates loose objects and pack fragments until both clone time and disk degrade —
**silently**, because nothing errors. Note the disk risk: the PVC is finite and a monorepo mirror plus
loose objects can fill it, at which point every fetch fails and every task fails as `infra`. Alert on
PVC usage; [08](08-deploy.md) sizes it at 50Gi.

**Ref resolution:** `git rev-parse --verify refs/heads/<base>^{commit}`. A missing ref is a task-level
failure with a named error, not a retry — the branch is not going to appear.

---

## 4. Locking

Two layers, because they fail differently.

1. **In-process per-repo serializer** — an async mutex keyed by mirror path. Handles the common case:
   two tasks for the same repo tick in the same loop iteration.
2. **`flock` on `/mirror/<key>.lock`** — handles the uncommon one. `flock` is held by the *process*, so
   a crashed controller's lock dies with it. That is exactly why it is used instead of a lock file
   with a PID in it.

**Across a controller restart**, the residual risk is not `flock` but git's own
`/mirror/<key>.git/*.lock` files (`index.lock`, `refs/heads/*.lock`, `gc.pid`), which a `SIGKILL`
leaves behind. Sweep them at boot with an age check (> 10 min) and log loudly. Do **not** delete them
unconditionally: an unconditional sweep at boot races a still-running fetch in a multi-replica world,
and the whole point of Flag B is that multi-replica is a later change, not an impossible one.

---

## 5. Serving over HTTP

`git-http-backend` is a **CGI program**. The bridge in `http-backend.ts` spawns it per request:

| Env | Value |
| --- | --- |
| `GIT_PROJECT_ROOT` | `/mirror` |
| `GIT_HTTP_EXPORT_ALL` | `1` (there is no `git-daemon-export-ok` file per mirror) |
| `PATH_INFO` | `/<key>.git/<rest>` — derived from the route, never from the raw URL |
| `REQUEST_METHOD` | `GET` or `POST` |
| `QUERY_STRING` | passed through, after the service allowlist check |
| `CONTENT_TYPE`, `CONTENT_LENGTH` | from the request |
| `REMOTE_USER` | the authenticated task id, for the access log |

Request body streams to the child's stdin. The response is CGI-framed: headers, `\r\n\r\n`, then body.
`cgi-headers.ts` parses the header block off stdout and only then starts streaming the body out —
**and it must handle the delimiter spanning a chunk boundary**, which is the bug this file exists to
make testable.

*Rejected: a pure-Node smart-HTTP implementation.* Pack negotiation is the hard part, git already
ships a correct one, and a subtly wrong `want`/`have` exchange fails as a slow clone rather than an
error.

### `node:24-alpine` has no `git`

The existing `docker/Dockerfile` runtime stage is `node:24-alpine`, which ships no git at all. The
controller therefore needs **its own image**, `docker/Dockerfile.executor`, with
`apk add --no-cache git git-daemon` (the `git-daemon` package is what carries
`/usr/libexec/git-core/git-http-backend` on Alpine — verify the path at build time rather than
hardcoding a guess).

This is a real consequence of decision 2 and it is easy to miss: it fails only in the container.

### Upload-pack only — two independent gates

Pods must not be able to push to the mirror.

1. **Route allowlist** in `routes/git.ts`: permit only `GET /info/refs?service=git-upload-pack`,
   `GET` of static objects/packs, and `POST /git-upload-pack`. Reject `/git-receive-pack` and
   `service=git-receive-pack` with 403.
2. **`git config http.receivepack false`** set on every mirror at creation.

Two gates because the route check is one typo away from being bypassed, and the consequence of a
bypass is an agent rewriting the shared base history for every subsequent task.

### Authentication

Every request carries the per-task bearer token ([05](05-job-and-runtime.md) §Token) via
`Authorization`. `executor/src/http/auth.ts` verifies: sha256 hash compare against the stored hash,
the attempt is non-terminal, **and the requested mirror key matches the task's `repo`**. A task
authorised for one repo must not be able to clone another — the mirror holds every configured repo on
one volume.

---

## 6. Acceptance criteria

### `npm test` — offline

| File | Must assert |
| --- | --- |
| `executor/test/cgi-headers.test.ts` | Header/body split on `\r\n\r\n`; **a header block spanning a chunk boundary** (feed the fixture in 1-byte chunks); a status line via the `Status:` header; a malformed block is an error rather than a silently empty body. No git binary involved. |
| `executor/test/naming.test.ts` | `mirrorPath()` for qualified and bare repo names; a name with `..`, `/`, a leading `-`, or a null byte is **rejected, not sanitised**; `branchName()` is stable and DNS-safe. (Shared with [03](03-controller.md).) |
| `executor/test/git-routes.test.ts` | Via `app.inject()` against `buildExecutorApp()` with a stub backend: `service=git-receive-pack` → 403; `POST /git-receive-pack` → 403; no `Authorization` → 401; a valid token for repo A requesting repo B → 403; a terminal attempt's token → 403. **These are the security assertions and they need no git and no cluster.** |

### Needs a real git binary and a real repo — new script, not in `npm test`

`executor/scripts/verify-mirror.sh`: create a throwaway upstream repo in a temp dir, `ensureMirror`,
`refreshMirror`, `resolveRef`, then `git clone --filter=blob:none` from the running controller's HTTP
endpoint and assert the clone has the resolved SHA. Then attempt a push and assert it fails.

Kept out of `npm test` because that suite is offline and must stay so; kept out of the cluster e2e
because it does not need a cluster.

### Cluster-only

That the Service is reachable from the agent namespace under the NetworkPolicy in
[08](08-deploy.md), and that `git-http-backend` exists at the expected path in the built controller
image.

## Files

**Create:** the seven files in §2, plus `docker/Dockerfile.executor`,
`executor/scripts/verify-mirror.sh`, and the three test files.

**Modify:** nothing outside `executor/` and `docker/`.
