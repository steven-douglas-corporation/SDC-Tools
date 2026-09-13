"use client";

import { useState } from "react";
import { TOOLBAR_BTN, TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_NEUTRAL, INPUT } from "@/components/ui/classnames";
import { useDraftParamsMenu } from "@/components/useDraftParamMenu";
import { encodeParamList } from "@/lib/quoted-display-prefs";
import { MenuStatus, MenuApplyHint, MenuGroup, MenuBulkActions, MenuCheckbox } from "@/components/MenuStatus";

// "Filters ▾" — the Projects grid's four row filters (Customer, Type, Status,
// Billable) in one bucket, replacing four separate toolbar buttons.
//
// The toolbar had twelve controls; four of them were filters that all did the
// same kind of thing to the same rows, so they belong behind one label. The
// button's badge counts how many are NARROWING (fewer selected than available),
// which is the only filter state worth surfacing at a glance — "all four
// filters exist" isn't information.
//
// Every tick applies on its own, ~250ms later — see useDraftParamsMenu. The
// menu stays open throughout, so you can watch the grid narrow as you go.

export type FilterKey = "customers" | "types" | "statuses" | "billables";

export type FilterSpec = {
  key: FilterKey;
  label: string;
  options: string[];
  selected: string[];
  // Long lists get a search box; four-option lists don't need one.
  searchable?: boolean;
};

// No remount-on-change wrapper here any more. It used to render the body under
// a key derived from the committed values, which is how the draft got reset;
// the hook resyncs itself now. With every tick applying immediately, remounting
// would rebuild the <details> on the first click and close the menu in the
// user's face — and clear the customer search box while it was at it.
export function ProjectsFilterMenu({ filters }: { filters: FilterSpec[] }) {
  const committed = Object.fromEntries(filters.map((f) => [f.key, f.selected])) as Record<FilterKey, string[]>;
  const { draft, setValues, toggleValue, dirty, pending, detailsRef, detailsProps } = useDraftParamsMenu<FilterKey>({
    committed,
    // Always set, even when empty: on this grid an absent param means "no filter
    // chosen yet, use the page default" (Active + Billable), which is NOT the
    // same as the user having cleared it.
    buildParams: (d, qs) => {
      // encodeParamList, not join(",") — see quoted-display-prefs: comma-bearing
      // customer names ("FIRST SOLAR, INC.") split back into fragments that match
      // no job, so ticking one used to empty the grid.
      for (const f of filters) qs.set(f.key, encodeParamList(d[f.key] ?? []));
    },
  });

  // Search text per filter, local to the open menu — not part of the draft.
  const [query, setQuery] = useState<Partial<Record<FilterKey, string>>>({});

  const narrowing = filters.filter((f) => (draft[f.key] ?? []).length < f.options.length).length;

  return (
    <details ref={detailsRef} {...detailsProps} className="group relative inline-block">
      <summary
        className={`${TOOLBAR_BTN} ${narrowing > 0 ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL} ${pending ? "opacity-60" : ""}`}
      >
        Filters
        {narrowing > 0 && ` (${narrowing})`}
        <MenuStatus pending={pending} />
      </summary>
      {/* motion-menu-panel (§36.5): opacity + a 3px rise, no height animation — so this
          menu opens at the same speed whether it holds four customers or two hundred.
          It plays on OPEN only: the panel element is updated in place when a box is
          ticked, never remounted (which is what useDraftParamsMenu exists to guarantee),
          so the animation cannot replay mid-selection and the internal scroll position
          survives. */}
      <div className="motion-menu-panel styled-scrollbar absolute left-0 top-full z-30 mt-2 max-h-[calc(var(--app-vh)_*_0.7)] w-64 overflow-y-auto rounded-lg border border-sdc-border bg-white p-2 shadow-lg">
        {filters.map((f) => {
          const sel = draft[f.key] ?? [];
          const q = (query[f.key] ?? "").trim().toLowerCase();
          const shown = q ? f.options.filter((o) => o.toLowerCase().includes(q)) : f.options;
          return (
            <MenuGroup
              key={f.key}
              label={f.label}
              count={`${sel.length}/${f.options.length}`}
              // Every group open — MenuGroup's default. This used to open only
              // the filters that were actively narrowing, which hid the rest.
            >
              {f.searchable && f.options.length > 8 && (
                <input
                  type="search"
                  value={query[f.key] ?? ""}
                  onChange={(e) => setQuery((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={`Search ${f.label.toLowerCase()}…`}
                  className={`${INPUT} mb-1 w-full text-xs`}
                />
              )}
              <MenuBulkActions
                // Select all / Clear act on the FULL option list, not the
                // search-filtered view — "Clear" that only cleared what you'd
                // typed would be a trap.
                onAll={() => setValues(f.key, [...f.options])}
                onNone={() => setValues(f.key, [])}
              />
              <div className="max-h-56 overflow-y-auto styled-scrollbar">
                {shown.map((opt) => (
                  <MenuCheckbox
                    key={opt}
                    label={opt}
                    checked={sel.includes(opt)}
                    onChange={() => toggleValue(f.key, opt)}
                  />
                ))}
                {shown.length === 0 && <p className="px-1.5 py-1 text-xs text-sdc-gray-400">No matches</p>}
              </div>
            </MenuGroup>
          );
        })}
        <MenuApplyHint dirty={dirty} />
      </div>
    </details>
  );
}
