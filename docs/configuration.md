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
  `GITHUB_APP_PRIVATE_KEY: ${GITHUB_APP_PRIVATE_KEY:-}`, i.e. a literal `''` whenever the host has
  not set one, which would clobber a mounted file on every start. Consequence: a file value is unset
  by deleting the line, not by `HOST=` in `.env`. It is also why the retired `GITHUB_TOKEN`,
  `ORG_REPOS` and `GITHUB_OWNER` are fatal only when *non-empty* — a stale blank line in a `.env`
  must not refuse to boot.
- **An unknown key in the file is fatal; an unknown environment variable is ignored.** Same
  asymmetry as the attribute allowlist vs the metric denylist, for the same kind of reason: a file
  has a closed key set, so `tokenn` is a typo — and a tolerated one boots a dashboard whose
  operator believes it is authenticated. `GITHUB_TOKEN`, `GITHUB_OWNER`, `ORG_REPOS`,
  `GITHUB_REPOS`, `DATA_SOURCE` and `CACHE_TTL_SECONDS` are the exceptions on the environment side:
  every one of them *was* meaningful, so ignoring one now would change behaviour silently. Each
  message names what replaced it rather than reporting a typo.
- **`DATABASE_URL` is required, and so is a decision about GitHub.** The database is the only source
  the dashboard reads, so there is no configuration without one. `GITHUB_MODE` is an explicit enum
  defaulting to `app`, and `app` with `GITHUB_APP_ID` or `GITHUB_APP_PRIVATE_KEY` missing is fatal
  and names the missing key. `none` is a supported state — nothing is constructed to fetch with, and
  the persisted figures still render — but it is a sentence an operator types, never somewhere a
  deployment lands by forgetting a variable, because a dashboard that silently fetches nothing
  presents as data loss rather than as a missing credential.
  - **This is the opposite default from `AUTH_MODE`, on purpose.** There, `none` keeps
    `git clone && npm run dev` working and the cost of the wrong default is a locked-out developer.
    Here the cost runs the other way. The price is paid explicitly in four places: `npm run seed`,
    `npm run verify:ui`, `scripts/test-jobs.sh` and the config suites all set `GITHUB_MODE=none`.
- **A process in `app` mode refuses a disposable database** (`_test`, `_seed`, `_synthetic`,
  `_demo`, `_e2e`). `npm run test:db` truncates one and `npm run seed` fills one with invented pull
  requests, so real fetched history put there is destroyed or made indistinguishable from
  synthetic. In `none` mode the same pairing is *allowed*, because nothing is fetched to lose —
  which is exactly how the seeding CLI and the browser check run. The guard used to key on
  `GITHUB_TOKEN`; same guard, same reasoning, new name for "this process fetches".
- **There is no repo list to configure.** It is whatever the GitHub App installation reports. A
  configured copy beside it would be a second roster to keep in step with the credential — and a
  repo in one but not the other used to fail every sync with a 404 that read as a deleted
  repository. `AppConfig` therefore has no `repos`, and the sync TTL's per-repo floor moved to the
  stats service, which is now the only thing that knows the count.
- **`ORG_ID` and `ORG_NAME` are empty-defaulted in `docker-compose.yml`**, unlike most of that
  block. Every other variable there is a real value that beats a mounted file by design, but the org
  id leads every stored primary key — a literal default would clobber the file's `organization.id`
  on every start and repartition the database under the operator.
- **A missing `FACTORY_CONFIG` path is fatal; a missing default path is silent.** One is an
  explicit request that could not be honoured, the other is the supported env-only mode that the
  test suite and CI run in.
- **Discovery walks upward and stops at `package-lock.json`.** `npm run dev -w server` runs with
  cwd `server/`, so a repo-root file has to be reachable from a subdirectory — but an unbounded
  walk would escape into `$HOME` and pick up an unrelated file. The marker sits at the repo root
  and at `/app` in the container.
- **`resolveConfig` reads `GITHUB_APP_PRIVATE_KEY_FILE`, and `loadConfig` never learns a file
  exists.** The whole `describe('loadConfig')` suite depends on the validator being a pure function
  of its argument, and an App private key normally arrives as a path — so the read happens in the
  one module that already does every byte of I/O in this system, before the validator sees the
  record. The validator only shape-checks the PEM; `createPrivateKey()` runs when the token provider
  is constructed, so a well-shaped but unusable key is still fatal at boot rather than at the first
  fetch. An inline key wins over a `_FILE` path, so a stale line in a mounted file cannot override
  a key an operator just exported. The key may also be base64: a PEM is multi-line and neither
  `.env` nor compose handles that well.
- **`GITHUB_API_URL` is environment-only and absent from `KEYS`**, for the same reason as the three
  OAuth endpoint overrides below: a configurable API host in a file that ships with a deployment is
  somewhere to send a private key. `index.ts` logs loudly when it is set.
- **Integers must be unquoted and strings must be strings** (`ttl_seconds = "900"` is rejected),
  so the file stays honestly typed instead of drifting into env-style stringly values. A `bots`
  entry containing a comma is rejected because the env form is comma-separated. **Booleans follow
  the same rule**: `cookie_secure = "true"` is rejected, while the env layer still takes `1`/`true`,
  because there every value is a string and there is nothing to distinguish.
- **`AUTH_MODE` is an explicit enum, never inferred from whether a client id is set**, and
  `AUTH_MODE=github` with an incomplete `[auth]` is fatal and names the missing key. Both are the
  same instinct as `persistence.status` having no `'off'`: a mode you can fall into by typo is worse
  than one that refuses. Full reasoning in [auth.md](auth.md). `AuthConfig` is a discriminated union
  rather than a record of optionals, so "half-configured" is unrepresentable rather than merely
  rejected.
- **Three `[auth]` settings are environment-only and deliberately absent from `KEYS`.**
  `GITHUB_OAUTH_AUTHORIZE_URL` / `_TOKEN_URL` / `_USER_URL` are a test seam — a configurable
  authorize URL in a file that ships with a deployment is a phishing vector, and `index.ts` logs
  loudly when one is in use. `AUTH_ALLOW_PUBLIC_BIND` is env-only for a different reason: it asserts
  something about the network in front of the process, which is a property of the host rather than of
  the deployment.
- **The group/world-readable warning covers every secret**, not just the App key: a `factory.toml`
  holding only a `session_secret` is exactly as bad, and keying the check on one name would have left
  it silent. It stays conditioned on the file actually carrying one, because the committed e2e config
  declares none and is necessarily mode 644. `GITHUB_APP_PRIVATE_KEY` is the worst of the four to
  leak and it replaced the least bad: a PAT carries the scopes it was issued with and can be
  revoked, while the key mints installation tokens indefinitely and rotating it means generating a
  new one in GitHub's UI.
- **`ORG_WORKSPACE_ROOT` is unset by default, must be absolute, and expands `~` against `env.HOME`
  rather than `os.homedir()`** — that last one is what keeps `loadConfig` a pure function of its
  argument. See [workspace.md](workspace.md) for the rest, including why a relative path is rejected
  rather than resolved.
- **Never log the merged record.** It holds the App private key. Log key names, provenance and the
  resolved path only.
