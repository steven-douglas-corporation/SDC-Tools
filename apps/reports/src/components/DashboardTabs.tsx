"use client";

import { type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { nextParams, notePendingParams } from "@/lib/url-params";

// Two tabs on the Dashboard: the overview it has always shown, and the Data
// Quality page ported from the Power BI report.
//
// Both panels are server-rendered and handed in as children — this component
// only decides which one is on screen, so nothing about the dashboard's queries
// moves to the browser. The hidden panel stays mounted rather than being
// unmounted, so switching back is instant and the page doesn't refetch.
export function DashboardTabs({
  overview,
  dataQuality,
  issueCount,
}: {
  overview: ReactNode;
  dataQuality: ReactNode;
  // Total open data-quality findings — shown as a badge, because the whole
  // point of a second tab is that nobody visits it unless something says to.
  issueCount: number;
}) {
  // The tab is a URL param, not local state. Two reasons: the Data Quality
  // panel's own slicers navigate, and they must not knock you back to Overview;
  // and the server needs to know which tab is open so it can skip the explorer's
  // whole-window punch scan when it isn't.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab") === "quality" ? "quality" : "overview";

  function setTab(next: "overview" | "quality") {
    // See lib/url-params.ts: useSearchParams still reports the pre-navigation
    // value while a change is in flight, so building straight from it can
    // silently revert whatever was set a moment ago.
    const currentQs = searchParams.toString();
    const qs = nextParams(currentQs);
    if (next === "quality") qs.set("tab", "quality");
    else for (const k of ["tab", "dqFrom", "dqTo", "dqEmp", "dqFn", "dqMtd"]) qs.delete(k);
    const q = qs.toString();
    notePendingParams(currentQs, q);
    router.push(q ? `${pathname}?${q}` : pathname, { scroll: false });
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
        <button type="button" role="tab" aria-selected={tab === "overview"} onClick={() => setTab("overview")} className={tabClass(tab === "overview")}>
          Overview
        </button>
        <button type="button" role="tab" aria-selected={tab === "quality"} onClick={() => setTab("quality")} className={tabClass(tab === "quality")}>
          Data Quality
          {issueCount > 0 && (
            <span className="ml-2 rounded-full bg-sdc-red px-1.5 py-0.5 text-label font-bold text-white tabular-nums">{issueCount}</span>
          )}
        </button>
      </div>
      {/* `hidden` rather than a conditional render: the panels are server output,
          so keeping both mounted costs nothing and makes the switch instant. */}
      <div role="tabpanel" hidden={tab !== "overview"}>
        {overview}
      </div>
      <div role="tabpanel" hidden={tab !== "quality"}>
        {dataQuality}
      </div>
    </>
  );
}
