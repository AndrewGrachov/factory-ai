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
check 'plugin enabled'         'context-mode'     run --entrypoint claude "$IMAGE" plugin list
check 'CLAUDE.md present'      'Agent guide'      run --entrypoint head "$IMAGE" -1 /home/node/.claude/CLAUDE.md
check 'skills present'         'backend-fix'      run --entrypoint ls "$IMAGE" /home/node/.claude/skills

# The entrypoint's own contract: land in $WORKDIR, refuse a missing one.
check 'defaults to /workspace' '/workspace'       run --entrypoint sh "$IMAGE" -c 'pwd'
check 'honours WORKDIR'        '/workspace/server' run -e WORKDIR=/workspace/server --entrypoint sh "$IMAGE" -c \
    'cd "$WORKDIR" && pwd'
check 'rejects bad WORKDIR'    'does not exist'   run -e WORKDIR=/nope "$IMAGE" --version

# A bind mount carries the host uid, so without safe.directory git refuses the repository outright.
# Note the single line: a backslash continuation inside single quotes is a literal backslash, not a
# continuation, and the container would receive a broken script that fails silently.
check 'git reads the mount' 'true' run --entrypoint sh "$IMAGE" -c 'claude-executor --version >/dev/null; git rev-parse --is-inside-work-tree'

# The plugin's MCP server has to answer over stdio, not merely be installed.
MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
check 'context-mode responds' '"name":"context-mode"' run -i --entrypoint sh "$IMAGE" -c "p=\$(ls -d \"\$CLAUDE_CONFIG_DIR\"/plugins/cache/context-mode/context-mode/*/); echo '$MCP_INIT' | timeout 60 node \"\${p}start.mjs\""

if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ]]; then
    check 'answers a prompt' 'EXECUTOR_OK' \
        run -e CLAUDE_CODE_OAUTH_TOKEN -e ANTHROPIC_API_KEY "$IMAGE" \
        -p 'Reply with exactly EXECUTOR_OK and nothing else.'
else
    # Without credentials the login refusal is itself the assertion: the CLI started, read its
    # config and got as far as auth, and nothing was baked into the image.
    check 'unauthenticated by design' 'Not logged in' run "$IMAGE" -p 'hello'
    echo 'note: no token in env — skipped the live prompt'
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
