#!/bin/sh
# Enter the work directory, then hand every argument to claude.
#
#   docker run ... claude-executor -p 'summarise the diff'
#   docker run ... -e WORKDIR=/workspace/server claude-executor -p '...'
set -eu

WORKDIR="${WORKDIR:-/workspace}"
export WORKDIR

if [ ! -d "$WORKDIR" ]; then
    echo "claude-executor: WORKDIR '$WORKDIR' does not exist." >&2
    echo "Mount a checkout at it, e.g. -v \"\$PWD:/workspace\"." >&2
    exit 2
fi

cd "$WORKDIR"

# A bind-mounted checkout keeps the host's uid, which is rarely 1000. git then refuses to read the
# repository at all ("dubious ownership"), and every git-shaped thing the agent tries fails with an
# error that says nothing about uids. Marking it safe is the narrow fix; it is scoped to this
# directory, and the container is already a single-user throwaway.
if [ -e "$WORKDIR/.git" ]; then
    git config --global --add safe.directory "$WORKDIR" 2>/dev/null || true
fi

# Opt-in, and off by default. The trust dialog is a real prompt with a real question — it also
# warns when the mounted checkout's .claude/settings.local.json pre-approves tool permissions, which
# then apply without asking. An interactive session ("--remote-control") has nobody at the keyboard
# to answer it, so the caller states up front that the mount is trusted; run.sh sets this.
if [ -n "${TRUST_WORKDIR:-}" ] && [ "${TRUST_WORKDIR}" != "0" ]; then
    node -e "
        const fs = require('fs');
        const f = process.env.CLAUDE_CONFIG_DIR + '/.claude.json';
        const c = JSON.parse(fs.readFileSync(f, 'utf8'));
        c.projects = c.projects || {};
        c.projects[process.env.WORKDIR] = {
            ...(c.projects[process.env.WORKDIR] || {}),
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
        };
        fs.writeFileSync(f, JSON.stringify(c, null, 2));
    " || echo "claude-executor: could not pre-accept the trust dialog for $WORKDIR" >&2
fi

exec claude "$@"
