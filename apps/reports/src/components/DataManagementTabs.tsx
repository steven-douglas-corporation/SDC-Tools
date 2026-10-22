"use client";

import { startTransition, useId, useOptimistic, type ReactNode } from "react";
import { usePaneUrl } from "@/components/PaneUrlProvider";
import {
  DATA_MANAGEMENT_TABS,
  DEFAULT_DATA_MANAGEMENT_TAB,
  dataManagementTab,
  type DataManagementTabId,
} from "@/lib/data-management-tabs";
import { nextParams, notePendingParams } from "@/lib/url-params";

// The tab strip for Data Management (the tabs are listed in lib/data-management-tabs.ts).
//
// `children` is ONLY the open tab. The server builds it from `?tab=` (see
// app/(app)/admin/data-management/page.tsx), so a tab nobody has opened costs nothing — the
// Job punches tab in particular reads every punch — which is also why a tab switch
// is a server round trip and the open tab is a URL param rather than local state.
//
// The click flips the strip at once and shows a loading line until the navigation
// lands, the same way the Dashboard's Finances tab does: the URL does not change
// until the server is done, and a click that appears to do nothing gets clicked
// again. The optimistic value snaps back to the URL's own when the navigation
// settles, so there is no state here to go stale.
//
// Pane-aware through usePaneUrl: in a split view or a workspace tab this reads and
// writes THIS pane's `tab`, never its neighbour's.
export function DataManagementTabs({ children }: { children: ReactNode }) {
  const url = usePaneUrl();
  const urlTab = dataManagementTab(url.searchParams.get("tab"));
  const [tab, setOptimisticTab] = useOptimistic<DataManagementTabId, DataManagementTabId>(urlTab, (_, next) => next);
  // Two panes can both be Data Management, so the aria ids cannot be fixed strings.
  const uid = useId();

  function setTab(next: DataManagementTabId) {
    // A repeat click on the tab already shown (or already loading) has nothing to add.
    if (next === tab) return;
    // See lib/url-params.ts: useSearchParams still reports the pre-navigation value
    // while a change is in flight, so building straight from it can silently revert
    // whatever was set a moment ago (the month, mostly).
    const currentQs = url.searchKey;
    const qs = nextParams(currentQs);
    // The default tab writes no param. The other tabs' own params (the month, the
    // punch explorer's filters) are left alone, so coming back to a tab finds it as
    // it was left.
    if (next === DEFAULT_DATA_MANAGEMENT_TAB) qs.delete("tab");
    else qs.set("tab", next);
    const q = qs.toString();
    notePendingParams(currentQs, q);
    startTransition(() => {
      setOptimisticTab(next);
      url.push(qs, { scroll: false });
    });
  }

  const tabClass = (active: boolean) =>
    `relative -mb-px border-b-2 px-4 py-2.5 text-sm font-semibold motion-interactive ${
      active
        ? "border-sdc-blue text-sdc-blue-dark"
        : "border-transparent text-sdc-muted hover:border-sdc-border hover:text-sdc-navy"
    }`;

  const loading = tab !== urlTab;
  const shownLabel = DATA_MANAGEMENT_TABS.find((t) => t.id === tab)?.label ?? "";

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-1 border-b border-sdc-border" role="tablist">
        {DATA_MANAGEMENT_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${uid}-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${uid}-panel`}
            onClick={() => setTab(t.id)}
            className={tabClass(tab === t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-${tab}`}>
        {loading ? (
          <p role="status" className="py-10 text-center text-sm text-sdc-muted">
            Loading {shownLabel}…
          </p>
        ) : (
          children
        )}
      </div>
    </>
  );
}
