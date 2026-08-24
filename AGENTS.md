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
explicitly. The same is true of `server/src/github/fixtures/sample-payload.json`, which the
fixture client reads at runtime. Forgetting either fails only in the container, never in dev.

## Architecture

| Package | Role |
| --- | --- |
| `core/` | Pure aggregation + shared types. No I/O, no dependencies. |
| `server/` | Fastify API: forge adapters, PR store, telemetry store, two cache slots, static SPA hosting. |
| `web/` | Vite + React 19 SPA, polls `/api/stats`. |
| `plugins/agent-telemetry/` | Installable Claude Code plugin. Reports `session -> (repo, branch)`. |

Data flow: `client.fetchPullRequests()` → `CanonicalPr[]` → `savePullRequests()` →
`loadPullRequests()` → `deriveAll()` → `DerivedPr[]` → `compute()` → `Stats` → JSON → panels.
`core/src/canonical.ts` and `core/src/types.ts` are the contract shared by all three packages; the
SPA imports `Stats` from core rather than redeclaring it. The two store steps are skipped entirely
when persistence is off, and the array then reaches `deriveAll()` in the order the fetch produced.

**`CanonicalPr` is provider-neutral, and that is load-bearing.** It used to be
`RawPullRequest` — literally GitHub's GraphQL response, nested connections and all — which meant
a second forge could only be added by faking GitHub's shape. `server/src/github/schema.ts` now
holds that response type, `server/src/github/map.ts` maps it, and `server/src/forge.ts` holds the
`ForgeClient` interface a `server/src/gitlab/` sibling would implement. `core` no longer knows
GitHub exists.

Telemetry is a **second, independent pipeline** that meets the first only at response assembly:
Claude Code → OTEL collector → `POST /api/otlp/v1/metrics` → `flattenMetrics()` → TimescaleDB →
`createPostgresTelemetryClient()` → `TelemetryInput` → `attribute()` → `TelemetryStats`, a
sibling of `Stats` in the payload rather than a field inside it.

Server wiring (`server/src/index.ts`): `loadConfig()` → forge client (`fixture` or `github`) →
telemetry client (`fixture`, `postgres` or `off`) → PR store (`postgres` or absent) →
`createStatsService()` → `buildApp()` → `prime()` (un-awaited) → `listen()`. `buildApp`
deliberately does not `listen`, which is what lets `server/test/` drive the whole app in-process
via `app.inject()` with stubbed clients and an in-memory store.

`ForgeClient` (`server/src/forge.ts`) has two implementations — the live GraphQL client and
`createFixtureClient()`, which replays `server/src/github/fixtures/sample-payload.json` (203 real
PRs, captured 2026-08-21, already post-backfill) **through `toCanonical()`**, so the fixture path
exercises the adapter rather than routing around it. `DATA_SOURCE=fixture` is the default, so the
app and every test run with no token and no rate-limit cost.

The raw capture sits beside the adapter because `core` cannot import from `server` and should not
know GitHub's response shape. `core/test/fixtures/sample-canonical.json` is **derived** from it by
`npm run fixture:canonical` and committed; regenerate it after any change to `toCanonical()`.

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
- **Totals come from the count fields; distributions come from the arrays beside them.** GraphQL
  caps nested connections at 100 nodes (`INNER_LIMIT`). PRs over that get a second pass in
  `backfill()`; anything still cut lands in `CanonicalPr.truncated` and surfaces as
  `stats.meta.truncated` rather than being silently undercounted. `CanonicalPr` names the two
  separately (`reviewCount` vs `reviews`) precisely so no call site can confuse them — a
  `{ totalCount, nodes }` wrapper reads as if they agree, and for #149 they differ by 297.
- **Force pushes are counted from the filtered node list.** `timelineItems.totalCount` ignores
  `itemTypes` and reports the whole timeline — it once claimed 404 force pushes across 14 PRs.
- **`forcePushCount` is `number | null` and `bodyOnlyReviews` degrades to null.** Null means the
  provider cannot observe the thing; 0 means it can and none happened. `Stats.rework.forcePushes`
  is all-or-nothing across the set for the same reason the revert rate is, and a plain reduce over
  nulls would render the literal string "NaN". Guarded by the NaN walker in
  `metrics.invariants.test.ts` and by `core/test/canonical.derive.test.ts`.
- **`stats.meta.window` is derived from array position, not min/max.** It used to rely on the
  query's `CREATED_AT DESC` ordering; with a store in play, `loadPullRequests()`'s
  `order by created_at desc, repo asc, number desc` is the single authority that keeps it true.
  Do not sort in `stats-service.ts` (that puts the invariant in two places) and do not sort in
  `deriveAll()` (that changes the no-database path too). Guarded by
  `server/test/stats.persistence.test.ts` → "reports the window off creation order".
- **`compute()` and `createStatsService()` take an injectable `now`.** The `partial` week flag
  and `generatedAt` depend on the current date; tests pin `FIXTURE_NOW` /
  `2026-08-21T12:00:00.000Z`. Keep using the injection point.
- **`weeklySeries()` seeds every week in the window, including empty ones.** A median over only
  the weeks that had a merge overstates throughput.
- **`CACHE_TTL_SECONDS` is rejected below 300 per configured repo**
  (`MIN_TTL_SECONDS_PER_REPO`). A full fetch is ~243 rate-limit points and ~45s per repo against a
  5000/hour budget. **`SYNC_TTL_SECONDS` (floor 60 per repo) is a second, lower floor used only
  when a store is present** — an incremental sync is a few pages. It does not weaken the guard,
  because the full walk is not gated by a TTL at all: it runs on `FULL_RESYNC_INTERVAL_MS` (24h)
  and refuses to start unless `last_rate_limit.remaining` actually covers `243 × repos × 1.5`.
  Reading the remaining budget is strictly stronger than inferring it from a clock.
- **A stale snapshot is served with 200.** A rate limit must keep the last good render on screen
  and explain itself, not blank the dashboard. `useStats` likewise never clears `data` on error.
- **`ERROR_COOLDOWN_MS` (30s) after a failed fetch.** Without it every request restarts the
  fetch and a rejected token becomes a request loop. `POST /api/refresh` bypasses it.
- **The revert rate degrades alone.** It is the only metric needing `Contents: read`; a missing
  ref returns `null` history and `revert.status = 'unavailable'`, never `{commits: 0, reverts: 0}`.
- **`core/test/metrics.independent.test.ts` shares no code with `core/src/metrics.ts` on
  purpose.** It recomputes headline numbers off the canonical payload and pins SPEC §1 landmarks.
  Importing helpers into it would make a wrong number invisible. **`server/test/github.map.test.ts`
  holds the other half of that chain**, recomputing the same landmarks off the *raw* GitHub
  capture — the seam moved there when `core` stopped speaking GitHub. If any of 203 / 178 / 654 /
  226 / 624 / 30 / 37 / 153.5 / 224 / 0.325 moves, the adapter is wrong; do not adjust the
  expectation.
- **Do not switch GraphQL pagination to `gh api graphql --paginate`.** It only advances the
  cursor if the variable is named `$endCursor`; anything else silently re-requests page 1 forever.
- **When a PR page times out, shrink the nested selections, not `PAGE_SIZE` (25).** Per-page cost
  is superlinear in the nested connections.

### Organizations

An **organization owns the repo list and partitions every stored row.** There is exactly one per
deployment, defined by `[organization]` in `factory.toml`, with no accounts and no memberships —
`meta.organization.mode` is the literal `'config'`. The selector in the topbar is a real
`<select disabled>`; mode 2 turns it on by dropping one attribute.

- **`ORG_ID` defaults to the literal `default`, and `ORG_NAME` to `GITHUB_OWNER`.** The id leads
  every org-owned primary key, so deriving it from the owner would re-key every persisted row the
  day the owner changed — the dashboard comes back empty and reads as data loss, not as a config
  change. A *label* can be derived for free, because nothing keys on one. Requiring `ORG_ID` was
  rejected: it breaks every existing `loadConfig({})` case, and AGENTS.md already names that as the
  signal not to require, not as an obstacle to work around.
- **The id is rejected, never normalised** (`^[a-z0-9][a-z0-9_-]{0,38}$`, no leading `__`). It is
  simultaneously a database key and a URL parameter, and a case-insensitive collision in a key is
  invisible: `Leeloo` and `leeloo` are two partitions that read as one. Silently lowercasing would
  leave the file, the database and the query string disagreeing.
- **`GITHUB_REPOS` and `github.repos` are fatal, not ignored.** The one deliberate exception to "an
  unknown environment variable is ignored", and for exactly the reason that rule is stated: a
  variable that *was* meaningful and is now dropped reverts a two-repo dashboard to one repo and
  still renders, indistinguishable from a repo genuinely removed. The file-layer message names
  `organization.repos` rather than saying "unknown key", because a key that demonstrably worked
  yesterday reads as a typo and the reader's next move is to type it again.
- **A Factory organization is not a GitHub organization.** `organization.repos` still resolves bare
  entries against `github.owner`, and a qualified `other-owner/name` keeps its own, so one
  organization can span several GitHub owners. `organization.id` has nothing to do with
  `github.owner`; do not "simplify" by deleting one.
- **`org_id` leads every org-owned primary key** across ten tables (`pull_request` + its four
  children, `branch_commit`, `branch_history`, `sync_state`, `session_branch`, `session_pr`). It
  leads rather than trails `provider` because a query always knows its organization, so the key is
  a prefix scan of the partition rather than a filter applied afterwards. Guarded by
  `pr-store.test.ts` → "keeps the same PR number under two organizations apart" and
  "a complete child list does not delete another organization's rows".
- **`metric_point` has no `org_id`, on purpose.** It has no `repo` either, for the reason stated in
  `001_init.sql`: a datapoint's repo is resolved by joining `session_branch`, so there is one source
  of truth rather than two that disagree. Its organization comes through that same join. Adding the
  column would mean a second source of truth *and* rebuilding a unique index on a hypertable.
  Consequence: a session with metrics but no `session_branch` row belongs to no organization, which
  is why `session_summary` is read with `org_id = $1 or org_id is null` — those rows are exactly
  what `sessionsWithoutHook` counts, and filtering them would make a broken hook look like an idle
  week. Guarded by "still reports a hook-less session, which belongs to no organization".
- **Pre-organization rows are backfilled `'__unclaimed__'` and adopted once, at boot.**
  `005_organizations.sql` cannot see the config, and backfilling the configured id directly would
  point a deployment that sets `ORG_ID=leeloo` at an empty partition: **200 OK, zero PRs, no log
  line**. `adoptOrg()` in `db/migrate.ts` claims them, which is why `migrate()` takes a required
  `orgId` and why `config.ts` refuses any id beginning with `__`.
- **The four child FKs are `on update cascade`, and `ORG_OWNED` deliberately omits those tables.**
  `org_id` is part of the reference, so adoption is an update to a referenced key and there is no
  legal order to do it in by hand: children first orphans them, parents first strands them. The
  cascade moves them with their parent. Listing a child in `ORG_OWNED` is not redundant but *wrong*
  — before its parent it violates the constraint, after it the statement matches nothing.
- **`session_branch_slice` partitions its `lead()` window by `org_id`, not merely projects it.**
  Otherwise the clamp runs across organizations and one org's slice is truncated by another's start,
  silently dropping the datapoints in between. Guarded by "does not attribute one organization's
  session to another's branch".
- **`SCHEMA_EPOCH` was not bumped.** It forces a full resync when a newly *selected provider field*
  leaves old rows null. `org_id` is backfilled and adopted, so no row is stale.
- **There is no `OrgProvider` interface, deliberately.** `TokenProvider` and `ForgeClient` are the
  tempting precedents, but both ship two implementations already in tree and both have a signature
  that was load-bearing on day one. A directory's org list is per *user*, so its real signature is
  `resolve(caller, orgId)` in a codebase with no caller, no session and no auth — the interface
  would change shape the day its second implementation arrived, having bought nothing but a
  provider threaded through `buildApp` and the service deps. The room mode 2 needs is in the *data
  shape* (`mode` + `available[]`) and in the store's construction-time org binding. Do not add one
  later for symmetry.
- **The store binds `orgId` at construction**, not per call: it is a constant for the life of the
  process, and it is the shape a request-scoped store needs later anyway.

### The combined repo view

The landing page reports **every repo in `config.repos` as one set of figures**. Per-repo pages
are not built yet; when they are, they filter `meta.repos` and the `repo` field on each row rather
than refetching.

- **`repo` ("owner/name") is stamped onto every `CanonicalPr` by the adapter, not read from the
  payload.** A GraphQL response carries no repo identity — the query does. `sample-payload.json`
  is a verbatim capture and stays that way; `toCanonical(raw, repo)` takes the name as an
  argument, which is how the fixture client and the capture script stamp it the same way the live
  client does.
- **Every primary key in `004_pull_requests.sql` carries both `provider` and `repo`.** A repo path
  is not unique across forges (`group/proj` exists on gitlab.com and on a self-hosted instance),
  and a PR number is unique only within a repo. Guarded by `pr-store.test.ts` →
  "keeps the same number under two repos apart".
- **Every map in `attribute()` is keyed by `repo#number` or `repo@branch`, never by `number` or
  `branch` alone.** Neither is unique across repos: two repos routinely both have a `#204` and a
  `main`. Keyed on either alone, a combined view reports one repo's tokens on the other repo's PR
  and labels it `exact`. Guarded by `core/test/telemetry.attribution.test.ts` →
  "a branch is not unique across repos", which fails loudly if the keys are ever simplified back.
  The same applies to `unmatched.branches` (a `{repo, branch}` list, not a string list). The old
  `truncated` filter in `stats-service.current()` is gone: `truncated` now rides on the PR record
  itself, so there is no side channel left to key wrongly.
- **The revert rate is all-or-nothing across repos.** `fetchBranchHistories()` returns one entry
  per repo, and if *any* repo's `dev` is unreadable the combined figure is reported `unavailable`
  naming that repo. Summing the repos that did resolve would produce a plausible number measured
  over an unknown subset — the exact failure the null-not-zero contract exists to prevent.
- **Repos are fetched sequentially, and `MIN_TTL_SECONDS_PER_REPO` (300) is multiplied by the repo
  count.** The ~243-point cost is paid once per repo, so a fixed floor weakens as repos are added
  — which is when it matters most. Concurrent fetches would burn the budget in a burst the TTL
  cannot smooth out.
- **`config.repoNames` is derived from `config.repos`, and there is no separate telemetry repo
  setting.** A second list is a second source of truth that silently drops sessions the moment it
  drifts.
- **The SPA qualifies a PR number only when more than one repo is in scope** (`prLabel()` in
  `web/src/format.ts`). Prefixing every row on a single-repo dashboard trains the reader to skip
  the prefix, which defeats it on the day a second repo appears.

### Configuration

Two sources: environment variables, and an optional `factory.toml` (see `factory.toml.example`).
The file layer lives entirely in `server/src/config-file.ts` and hands `loadConfig` an env-shaped
record, so env wins by merge order.

- **`loadConfig` does no I/O, and `server/src/config.ts` is untouched by the file layer.**
  `loadConfig({})` has to mean the same thing on every machine; if the validator read the disk,
  the existing `describe('loadConfig')` cases would start reading whatever `factory.toml` the
  developer happens to keep and fail on exactly one machine. That block's survival is the
  regression test.
- **The file is stringified to env shape rather than parsed into `Partial<AppConfig>`.** Round-
  tripping `900` through `String()` so `int()` can re-parse it is circuitous, but the cross-source
  rules (`DATA_SOURCE=github` requires `GITHUB_TOKEN`, the 300s floor) must hold over the *merged*
  result, and a second validator would drift from the first.
- **An empty environment variable is not an override.** `docker-compose.yml` passes
  `GITHUB_TOKEN: ${GITHUB_TOKEN:-}`, i.e. a literal `''` whenever the host has no token, which
  would clobber a mounted file on every start. Consequence: a file value is unset by deleting the
  line, not by `HOST=` in `.env`.
- **An unknown key in the file is fatal; an unknown environment variable is ignored.** Same
  asymmetry as the attribute allowlist vs the metric denylist, for the same kind of reason: a file
  has a closed key set, so `tokenn` is a typo — and a tolerated one boots the dashboard on
  fixture data, indistinguishable from having no token. `GITHUB_REPOS` is the single exception on
  the environment side; see the Organizations section for why.
- **`ORG_ID`, `ORG_NAME` and `ORG_REPOS` are empty-defaulted in `docker-compose.yml`**, unlike most
  of that block. Every other variable there is a real value that beats a mounted file by design,
  but the org id leads every stored primary key — a literal default would clobber the file's
  `organization.id` on every start and repartition the database under the operator. `ORG_REPOS`
  follows suit, one step less severe. This also fixes the pre-existing case where
  `GITHUB_REPOS: ${GITHUB_REPOS:-leeloo.ai}` silently overrode a mounted file's repo list.
- **A missing `FACTORY_CONFIG` path is fatal; a missing default path is silent.** One is an
  explicit request that could not be honoured, the other is the supported env-only mode that the
  test suite and CI run in.
- **Discovery walks upward and stops at `package-lock.json`.** `npm run dev -w server` runs with
  cwd `server/`, so a repo-root file has to be reachable from a subdirectory — but an unbounded
  walk would escape into `$HOME` and pick up an unrelated file. The marker sits at the repo root
  and at `/app` in the container.
- **`resolveConfig` returns the merged record, and `index.ts` passes it to `envTokenProvider`.**
  That provider is the only PAT read outside `config.ts`; left on its `process.env` default it
  would silently ignore the file's token while the config believed it had one.
- **Integers must be unquoted and strings must be strings** (`ttl_seconds = "900"` is rejected),
  so the file stays honestly typed instead of drifting into env-style stringly values. A `bots`
  entry containing a comma is rejected because the env form is comma-separated.
- **Never log the merged record.** It holds the PAT. Log key names, provenance and the resolved
  path only.

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
- **A narrowed range reports the revert rate from persisted commit rows, and `unavailable` when
  it cannot.** `revertForRange()` slices `StatsSnapshot.commits`. It refuses in three cases, each
  of which would otherwise be a ratio over an unknown subset: nothing persisted (the pre-store
  behaviour), `commits.length !== history.commits` (a partial scan, so the row count is not a
  valid denominator), and any repo whose `branch_history.covered_from` is later than `range.from`
  — that last one names the repo, because a combined figure over a subset is worse than none.
  All-time still uses the provider's reported total, never a row count.
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

### Persistence and incremental sync

PR data is persisted whenever `DATABASE_URL` is set **and** `DATA_SOURCE` is not `fixture`. On
boot `prime()` seeds the cache slot from the store, so a restart with a warm database serves real
data on the first request rather than a 202.

- **Fixture data is never persisted, and there is no flag that says otherwise.** `DATA_SOURCE`
  defaults to `fixture` and `docker-compose.yml` sets `DATABASE_URL` unconditionally, so the
  default path is exactly the one that would write 203 synthetic PRs into `factory_dev`.
  `config.persistence` is *derived* rather than configurable for that reason — the dangerous
  combination has to be inexpressible, not merely distinguishable, the same lesson as the `*_test`
  guard. And `loadConfig` **throws** on `DATA_SOURCE=github` with a `*_test` database, the mirror
  of it: the db suite truncates that database, so real fetched history put there is lost on the
  next `npm run test:db`.
- **`prime()` seeds with `last_sync_at`, never `now()`.** Seeding with `now()` reports
  `ageSeconds: 0, stale: false` off a three-day-old database, `ensureFresh()` then declines to
  sync, and the result is a permanently frozen dashboard that looks fresh.
- **`cache.seed()` only fills an empty slot.** A seed arriving after a live fetch landed is older
  by definition. And `ensureFresh()` returns early while `prime()` is in flight — otherwise the
  first sync races the seed, wins, and burns a full walk for nothing.
- **A persistence failure never propagates out of `produce()`.** It would set `lastFailureAt` and
  freeze the whole PR pipeline for 30s over a database fault. Every store call goes through
  `tryStore()`, which records `persistence.status = 'unavailable'` and returns null. Guarded by
  `server/test/stats.persistence.test.ts` → "does not set the fetch cooldown".
- **The watermark is a `sync_state` column, not `max(provider_updated_at)` over `pull_request`.**
  That maximum advances on every successful upsert, *including part-way through a walk that then
  died* — the next run would resume from the newest row it happened to write and skip everything
  in between, silently and permanently. It advances only for a repo whose `completed[repo]` is
  true.
- **The incremental cutoff is `min(watermark − 5min, now − 14d, oldest open PR's updatedAt)`.**
  Each term earns its place. The overlap covers GraphQL replica lag, without which an update is
  missed forever and invisibly. The other two exist because `updatedAt` does **not** reliably bump
  on a *child* change — a thread resolved, a label removed, a force push — and those feed
  `headline.unresolvedThreadRatio`, the most prominent number on the page. Do not replace them
  with a second query path.
- **An incremental walk orders `UPDATED_AT DESC` and stops only after a whole page falls below the
  cutoff.** `orderBy` is not a strict total order across equal timestamps, so a mid-page stop can
  drop a sibling of the node that triggered it. **Do not** instead keep `CREATED_AT DESC` and stop
  on `createdAt`: that never re-reads an old PR, so a thread resolved on a three-month-old one
  never lands and the unresolved ratio freezes.
- **A full reconciliation runs every 24h, or when `synced_epoch < SCHEMA_EPOCH`.** The epoch bump
  is the important half: it is the only repair for a newly selected field leaving old rows null,
  which is silently wrong for old PRs only. Bump `SCHEMA_EPOCH` when you add one.
- **A truncated child list is upserted, never delete-and-replaced.** This is the single most
  dangerous line in the write path. A degraded refetch of #149 returns 100 reviews with the total
  still reading 397; replacing 397 rows with 100 corrupts the resolution ratio with no error
  anywhere. The decision is **per connection**, because one PR can arrive with a complete commit
  list and a truncated review list in the same fetch. A *complete* list is delete-and-replaced,
  which is the only thing that ever makes a review deleted upstream stop being counted.
  `pr-store.truncation.test.ts` also asserts `count(*) from pr_review !== review_count` for #149
  on purpose, so nobody "fixes" the discrepancy by making the total a `count(*)` — that would
  undercount by 297.
- **`truncated` is recomputed on every write, never unioned.** A union leaves a stale caveat on the
  page after a successful backfill has already filled the list in.
- **`branch_commit` stores `message_headline`, not a precomputed `is_revert`.** Same reason
  `metric_point` stores datapoints and not rollups: the classifier (`isRevertHeadline` in
  `core/src/config.ts`) will change, and a verdict cannot be re-derived. It also lives in `core`
  so the server and any slicing path share one definition.
- **A base-branch rescan resumes an hour behind the newest stored commit.** `since` is inclusive
  upstream, so the tip repeats and the primary key makes that a no-op. The overlap is not
  paranoia: a commit date is not monotonic with history order, so a rebase can place a commit
  behind its own parent and a zero-overlap resume genuinely skips it.
- **`branch_history.covered_from` only ever moves backwards.** A later scan starting from a newer
  bound has not lost the older commits, and moving it forward would make a range that *is* covered
  report as unavailable.
- **`ttlMs` is `syncTtlMs` when a store is present and `cacheTtlMs` otherwise**, and the history
  loop now has a `MAX_HISTORY_PAGES` cap it was missing — a first scan of a busy monorepo could
  page until the quota ran out.

**Tradeoff worth knowing:** the SQL, the views and the migration runner have **no coverage in
`npm test`**. That is the price of keeping the default suite offline and database-free; they are
covered by `npm run test:db`, which needs a running container. The offline suite covers the same
logic through `memoryPrStore()` in `server/test/helpers.ts`.

## API

| Route | Behaviour |
| --- | --- |
| `GET /api/health` | Never calls GitHub or the database, so a token-less, DB-less container still reports healthy. |
| `GET /api/stats` | `200` with `{ stats, telemetry, meta }`; `202` with progress while a cold fetch runs (SPA polls every 2s); `503` only if the first PR fetch failed **and** nothing is persisted. A cold boot with a warm database is a 200 because the seed landed — but both other codes stay reachable and deleting either is a regression. `telemetry` is `null` when unavailable, and `meta.persistence` degrades in four states (`ok` / `migrating` / `unavailable` / `off`); neither is ever a reason for a non-200. `?range=day\|week\|2w\|month\|all\|custom` (default `all`), plus `?from=&to=` for `custom`; `400 BAD_RANGE` on anything unparseable, never a silent fallback to all time. `?org=` is accepted and `400 UNKNOWN_ORG` on a mismatch — see below. |
| `POST /api/refresh` | `202`. Single-flight. Refreshes both caches. |
| `POST /api/otlp/v1/metrics` | `200 {"partialSuccess":{}}`. 1 MB limit, JSON only. Registered only when a store exists. |
| `POST /api/otlp/v1/logs` | `200`. Accepted and dropped — see M6 in the plan. |
| `POST /api/sessions/branch` | `202`. `400` on a malformed body, never 5xx. |

- **`meta.organization.mode` is a discriminant, never inferred from `available.length > 1`.** A
  directory user with one membership can be granted a second with no deploy; a control disabled by
  list length is right today by accident and silently wrong then.
- **`400 UNKNOWN_ORG` is checked before `parseRange` and before `ensureFresh()`.** The organization
  selects *which* data set is being ranged, so it is the more fundamental error, and a bad request
  must never be answered with a 202 the client then polls forever. Rejected rather than ignored, and
  the `BAD_RANGE` precedent understates the reason: an ignored range at least echoes in
  `meta.range` where a reader could notice, whereas an ignored `?org=` would echo
  `meta.organization.current` as the configured org and render one organization's figures under a
  heading the caller did not ask for. Once the store is partitioned, "trust the parameter" must
  never become a habit — the day auth lands, that habit is a cross-tenant read. Guarded by
  "reports the organization, not the range, when both are wrong", which is what pins the ordering.
- **`org` goes no further than the guard.** The service knows the only organization there is, and a
  parameter it ignores is worse than no parameter.

## Security posture

There is no application-level auth. The `127.0.0.1` bind in `docker-compose.yml` is the access
control — do not expose the port without putting authentication in front of it first. CSP and
`X-Content-Type-Options` / `Referrer-Policy` are set as response headers in `app.ts` (a `meta`
tag would not let dev allow the Vite HMR websocket).

Required fine-grained PAT permissions: `Metadata: read`, `Pull requests: read`, and
`Contents: read` (revert rate only).

The PAT may now sit on disk in `factory.toml`, which is gitignored and dockerignored. `chmod 600`
it — the boot warning about a group/world-readable mode is not decorative, because no
application-level auth plus a readable token is worse than either alone.

The telemetry ingest routes are unauthenticated, and the collector listens on 4317/4318. Both are
bound to `127.0.0.1` for the same reason as the dashboard. **Keep
`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES` and `OTEL_LOG_TOOL_DETAILS` off** — set
to `0` in `.claude/settings.json`. Enabling any of them puts prompt text and source code into the
database, and the attribute allowlist does not save you: that content arrives as the log record
*body*, not as an attribute.

## Known limits

- Charts are fixed-width; below ~700px the weekly axis labels become illegible.
- The fixture is post-backfill, so the oversized-PR path (#149, 397 reviews) is not exercised by
  it — `server/test-db/pr-store.test.ts` synthesises it instead.
- The fixture capture predates `updatedAt`, commit `oid` and review-thread `id`, so
  `fixturePayload()` fills them in. Safe only because fixture data is never persisted; nothing on
  that path uses them.
- An incremental sync cannot see a PR **deleted** upstream. A daily reconciliation reports rows it
  did not see, but does not remove them: losing expensively fetched history because a token lost a
  scope is worse than a stale count.
- The persisted PR store is single-writer. Two dashboards sharing one database would both sync and
  both advance the same watermark; nothing detects it.
- Token and line counts are what the agent wrote, not what survived to merge. There is no SHA in
  the telemetry, so no "AI share of this diff" number is possible.
- Attribution starts when the plugin is installed. A PR merged before that shows no usage, which
  is not the same as having used none.
- The branch is sampled roughly every 20s, not tracked. A branch held for less than one interval
  can be missed.
- `POST /api/otlp/v1/logs` accepts and discards. `prompt.id` and `message.uuid` are only worth
  storing once there is a per-prompt view to spend them on.
- **The two cache slots in `cache.ts` are process-global.** Correct for one organization, and the
  actual blocker for multi-tenancy — not the store signature, which is already org-bound. A second
  organization needs a slot per organization, or every request serves the first one's snapshot.
- **`session_branch.branch` is documented nullable ("null on detached HEAD") but sits in the
  primary key**, so postgres has rejected those rows since `001_init.sql`. `recordBranch` and
  `transcripts.ts` both try to write them and `routes.ingest.test.ts` cannot catch it because it
  asserts against a stub. `005_organizations.sql` preserves the constraint deliberately rather than
  fixing it in passing: the repair is a unique index over `coalesce(branch, '')`, which changes the
  `on conflict` target in three write paths and deserves its own review.
