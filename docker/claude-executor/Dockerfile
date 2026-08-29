# Claude Code, headless, with a fixed configuration baked in.
#
# Build context is this directory, not the repo root: the image carries no application code, only
# the CLI and the config under claude-home/.
#
#   docker build -t claude-executor docker/claude-executor
#
# debian rather than alpine: the CLI ships prebuilt glibc binaries (ripgrep among them) that fail
# at runtime on musl, and the failure surfaces as an empty search result rather than an error.
# The full image rather than -slim, despite the size: it already carries git and the CA bundle, and
# Claude Code shells out to git for status, diffs and blame. Installing them with apt instead would
# be smaller but adds a network-dependent layer that breaks behind a TLS-intercepting proxy.
FROM node:24-bookworm

ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && npm cache clean --force

ENV CLAUDE_CONFIG_DIR=/home/node/.claude

# The predefined configuration. Everything under claude-home/ lands in the config directory as-is:
# settings.json, CLAUDE.md, agents/, commands/, skills/, hooks/. No credentials live here — those
# arrive at runtime as environment (see README).
COPY --chown=node:node claude-home/ /home/node/.claude/

# Bind-mounted at runtime. Owned by node so the CLI can write into the checkout.
RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /workspace

USER node

ENTRYPOINT ["claude"]
CMD ["--help"]
