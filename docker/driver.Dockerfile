# The job driver: polls the board and spawns claude-executor containers.
#
# It does not run Docker — it TALKS to the host's daemon over a mounted socket, so the runners it
# starts are siblings of this container, not children. That is why the workspace is referenced by
# volume NAME: a host path would mean nothing to the daemon in that context, and a path inside this
# container even less.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Every workspace's manifest, or `npm ci` refuses the lockfile — even though only driver/ is built.
COPY core/package.json core/
COPY server/package.json server/
COPY web/package.json web/
COPY driver/package.json driver/
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY driver driver
# Only the driver. Its tsconfig has no project references — it shares no code with core, which is
# what keeps this image free of the server's dependency tree.
RUN npm run build -w driver

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The client only. The daemon is the host's, reached through the socket mounted at run time.
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
# No `npm ci` here: the driver has no runtime dependencies at all. package.json is still needed —
# it is what makes node read dist/*.js as ESM.
COPY driver/package.json driver/package.json
COPY --from=build /app/driver/dist driver/dist
# Runs as root, unlike the dashboard. /var/run/docker.sock is root-owned on the host and a
# non-root user cannot open it; see docs/security.md for what mounting it actually grants.
CMD ["node", "driver/dist/index.js"]
