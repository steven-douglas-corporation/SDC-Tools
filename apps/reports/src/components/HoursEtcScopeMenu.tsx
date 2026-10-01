"use client";

import { TOOLBAR_BTN, TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_NEUTRAL, INPUT, BUTTON_MENU_LINK } from "@/components/ui/classnames";
import { useDraftParamsMenu } from "@/components/useDraftParamMenu";
import { MenuStatus, MenuApplyHint } from "@/components/MenuStatus";

// "Match Monthly ETC ▾" — narrows the Hours tab to exactly the punches Monthly ETC
// counts as Hours Worked for one month (lib/hours-etc-scope-rules.ts), and turns on
// the panel that itemises what that leaves out. One param, `etcMonth`.

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

// Local calendar, not toISOString() — see HoursDateFilter's note on the UTC shift.
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function HoursEtcScopeMenu({ etcMonth, from }: { etcMonth: string; from: string }) {
  const { draft, setValues, dirty, pending, detailsRef, detailsProps } = useDraftParamsMenu<"etcMonth">({
    committed: { etcMonth: etcMonth ? [etcMonth] : [] },
    buildParams: (d, qs) => {
      const m = d.etcMonth[0] ?? "";
      if (m) qs.set("etcMonth", m);
      else qs.delete("etcMonth");
      qs.delete("page");
    },
  });

  const draftMonth = draft.etcMonth[0] ?? "";
  const active = Boolean(etcMonth);
  // Turning it on starts from the month the Dates filter already points at, so
  // "Sep 1 – Sep 30" plus this button compares September without a second pick.
  const suggested = /^\d{4}-\d{2}/.test(from) ? from.slice(0, 7) : currentMonth();

  return (
    <details ref={detailsRef} {...detailsProps} className="group relative inline-block">
      <summary className={`${TOOLBAR_BTN} ${active ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL} ${pending ? "opacity-60" : ""}`}>
        {active ? `Monthly ETC: ${monthLabel(etcMonth).replace(/^(\w{3})\w*/, "$1")}` : "Match Monthly ETC"}
        <MenuStatus pending={pending} />
      </summary>
      <div className="motion-menu-panel absolute right-0 left-auto top-full z-30 mt-2 w-72 rounded-lg border border-sdc-border bg-white p-3 shadow-lg">
        <p className="text-note text-sdc-gray-600">
          Show only the hours Monthly ETC counts as <strong>Hours Worked</strong>: the jobs its grid lists for the month, on the section
          codes it has columns for. A panel lists everything left out, and why.
        </p>
        <label className="mt-2.5 flex items-center gap-2">
          <span className="text-note text-sdc-gray-600">Month</span>
          <input
            key={`m:${draftMonth}`}
            type="month"
            defaultValue={draftMonth}
            onChange={(e) => {
              if (/^\d{4}-\d{2}$/.test(e.target.value)) setValues("etcMonth", [e.target.value]);
            }}
            className={`${INPUT} w-full text-xs`}
            aria-label="Monthly ETC month"
          />
        </label>
        <div className="mt-2.5 flex flex-wrap gap-1 border-t border-sdc-border-soft pt-2">
          {!draftMonth && (
            <button type="button" onClick={() => setValues("etcMonth", [suggested])} className={BUTTON_MENU_LINK}>
              Match {monthLabel(suggested)}
            </button>
          )}
          <button type="button" onClick={() => setValues("etcMonth", [])} disabled={!draftMonth} className={BUTTON_MENU_LINK}>
            Off
          </button>
        </div>
        <MenuApplyHint dirty={dirty} />
      </div>
    </details>
  );
}
