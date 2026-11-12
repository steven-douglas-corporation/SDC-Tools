"use client";

import { usePaneUrl } from "@/components/PaneUrlProvider";

// Cutoff for the Cash Flow "Left to Invoice Split": today (live, the default) or the end of a
// chosen month. Lives in the page's own `lti` param — pane-aware, so it works on the plain page,
// in a workspace tab and in a split pane — and the server re-reads the split for it.
// No `lti` = today. A native month input yields `YYYY-MM`, the one shape the server accepts.

export function LeftToInvoiceCutoffPicker({ month }: { month: string | null }) {
  const url = usePaneUrl();

  function set(value: string | null) {
    const qs = new URLSearchParams(url.searchKey);
    if (value) qs.set("lti", value);
    else qs.delete("lti");
    url.push(qs, { scroll: false });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs text-sdc-gray-600">
      <span className="font-semibold text-sdc-navy">Calculate as of</span>
      <button
        type="button"
        onClick={() => set(null)}
        aria-pressed={month === null}
        className={`rounded border px-2 py-1 ${month === null ? "border-sdc-navy bg-sdc-navy text-white" : "border-sdc-border bg-white text-sdc-navy hover:bg-sdc-blue-light/40"}`}
      >
        Today (live)
      </button>
      <label className="flex items-center gap-1.5">
        <span>or month end</span>
        <input
          type="month"
          value={month ?? ""}
          onChange={(e) => set(/^\d{4}-(0[1-9]|1[0-2])$/.test(e.target.value) ? e.target.value : null)}
          className={`rounded border px-2 py-1 text-sdc-navy ${month ? "border-sdc-navy" : "border-sdc-border"}`}
        />
      </label>
    </div>
  );
}
