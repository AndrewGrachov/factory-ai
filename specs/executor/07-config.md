# 07 — Configuration

**Depends on:** [00-overview](00-overview.md).
**Blocks:** [03-controller](03-controller.md), [06-api-and-auth](06-api-and-auth.md).

## Scope

Two config surfaces that must not become one: what the **server** needs to accept a task, and what the
**controller** needs to run one. Plus the `config-file.ts` changes that let `factory.toml` carry an
`[executor]` section without breaking the dashboard.

## Non-goals

The routes that read the config ([06](06-api-and-auth.md)); the controller that reads the other half
([03](03-controller.md)).

---

## 1. The split, and why it is a split

| Consumer | Lives in | Reads |
| --- | --- | --- |
| Server (intake) | `server/src/config.ts` → `AppConfig.executor` | `factory.toml` `[executor]` + env |
| Controller (deployment) | `executor/src/config.ts` → `loadExecutorConfig(env)` | **env only** |

**Controller-only settings — namespace, image, service account, resources — have no `factory.toml`
form.** They are deployment facts that belong in the Kubernetes manifest, and putting them in a file
the *server* also parses would mean `loadConfig` validating fields it can never act on. A field
nothing reads is a field that drifts.

This is also what keeps `executor` from depending on `@factory-ai/server`.

| Rejected | Why |
| --- | --- |
| `executor` imports `resolveConfig` from `server` | Makes an application a library for one call. |
| Duplicate the `KEYS` table in `executor` | Two sources of truth for a closed key set — the exact drift `config-file.ts` exists to prevent. |
| Hoist `config-file.ts` into `core` | Needs `smol-toml`, and "core has no dependencies" is a stated invariant. |

---

## 2. `AppConfig` gains exactly one field

```ts
export interface ExecutorIntakeConfig {
    readonly tools: readonly string[];
    readonly defaultTool: string;
    readonly defaultPermissionMode: PermissionMode;
    readonly allowFullPermissions: boolean;
    readonly maxQueuedPerHour: number;
    readonly maxAttempts: number;
    readonly taskTimeoutSeconds: number;
    readonly storeLogs: boolean;
    readonly logTailBytes: number;
    readonly mcpServers: readonly string[];
}

export interface AppConfig {
    // …existing fields…
    /** null when the executor is off. A discriminant, so `if (config.executor)` reads exactly like
     *  `if (store)` in index.ts — never inferred from `tools.length` or a bare boolean. */
    readonly executor: ExecutorIntakeConfig | null;
}
```

One nested object rather than eight loose booleans on `AppConfig`.

**The API secret is deliberately NOT in `AppConfig`.** `server/src/executor-token.ts` reads it from the
merged env, mirroring `envTokenProvider` in `server/src/github/token.ts`, so nothing that logs the
config can leak it — the same reason `GITHUB_TOKEN` is not there.

`loadConfig` still does **no I/O**. `loadConfig({})` has to mean the same thing on every machine, and
it must keep returning `executor: null` so the existing `describe('loadConfig')` block keeps meaning
what it means.

---

## 3. `[executor]` — `factory.toml` keys, server-consumed

`server/src/config-file.ts` needs a new `Kind: 'bool'`. TOML `true` → env `"true"`; a **quoted
`"true"` is rejected**, consistent with the existing rule that `ttl_seconds = "900"` is rejected.

| TOML | env | kind | default | validation (all fatal) |
| --- | --- | --- | --- | --- |
| `executor.enabled` | `EXECUTOR_ENABLED` | bool | `false` | must be `true`/`false` |
| `executor.api_tokens` | `EXECUTOR_API_TOKENS` | list | — | **fatal if `enabled` and empty**; each entry `name:secret[:trusted]`; **fatal if any secret < 32 chars** |
| `executor.tools` | `EXECUTOR_TOOLS` | list | `["claude-code"]` | non-empty; every entry in `KNOWN_AGENT_TOOLS` |
| `executor.default_tool` | `EXECUTOR_DEFAULT_TOOL` | string | first of `tools` | must be in `tools` |
| `executor.default_permission_mode` | `EXECUTOR_DEFAULT_PERMISSION_MODE` | string | `"acceptEdits"` | one of three |
| `executor.allow_full_permissions` | `EXECUTOR_ALLOW_FULL_PERMISSIONS` | bool | `false` | — |
| `executor.max_queued_per_hour` | `EXECUTOR_MAX_QUEUED_PER_HOUR` | int | `20` | positive |
| `executor.max_attempts` | `EXECUTOR_MAX_ATTEMPTS` | int | **`1`** | 1–5 |
| `executor.task_timeout_seconds` | `EXECUTOR_TASK_TIMEOUT_SECONDS` | int | `1800` | 60–86400 |
| `executor.mcp_servers` | `EXECUTOR_MCP_SERVERS` | list | `[]` | names the intake will accept |
| `executor.store_logs` | `EXECUTOR_STORE_LOGS` | bool | `false` | — |
| `executor.log_tail_bytes` | `EXECUTOR_LOG_TAIL_BYTES` | int | `16384` | positive, ≤ 1 MB |

**`max_attempts` defaults to 1** because a retry re-runs a prompt against push credentials. Auto-retry
is opted into, never inherited.

**`enabled` defaults to `false`** because the attack surface must be opt-in ([06](06-api-and-auth.md)
§2).

### Two edits to `config-file.ts` beyond the key table

1. **Register the `[executor]` section.** An unknown TOML *section* is fatal, so a shared
   `factory.toml` carrying `[executor]` would stop the **dashboard** booting until this lands.
2. **Extend the readability warning.** `readConfigFile` currently warns about a group/world-readable
   file only when it carries `GITHUB_TOKEN`. Extend the condition to `EXECUTOR_API_TOKENS` — otherwise
   a mode-644 file holding a key to remote code execution warns about nothing.

### `DEPLOYMENT_ONLY`

Since an unknown TOML key is fatal, `executor.namespace` in `factory.toml` would produce "unknown key
executor.namespace", which reads as a typo in something the operator reasonably expected to work.
`config-file.ts` gains a **`DEPLOYMENT_ONLY`** map beside the existing `MOVED` / `REMOVED` maps:

> `factory.toml: executor.namespace is set on the controller Deployment, not in this file —
> deployment settings are environment-only so the dashboard does not validate fields it cannot act on.`

Populate it with every key in §4.

### `docker-compose.yml`

```yaml
EXECUTOR_ENABLED: ${EXECUTOR_ENABLED:-}
EXECUTOR_API_TOKENS: ${EXECUTOR_API_TOKENS:-}
```

**Empty-defaulted**, joining the `ORG_*` three, for exactly the reason stated there: an empty
environment variable is not an override, and a literal default would clobber a mounted `factory.toml`
on every start. Here it would additionally either **silently enable an RCE endpoint** or silently
disable the token on it.

---

## 4. `ExecutorConfig` — env only, controller-side

`executor/src/config.ts`. **Does no I/O**, same rule and same reason as `loadConfig`:
`loadExecutorConfig({})` must mean the same thing on every machine.

| env | default | validation |
| --- | --- | --- |
| `DATABASE_URL` | — | required |
| `ORG_ID` | `default` | same pattern as `loadConfig`: `^[a-z0-9][a-z0-9_-]{0,38}$`, no leading `__` |
| `RUNNER_BACKEND` | `kubernetes` | `kubernetes` \| `local` |
| `EXECUTOR_NAMESPACE` | `factory-agent` | DNS-1123 label |
| `EXECUTOR_IMAGE` | — | **required when `RUNNER_BACKEND=kubernetes`** |
| `EXECUTOR_IMAGE_PULL_SECRET` | `null` | |
| `EXECUTOR_SERVICE_ACCOUNT` | `factory-agent` | |
| `EXECUTOR_POLL_INTERVAL_MS` | `2000` | ≥ 500 — a hot-loop floor, same shape as `MIN_TELEMETRY_TTL_SECONDS` |
| `EXECUTOR_MAX_CONCURRENT` | `2` | ≥ 1 |
| `EXECUTOR_LEASE_SECONDS` | `60` | ≥ 15 **and < `task_timeout_seconds`** |
| `EXECUTOR_LEASE_GRACE_SECONDS` | `2 × lease` | **≥ 2 × lease** — Flag G |
| `EXECUTOR_OTEL_ENDPOINT` | `http://collector:4318` | absolute URL |
| `EXECUTOR_OTEL_FLUSH_MS` | export interval + 2000 | ≥ 1000 — Flag F |
| `EXECUTOR_GIT_MIRROR_URL` | — | required |
| `MIRROR_TTL_SECONDS` | `60` | ≥ 0 |
| `EXECUTOR_CLAUDE_BIN` / `EXECUTOR_OPENCODE_BIN` | `claude` / `opencode` | |
| `EXECUTOR_CPU_REQUEST` / `_LIMIT` | `500m` / `2` | k8s quantity syntax |
| `EXECUTOR_MEMORY_REQUEST` / `_LIMIT` | `1Gi` / `4Gi` | k8s quantity syntax |
| `EXECUTOR_WORKSPACE_SIZE` | `10Gi` | k8s quantity syntax |
| `EXECUTOR_LOCAL_STATE_DIR` | `/tmp/factory-executor` | used only by `RUNNER_BACKEND=local` |
| `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` / `GITHUB_APP_PRIVATE_KEY` | — | required for pushes ([05](05-job-and-runtime.md) §4) |

### The cross-field invariants, validated here

- `EXECUTOR_LEASE_GRACE_SECONDS ≥ 2 × EXECUTOR_LEASE_SECONDS`
- `EXECUTOR_LEASE_SECONDS < executor.task_timeout_seconds`

Both are Flag G: if the lease reaper marks an attempt `lost` while the pod is still running and
holding push credentials, a retry launches a **second** agent on the same branch. Validate at config
load, not at the point of use — a misconfiguration must refuse to start rather than corrupt a branch
an hour later.

---

## 5. The controller must NOT call `migrate()`

`server/src/index.ts` already warns that two migration runners race each other, and `migrate()` also
calls `adoptOrg()`, which the executor has no business doing.

`executor/src/db/ready.ts` instead polls:

```sql
select 1 from schema_migrations where version = '006_agent_tasks.sql'
```

with backoff, and **refuses to claim** until it is present.

Say this loudly in a comment in `executor/src/index.ts`, because calling `migrate()` there is the
obvious thing to do and it is wrong.

---

## 6. Acceptance criteria — `npm test`, offline

| File | Must assert |
| --- | --- |
| `server/test/config.executor.test.ts` | `loadConfig({})` returns `executor: null`. `enabled` without tokens is **fatal**. A 20-char secret is **fatal**. `default_tool` not in `tools` is fatal. `default_permission_mode` outside the enum is fatal. `max_attempts` outside 1–5 is fatal. `timeoutSeconds` outside 60–86400 is fatal. **The secret does not appear anywhere in the returned `AppConfig`** (search the serialised object). |
| `server/test/config.file.test.ts` (extend) | `[executor]` keys parse. The new `bool` kind: `true` accepted, `"true"` rejected. `executor.namespace` produces the `DEPLOYMENT_ONLY` message and not "unknown key". The readability warning fires on a file holding `api_tokens` and **no** PAT. An empty `EXECUTOR_ENABLED` env var does not override a file value. |
| `executor/test/config.test.ts` | `loadExecutorConfig({})` is fatal on the missing required fields. The poll floor. `lease < timeout`. `grace ≥ 2 × lease`. `RUNNER_BACKEND=local` does **not** require `EXECUTOR_IMAGE`. **No I/O**: `loadExecutorConfig({})` throws identically with a `factory.toml` present in cwd. |

The "search the serialised object" assertion is the one that keeps the secret out of logs. Written as a
field check it passes the day someone adds a new field.

## Files

**Create:** `executor/src/config.ts`, `executor/src/db/ready.ts`,
`server/test/config.executor.test.ts`, `executor/test/config.test.ts`.

**Modify:** `server/src/config.ts` (`ExecutorIntakeConfig`, the `executor` discriminant),
`server/src/config-file.ts` (section registration, `bool` kind, `DEPLOYMENT_ONLY`, readability
warning), `docker-compose.yml`, `factory.toml.example`, `.env.example`,
`server/test/config.file.test.ts`, `docs/configuration.md`.
