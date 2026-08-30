import { useMemo, useState } from 'react';
import { Outlet, useOutletContext } from 'react-router-dom';
import { useStats } from '../api/useStats.js';
import type { StatsPayload, FetchState } from '../api/useStats.js';
import { DEFAULT_RANGE, rangeQuery } from './RangeSelector.js';
import type { RangeSelection } from './RangeSelector.js';
import { SideNav } from './SideNav.js';
import { TopBar } from './TopBar.js';

/**
 * Everything both pages share: the range, the one `/api/stats` poll, and the chrome around them.
 *
 * The poll lives HERE rather than in the dashboard page because the Workspace page needs the same
 * payload — it joins each checkout to that repo's pull-request figures — and two pages each running
 * `useStats` would be two polls of the same endpoint every two seconds.
 */
export interface ShellContext {
    data: StatsPayload | null;
    range: RangeSelection;
    setRange: (range: RangeSelection) => void;
    refreshing: boolean;
    progress: FetchState | null;
    error: string | null;
    refresh: () => void;
}

/** Typed access to what the layout route publishes. */
export function useShell(): ShellContext {
    return useOutletContext<ShellContext>();
}

export function AppShell() {
    // The range is state because it is an INPUT the user changes and that must ride the next
    // request. The organization is not: with one config-defined org it is server-reported identity,
    // read straight off `meta`, so a useState here would need a value before the first payload
    // exists and would have to be reconciled against every response — two sources of truth for one
    // value. When the org becomes an input its state moves up to here too:
    //
    //     const [org, setOrg] = useState<string | null>(null);   // null = the server's default
    //     const query = useMemo(
    //         () => (org ? `${rangeQuery(range)}&org=${org}` : rangeQuery(range)),
    //         [range, org],
    //     );
    //
    // useStats keys on the query string, so that re-polls with no change to the hook.
    //
    // This block used to live in App.tsx and predicted that "when accounts arrive the org becomes an
    // input and the state moves up to here". Accounts arrived, and what moved up was the range —
    // into this layout route, which is the new "here".
    const [range, setRange] = useState<RangeSelection>(DEFAULT_RANGE);
    const query = useMemo(() => rangeQuery(range), [range]);
    const { data, refreshing, progress, error, refresh } = useStats(query);

    const context: ShellContext = { data, range, setRange, refreshing, progress, error, refresh };

    return (
        <div className="shell">
            <SideNav />
            <div className="shell-main">
                <TopBar data={data} refreshing={refreshing} onRefresh={refresh} />
                <Outlet context={context} />
            </div>
        </div>
    );
}
