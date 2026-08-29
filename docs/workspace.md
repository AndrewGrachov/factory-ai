# Workspace

Read before: touching `server/src/workspace/*`, `ORG_WORKSPACE_ROOT` / `organization.workspace_root`,
or the `git` install in `docker/Dockerfile`.

An organization's **workspace** is one clone per configured repo at `<root>/<orgId>/<name>`, created
at boot. It exists so something can eventually be *run* against a checkout — `docker/claude-executor`
expects one — not so the dashboard can read it. Nothing rendered on the page comes from here.

- **Unset by default, and unset means nothing is cloned.** A default path would make an upgrade
  start cloning gigabytes for an operator who changed nothing, and would turn a no-network boot into
  a network boot. Since no route, query or metric reads a checkout, there is no case where having
  one silently beats not having one.
- **`docker-compose.yml` is the one exception: it defaults `ORG_WORKSPACE_ROOT` to `/workspaces`
  and mounts a named volume there.** The paragraph above is about defaulting a *host* path, which
  compose is not doing — `/workspaces` exists only inside the container it also provisions, so
  nothing is written anywhere the operator did not hand over. It is a literal rather than
  empty-defaulted like `ORG_ID` / `ORG_NAME` / `ORG_REPOS` for the same reason: those three are
  host-independent identifiers a mounted `factory.toml` should win, while a `workspace_root` in
  that file is a host path that cannot exist in the container, so overriding it is correct.
- **The volume is named, not a bind mount, and it is mounted unconditionally.** The container runs
  as `node` and usually cannot write a host directory owned by someone else — a clone dying on
  permissions is a confusing first symptom. Unconditional because a named volume is created on
  demand, so unlike the `factory.toml` bind there is no missing source for compose to fail on, and
  without it every clone would be discarded on the next `up`.
- **Compose gets its secrets by `${VAR}` substitution from `.env`, never `env_file:`.** `env_file`
  would inject the whole file into the container, including variables meant only for host scripts —
  `.env`'s `DATABASE_URL` points at `127.0.0.1`, a different database from the one compose
  provisions — and would bypass the deliberate empty-defaulting of the `ORG_*` three.
- **`loadConfig` still does no I/O.** No `existsSync`, no `mkdir` in `config.ts` — the whole
  `describe('loadConfig')` block depends on the validator being a pure function of its argument, and
  the directory is created by the reconcile instead. For the same reason `~` expands against
  `env.HOME` rather than `os.homedir()`: the latter reads the environment behind the validator's
  back and the case then passes on one machine only.
- **A relative root is rejected, not resolved.** `npm run dev -w server` has cwd `server/` and the
  container has `/app`, so one relative path is two different trees on a single machine. Resolving
  against the config *file's* directory was rejected too: it gives one key two meanings depending on
  whether it arrived from the file or the environment, and `loadConfig` is not allowed to know a
  file exists.
- **Repo names are constrained only when a root is set.** The checkout is `<root>/<orgId>/<name>`,
  so both halves must survive as a bare path segment. `orgId` already does — `ORG_ID_PATTERN`
  forbids dots and slashes for exactly this reason — but a repo name never had to, because until now
  it was only ever a string in an API path. Two owners' same-named repos are one directory, and a
  leading `-` is read by git as an option. Both are legal without a workspace, and a deployment that
  never clones should not start failing to boot over one.
- **An existing checkout is never touched, and nothing is ever pruned.** `.git` present means skip:
  no fetch, no reset, no branch change. The tree may hold uncommitted work belonging to a Claude
  Code session, and this process cannot tell. Consequence: a repo removed from `organization.repos`
  leaves its directory behind, clones drift from their remotes, and disk growth is unbounded and
  unmonitored.
- **A directory that exists and is not a checkout aborts the whole reconcile.** Not a per-repo
  failure: it means the root points at the wrong tree, and continuing would scatter clones through
  someone's home directory.
- **Cloned into `<name>.tmp-<pid>` and renamed into place.** A process killed mid-clone would
  otherwise leave a partial tree that the *next* boot classifies as "exists, not a checkout" — the
  rule above then fails forever, on a directory nobody deliberately created.
- **The token reaches git through the environment, and only a credential-helper snippet reaches
  argv.** A token in the clone URL is world-readable in `/proc/<pid>/cmdline`, and git writes the
  URL permanently into `.git/config`, where every later `git remote get-url origin` prints it —
  including the one `backfill/transcripts.ts` runs to attribute a session to a repo. `http.extraHeader`
  has the same argv problem; `GIT_ASKPASS` needs a script on disk. The helper list is cleared with a
  leading empty `-c credential.helper=` first, or an inherited `osxkeychain`/`store` answers with a
  stale credential. `GIT_TERMINAL_PROMPT=0` is set because an unauthenticated private clone would
  otherwise block on stdin and hang the boot rather than failing.
- **No token is a supported state here too.** Public repos clone, private ones report a named
  failure. Making it fatal would delete the no-token mode that `verify:ui` and `npm run seed` rely
  on, and `envTokenProvider` is deliberately *not* used for this reason — it throws when unset.
- **A clone failure is logged, and boot continues.** Same posture as a failed migration and a failed
  prime: nothing on the read path needs a checkout, so an unreachable GitHub must not stop the
  stored figures being served. The reconcile is fired, not awaited, for the matching reason — a
  clone is minutes of network for a feature no route uses, and `listen()` must not wait on it.
- **Full clone, not `--depth 1`.** Base-branch history and revert detection read history.
- **`node:24-alpine` ships no git**, so `docker/Dockerfile` installs it. Absent, the failure is an
  ENOENT per repo that appears only in the container and never in dev — the same failure mode as a
  migration that was not copied.
- **The tests never reach the network.** `workspace.reconcile.test.ts` clones `file://` from a bare
  repo it builds itself, with `user.email`, `user.name`, `init.defaultBranch` and `commit.gpgsign`
  all pinned on the command line so the fixture does not depend on the runner having a global git
  config. Auth is covered through the injected `run` seam instead, which is the only way to assert
  the token is in the child environment and *not* in argv.
