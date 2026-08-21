/**
 * SPEC §4 requires this copy to live on the page, not only in the spec: without it the
 * numbers above read as more complete than they are.
 */
export function Limitations() {
    return (
        <section className="panel">
            <h2>What this cannot tell you</h2>
            <ul className="limits">
                <li>Nothing about token or API cost, or wall-clock time spent in an AI session.</li>
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
