---
name: github
description: Work with GitHub through the gh CLI — opening pull requests, reading PR reviews and line comments, checking CI status, and replying to review feedback. Use whenever a GitHub URL, PR number or issue is mentioned, after pushing a branch, or when asked to address review comments. Covers the reply-with-what-changed convention.
---

# GitHub through gh

Use `gh` for all GitHub work — issues, PRs, checks, releases. Given a GitHub URL, fetch it with
`gh` rather than guessing at the content or scraping the page.

```bash
gh pr view <N> --repo <owner/repo> --comments --json comments,reviews
gh api repos/<owner/repo>/pulls/<N>/comments   # line-level review comments
gh pr status
gh pr checks <N>
gh pr diff <N>
gh pr checkout <N>
```

## Opening a pull request

After pushing a feature branch, open the PR without waiting to be asked.

Before writing the body, read **every** commit on the branch — `git diff <base>...HEAD` and
`git log <base>..HEAD`, not just the last commit. Keep the title under 70 characters; detail
belongs in the body.

```bash
gh pr create --title "Short title" --body "$(cat <<'EOF'
## Summary
<what changed and why>

## Test plan
- [ ] ...
EOF
)"
```

State what was verified and what was not. An unchecked box is information; a checked box that was
never run is a lie the reviewer will act on.

## Addressing review feedback

**Read the review summary on the PR itself, not only the line comments.** The substantive
objection often lives in the summary while the line comments are details.

After pushing fixes, reply to each comment you addressed. Every reply must say *what changed and
how* — "fixed in `<sha>`" alone is useless to a reviewer:

```bash
gh pr comment <N> --body "Fixed in <sha> — clamped limit to MAX_LIMIT=100 in the validator before
the DB query, so an oversized page can no longer reach Postgres"
```

That lets the reviewer verify without re-reading the diff, and keeps the thread an accurate record
of what is still open.
