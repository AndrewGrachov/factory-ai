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

# Atlassian CLI — the only supported way to read and write Jira from here; the Atlassian MCP server
# is deliberately not configured. TARGETARCH is amd64/arm64, which is exactly how the download
# paths are named, so no mapping table is needed.
ARG TARGETARCH
RUN curl -fsSL -o /usr/local/bin/acli \
        "https://acli.atlassian.com/linux/latest/acli_linux_${TARGETARCH}/acli" \
    && chmod 0755 /usr/local/bin/acli \
    && acli --version

ENV CLAUDE_CONFIG_DIR=/home/node/.claude

# The predefined configuration. Everything under claude-home/ lands in the config directory as-is:
# settings.json, CLAUDE.md, agents/, commands/, skills/, hooks/. No credentials live here — those
# arrive at runtime as environment (see README).
COPY --chown=node:node claude-home/ /home/node/.claude/

# Bind-mounted at runtime. Owned by node so the CLI can write into the checkout.
RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /workspace

USER node

# Baked in at build time rather than resolved on first run: a cold container would otherwise clone
# the marketplace and install before it could answer anything, and would fail outright with no
# network. `plugin install` rewrites settings.json in place, adding extraKnownMarketplaces and
# enabledPlugins — which is why those two keys are absent from the committed settings.json. Runs as
# node because it writes into CLAUDE_CONFIG_DIR; as root it would leave the files unwritable.
RUN claude plugin marketplace add mksglu/context-mode \
    && claude plugin install context-mode@context-mode

ENTRYPOINT ["claude"]
CMD ["--help"]
