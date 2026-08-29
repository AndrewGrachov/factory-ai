# claude-executor

Claude Code in a container, with a fixed configuration baked in. It runs an agent against a mounted
checkout; it does not build or run this repo's application.

## Layout

| Path | Becomes |
| --- | --- |
| `Dockerfile` | the image — Node 24 (debian slim), git, `@anthropic-ai/claude-code` |
| `claude-home/` | `/home/node/.claude` inside the image, via `CLAUDE_CONFIG_DIR` |

`claude-home/` is the predefined configuration folder. Whatever you drop in it ships in the image:
`settings.json` today, plus `CLAUDE.md`, `agents/`, `commands/`, `skills/` or `hooks/` if you add
them. It is a deliberate copy rather than a mount of the host's `~/.claude` — that directory holds
`.credentials.json`, `history.jsonl` and per-project session state, none of which belong in an image
layer or in git.

## Build

```bash
docker build -t claude-executor docker/claude-executor

# Pin the CLI instead of tracking latest:
docker build --build-arg CLAUDE_CODE_VERSION=2.0.0 -t claude-executor docker/claude-executor
```

The build context is this directory, not the repo root.

## Run

Credentials never enter the image; they arrive as environment at run time.

```bash
docker run --rm -it \
    -e CLAUDE_CODE_OAUTH_TOKEN \
    -v "$PWD:/workspace" \
    claude-executor -p 'summarise the diff on this branch'
```

`ANTHROPIC_API_KEY` works in place of `CLAUDE_CODE_OAUTH_TOKEN`. `ENTRYPOINT` is `claude`, so
arguments after the image name go straight to the CLI.

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
