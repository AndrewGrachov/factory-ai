# Security posture

Read before: changing a bind address, a header, a PAT scope, or any `OTEL_LOG_*` setting.

There is no application-level auth. The `127.0.0.1` bind in `docker-compose.yml` is the access
control — do not expose the port without putting authentication in front of it first. CSP and
`X-Content-Type-Options` / `Referrer-Policy` are set as response headers in `app.ts` (a `meta`
tag would not let dev allow the Vite HMR websocket).

Required fine-grained PAT permissions: `Metadata: read`, `Pull requests: read`, and
`Contents: read` (revert rate only).

The PAT may now sit on disk in `factory.toml`, which is gitignored and dockerignored. `chmod 600`
it — the boot warning about a group/world-readable mode is not decorative, because no
application-level auth plus a readable token is worse than either alone.

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
credentials that worker holds. On this port, with no auth, the `127.0.0.1` bind is the only thing
standing between an unauthenticated request and remote code execution. A driver running off-host
removes exactly that — put authentication in front of the port *before* moving it, not after. See
[jobs.md](jobs.md).

The telemetry ingest routes are unauthenticated, and the collector listens on 4317/4318. Both are
bound to `127.0.0.1` for the same reason as the dashboard. **Keep
`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES` and `OTEL_LOG_TOOL_DETAILS` off** — set
to `0` in `.claude/settings.json`. Enabling any of them puts prompt text and source code into the
database, and the attribute allowlist does not save you: that content arrives as the log record
*body*, not as an attribute.
