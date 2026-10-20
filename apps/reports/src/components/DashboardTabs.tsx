"use client";

import { startTransition, useOptimistic, type ReactNode } from "react";
import { usePaneUrl } from "@/components/PaneUrlProvider";
import { nextParams, notePendingParams } from "@/lib/url-params";

// Two tabs on the Dashboard: Executive, the overview it has always shown, and
// Finances, a set of cards that each link to the page that owns the figure.
//
// Only rendered for a role that can see at least one Finances card; everyone else
// gets the Executive content with no tab strip at all (see (app)/page.tsx).
//
// Executive is server output handed in and kept mounted under `hidden`, so switching
// back to it is instant. Finances is NOT: the server builds it only when the URL says
// `?tab=finances`, so it costs the landing view nothing and is never in the page for
// someone who has not opened it. That is also why the tab is a URL param rather than
// local state.
export function DashboardTabs({
  executive,
  finances,
}: {
  executive: ReactNode;
  /** Null until the URL says the Finances tab is open — the server renders it on demand. */
  finances: ReactNode | null;
}) {
  // Pane-aware (2026-09-14): the Dashboard tab's own params, wherever it is rendered.
  const url = usePaneUrl();
  const urlTab = url.searchParams.get("tab") === "finances" ? "finances" : "executive";
  // The Finances tab is a server round trip (nothing is queried until the URL says so),
  // and the URL does not change until it lands. Until then the click used to look like
  // it did nothing, so people clicked again. The optimistic value flips the tab at once
  // and snaps back to the URL's own when the navigation settles — no state to go stale.
  const [tab, setOptimisticTab] = useOptimistic<"executive" | "finances", "executive" | "finances">(urlTab, (_, next) => next);
  const loading = tab === "finances" && urlTab !== "finances";

  function setTab(next: "executive" | "finances") {
    // A repeat click on the tab already shown (or already loading) has nothing to add.
    if (next === tab) return;
    // See lib/url-params.ts: useSearchParams still reports the pre-navigation
    // value while a change is in flight, so building straight from it can
    // silently revert whatever was set a moment ago (the month, mostly).
    const currentQs = url.searchKey;
    const qs = nextParams(currentQs);
    if (next === "finances") qs.set("tab", "finances");
    else qs.delete("tab");
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

  return (
    <>
      <div className="mb-6 flex items-center gap-1 border-b border-sdc-border" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "executive"} onClick={() => setTab("executive")} className={tabClass(tab === "executive")}>
          Executive
        </button>
        <button type="button" role="tab" aria-selected={tab === "finances"} onClick={() => setTab("finances")} className={tabClass(tab === "finances")}>
          Finances
        </button>
      </div>
      <div role="tabpanel" hidden={tab !== "executive"}>
        {executive}
      </div>
      <div role="tabpanel" hidden={tab !== "finances"}>
        {loading ? (
          <p role="status" className="py-10 text-center text-sm text-sdc-muted">
            Loading Finances…
          </p>
        ) : (
          finances
        )}
      </div>
    </>
  );
}
