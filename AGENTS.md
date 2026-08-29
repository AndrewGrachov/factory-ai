# AGENTS.md

Guidance for agents working in this repository. This file holds only what applies to every task —
commands, build coupling, and the map below. Everything else lives in `docs/`, one file per
concern. **Read the matching `docs/` file before you touch the code it covers**; each one is a list
of decisions that look like cruft and are not, and most are guarded by a test that fails obscurely.

## Read before you touch

| Touching | Read |
| --- | --- |
| Data flow, forge adapters, `server/src/index.ts` wiring, fixtures | [docs/architecture.md](docs/architecture.md) |
| `core/src/metrics.ts`, `canonical.ts`, the GraphQL query, cache/TTL constants | [docs/metrics.md](docs/metrics.md) |
| Anything named `org_id`, `005_organizations.sql`, the org selector | [docs/organizations.md](docs/organizations.md) |
| `attribute()` keys, `004_pull_requests.sql` keys, per-repo rendering | [docs/repos.md](docs/repos.md) |
| `config.ts`, `config-file.ts`, compose env blocks, `factory.toml` | [docs/configuration.md](docs/configuration.md) |
| `server/src/telemetry/*`, OTLP routes, SQL views, collector config | [docs/telemetry.md](docs/telemetry.md) |
| `filterPrs()`, `parseRange`, `revertForRange()`, the range selector, charts | [docs/date-range.md](docs/date-range.md) |
| `server/src/store/*`, `stats-service.ts`, the sync watermark, migrations | [docs/persistence.md](docs/persistence.md) |
| Routes, status codes, query parameters | [docs/api.md](docs/api.md) |
| Bind addresses, headers, PAT scopes, `OTEL_LOG_*` | [docs/security.md](docs/security.md) |
| Reporting a number as measured | [docs/limits.md](docs/limits.md) |

Metric definitions and the reasoning behind them live in `../factory-stats/SPEC.md`, outside this
repo.

## Commands

```bash
npm install

# All of these need a database; there is no in-memory mode. `docker compose up -d timescale` first.
npm run dev            # builds core, then API on 127.0.0.1:8080 + Vite on 5173 (/api proxied)
npm run dev:server     # tsx watch, server only
npm run dev:web        # vite only (needs the API running for /api)

npm run build          # core -> server -> web, in that order
npm start              # node server/dist/index.js (requires build)

npm test               # vitest run — offline, no token, no quota, no database
npm run typecheck      # tsc -b across all three project references

# Real browser (chromium, headless). Builds, SEEDS factory_e2e, serves the SPA from the API on
# 8123 and walks every date range. Still offline — no token, no quota, no network — but by way of
# a seeded database rather than a replayed payload. Screenshots to artifacts/ui/ — read them; a
# passing assertion says the DOM was right, only the image says the layout was.
npm run verify:ui      # needs: a running timescale, and `npx playwright install chromium` once

# Fill a disposable database with synthetic PRs, base-branch history and agent sessions. Refuses
# any database whose name does not mark it disposable: synthetic rows are indistinguishable from
# real ones once written, and there is no way to separate them afterwards.
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_seed npm run seed

docker compose up --build   # SPA + API on 127.0.0.1:8080, TimescaleDB, OTEL collector

# factory_dev holds real data; *_test, *_seed, *_synthetic, *_demo and *_e2e are disposable. The db
# suite TRUNCATES its tables, so it refuses any database not named *_test — pointing it at
# factory_dev would silently destroy backfilled history, and the tests would still pass. loadConfig
# mirrors that: a process WITH a token refuses to run against any disposable name at all.
docker compose up -d timescale
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test npm run test:db

# Import history from ~/.claude/projects/*/*.jsonl. Idempotent; safe to re-run.
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_dev npm run backfill

# Regenerate core/test/fixtures/sample-canonical.json from the raw GitHub capture. Run after any
# change to toCanonical(); the core suite measures its output.
npm run fixture:canonical
```

Single test file / single case:

```bash
npx vitest run core/test/metrics.invariants.test.ts
npx vitest run -t 'matches the measured headline figures'
```

There is no linter or formatter configured. Match existing style: 4-space indent, single quotes,
semicolons.

## Build coupling to know about

`server` and `web` resolve `@factory-ai/core` to `core/dist`, not `core/src`. **`core` must be
built before the server or web can typecheck or run** — that is why `npm run dev` and
`npm run build` build it first. A stale `core/dist` produces type errors that look like source
bugs. Fix with `npm run build -w core`.

All three packages are ESM with `verbatimModuleSyntax`; relative imports carry a `.js`
extension even in `.tsx` files.

Tests import `core/src` directly (`../src/metrics.js`), so `core/test` does not need the build.
`vitest.config.ts` includes `core/test`, `server/test` and `web/test`. The web suite is a
**render smoke test only** — it renders the telemetry panels with `react-dom/server`, so no DOM
and no browser is needed, but it will not tell you the SPA looks right.

A new file in `core/src` must be re-exported from `core/src/index.ts` or the server sees
"module has no exported member" — the same failure mode as a stale `core/dist`, and it looks
just as much like a source bug.

**`server/migrations/*.sql` are not compiled by `tsc`**, so `docker/Dockerfile` copies them
explicitly — by directory, so a new migration needs no Dockerfile edit. Forgetting that fails only
in the container, never in dev. The GitHub capture no longer needs copying: nothing reads it at
runtime any more.
