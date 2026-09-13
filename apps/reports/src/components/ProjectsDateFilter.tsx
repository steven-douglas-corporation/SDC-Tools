"use client";

import { TOOLBAR_BTN, TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_NEUTRAL, INPUT } from "@/components/ui/classnames";
import { useDraftParamsMenu } from "@/components/useDraftParamMenu";
import { MenuStatus, MenuApplyHint } from "@/components/MenuStatus";

// "Dates ▾" — filter the Projects grid to jobs whose Start Date or Complete
// Date falls in a range.
//
// Its own button rather than a fifth entry in "Filters", which is built around
// pick-from-a-list values: every control in there is a checkbox over a known
// option set, and a date range is neither. Folding it in would have meant
// teaching that menu a second shape for one filter.
//
// Applies as you go, like the other menus (useDraftParamsMenu). The hook is
// generic over string[] per param — a date is just a one-element list here,
// empty meaning "not set".
//
// Slower debounce than the checkbox menus, though: a date is TYPED, and a
// half-typed year is a complete, valid, wildly wrong date as far as the input is
// concerned (type "2026" a digit at a time and it reports 0002 on the way). The
// checkbox menus only ever coalesce deliberate clicks, so 250ms is plenty there;
// here it wants to be past the gap between keystrokes.
//
// One field at a time, deliberately: "started after X AND completed before Y"
// reads like a useful question but is a different filter (a duration), and
// offering two independent ranges in a 220px dropdown invites people to set
// half of each by accident.

export type DateFilterField = "start" | "complete";
type Key = "dateField" | "from" | "to";

const FIELD_LABEL: Record<DateFilterField, string> = {
  start: "Start Date",
  complete: "Complete Date",
};

export function ProjectsDateFilter({
  field,
  from,
  to,
}: {
  field: DateFilterField;
  from: string; // "YYYY-MM-DD", "" when unset
  to: string;
}) {
  // No remount wrapper — the hook resyncs its own draft, and remounting would
  // close the menu the moment a date applied. See useDraftParamMenu.
  const committed: Record<Key, string[]> = {
    dateField: [field],
    from: from ? [from] : [],
    to: to ? [to] : [],
  };

  const { draft, setValues, dirty, pending, detailsRef, detailsProps } = useDraftParamsMenu<Key>({
    committed,
    debounceMs: 700,
    buildParams: (d, qs) => {
      const f = d.from[0] ?? "";
      const t = d.to[0] ?? "";
      // Delete rather than set-empty: with no range there is no filter, and a
      // trailing `&from=&to=` would ride along into every saved view and shared
      // link for no reason.
      if (f) qs.set("from", f);
      else qs.delete("from");
      if (t) qs.set("to", t);
      else qs.delete("to");
      // Written whenever it isn't the "start" default, even with no range set
      // yet. It used to also require a bound, on the grounds that the field
      // means nothing without one — true of the QUERY, but it made the param a
      // one-way trip: pick Complete Date first (the natural order — choose the
      // column, then the range) and the value was dropped on the way out, so
      // the server kept answering "start", the draft never matched what came
      // back, and the menu sat on "Applying…" forever. Harmless in the URL: the
      // page only builds a date filter when there's actually a bound.
      const fieldValue = d.dateField[0] ?? "start";
      if (fieldValue !== "start") qs.set("dateField", fieldValue);
      else qs.delete("dateField");
    },
  });

  const draftField = (draft.dateField[0] ?? "start") as DateFilterField;
  const draftFrom = draft.from[0] ?? "";
  const draftTo = draft.to[0] ?? "";
  const active = Boolean(from || to);
  // A range typed backwards returns nothing and looks like a broken grid, so
  // say so in the menu instead of letting them close it and wonder.
  const backwards = Boolean(draftFrom && draftTo && draftFrom > draftTo);

  return (
    <details ref={detailsRef} {...detailsProps} className="group relative inline-block">
      <summary className={`${TOOLBAR_BTN} ${active ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL} ${pending ? "opacity-60" : ""}`}>
        Dates
        {active && ` (${FIELD_LABEL[field].replace(" Date", "")})`}
        <MenuStatus pending={pending} />
      </summary>
      <div className="motion-menu-panel absolute left-0 top-full z-30 mt-2 w-60 rounded-lg border border-sdc-border bg-white p-2.5 shadow-lg">
        <p className="mb-1.5 text-note font-semibold uppercase tracking-wide text-sdc-gray-600">Filter on</p>
        <div className="mb-2.5 flex gap-1">
          {(Object.keys(FIELD_LABEL) as DateFilterField[]).map((f) => (
            <button
              // type="button" — this sits inside the grid's <form>
              // (QuotedSaveForm wraps the whole page) and a submit here would
              // fire a save.
              type="button"
              key={f}
              onClick={() => setValues("dateField", [f])}
              aria-pressed={draftField === f}
              className={`flex-1 rounded-md border px-2 py-1 text-note font-medium motion-interactive ${
                draftField === f
                  ? "border-sdc-blue bg-sdc-blue-light text-sdc-blue-dark"
                  : "border-sdc-border bg-white text-sdc-navy hover:bg-sdc-blue-light"
              }`}
            >
              {FIELD_LABEL[f]}
            </button>
          ))}
        </div>

        <label className="mb-1.5 flex items-center justify-between gap-2 text-note text-sdc-gray-600">
          From
          <input
            type="date"
            value={draftFrom}
            onChange={(e) => setValues("from", e.target.value ? [e.target.value] : [])}
            className={`${INPUT} w-36 text-xs`}
            aria-label={`${FIELD_LABEL[draftField]} from`}
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-note text-sdc-gray-600">
          To
          <input
            type="date"
            value={draftTo}
            onChange={(e) => setValues("to", e.target.value ? [e.target.value] : [])}
            className={`${INPUT} w-36 text-xs`}
            aria-label={`${FIELD_LABEL[draftField]} to`}
          />
        </label>

        {backwards && <p className="mt-2 text-note font-medium text-sdc-red-text">&quot;From&quot; is after &quot;To&quot; — no job can match.</p>}

        <div className="mt-2.5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              setValues("from", []);
              setValues("to", []);
            }}
            disabled={!draftFrom && !draftTo}
            className="rounded px-1.5 py-0.5 text-note font-medium text-sdc-blue hover:bg-sdc-blue-light disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear
          </button>
          <MenuApplyHint dirty={dirty} />
        </div>
        {/* Jobs with no date in the chosen field can't satisfy a range, so they
            drop out. Said here because "50 jobs" quietly becoming 31 with no
            explanation is how people conclude the grid is broken. */}
        <p className="mt-2 text-label leading-relaxed text-sdc-gray-400">
          Jobs with no {FIELD_LABEL[draftField].toLowerCase()} are hidden while a range is set.
        </p>
      </div>
    </details>
  );
}
