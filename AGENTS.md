# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install

npm run dev            # builds core, then API on 127.0.0.1:8080 + Vite on 5173 (/api proxied)
npm run dev:server     # tsx watch, server only
npm run dev:web        # vite only (needs the API running for /api)

npm run build          # core -> server -> web, in that order
npm start              # node server/dist/index.js (requires build)

npm test               # vitest run — offline, no token, no quota, no database
npm run typecheck      # tsc -b across all three project references

# Real browser (chromium, headless). Builds, serves the SPA from the API on 8123 with fixture
# data on both pipelines, walks every date range. Screenshots to artifacts/ui/ — read them; a
# passing assertion says the DOM was right, only the image says the layout was.
npm run verify:ui      # needs: npx playwright install chromium (once)

docker compose up --build   # SPA + API on 127.0.0.1:8080, TimescaleDB, OTEL collector

# Two databases: factory_dev holds real data, factory_test is disposable. The db suite
# TRUNCATES its tables, so it refuses any database not named *_test — pointing it at
# factory_dev would silently destroy backfilled history, and the tests would still pass.
docker compose up -d timescale
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test npm run test:db

# Import history from ~/.claude/projects/*/*.jsonl. Idempotent; safe to re-run.
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_dev npm run backfill
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
explicitly. Forgetting that fails only in the container, never in dev.

## Architecture

| Package | Role |
| --- | --- |
| `core/` | Pure aggregation + shared types. No I/O, no dependencies. |
| `server/` | Fastify API: GitHub GraphQL client, telemetry store, two cache slots, static SPA hosting. |
| `web/` | Vite + React 19 SPA, polls `/api/stats`. |
| `plugins/agent-telemetry/` | Installable Claude Code plugin. Reports `session -> (repo, branch)`. |

Data flow: `client.fetchPullRequests()` → `RawPullRequest[]` → `deriveAll()` → `DerivedPr[]` →
`compute()` → `Stats` → JSON → panels. `core/src/types.ts` is the contract shared by all three
packages; the SPA imports `Stats` from core rather than redeclaring it.

Telemetry is a **second, independent pipeline** that meets the first only at response assembly:
Claude Code → OTEL collector → `POST /api/otlp/v1/metrics` → `flattenMetrics()` → TimescaleDB →
`createPostgresTelemetryClient()` → `TelemetryInput` → `attribute()` → `TelemetryStats`, a
sibling of `Stats` in the payload rather than a field inside it.

Server wiring (`server/src/index.ts`): `loadConfig()` → GitHub client (`fixture` or `github`) →
telemetry client (`fixture`, `postgres` or `off`) → `createStatsService()` → `buildApp()`.
`buildApp` deliberately does not `listen`, which is what lets `server/test/` drive the whole app
in-process via `app.inject()` with stubbed clients.

`GitHubClient` (`server/src/github/client.ts`) is an interface with two implementations — the
live GraphQL client and `createFixtureClient()`, which replays `core/test/fixtures/sample-payload.json`
(203 real PRs, captured 2026-08-21, already post-backfill). `DATA_SOURCE=fixture` is the default,
so the app and every test run with no token and no rate-limit cost.

`TelemetryClient` (`server/src/telemetry/client.ts`) mirrors that split exactly, and
`TELEMETRY_SOURCE=fixture` is likewise the default — so `npm test` and a bare `npm run dev` need
no database and no collector. The fixture replays `core/test/fixtures/telemetry-sessions.json`,
which unlike the PR payload is **synthetic**: it is generated by `generate-telemetry.mjs` next to
it, and the UI badges it loudly because invented token counts beside real PR numbers is exactly
the problem the limitations panel exists to warn about.

The GitHub credential goes through the `TokenProvider` interface in `server/src/github/token.ts`
so a GitHub App installation token can replace the PAT without touching call sites.

## How AI usage reaches a pull request

Claude Code's OTEL metrics carry **no PR number, no branch and no commit SHA** —
`claude_code.pull_request.count` and `claude_code.commit.count` have only the standard
attributes. The only shared identifier is `session.id`. So the join needs a side channel:
the `agent-telemetry` plugin samples the current branch and posts
`session -> (repo, branch)`, and `attribute()` joins that branch to `DerivedPr.headRefName`.

Two things about that join are not obvious:

- **A head branch is not a unique key.** Nine branches in the sample payload are reused across
  separate merged PRs. Matching on branch alone would credit the same work to every PR that ever
  used it, so candidates are ordered by when they stopped accepting work and a split goes to the
  first PR still open when the work happened. Work on a branch whose PRs have all merged is
  reported as `unmatched`, never back-dated.
- **`OTEL_METRICS_INCLUDE_SESSION_ID` must stay true** (it is the default). Disabling it severs
  the only link between a metric and a branch: every PR reads `attribution: 'none'` and
  `sessionsWithoutHook` grows without bound — indistinguishable from the plugin being broken.

The plugin is installed at **user scope**, not into this repo, because the dashboard reports on
`leeloo.ai` and the sessions that matter happen there. See
`plugins/agent-telemetry/README.md`.

Metric definitions and the reasoning behind them live in `../factory-stats/SPEC.md` (outside this
repo). Every definition corrects a specific measurement distortion.

## Invariants that look like cruft but are not

Aggregation is the one place a wrong number is invisible, so most of these have a test guarding
them. Do not "simplify" them.

- **`ratio()` returns `null`, never `0`, on a zero denominator.** The entire
  unavailable-vs-zero contract on the page rests on this. "0 reverts in 0 commits" reads as a
  real answer.
- **Totals come from `totalCount`; distributions come from node lists.** GraphQL caps nested
  connections at 100 nodes (`INNER_LIMIT`). PRs over that get a second pass in
  `backfill()`; anything still cut is reported in `stats.meta.truncated` rather than silently
  undercounted.
- **Force pushes are counted from the filtered node list.** `timelineItems.totalCount` ignores
  `itemTypes` and reports the whole timeline — it once claimed 404 force pushes across 14 PRs.
- **`stats.meta.window` relies on the query's `CREATED_AT DESC` ordering.** Do not "fix" it to
  min/max.
- **`compute()` and `createStatsService()` take an injectable `now`.** The `partial` week flag
  and `generatedAt` depend on the current date; tests pin `FIXTURE_NOW` /
  `2026-08-21T12:00:00.000Z`. Keep using the injection point.
- **`weeklySeries()` seeds every week in the window, including empty ones.** A median over only
  the weeks that had a merge overstates throughput.
- **`CACHE_TTL_SECONDS` is rejected below 300** (`MIN_TTL_SECONDS`). A full fetch is ~243
  rate-limit points and ~45s against a 5000/hour budget.
- **A stale snapshot is served with 200.** A rate limit must keep the last good render on screen
  and explain itself, not blank the dashboard. `useStats` likewise never clears `data` on error.
- **`ERROR_COOLDOWN_MS` (30s) after a failed fetch.** Without it every request restarts the
  fetch and a rejected token becomes a request loop. `POST /api/refresh` bypasses it.
- **The revert rate degrades alone.** It is the only metric needing `Contents: read`; a missing
  ref returns `null` history and `revert.status = 'unavailable'`, never `{commits: 0, reverts: 0}`.
- **`core/test/metrics.independent.test.ts` shares no code with `core/src/metrics.ts` on
  purpose.** It recomputes headline numbers off the raw payload and pins SPEC §1 landmarks.
  Importing helpers into it would make a wrong number invisible.
- **Do not switch GraphQL pagination to `gh api graphql --paginate`.** It only advances the
  cursor if the variable is named `$endCursor`; anything else silently re-requests page 1 forever.
- **When a PR page times out, shrink the nested selections, not `PAGE_SIZE` (25).** Per-page cost
  is superlinear in the nested connections.

### Telemetry

- **A cumulative counter is reduced with `max(value)` per `start_time`, never `sum(value)`.**
  This is the single most dangerous line in the feature: a plain `SUM` over a cumulative series
  produces a plausible, wildly wrong token count with no error anywhere. A restart begins a new
  `start_time`, so the per-group totals are added. Guarded in `server/test-db`, where the fixture
  series sums to 2.5× its real total.
- **Nanosecond timestamps divide by `1e6`, not `1e9`.** The `1e9` mistake puts every datapoint in
  1970, the branch join then returns nothing, and the symptom looks like a broken hook rather
  than a broken parser.
- **Two cache slots with independent TTLs, cooldowns and `lastFailureAt`.** A GitHub rate limit
  must not freeze the local database read, and a dead database must not stall the PR fetch.
  `TELEMETRY_TTL_SECONDS` has a floor of 5 — not a typo next to the 300s above, the reasons are
  opposite: there is no quota to protect, only a hot loop to prevent.
- **Migrations are not awaited before `app.listen()`.** They retry with backoff for the better
  part of a minute while the container starts, and blocking would hold the PR metrics — which
  need no database at all — hostage. The client gates its own queries on `ready`.
- **Telemetry degrades alone, in four distinct states.** `disabled` renders no panels at all;
  `unreachable` renders frames with a reason and no numbers; `stale` serves the last good
  snapshot with 200; `empty` returns a *real* `TelemetryStats` with `sessions: 0` and null
  everywhere. `empty` being non-null is deliberate — it is how you see a pipeline that is wired
  but silent, which is the most common state during setup and would otherwise be
  indistinguishable from `disabled`.
- **`attribution: 'none'` and `'shared'` rows carry null on every quantity, and are still
  listed.** `0 tokens` would assert the PR was written without AI, which is not what was
  measured. One indivisible session nulls the whole row rather than reporting the divisible part.
- **`TelemetryStats.totals` comes from sessions, never from the PR rows.** They legitimately
  disagree, because a shared session contributes to totals and to no row. Pinning which is
  authoritative is what stops a future "make these agree" refactor from double-counting.
- **Attribute keys are allowlisted; metric names are denylisted.** Keep the asymmetry: a future
  Claude Code version can add an identity attribute, and a denylist would silently start storing
  it — whereas an unknown *metric* from a future tool must still be stored so its data
  accumulates before support is written. `user.email`, `user.id`, `user.account_uuid`,
  `organization.id` and `workspace.host_paths` all arrive by default and are all dropped.
- **There is no monetary field anywhere, on purpose.** Prices and cache discounts change, and a
  dollar figure implies precision a ~20s branch sample cannot support.
  `claude_code.cost.usage` is refused at the ingest route. A test asserts no field named
  `cost`/`usd`/`price` exists in `TelemetryStats`, because this is exactly the kind of thing that
  returns via a "small addition".
- **`ON CONFLICT DO NOTHING` on `metric_point`, never `DO UPDATE`.** OTLP delivery is
  at-least-once, so an identical retry must be a no-op; an update would move `received_at` and
  destroy the only way to tell a retry from a genuine second export.
- **The ingest route returns 5xx only for a genuine write failure.** Exporters retry 5xx forever,
  so a body the parser cannot read gets a 200, and a malformed branch report gets a 400.
- **`session_branch_slice` clamps overlapping intervals.** The upsert widens `first_seen`/
  `last_seen`, so consecutive branches routinely overlap and a raw join would count the same
  datapoint on both branches.
- **`*.repeatable.sql` migrations are re-applied every boot and drop their views first.** Being
  recorded in `schema_migrations` would mean a view fix never lands until someone deletes the
  volume; and `create or replace view` cannot change a column's type, so a fix that widens one
  would fail on every existing database while passing on a fresh one.
- **Week bucketing stays in `core` (`weekStart`/`isoWeekKey`), never `time_bucket()`.** The
  telemetry series shares a chart axis with the PR series; two implementations is how they drift
  by a day.
- **A transcript `pr-link` outranks the branch join, but does not replace it.** Both sources
  fold into the same PR row. Letting the stronger tier win outright would drop a session that
  branch-matched the same PR — counted in no row and in no unmatched bucket.
- **`session_source` picks one source per session, OTEL over transcript.** A session that ran
  with OTEL enabled *and* has a transcript on disk would otherwise be counted twice. Every
  view reads `metric_point_used`, never `metric_point`; reading the table reintroduces the
  double count.
- **Versioned migrations run before repeatable ones, regardless of filename order.** A new
  versioned file that adds a column the views read would otherwise fail purely because `003`
  sorts after `002`.
- **Transcripts carry only token usage.** No edit decisions, no active time, so those fields
  are null for backfilled sessions — which is the null-not-zero contract doing its job, not a
  bug. **`input_tokens` in a transcript excludes cache reads**, so on a heavily cached
  conversation it is a small fraction of the real input; `cacheRead` holds the bulk.
- **The collector exporter sets `compression: none`.** It gzips by default, Fastify's JSON parser
  does not decompress, and the result is a flat `400` on every export with "Exporting failed.
  Dropping data" in the collector log and an `empty` dashboard. Symptoms point at the server; the
  cause is one line of collector YAML.
- **`docker-compose.yml` defaults `TELEMETRY_SOURCE` to `postgres`, while the code defaults to
  `fixture`.** They differ on purpose: compose provisions the database *and* the collector, so
  fixture mode there would 404 the ingest route and leave the collector retrying forever. The code
  default serves `npm run dev` and the test suite, which have neither.
- **`core/test/telemetry.independent.test.ts` shares no code with `core/src/telemetry.ts`**, for
  the same reason as its metrics counterpart.

- **`factory_dev` and `factory_test` are separate databases, and the db suite refuses anything
  not named `*_test`.** The suite truncates `metric_point` and `session_branch` in
  `beforeEach`, so a shared database means one test run wipes every backfilled session — and
  the tests still pass, which is what makes it worth a guard rather than a comment.
- **The scatter plots `linked` and `exact`, not `exact` alone.** Filtering to `exact` blanked
  the panel entirely on real data, where nearly every PR is attributed by transcript pr-link.
  Types passed, the fixture passed, and only a browser showed it.

### Date range

- **The cache slot holds the derived PRs, not a computed `Stats`.** A range re-runs `compute()`
  and `attribute()` at read time over `filterPrs()`, so every range is served from the one fetch
  the rate-limit budget paid for and no cache key mentions a range. Pre-aggregating again would
  either bucket the cache per range or force the selector to be cosmetic.
- **A narrowed range reports the revert rate as `unavailable`, not as a number.** The commit
  history was fetched with `since` = earliest merge of the *whole* window and cannot be re-sliced
  without another GitHub call; left in place it would read as the revert rate for the range.
- **Presets are a rolling lookback, not a calendar period.** "This week" on a Tuesday would
  otherwise cover two days and look like a throughput collapse.
- **Range membership follows the timestamp each metric is already bucketed by**: merged PRs by
  `mergedAt` (as `weeklySeries()` does), open PRs by having existed at `to`, closed-unmerged by
  `createdAt`. Switching merged PRs to `createdAt` drops any PR opened before the range and
  merged inside it — straight off the throughput chart.
- **`to` is exclusive, and a bare `YYYY-MM-DD` from the date input is widened to the next day.**
  Without the widening, "custom: today to today" is an empty interval that renders as no activity.
- **`BarChart` caps `barWidth` at 56px.** The chart is fixed-width, so a one-week range renders
  a single ~580px bar that reads as a filled panel rather than as one data point. Types, tests
  and the SSR smoke render all passed; only `npm run verify:ui` showed it.
- **Sessions are kept on overlap, and `TelemetryInput.coverage` is never filtered.** A session
  straddling the boundary did real work inside the range; and coverage is what distinguishes "no
  AI usage in this range" from "telemetry does not reach back this far".

**Tradeoff worth knowing:** the SQL, the views and the migration runner have **no coverage in
`npm test`**. That is the price of keeping the default suite offline and database-free; they are
covered by `npm run test:db`, which needs a running container.

## API

| Route | Behaviour |
| --- | --- |
| `GET /api/health` | Never calls GitHub or the database, so a token-less, DB-less container still reports healthy. |
| `GET /api/stats` | `200` with `{ stats, telemetry, meta }`; `202` with progress while a cold fetch runs (SPA polls every 2s); `503` if the first PR fetch failed. `telemetry` is `null` when unavailable — never a reason for a non-200. `?range=day\|week\|2w\|month\|all\|custom` (default `all`), plus `?from=&to=` for `custom`; `400 BAD_RANGE` on anything unparseable, never a silent fallback to all time. |
| `POST /api/refresh` | `202`. Single-flight. Refreshes both caches. |
| `POST /api/otlp/v1/metrics` | `200 {"partialSuccess":{}}`. 1 MB limit, JSON only. Registered only when a store exists. |
| `POST /api/otlp/v1/logs` | `200`. Accepted and dropped — see M6 in the plan. |
| `POST /api/sessions/branch` | `202`. `400` on a malformed body, never 5xx. |

## Security posture

There is no application-level auth. The `127.0.0.1` bind in `docker-compose.yml` is the access
control — do not expose the port without putting authentication in front of it first. CSP and
`X-Content-Type-Options` / `Referrer-Policy` are set as response headers in `app.ts` (a `meta`
tag would not let dev allow the Vite HMR websocket).

Required fine-grained PAT permissions: `Metadata: read`, `Pull requests: read`, and
`Contents: read` (revert rate only).

The telemetry ingest routes are unauthenticated, and the collector listens on 4317/4318. Both are
bound to `127.0.0.1` for the same reason as the dashboard. **Keep
`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES` and `OTEL_LOG_TOOL_DETAILS` off** — set
to `0` in `.claude/settings.json`. Enabling any of them puts prompt text and source code into the
database, and the attribute allowlist does not save you: that content arrives as the log record
*body*, not as an attribute.

## Known limits

- Charts are fixed-width; below ~700px the weekly axis labels become illegible.
- The fixture is post-backfill, so the oversized-PR path (#149, 397 reviews) is not exercised by
  it.
- Token and line counts are what the agent wrote, not what survived to merge. There is no SHA in
  the telemetry, so no "AI share of this diff" number is possible.
- Attribution starts when the plugin is installed. A PR merged before that shows no usage, which
  is not the same as having used none.
- The branch is sampled roughly every 20s, not tracked. A branch held for less than one interval
  can be missed.
- `POST /api/otlp/v1/logs` accepts and discards. `prompt.id` and `message.uuid` are only worth
  storing once there is a per-prompt view to spend them on.
