# Date range

Read before: touching `filterPrs()`, `parseRange`, `revertForRange()`, the range selector, or
`BarChart`.

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
