# 06 — HTTP API, auth, and CLI

**Depends on:** [01-schema-and-store](01-schema-and-store.md) (the store),
[07-config](07-config.md) (`config.executor`).
**Blocks:** nothing — but nothing is usable without it.

## Scope

The intake surface: four routes on the existing Fastify server, the authentication that has to exist
before they do, and a CLI that is the only UI in the first slice.

## Non-goals

The controller ([03](03-controller.md)); the executor's own internal HTTP surface, which lives in the
controller process ([04](04-git-mirror.md) §5, [05](05-job-and-runtime.md) §4); a dashboard panel
(§6 says why it is deferred).

---

## 1. Registration

`server/src/routes/tasks.ts`, wired in `server/src/app.ts`:

```ts
if (config.executor) await app.register(taskRoutes(config.executor, taskStore, auth, now));
```

Conditional registration mirrors the existing `if (store) await app.register(ingestRoutes(store))`.
Two reasons, and the second is the load-bearing one:

- A dashboard not running the executor has no such route to attack.
- `config.executor === null` makes "disabled" a **discriminant**, not something inferred from a flag
  plus a token plus a tool list. `docs/api.md` already states the rule for
  `meta.organization.mode`: "a discriminant, never inferred".

The server **never** talks to Kubernetes. It writes a row and returns. *Rejected:* the server creating
Jobs directly — that puts cluster credentials in the process serving the SPA on a port with no
application auth.

---

## 2. Auth — confront this before writing a route

**This is the most dangerous route in the codebase and the existing posture does not cover it.**

`docs/security.md` says: *"There is no application-level auth. The `127.0.0.1` bind in
`docker-compose.yml` is the access control."* Three reasons that argument fails **specifically here**:

1. **The posture does not transfer to Kubernetes.** The controller is a Deployment. If the server
   moves into the cluster with it there is no loopback bind, and anything that can reach the Service
   can queue a job. If the server stays on the operator's laptop, it now needs a network path to the
   cluster's database — a second hole in the same reasoning.
2. **Every existing route is a read.** A browser-origin POST to `127.0.0.1:8080` is harmless against
   `/api/refresh` and catastrophic against `/api/tasks`. The CSP blocks `form-action` and the JSON
   content-type forces a CORS preflight — **that preflight is currently the only thing** between a
   malicious page open in the operator's browser and a pod with git push credentials. That is a thin
   reed.
3. **There is no audit identity.** Without one, "who queued this push" is permanently unanswerable.

### Required, all four, all cheap

| Mitigation | Detail |
| --- | --- |
| **Opt-in surface** | `executor.enabled` defaults `false`, and the routes are **not registered** when it is false. |
| **A shared-secret bearer token, required** | `EXECUTOR_API_TOKENS` as `name:secret[:trusted]` entries. `loadConfig` is **fatal** if `enabled` is true and no token is set, and **fatal on any secret shorter than 32 chars** — a short secret on an RCE endpoint is worse than none, because it looks like protection. Compared with `crypto.timingSafeEqual` over a fixed-length hash, so the compare is not a length oracle. |
| **`requested_by`, not null** | From the token's name (`token:ci-bot`) or `cli:<os-user>`. |
| **`repo` must be one of `config.repoNames`** | **The highest-value line in the whole design.** The request never carries a clone URL. An arbitrary URL is how an attacker gets the pod's credential to push somewhere they control, and how the token gets exfiltrated by pointing at their own host. |

Plus: `permissionMode: 'full'` is **double-gated** — `executor.allow_full_permissions` *and* a
`trusted` token; `max_queued_per_hour` → 429, because an accidentally-open endpoint that spawns pods
is also a cloud-bill DoS; and the agent ServiceAccount is scoped so a compromised agent cannot create
more Jobs ([05](05-job-and-runtime.md)).

New file `server/src/executor-token.ts`, mirroring `server/src/github/token.ts`: **the secret never
enters `AppConfig`**, exactly as `GITHUB_TOKEN` does not, so `console.log(config)` stays safe and
"never log the merged record" stays true.

**This deliberately breaks the "no application-level auth exists" invariant.** It is the right place to
break it, and `docs/security.md` must be **rewritten** rather than appended to: the sentence "the bind
is the access control" becomes false the moment this route exists.

---

## 3. Check ordering — not negotiable

Every handler, in this order:

1. **auth** → 401 / 403
2. **`?org=` / `body.org` mismatch** → `400 UNKNOWN_ORG`
3. body / param shape → `400 …`
4. semantics (repo allowlist, tool, permission mode, MCP names) → `400 …`
5. rate limit → `429`
6. store

`UNKNOWN_ORG` before everything else for the reason `docs/api.md` already gives: the organization
selects *which* data set is being addressed, and "the day auth lands, that habit is a cross-tenant
read". Auth ahead of even that, because an unauthenticated caller must learn nothing about which orgs
exist.

Matches `server/src/routes/stats.ts`, where `UNKNOWN_ORG` is already checked before `parseRange` and
before `ensureFresh()` — *"a bad request must never be answered with a 202 the client then polls
forever."*

---

## 4. Routes

### `POST /api/tasks`

Body cap **64 KB** (`{ bodyLimit: 65_536 }`) — same shape of argument as the 1 MB OTLP cap: far above a
real prompt, far below anything usable to pressure the process. `415` on a non-JSON content-type.

```jsonc
{
  "repo": "Bellows-AI/bellows.ai",       // required, must be in organization.repos
  "baseBranch": "dev",                         // optional, defaults to config.baseBranch
  "tool": "claude-code",                       // optional, defaults to executor.default_tool
  "invocation": { "kind": "command", "name": "bellows-frontend-fix", "args": "LEEL-1234" },
  "prompt": "",                                // required when kind === 'prompt'
  "permissionMode": "acceptEdits",             // optional
  "mcpServers": ["jira"],                      // optional, names resolved against executor config
  "model": null,
  "timeoutSeconds": 1800,                      // optional, clamped to config
  "priority": 0,
  "clientKey": "cli-3f2a…"                     // optional idempotency key
}
```

| Code | When |
| --- | --- |
| `201` + `Location: /api/tasks/<id>` | Created. |
| `200` | `clientKey` already existed. Same row, no second agent. |
| `400 UNKNOWN_ORG` | `?org=` / `body.org` mismatch. |
| `400 BAD_TASK` | Malformed body; missing `repo`; `invocation.kind` not one of three; empty `prompt` for `kind: 'prompt'`. |
| `400 UNKNOWN_REPO` | Not in `organization.repos`. **The single highest-value validation here.** |
| `400 UNKNOWN_TOOL` | Not in `executor.tools`. |
| `400 UNSUPPORTED_INVOCATION` | The chosen tool's adapter reports `supports.command === false` (or `.skill`). **Never silently downgraded to prose** — same rule as `?range=` invalid giving `400 BAD_RANGE`. |
| `400 BAD_PERMISSION_MODE` | Not one of three; or `full` while `allow_full_permissions` is false; or `full` from a non-`trusted` token. |
| `400 UNKNOWN_MCP_SERVER` | A name not in the executor's MCP config. |
| `401 UNAUTHENTICATED` / `403 FORBIDDEN` | §2. |
| `429 RATE_LIMITED` + `Retry-After` | `max_queued_per_hour` exceeded. |
| `503 STORE_UNAVAILABLE` | Genuine write failure only. Reserved for "resend", like the OTLP route. |
| `404` | `executor.enabled = false` — the route does not exist. |

**201, not 202.** The row is created synchronously and durably and the response carries the id the
caller needs; that is a completed action. `status: 'queued'` is what says the *execution* is async.
`POST /api/sessions/branch` is 202 because it is fire-and-forget from a hook that will never read the
answer; this is the opposite. *Rejected:* 202 for consistency with the other two POSTs — it would make
"did my task get persisted" unanswerable from the status line.

### `GET /api/tasks/:id`

`200` · `400 UNKNOWN_ORG` · `400 BAD_TASK_ID` (not a uuid — **rejected, not 404**, because a malformed
id is a client bug and a 404 sends the reader looking for a deleted row) · `404 TASK_NOT_FOUND`.

```jsonc
{
  "task": { "id": "…", "status": "running", "repo": "…", "invocation": {…},
            "requestedBy": "cli:andrii", "prompt": "…" },
  "attempts": [{ "attemptNo": 1, "status": "running", "sessionId": "…", "jobName": "…",
                 "baseSha": "…", "headSha": null, "commits": null }],
  // null until the pod's final OTEL export lands, which is one export interval AFTER the attempt
  // finishes. Rendered as "pending", never as 0.
  "tokens": null,
  "tokensReason": "export-pending",   // export-pending | no-session-id | unmapped-agent | null
  // A discriminant, not an inference from an empty array.
  "logs": { "available": false,
            "hint": { "namespace": "factory-agent", "selector": "factory.dev/task=<id>" } }
}
```

### `GET /api/tasks`

`?status=` (repeatable) `?repo=` `?limit=` (default 50, max 200) `?cursor=` (opaque `createdAt|id`).

`200 { tasks, page: { nextCursor } }` · `400 BAD_STATUS` · `400 BAD_LIMIT` · `400 BAD_CURSOR` ·
`400 UNKNOWN_ORG`.

- **Keyset, not offset** — rows are inserted continuously and an offset page silently repeats or skips.
- **No silent clamping of `limit`**: `?limit=5000` is a 400, not a quiet 200.
- **`prompt` is omitted from list rows** and returned only by `GET /api/tasks/:id`. A list endpoint
  that sprays every prompt in the org into one response is what an over-broad token turns into a data
  dump.

### `POST /api/tasks/:id/cancel`

| Code | When |
| --- | --- |
| `200 { task }` | It was `queued`; one atomic `update … where status='queued'` made it `cancelled`. It really is cancelled. |
| `202 { task }` | It was `running`; `cancel_requested_at` is set and the controller will destroy the run. Only *requested*. |
| `409 ALREADY_TERMINAL` | Already `succeeded`/`failed`/`cancelled`. |
| `404 TASK_NOT_FOUND` | |

The 200/202 split is the entire reason `cancel_requested_at` is a column rather than a status: the
status line then tells the truth about whether anything actually stopped. **Never 5xx for a
well-formed request**, same rule as `/api/sessions/branch`.

### No log route in slice 1

The server has no cluster credentials; only the controller does.

| Rejected | Why |
| --- | --- |
| Server proxies to a controller endpoint | Turns the unauthenticated dashboard into a proxy for arbitrary pod logs in the cluster. |
| SSE stream | The SPA polls every 2s and has no streaming client; a stream is a new failure mode for no new information. |
| Controller tails into the database now | That is `agent_task_log` + `store_logs`, and agent stdout contains source code and assistant text — a bigger privacy exposure than the prompt column. |

---

## 5. CLI

`executor/src/cli/task.ts`, exposed as `npm run task`.

```
task create --repo <owner/name> [--prompt <text> | --command <name> [--args <s>] | --skill <name>]
            [--tool] [--permission-mode] [--base-branch] [--mcp <name>…] [--timeout] [--wait]
task get <id>
task list [--status …] [--repo …] [--limit …]
task cancel <id>
task logs <id>        # prints the ready-made kubectl command from logs.hint
```

**It talks HTTP to the server, never to the database.** One intake path, so the validation in §4 and
the `requested_by` attribution cannot be bypassed. *Rejected:* the CLI writing rows through
`createTaskStore` directly — skips every check and produces rows with no audit identity.

`--wait` polls `GET /api/tasks/:id` and exits non-zero on a terminal `failed`.

---

## 6. Dashboard surface — deferred, and why

**Do not put a task list in `web/` in slice 1.** Two concrete reasons:

- `/api/stats` is a single cached snapshot behind two **process-global** cache slots
  (`docs/limits.md`), and a task list is live, mutable and paginated. Folding it in would either
  lengthen the cold-fetch path or serve a stale task list with a 200 — the one thing that cache design
  is careful about.
- The SPA has no auth, so a task list in the browser means the browser holding the executor token.

If something visible is wanted now, the smallest honest thing is **counts only** in `meta`:

```jsonc
"meta": { "executor": { "enabled": true, "queued": 2, "running": 1,
                        "succeeded24h": 9, "failed24h": 1 } }
```

No ids, no prompts, no per-task rows — nothing an operator's own dashboard should not show, so it
needs no token. `meta.executor` is **`null` when disabled** (a discriminant, not `queued === 0`).
Slice 2 adds the real list plus a token-bearing fetch.

---

## 7. Acceptance criteria — `npm test`, offline

`server/test/routes.tasks.test.ts`, driven through `app.inject()` with `memoryTaskStore()`:

- **`UNKNOWN_ORG` is what comes back when both the org and the body are wrong** — this pins the check
  ordering and is the same guard the stats route already has.
- Routes are absent (404) when `config.executor === null`.
- 401 with no token; 403 with a wrong one; a 31-char configured secret is a **config-load failure**,
  not a request failure.
- `full` refused twice over: once by `allow_full_permissions: false`, once by a non-`trusted` token.
- `UNKNOWN_REPO` for a repo not in `config.repoNames`.
- `UNSUPPORTED_INVOCATION` rather than a silent downgrade to prose.
- Idempotent replay of the same `clientKey` → **200, not 201**, and the store records one create.
- 429 past `max_queued_per_hour`, with `Retry-After`.
- A body over 64 KB is rejected; a non-JSON content-type is 415.
- Cancel: 200 vs 202 vs 409 for the three states.
- `prompt` is **absent** from every list row and **present** on the detail route.
- `tokens: null` with a `tokensReason` — never `0` — for an attempt with no session id.

`server/test/config.executor.test.ts` covers the config-load failures; owned by
[07](07-config.md).

## Files

**Create:** `server/src/routes/tasks.ts`, `server/src/executor-token.ts`,
`executor/src/cli/task.ts`, `server/test/routes.tasks.test.ts`.

**Modify:** `server/src/app.ts` (conditional registration), `server/src/index.ts` (construct the task
store and the token verifier), `package.json` (the `task` script), `docs/api.md`,
`docs/security.md` (**rewrite** the access-control paragraph).
