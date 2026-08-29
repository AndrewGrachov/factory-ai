#!/usr/bin/env bash
# Start a Remote Control session in the container, against the current directory.
#
#   docker/claude-executor/run.sh                 # session named after the directory
#   docker/claude-executor/run.sh my-session      # named session
#   TARGET=~/src/api docker/claude-executor/run.sh
#
# Reads CLAUDE_CODE_OAUTH_TOKEN from the repo's .env and passes that one variable. Nothing else in
# .env is forwarded: an agent in the container has no business holding the GitHub PAT or the
# database URL, and --env-file would hand it both.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

IMAGE="${IMAGE:-claude-executor}"
ENV_FILE="${ENV_FILE:-$REPO/.env}"
TARGET="$(cd "${TARGET:-$PWD}" && pwd)"
SESSION="${1:-$(basename "$TARGET")}"
[ $# -gt 0 ] && shift

token="${CLAUDE_CODE_OAUTH_TOKEN:-}"
if [[ -z "$token" ]]; then
    if [[ ! -f "$ENV_FILE" ]]; then
        echo "run.sh: no CLAUDE_CODE_OAUTH_TOKEN in the environment and no $ENV_FILE to read." >&2
        exit 2
    fi
    # One key, read with grep rather than sourcing the file: sourcing executes it, and .env is
    # deliberately gitignored, so its contents are whatever happens to be on this machine.
    token="$(grep -m1 -E '^[[:space:]]*CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'\''' | xargs)"
fi

if [[ -z "$token" ]]; then
    echo "run.sh: CLAUDE_CODE_OAUTH_TOKEN is empty or absent in $ENV_FILE." >&2
    echo "Generate one with: claude setup-token" >&2
    exit 2
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "building $IMAGE"
    docker build -q -t "$IMAGE" "$HERE" >/dev/null
fi

echo "remote control: $SESSION   workdir: $TARGET"

# TRUST_WORKDIR answers the trust dialog for the mount, which an interactive session has nobody to
# answer. Mounting a directory here is that decision already; see the README for what it implies
# when the checkout ships a .claude/settings.local.json.
exec docker run --rm -it \
    -e CLAUDE_CODE_OAUTH_TOKEN="$token" \
    -e TRUST_WORKDIR=1 \
    -v "$TARGET:/workspace" \
    "$IMAGE" --remote-control "$SESSION" "$@"
