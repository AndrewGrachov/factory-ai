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

The telemetry ingest routes are unauthenticated, and the collector listens on 4317/4318. Both are
bound to `127.0.0.1` for the same reason as the dashboard. **Keep
`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES` and `OTEL_LOG_TOOL_DETAILS` off** — set
to `0` in `.claude/settings.json`. Enabling any of them puts prompt text and source code into the
database, and the attribute allowlist does not save you: that content arrives as the log record
*body*, not as an attribute.
