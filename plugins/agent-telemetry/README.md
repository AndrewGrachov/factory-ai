# agent-telemetry

Reports the git branch of each Claude Code session to a local Factory Stats dashboard, so AI
token usage can be attributed to individual pull requests.

## Why this exists

Claude Code's OpenTelemetry metrics carry no PR number, no branch name and no commit SHA —
`claude_code.pull_request.count` and `claude_code.commit.count` have only the standard
attributes. The only identifier shared between a metric and anything else is `session.id`.

Hooks, by contrast, receive `session_id` and `cwd`. This plugin samples
`git rev-parse --abbrev-ref HEAD` and posts `session -> (repo, branch)`; the dashboard then
joins that branch to `pullRequest.headRefName`.

Without it, every PR on the dashboard reads `attribution: none` forever.

## Install

The dashboard reports on one repo, and the sessions that matter happen **in that repo** — not
in the dashboard's own repo. So this installs at user scope and instruments every repo you
work in:

```bash
claude plugin marketplace add /path/to/factory-ai
claude plugin install agent-telemetry@factory-ai
```

Remove it at any time with `/plugin uninstall`.

## The other half: OTEL

This plugin supplies the branch. The token counts come from Claude Code's own OTLP export,
which is configured separately. `factory-ai/.claude/settings.json` has a working `env` block
to copy; to instrument another repo, put the same block in that repo's `.claude/settings.json`
or in `~/.claude/settings.json` for all repos at once.

Two settings there are load-bearing:

- **`OTEL_METRICS_INCLUDE_SESSION_ID` must stay true** (it is the default). It is the only link
  between a metric and a branch. Disabling it makes every PR read `none` and
  `sessionsWithoutHook` climb without bound — indistinguishable from this plugin being broken.
- **`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES` and `OTEL_LOG_TOOL_DETAILS` must
  stay off.** Enabling any of them puts prompt text and source code into the telemetry
  database. The server's attribute allowlist does not save you: that content arrives as the log
  record *body*, not as an attribute.

## What it sends

```json
{
  "agent": "claude-code",
  "sessionId": "abc123",
  "repo": "owner/name",
  "branch": "feat/x",
  "headSha": "deadbeef",
  "at": "2026-08-21T10:05:00Z"
}
```

`cwd` and `transcript_path` are read locally and **never transmitted** — both are absolute
host paths. No prompts, no file contents, no diff, no identity.

Endpoint defaults to `http://127.0.0.1:8080`; override with `FACTORY_STATS_URL`.

## Behaviour

Enabled at user scope, this runs in every repo on the machine, so it is built to be
unnoticeable:

| | |
|---|---|
| Not a git repo | exits immediately |
| Dashboard down | silent no-op |
| Any error at all | exits 0, nothing on stderr |
| Request timeout | 200ms, fire-and-forget, no retry |
| Sampling | once per 20s per session, plus every session start and end |
| Dependencies | none — Node builtins and `git` |

There is no retry queue and no spool file on purpose. The signal is a periodic sample whose
loss model is already benign, and a spool would trade that for unbounded disk growth and
stale-replay bugs.

## Hooks used

| Event | Why |
|---|---|
| `SessionStart` | opens the interval with the session's first branch |
| `PostToolUse` on `Bash` | catches a `git checkout` mid-session |
| `SessionEnd` | closes the interval |

A session that holds several branches produces several intervals. If its metrics are
time-sliced they are divided between them; if only an end-of-session total exists, the
dashboard marks the session **shared** and reports no per-PR figure rather than a plausible
half.

## Verifying

```bash
claude plugin validate ./plugins/agent-telemetry
```

Worth running after any edit: a malformed `hooks/hooks.json` loads the plugin **without** its
hooks, and the only symptom is `sessionsWithoutHook` climbing on the dashboard's Data quality
panel.

## Limits

- Attribution starts when the plugin is installed. A PR merged before that shows no usage,
  which is not the same as having used none.
- The branch is **sampled, not tracked**. A branch held for less than one interval can be missed.
- A head branch is not unique — the same branch is often reused across PRs — so the dashboard
  narrows by time, assigning work to the first PR on that branch still open when it happened.
- Token counts are what the agent wrote, not what survived to merge.
