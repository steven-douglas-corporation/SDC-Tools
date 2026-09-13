"use client";

import { useState } from "react";
import { TOOLBAR_BTN, TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_NEUTRAL, INPUT } from "@/components/ui/classnames";
import { useDraftParamsMenu } from "@/components/useDraftParamMenu";
import { MenuStatus, MenuApplyHint, MenuGroup, MenuBulkActions, MenuCheckbox } from "@/components/MenuStatus";

// "Filters ▾" for the Hours tab — Job / Employee / Function-Section / Department in one
// bucket, applying to the URL as you go (useDraftParamsMenu — see its own header for why
// a lone tick navigates immediately and a burst debounces).
//
// Structurally mirrors ProjectsFilterMenu.tsx, which this doesn't reuse directly: that
// component's option list is `string[]` because a Projects filter's DISPLAY value and its
// FILTER value are the same string (a customer name IS the thing you filter on). Here
// they usually aren't — a job is filtered by id but shown as "1148 — BISCUIT QTY 10", an
// employee by Paylocity id but shown by name — so options carry both.

export type HoursFilterKey = "jobs" | "employees" | "sections" | "departments";

export type HoursFilterOption = { value: string; label: string };

export type HoursFilterSpec = {
  key: HoursFilterKey;
  label: string;
  options: HoursFilterOption[];
  selected: string[];
  searchable?: boolean;
};

export function HoursFilterMenu({ filters }: { filters: HoursFilterSpec[] }) {
  const committed = Object.fromEntries(filters.map((f) => [f.key, f.selected])) as Record<HoursFilterKey, string[]>;
  const { draft, setValues, toggleValue, dirty, pending, detailsRef, detailsProps } = useDraftParamsMenu<HoursFilterKey>({
    committed,
    buildParams: (d, qs) => {
      for (const f of filters) {
        const values = d[f.key] ?? [];
        if (values.length > 0) qs.set(f.key, values.join(","));
        else qs.delete(f.key);
      }
      // A filter change invalidates whatever page of the detail table was showing.
      qs.delete("page");
    },
  });

  const [query, setQuery] = useState<Partial<Record<HoursFilterKey, string>>>({});

  // "Select all" (every current option explicitly picked) narrows nothing, same
  // judgment ProjectsFilterMenu makes — only a selection SMALLER than the full option
  // set is actually restricting the result.
  const narrowing = filters.filter((f) => {
    const sel = draft[f.key] ?? [];
    return sel.length > 0 && sel.length < f.options.length;
  }).length;

  // What the "(N)" counts, spelled out on hover. The number is GROUPS that are
  // narrowing, not values picked — so selecting two departments reads as
  // "Filters (1)", which is correct and, on its own, easy to misread as the
  // second pick not having registered. The tooltip is the cheapest way to say
  // which it is without changing a count this app renders the same way on the
  // Projects tab.
  const countExplanation =
    narrowing === 0
      ? "No filters applied — showing everything"
      : filters
          .filter((f) => {
            const sel = draft[f.key] ?? [];
            return sel.length > 0 && sel.length < f.options.length;
          })
          .map((f) => `${f.label}: ${(draft[f.key] ?? []).length} of ${f.options.length} selected`)
          .join(" · ");

  return (
    <details ref={detailsRef} {...detailsProps} className="group relative inline-block">
      <summary
        title={countExplanation}
        className={`${TOOLBAR_BTN} ${narrowing > 0 ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL} ${pending ? "opacity-60" : ""}`}
      >
        Filters
        {narrowing > 0 && ` (${narrowing})`}
        <MenuStatus pending={pending} />
      </summary>
      <div className="motion-menu-panel styled-scrollbar absolute left-0 top-full z-30 mt-2 max-h-[calc(var(--app-vh)_*_0.7)] w-72 overflow-y-auto rounded-lg border border-sdc-border bg-white p-2 shadow-lg">
        {filters.map((f) => {
          const sel = draft[f.key] ?? [];
          const q = (query[f.key] ?? "").trim().toLowerCase();
          const shown = q ? f.options.filter((o) => o.label.toLowerCase().includes(q)) : f.options;
          return (
            <MenuGroup key={f.key} label={f.label} count={`${sel.length || "all"}/${f.options.length}`}>
              {f.searchable && f.options.length > 8 && (
                <input
                  type="search"
                  value={query[f.key] ?? ""}
                  onChange={(e) => setQuery((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={`Search ${f.label.toLowerCase()}…`}
                  className={`${INPUT} mb-1 w-full text-xs`}
                />
              )}
              <MenuBulkActions onAll={() => setValues(f.key, f.options.map((o) => o.value))} onNone={() => setValues(f.key, [])} />
              <div className="max-h-56 overflow-y-auto styled-scrollbar">
                {shown.map((opt) => (
                  <MenuCheckbox key={opt.value} label={opt.label} checked={sel.includes(opt.value)} onChange={() => toggleValue(f.key, opt.value)} />
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
