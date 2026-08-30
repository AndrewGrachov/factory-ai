# Security posture

Read before: changing a bind address, a header, a PAT scope, or any `OTEL_LOG_*` setting.

**There are two postures, and `AUTH_MODE` picks between them explicitly.** With `AUTH_MODE=github`
every `/api/*` route requires a credential — a session cookie for people, a `Bearer fwt_…` worker
token for the driver. With `AUTH_MODE=none`, the default, there is no application-level auth at all
and the `127.0.0.1` bind is the access control, exactly as it always was; `loadConfig` refuses that
mode on a non-loopback `HOST` unless `AUTH_ALLOW_PUBLIC_BIND=1` says something else is doing the
authenticating. See [auth.md](auth.md). CSP and `X-Content-Type-Options` / `Referrer-Policy` are set
as response headers in `app.ts` (a `meta` tag would not let dev allow the Vite HMR websocket).

**The SPA's own document is served unauthenticated on purpose, in both modes.** If `index.html`
answered 401 there would be nothing left to render a sign-in button in. The wall is on `/api/*`.

**Authentication is not a sandbox.** Signing in narrows "anyone who can reach the port" to "any
member of this organization"; it does not make any route safe to hand out. See the job board below.

Required fine-grained PAT permissions: `Metadata: read`, `Pull requests: read`, and
`Contents: read` (revert rate only).

The PAT may now sit on disk in `factory.toml`, which is gitignored and dockerignored. `chmod 600`
it — the boot warning about a group/world-readable mode is not decorative, because no
application-level auth plus a readable token is worse than either alone. That warning covers
`GITHUB_OAUTH_CLIENT_SECRET`, `SESSION_SECRET` and `INGEST_TOKEN` as well as the PAT: a file holding
only a session secret is exactly as bad, and keying the check on one name would have left it silent.

`SESSION_SECRET` signs the session cookie, so rotating it logs everyone out — which is the only
lever there is when something has leaked. Session rows hold the sha-256 of a token, never the token,
because the table would otherwise be a list of every live credential.

With `ORG_WORKSPACE_ROOT` set, the PAT is also used to clone private source onto the host, and that
source then sits in a plain directory next to a service with no auth. The token is passed to `git`
through the child environment and never on a command line or into `.git/config` — see
[workspace.md](workspace.md) for why that distinction is load-bearing.

**The driver mounts `/var/run/docker.sock`, which is root on the host.** A process holding that
socket can start a container with the host filesystem mounted, so it is not "docker access", it is
uid 0. That is why the driver is a separate service behind a compose profile — `docker compose up`
must not start it by accident — and why the socket is never given to the dashboard, whose port is
unauthenticated. Anything that can queue a job can already ask an agent to run commands; keeping
the socket one process away is what stops that from being trivially root.

**The job board is a different class of risk from every other route here.** `POST /api/jobs` queues
a shell command that a worker then runs against the organization's checkouts, with whatever
credentials that worker holds. Under `AUTH_MODE=none` the `127.0.0.1` bind is the only thing standing
between an unauthenticated request and remote code execution, and a driver running off-host removes
exactly that — so put authentication in front of the port *before* moving it, not after. Under
`AUTH_MODE=github` it is narrowed to **any member of the organization**, which is smaller and still
real: membership is not a sandbox, and `RUNNER_SKIP_PERMISSIONS` decides how much an agent may then
do. Queueing records `job.created_by`, so at least the request has a name against it. The claim side
takes a worker token rather than a session, because a member holding a lease is a member able to take
work away from the driver running it. See [jobs.md](jobs.md) and [auth.md](auth.md).

The telemetry ingest routes are unauthenticated unless `auth.ingest_token` is set, and the collector
listens on 4317/4318. Both are bound to `127.0.0.1` for the same reason as the dashboard. The token
is optional because the two callers are a collector on the compose network and a plugin installed on
developer laptops, and requiring it would break both with no migration path; it travels as
`X-Factory-Ingest-Token`, never as a query parameter, which would land in every access log. It is an
*authenticity* check rather than an authorization one: `metric_point` has no `org_id` by design, so a
shared token cannot bind an export to an organization either. **Keep
`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES` and `OTEL_LOG_TOOL_DETAILS` off** — set
to `0` in `.claude/settings.json`. Enabling any of them puts prompt text and source code into the
database, and the attribute allowlist does not save you: that content arrives as the log record
*body*, not as an attribute.
