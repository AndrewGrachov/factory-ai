import type { OrganizationMeta } from '@factory-ai/core';

/**
 * The organization these figures belong to.
 *
 * One organization and no accounts yet, so the control is real but inert: a native
 * `<select disabled>` rather than a plain label, because the day a second organization exists the
 * only changes here are that `disabled` goes false and an `onChange` arrives. A label would have to
 * be replaced instead — and the upper-right slot would move on that day, in front of everyone who
 * had already learned where it was, rather than on this one.
 *
 * `available` drives the options in both modes, so there is no mode-specific branch in the markup;
 * in config mode the server sends a one-element list equal to `current`.
 */
export function OrgSelector({ organization }: { organization: OrganizationMeta }) {
    // Keyed on `mode`, never on `available.length < 2`. A directory user who belongs to one
    // organization today can be granted a second tomorrow with no deploy; disabling by list length
    // would be right today by accident and silently wrong then.
    const locked = organization.mode === 'config';

    // WHY it is inactive, not merely that it is. A disabled control with no explanation reads as a
    // bug or as a permissions problem; this says it is a property of the deployment.
    const reason = locked
        ? 'This deployment reports on one organization, set by ORG_ID. Switching becomes available when accounts can belong to more than one.'
        : 'Switch organization';

    return (
        // The title sits on the wrapper, not on the <select>: a disabled form control receives no
        // mouse events in Chrome or Firefox, so a title on the element itself never shows.
        <label className="org-selector" title={reason}>
            <span className="muted">org</span>
            <select
                className="org-select"
                value={organization.current.id}
                // Also what suppresses React's "value without onChange" warning — the controlled
                // -value check passes on `disabled` as well as on `readOnly` — so this needs no
                // no-op handler.
                disabled={locked}
                aria-label={`Organization: ${organization.current.name}`}
            >
                {organization.available.map((org) => (
                    <option key={org.id} value={org.id}>
                        {org.name}
                    </option>
                ))}
            </select>
        </label>
    );
}
