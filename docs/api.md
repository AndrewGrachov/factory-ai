# API

Read before: adding or changing a route, a status code, or a query parameter.

Every `/api/*` route needs a credential under `AUTH_MODE=github`, and none under `AUTH_MODE=none`.
Which one each takes is in the table in [auth.md](auth.md); the exemptions worth knowing here are
`GET /api/health` and `/api/auth/*`, and the fact that the SPA's own document is never gated. An
unauthenticated `/api/*` request is `401 UNAUTHENTICATED`.

| Route | Behaviour |
| --- | --- |
| `GET /api/auth/github` | `302` to GitHub, setting a signed, single-use state cookie. `?returnTo=` is validated as a same-origin absolute path; anything else becomes `/`. |
| `GET /api/auth/github/callback` | `302` on every outcome, never JSON — it is reached by a top-level navigation, and an error body is a dead end for the human in front of it. Failures carry `?auth_error=denied\|state\|github\|no_membership`. |
| `POST /api/auth/logout` | `204`, including for a caller who was never signed in. POST because a GET logout is CSRF-able and gets fired by link prefetchers. |
| `GET /api/auth/me` | `200 { user, role, organization, mode }` or `401 UNAUTHENTICATED`. Deliberately exempt from the wall: being what *tells* the SPA it is unauthenticated is its whole purpose. |
| `GET /api/health` | Never calls GitHub or the database. A container whose migrations are still retrying is up and answering, so probing either here would fail the compose healthcheck and restart the container that was about to succeed. |
| `GET /api/stats` | `200` with `{ stats, telemetry, meta }`; `202` with progress while a cold fetch runs (SPA polls every 2s); `503` only if the first PR fetch failed **and** nothing is persisted. A cold boot with a warm database is a 200 because the seed landed — but both other codes stay reachable and deleting either is a regression. `telemetry` is `null` when unavailable, and `meta.persistence` degrades in three states (`ok` / `migrating` / `unavailable` — there is no `off`); neither is ever a reason for a non-200. `?range=day\|week\|2w\|month\|all\|custom` (default `all`), plus `?from=&to=` for `custom`; `400 BAD_RANGE` on anything unparseable, never a silent fallback to all time. `?org=` is accepted and `400 UNKNOWN_ORG` on a mismatch — see below. |
| `POST /api/refresh` | `202`. Single-flight. Refreshes both caches. |
| `POST /api/otlp/v1/metrics` | `200 {"partialSuccess":{}}`. 1 MB limit, JSON only. Registered only when a store exists. |
| `POST /api/otlp/v1/logs` | `200`. Accepted and dropped — see M6 in the plan. |
| `POST /api/sessions/branch` | `202`. `400` on a malformed body, never 5xx. |
| `POST /api/jobs` | `201 { id, status }`. `400 BAD_COMMAND` on a missing, empty or over-16-KiB command. Records `created_by` from the authenticated caller, **never from the body** — a client-supplied author is impersonation on the audit trail of a route that runs shell commands. |
| `POST /api/jobs/claim` | `200 { id, command, attempts, leaseToken, leaseExpiresAt, userId, resumeSessionId }`, or **`204`** when nothing is waiting — an idle poll is the common case and must be recognisable without parsing a body. `resumeSessionId` is non-null only when the claim is picking a parked job back up, and the worker restores that session instead of starting one. `userId` is the account that queued the job, or null for one queued before accounts existed; nothing consumes it yet — it is shipped ahead of its consumer so that resolving a per-user credential or workspace is a change to the driver alone rather than to the protocol as well. `400 BAD_WORKER` / `BAD_LEASE`. |
| `POST /api/jobs/:id/heartbeat` | `200 { leaseExpiresAt }`. **`409 LEASE_LOST`** once the lease has been reclaimed — the driver kills the container on this, and it is the only signal a superseded worker gets. `404` unknown, `400 BAD_ID` / `BAD_TOKEN`. |
| `POST /api/jobs/:id/session` | `200 { id, sessionId, remoteSessionId }`. Records the agent session the running attempt is using. Called **twice** per Remote Control attempt: `sessionId` (a uuid) is known at spawn, `remoteSessionId` (`cse_…`, optional, opaque, ≤256 chars) only once the bridge connects. A null `remoteSessionId` never clears one already stored. Lease-guarded: `409 LEASE_LOST`, `404`, `400 BAD_ID` / `BAD_TOKEN` / `BAD_SESSION_ID` / `BAD_REMOTE_SESSION_ID`. Separate from `complete` because the link is worth most while the job is still running. |
| `POST /api/jobs/:id/suspend` | `200 { id, status: 'standby' }`. Parks a running job: the container is gone, but it is not finished, it keeps its `sessionId`, and it hands back the attempt the claim took. `409 LEASE_LOST`, `404`, `400 BAD_ID` / `BAD_TOKEN`. |
| `POST /api/jobs/:id/resume` | `200 { id, status: 'queued' }`. **Takes no lease token** — nobody holds a parked job, which is what makes this callable by a person. `409 NOT_STANDBY` for a job that exists but is not parked, `404` unknown, `400 BAD_ID`. |
| `POST /api/jobs/:id/complete` | `200`. `409 LEASE_LOST` for a report from a worker that no longer holds the job; refused, never merged. `404` unknown; `400` on a status outside `succeeded\|failed`. `output` is truncated to 64 KiB server side. |
| `GET /api/jobs/:id` | `200` the job, `404` otherwise. `createdBy` names the account that queued it, or null. `sessionId` and `remoteSessionId` are null until the driver reports them, and again from the moment the job is re-claimed for a *new* attempt — both survive a park and resume. `remoteSessionId` stays null for every headless job. |
| `GET /api/jobs` | `200 { jobs }`. `?status=&limit=` (default 50, cap 200). `output` is omitted from the list projection — it is unbounded and no list view shows it. |

- **The job routes are registered only when `buildApp` is given a job store**, like the ingest
  routes. See [jobs.md](jobs.md) for the lease and fencing-token rules behind the `409`s.


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
