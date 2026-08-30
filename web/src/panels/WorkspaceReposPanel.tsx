import type { Stats } from '@factory-ai/core';
import type { WorkspaceRepo } from '../api/useWorkspace.js';
import { RepoStatus } from '../components/RepoStatus.js';
import { bytes, commitDate, duration, num } from '../format.js';
import { repoMetrics } from '../workspace/join.js';

/**
 * One row per selected repository: what is on disk, and what the dashboard measured for it.
 *
 * Every cell that could be absent renders an em dash rather than a zero. Three different things
 * produce one, and they are not interchangeable — see `repoMetrics`.
 */
export function WorkspaceReposPanel({
    repos,
    measured,
    stats,
}: {
    repos: readonly WorkspaceRepo[];
    measured: readonly { owner: string; name: string }[];
    stats: Stats | null;
}) {
    return (
        <section className="panel">
            <h2>Repositories</h2>
            <table className="table">
                <thead>
                    <tr>
                        <th>Repository</th>
                        <th>Status</th>
                        <th>Branch</th>
                        <th>Last commit</th>
                        <th className="right">Size</th>
                        <th className="right">Merged PRs</th>
                        <th className="right">Median cycle</th>
                        <th className="right">Median size</th>
                    </tr>
                </thead>
                <tbody>
                    {repos.map((repo) => {
                        const metrics = repoMetrics({
                            owner: repo.owner,
                            name: repo.name,
                            measured,
                            stats,
                        });
                        return (
                            <tr key={`${repo.owner}/${repo.name}`}>
                                <td>
                                    {repo.owner}/{repo.name}
                                </td>
                                <td>
                                    <RepoStatus status={repo.status} error={repo.error} />
                                </td>
                                <td>{repo.branch ?? '—'}</td>
                                <td title={repo.lastCommit?.headline ?? ''}>
                                    {commitDate(repo.lastCommit?.at)}
                                </td>
                                <td className="right">{bytes(repo.sizeBytes)}</td>
                                {metrics.unavailable ? (
                                    // One cell spanning the three metric columns, carrying the
                                    // reason. Three separate dashes would look like three measured
                                    // absences rather than one thing that was never measured.
                                    <td className="right muted" colSpan={3}>
                                        {metrics.unavailable}
                                    </td>
                                ) : (
                                    <>
                                        <td className="right">{num(metrics.mergedWithCycle, 0)}</td>
                                        <td className="right">{duration(metrics.medianCycleHours)}</td>
                                        <td className="right">{num(metrics.medianSize, 0)}</td>
                                    </>
                                )}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
            <p className="muted">
                Merged PRs counts pull requests with a measured cycle time in the selected range, for
                repositories the dashboard reports on.
            </p>
        </section>
    );
}
