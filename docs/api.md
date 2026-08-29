# API

Read before: adding or changing a route, a status code, or a query parameter.

| Route | Behaviour |
| --- | --- |
| `GET /api/health` | Never calls GitHub or the database. A container whose migrations are still retrying is up and answering, so probing either here would fail the compose healthcheck and restart the container that was about to succeed. |
| `GET /api/stats` | `200` with `{ stats, telemetry, meta }`; `202` with progress while a cold fetch runs (SPA polls every 2s); `503` only if the first PR fetch failed **and** nothing is persisted. A cold boot with a warm database is a 200 because the seed landed — but both other codes stay reachable and deleting either is a regression. `telemetry` is `null` when unavailable, and `meta.persistence` degrades in three states (`ok` / `migrating` / `unavailable` — there is no `off`); neither is ever a reason for a non-200. `?range=day\|week\|2w\|month\|all\|custom` (default `all`), plus `?from=&to=` for `custom`; `400 BAD_RANGE` on anything unparseable, never a silent fallback to all time. `?org=` is accepted and `400 UNKNOWN_ORG` on a mismatch — see below. |
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
