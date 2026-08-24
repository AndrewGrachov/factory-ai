FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY core/package.json core/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json tsconfig.json ./
COPY core core
COPY server server
COPY web web
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY core/package.json core/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/core/dist core/dist
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
# The fixtures back DATA_SOURCE=fixture and TELEMETRY_SOURCE=fixture, which is how the
# container runs with no token, no database and no collector.
COPY --from=build /app/core/test/fixtures/sample-payload.json core/test/fixtures/sample-payload.json
COPY --from=build /app/core/test/fixtures/telemetry-sessions.json core/test/fixtures/telemetry-sessions.json
# tsc does not compile .sql, so the migrations have to be copied by hand. Forgetting this
# fails only in the container, never in dev.
COPY --from=build /app/server/migrations server/migrations
# No COPY for factory.toml, despite the precedent just above: it carries a GitHub token, so it
# has to arrive as a read-only mount or as environment, never baked into an image layer.
ENV WEB_ROOT=/app/web/dist
ENV HOST=0.0.0.0
USER node
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
