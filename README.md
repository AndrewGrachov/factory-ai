# factory-ai

Software Engineering factory control plane.

First surface: **Factory Stats** — a dashboard measuring the efficiency of an AI-heavy delivery
process for `Leeloo-AI-RGA-OS/leeloo.ai`: throughput, cycle time, rework, and whether automated
code review produces actionable signal.

Metric definitions, the API traps behind them, and the reasoning are specified in
`../factory-stats/SPEC.md`. Every definition exists to correct a specific distortion —
simplifying one silently makes the number wrong.

## Layout

| Package | Purpose |
| --- | --- |
| `core/` | Pure aggregation and shared types. No dependencies, no I/O. Byte-equivalent to the verified reference implementation. |
| `server/` | Fastify API: GitHub GraphQL client, in-memory cache, and static hosting for the SPA. |
| `web/` | Vite + React SPA. |

## Running it

A database is required: it is the only source the dashboard reads. A GitHub token is not — without
one nothing is fetched and whatever is already stored still renders.

```bash
npm install
docker compose up -d timescale        # required; there is no in-memory mode

# No token: fill a disposable database with synthetic data and browse that.
docker compose exec timescale psql -U factory -d postgres -c 'create database factory_seed'
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_seed npm run seed
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_seed npm run dev

# Live, via the config file
cp factory.toml.example factory.toml && chmod 600 factory.toml   # set github.token
npm run dev

# Live, via the environment instead — it overrides factory.toml wherever they disagree
cp .env.example .env   # set GITHUB_TOKEN
npm run dev

# The organization owns the repo list, and every repo it lists is reported combined on one page.
# Cost is ~243 rate-limit points per repo, so the sync TTL floor rises to 60s x the repo count.
#   [organization]
#   id    = "leeloo"
#   name  = "Leeloo AI"
#   repos = ["leeloo.ai", "leeloo-infra"]
```

A database whose name ends in `_test`, `_seed`, `_synthetic`, `_demo` or `_e2e` is treated as
disposable, and is refused outright if a token is also set — `npm run seed` writes invented pull
requests into one and `npm run test:db` truncates one, so real fetched history put there is either
counterfeited or destroyed.

`npm run dev` starts the API on `127.0.0.1:8080` and Vite on `5173` with `/api` proxied.

```bash
docker compose up --build     # serves the built SPA and the API on 127.0.0.1:8080
```

## Auth

There is none. The dashboard has no login, and the localhost bind in `docker-compose.yml` is the
access control. Do not expose the port without putting authentication in front of it first.

The GitHub credential is a single server-side PAT read from `GITHUB_TOKEN`, behind the
`TokenProvider` interface in `server/src/github/token.ts` — a GitHub App installation token can
replace it without touching any call site.

Required fine-grained PAT permissions:

- `Metadata: read`
- `Pull requests: read`
- `Contents: read` — **only** for the revert rate. Without it that single metric reports
  "unavailable" and everything else still works.

## Cost and freshness

A full history fetch is 9 pages, ~243 rate-limit points and ~45 seconds against a 5000/hour
budget. Consequences baked into the code:

- The server caches one snapshot in memory; `CACHE_TTL_SECONDS` is rejected below 300.
- A cold `GET /api/stats` answers **202** with progress while fetching; the SPA polls every 2s.
- A stale snapshot is still served with 200. A rate limit keeps the last good render on screen
  and explains itself rather than blanking the dashboard.
- After a failed fetch the server waits 30s before retrying, so a rejected token cannot turn
  into a request loop. `POST /api/refresh` bypasses that.

## API

| Route | Behaviour |
| --- | --- |
| `GET /api/health` | Never calls GitHub, so a token-less or rate-limited container still reports healthy. |
| `GET /api/stats` | `200` with `{ stats, meta }`, `202` while a cold fetch runs, `503` if the first fetch failed. |
| `POST /api/refresh` | `202`. Single-flight. |

## Tests

```bash
npm test        # offline, no token, no quota
npm run typecheck
```

- `core/test/metrics.independent.test.ts` recomputes every headline number straight off the raw
  payload, deliberately sharing no code with `core/src/metrics.ts`, and pins the SPEC §1 measured
  landmarks. Aggregation is the one place a wrong number is invisible.
- `core/test/metrics.invariants.test.ts` asserts what a plausible-but-wrong aggregation would
  violate: distributions sum to the PR count, `resolved <= total`, `p50 <= p90`, human rework ≤ any
  rework, no `NaN`, every ratio null or in [0,1].
- `server/test/` drives the API in-process via `app.inject()` with a stubbed GitHub client:
  caching, single-flight, the 202 cold path, error-code mapping, and the degraded revert rate.

## Things that will bite

- Metrics depend on the current date (the partial-week flag). `compute()` takes an injectable
  `now` for exactly this reason — keep using it in tests.
- `stats.meta.window` relies on the query's `CREATED_AT DESC` ordering.
- Charts are fixed-width; below roughly 700px the weekly axis labels become illegible.
- The fixture is already post-backfill, so the oversized-PR path (#149, 397 reviews) is not
  exercised by it.
