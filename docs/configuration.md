# Configuration

Read before: touching `server/src/config.ts`, `server/src/config-file.ts`, `docker-compose.yml`
environment blocks, or `factory.toml.example`.

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
  rules (the disposable-database refusal, the sync floor) must hold over the *merged* result, and a
  second validator would drift from the first.
- **An empty environment variable is not an override.** `docker-compose.yml` passes
  `GITHUB_TOKEN: ${GITHUB_TOKEN:-}`, i.e. a literal `''` whenever the host has no token, which
  would clobber a mounted file on every start. Consequence: a file value is unset by deleting the
  line, not by `HOST=` in `.env`.
- **An unknown key in the file is fatal; an unknown environment variable is ignored.** Same
  asymmetry as the attribute allowlist vs the metric denylist, for the same kind of reason: a file
  has a closed key set, so `tokenn` is a typo — and a tolerated one boots a dashboard whose
  operator believes it is authenticated. `GITHUB_REPOS`, `DATA_SOURCE` and `CACHE_TTL_SECONDS` are
  the exceptions on the environment side: all three *were* meaningful, so ignoring one now would
  change behaviour silently.
- **`DATABASE_URL` is required, and `GITHUB_TOKEN` is not.** The database is the only source the
  dashboard reads, so there is no configuration without one. A missing token is a supported state
  rather than an error: the process does not fetch, `envTokenProvider` throws before a request is
  ever built, and the persisted figures still render with the failure named in `meta`. That is what
  lets `verify:ui` and a seeded demo run with no credentials and no network.
- **A process WITH a token refuses a disposable database** (`_test`, `_seed`, `_synthetic`,
  `_demo`, `_e2e`). `npm run test:db` truncates one and `npm run seed` fills one with invented pull
  requests, so real fetched history put there is destroyed or made indistinguishable from
  synthetic. Without a token the same pairing is *allowed*, because nothing is fetched to lose —
  which is exactly how the seeding CLI and the browser check run.
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
- **`ORG_WORKSPACE_ROOT` is unset by default, must be absolute, and expands `~` against `env.HOME`
  rather than `os.homedir()`** — that last one is what keeps `loadConfig` a pure function of its
  argument. See [workspace.md](workspace.md) for the rest, including why a relative path is rejected
  rather than resolved.
- **Never log the merged record.** It holds the PAT. Log key names, provenance and the resolved
  path only.
