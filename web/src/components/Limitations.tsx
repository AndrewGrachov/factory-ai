/**
 * SPEC §4 requires this copy to live on the page, not only in the spec: without it the
 * numbers above read as more complete than they are.
 */
export function Limitations() {
    return (
        <section className="panel">
            <h2>What this cannot tell you</h2>
            <ul className="limits">
                <li>
                    <strong>
                        The token and line counts are what the agent wrote, not what survived to
                        merge.
                    </strong>{' '}
                    Claude Code telemetry carries no commit SHA, no PR number and no branch, so
                    nothing here can say "340 of PR #123's lines are AI-written". The honest reading
                    is "written during sessions attributed to this branch".
                </li>
                <li>
                    Attribution rests on a hook that samples the current branch roughly every 20
                    seconds and is allowed to fail silently. A branch held for less than one interval
                    can be missed, and a session that held several branches is marked{' '}
                    <em>shared</em> and contributes no per-PR figure at all.
                </li>
                <li>
                    AI usage only covers sessions after the plugin was installed, on machines that
                    have it. A PR showing no usage is not a PR written without AI.
                </li>
                <li>
                    No monetary cost, deliberately. Prices and cache discounts change, and a dollar
                    figure would imply precision this attribution cannot support.
                </li>
                <li>
                    The four token types are never summed into one number — a long cached
                    conversation would count the same context repeatedly — and the counts include
                    work that was rejected, undone or abandoned.
                </li>
                <li>
                    No AI-vs-human share of the diff. There are no{' '}
                    <code>Co-Authored-By: Claude</code> trailers on <code>dev</code>, and the AI
                    pipeline labels only cover a fraction of PRs, while most code here is AI-written
                    locally. Any "AI share" number would be invented.
                </li>
                <li>
                    Review latency is distorted: the bot reviews within minutes, so
                    time-to-first-review is only meaningful in its human-only form.
                </li>
                <li>
                    "Unresolved thread" is partly a UI-click artifact, not purely a quality signal.
                </li>
                <li>
                    Work before the first push is invisible, and squashes or force-pushes erase
                    commit history that these numbers are derived from.
                </li>
                <li>
                    Reverts undercount defects — fix-forward is the norm here — and nothing here
                    measures production incidents.
                </li>
                <li>n is small. Weekly points are noisy and a single large PR moves a median.</li>
                <li>
                    <code>additions</code> / <code>deletions</code> include lockfiles, translations
                    and generated code.
                </li>
                <li>Nothing here says whether the shipped work was the right work.</li>
            </ul>
        </section>
    );
}
