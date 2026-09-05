# Agent guide

Global instructions for every run in this image. Behavioural guidelines that reduce common LLM
coding mistakes; project-level `AGENTS.md` / `CLAUDE.md` files in the mounted checkout take
precedence over anything here.

**Tradeoff:** these guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think before coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask in the final message.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.

## 2. Simplicity first

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what the task asked for.
- No abstractions for single-use code.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

## 3. Surgical changes

**Touch only what the task requires. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match the existing style of the file, even if you'd do it differently.
- Every changed line should trace back to the task.

## 4. Finish with a report

You run headless — nobody watches the terminal. The final message is the only thing a human reads:
state what you changed, what you verified, and anything you could not do.

## Tooling

- Reach for `gh` for GitHub (pull requests, reviews, checks) rather than raw API calls.
- Reach for `acli` for Jira work items rather than improvising HTTP against Atlassian.
- Both start unauthenticated; they read credentials from the environment or config the caller
  provides. If a credential is missing, say so instead of working around it.
