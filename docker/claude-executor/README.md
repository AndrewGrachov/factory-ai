# claude-executor

Claude Code in a container, with a fixed configuration baked in. It runs an agent against a mounted
checkout; it does not build or run this repo's application.

## Layout

| Path | Becomes |
| --- | --- |
| `Dockerfile` | the image — Node 24 (debian), git, `@anthropic-ai/claude-code`, `acli`, the `context-mode` plugin |
| `entrypoint.sh` | `/usr/local/bin/claude-executor` — the `ENTRYPOINT` |
| `test.sh` | builds the image and exercises it against this repo — not shipped inside it |
| `claude-home/` | `/home/node/.claude` inside the image, via `CLAUDE_CONFIG_DIR` |
| `claude-home/settings.json` | telemetry configuration |
| `claude-home/CLAUDE.md` | the global instructions every session loads |
| `claude-home/skills/` | `github`, `jira`, `backend-fix` — loaded on demand, not every session |

`claude-home/` is the predefined configuration folder. Whatever you drop in it ships in the image —
add `agents/`, `commands/` or `hooks/` and they need no Dockerfile change.

Tool-specific guidance lives in `skills/`, not in `CLAUDE.md`: `CLAUDE.md` is read in full at the
start of every session, while a skill costs only its description until something actually invokes
it. Anything that applies to a subset of tasks belongs in a skill. It is a
deliberate copy rather than a mount of the host's `~/.claude` — that directory holds
`.credentials.json`, `history.jsonl` and per-project session state, none of which belong in an image
layer or in git.

`CLAUDE.md` is deliberately vendor-neutral: this repo is public, so it carries no site names,
ticket prefixes or internal repo references. It also documents only tooling the image actually
has — instructions for an absent binary cost tokens every session and end in
`command not found`. To run with your own instead, mount over it:
`-v "$HOME/.claude/CLAUDE.md:/home/node/.claude/CLAUDE.md:ro"`.

## Preinstalled tooling

- **`context-mode` plugin**, installed at build time from `mksglu/context-mode` and enabled. Its
  MCP server is plain `node`, so nothing further is needed at run time. Because
  `claude plugin install` writes `extraKnownMarketplaces` and `enabledPlugins` into `settings.json`
  itself, those keys are deliberately absent from the committed file.
- **`acli`** (Atlassian CLI) at `/usr/local/bin/acli`, matching `CLAUDE.md`'s instruction to drive
  Jira through it rather than through the Atlassian MCP server. Unauthenticated on a fresh
  container — it reads credentials from `~/.config/acli`, so either log in once per container:

  ```bash
  docker run --rm -it -e JIRA_API_TOKEN claude-executor \
      sh -c 'echo "$JIRA_API_TOKEN" | acli jira auth login \
          --site your-site.atlassian.net --email you@example.com --token'
  ```

  or mount an existing profile read-only with `-v "$HOME/.config/acli:/home/node/.config/acli:ro"`.
  Note that `ENTRYPOINT` is `claude`, hence the explicit `sh -c` above.

## Build

```bash
docker build -t claude-executor docker/claude-executor

# Pin the CLI instead of tracking latest:
docker build --build-arg CLAUDE_CODE_VERSION=2.0.0 -t claude-executor docker/claude-executor
```

The build context is this directory, not the repo root.

## Test

```bash
docker/claude-executor/test.sh
```

Builds the image as `claude-executor-test` and runs eleven checks against this repo as the mounted
checkout: the CLI, `acli`, the plugin (including a real MCP stdio handshake, since installed is not
the same as working), `CLAUDE.md`, the skills, the three `$WORKDIR` behaviours, and git reading the
mount. Prints `ok`/`FAIL` per check and exits non-zero if any fail.

Offline — no token and no quota. It ends by asserting the CLI reaches the login prompt, which is
the assertion that no credential is baked in. Export `CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY` and it runs one live prompt instead.

## Run

Credentials never enter the image; they arrive as environment at run time.

```bash
docker run --rm -it \
    -e CLAUDE_CODE_OAUTH_TOKEN \
    -v "$PWD:/workspace" \
    claude-executor -p 'summarise the diff on this branch'
```

`ANTHROPIC_API_KEY` works in place of `CLAUDE_CODE_OAUTH_TOKEN`.

`ENTRYPOINT` is the `claude-executor` wrapper: it changes into `$WORKDIR`, then `exec`s `claude`
with every argument given after the image name. Arguments reach the CLI unchanged — the wrapper
adds no flags and interprets none.

```bash
# Run against a subdirectory of the mount, or a second checkout, without rebuilding
docker run --rm -e WORKDIR=/workspace/server -v "$PWD:/workspace" claude-executor -p '...'
docker run --rm -e WORKDIR=/other -v "$PWD:/workspace" -v ~/src/api:/other claude-executor -p '...'
```

`WORKDIR` defaults to `/workspace` and must exist — the wrapper exits `2` with a message rather
than letting `claude` start in the wrong directory and answer about the wrong tree.

It also marks the checkout `safe.directory` when one is mounted. A bind mount keeps the host's uid,
which is rarely the container's 1000, and git otherwise refuses the repository outright with a
"dubious ownership" error that never mentions uids.

## Telemetry

`claude-home/settings.json` points the OTLP exporter at `http://collector:4318` — the `collector`
service in this repo's `docker-compose.yml`, resolvable only from that compose network:

```bash
docker compose up -d
docker run --rm -it --network factory-ai_default \
    -e CLAUDE_CODE_OAUTH_TOKEN \
    -v "$PWD:/workspace" \
    claude-executor -p '...'
```

Off that network the exporter fails to connect; the CLI still works, the sessions just go
unrecorded. Override `OTEL_EXPORTER_OTLP_ENDPOINT` with `-e` to point elsewhere, or set
`CLAUDE_CODE_ENABLE_TELEMETRY=0` to disable it.

The three `OTEL_LOG_*` flags are `0` on purpose: they control whether prompts, responses and tool
arguments are shipped as log bodies. See [docs/security.md](../../docs/security.md).
