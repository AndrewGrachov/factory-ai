#!/usr/bin/env bash
# Build the image and exercise it against this repo as the mounted checkout.
#
#   docker/claude-executor/test.sh
#
# Offline by default: no token, no network beyond the build. With
# CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the environment it also runs one real prompt.
set -uo pipefail

IMAGE="${IMAGE:-claude-executor-test}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

pass=0
fail=0

check() { # check <name> <expected substring> <docker args...>
    local name="$1" want="$2"
    shift 2
    local got
    got="$("$@" 2>&1)"
    if [[ "$got" == *"$want"* ]]; then
        printf 'ok   %s\n' "$name"
        pass=$((pass + 1))
    else
        printf 'FAIL %s\n     want substring: %s\n     got: %s\n' "$name" "$want" "${got:0:400}"
        fail=$((fail + 1))
    fi
}

echo "building $IMAGE"
docker build -q -t "$IMAGE" "$HERE" >/dev/null || { echo "build failed"; exit 1; }

run() { docker run --rm -v "$REPO:/workspace" "$@"; }

check 'claude runs'            'Claude Code'      run "$IMAGE" --version
check 'acli installed'         'acli version'     run --entrypoint acli "$IMAGE" --version
check 'gh installed'           'gh version'       run --entrypoint gh "$IMAGE" --version
check 'plugin enabled'         'context-mode'     run --entrypoint claude "$IMAGE" plugin list
check 'CLAUDE.md present'      'Agent guide'      run --entrypoint head "$IMAGE" -1 /home/node/.claude/CLAUDE.md
check 'skills present'         'backend-fix'      run --entrypoint ls "$IMAGE" /home/node/.claude/skills

# The entrypoint's own contract: land in $WORKDIR, refuse a missing one.
check 'defaults to /workspace' '/workspace'       run --entrypoint sh "$IMAGE" -c 'pwd'
check 'honours WORKDIR'        '/workspace/server' run -e WORKDIR=/workspace/server --entrypoint sh "$IMAGE" -c \
    'cd "$WORKDIR" && pwd'
check 'rejects bad WORKDIR'    'does not exist'   run -e WORKDIR=/nope "$IMAGE" --version

# Both prompts an unattended container cannot answer. Onboarding is settled at build time; trust is
# opt-in per run, so the default must still be false.
check 'onboarding done'   'true'  run --entrypoint node "$IMAGE" -e \
    'console.log(require(process.env.CLAUDE_CONFIG_DIR + "/.claude.json").hasCompletedOnboarding)'
check 'trust is opt-in'   'false' run --entrypoint sh "$IMAGE" -c \
    'claude-executor --version >/dev/null; node -e "const c=require(process.env.CLAUDE_CONFIG_DIR+\"/.claude.json\"); console.log(Boolean((c.projects||{})[\"/workspace\"]))"'
check 'TRUST_WORKDIR opts in' 'true' run -e TRUST_WORKDIR=1 --entrypoint sh "$IMAGE" -c \
    'claude-executor --version >/dev/null; node -e "const c=require(process.env.CLAUDE_CONFIG_DIR+\"/.claude.json\"); console.log(Boolean(c.projects[\"/workspace\"].hasTrustDialogAccepted))"'

# A bind mount carries the host uid, so without safe.directory git refuses the repository outright.
# Note the single line: a backslash continuation inside single quotes is a literal backslash, not a
# continuation, and the container would receive a broken script that fails silently.
check 'git reads the mount' 'true' run --entrypoint sh "$IMAGE" -c 'claude-executor --version >/dev/null; git rev-parse --is-inside-work-tree'

# The plugin's MCP server has to answer over stdio, not merely be installed.
MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
check 'context-mode responds' '"name":"context-mode"' run -i --entrypoint sh "$IMAGE" -c "p=\$(ls -d \"\$CLAUDE_CONFIG_DIR\"/plugins/cache/context-mode/context-mode/*/); echo '$MCP_INIT' | timeout 60 node \"\${p}start.mjs\""

# The login refusal is an assertion in its own right, and the only one that proves no credential
# was baked into the image. It runs whether or not a token is available, with the token withheld.
check 'unauthenticated by design' 'Not logged in' run "$IMAGE" -p 'hello'

# Fall back to the repo's .env for the live prompt, reading only that one key — see run.sh.
token="${CLAUDE_CODE_OAUTH_TOKEN:-}"
if [[ -z "$token" && -f "$REPO/.env" ]]; then
    token="$(grep -m1 -E '^[[:space:]]*CLAUDE_CODE_OAUTH_TOKEN=' "$REPO/.env" | cut -d= -f2- | tr -d '"'\''' | xargs)"
fi

if [[ -n "${token}${ANTHROPIC_API_KEY:-}" ]]; then
    check 'answers a prompt' 'EXECUTOR_OK' \
        run -e CLAUDE_CODE_OAUTH_TOKEN="$token" -e ANTHROPIC_API_KEY "$IMAGE" \
        -p 'Reply with exactly EXECUTOR_OK and nothing else.'
else
    echo 'note: no token in the environment or .env — skipped the live prompt'
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
