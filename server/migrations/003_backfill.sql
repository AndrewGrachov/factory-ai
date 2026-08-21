-- Backfill from Claude Code session transcripts (~/.claude/projects/*/*.jsonl).
--
-- Transcripts carry more than the OTEL export does: `gitBranch` on every record, and a
-- `pr-link` record with an actual `prNumber`. That makes them both a historical source and a
-- strictly better join key — no branch reuse ambiguity, no time-window heuristic.

-- Which pipeline a datapoint came from. The default keeps every existing row as 'otel'.
--
-- This exists to stop double-counting: a session that ran while OTEL was enabled AND has a
-- transcript on disk would otherwise be counted twice, silently doubling its tokens. The
-- views pick exactly one source per session — see session_source.
alter table metric_point add column if not exists source text not null default 'otel';

-- The dedup index has to include source, or importing a transcript for a session OTEL already
-- covered would collide on the unique key instead of being stored and then filtered.
drop index if exists metric_point_dedup;
create unique index if not exists metric_point_dedup
    on metric_point (metric, session_id, time, source, md5(attrs::text));

-- A session's direct PR association, straight from the transcript's pr-link records.
-- Recorded when Claude Code itself opened the PR, so it is absent for hand-made PRs — branch
-- matching stays the fallback rather than being replaced.
create table if not exists session_pr (
    agent      text        not null default 'claude-code',
    session_id text        not null,
    repo       text        not null,
    pr_number  integer     not null,
    first_seen timestamptz not null,
    primary key (agent, session_id, repo, pr_number)
);

create index if not exists session_pr_repo on session_pr (repo, pr_number);
