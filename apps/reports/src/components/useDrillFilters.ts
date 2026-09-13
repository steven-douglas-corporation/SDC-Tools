"use client";

import { useState } from "react";
import {
  activeFilterCount,
  clearDrillFilters,
  setFilterRange,
  setFilterValues,
  toggleFilterValue,
  type DrillFilterKey,
  type DrillFilters,
} from "@/lib/drill-filters";

/**
 * The filter state for one drill-through (§73).
 *
 * Plain local state, no URL and no server: the rows are already in the panel, so a tick
 * is a synchronous re-filter of an array. That is what makes "filters apply immediately"
 * true rather than aspirational — there is nothing to wait for, and nothing to debounce
 * (§32.7 forbids debouncing a checkbox for exactly this reason). It is also why a filter
 * change cannot reload the Monthly ETC page: nothing here touches the router.
 *
 * ── resetKey ────────────────────────────────────────────────────────────────
 *
 * Filters must be dropped when the drill closes or the report month changes. Closing is
 * handled by the callers unmounting the panel, which takes this state with it. A MONTH
 * change is not: the KPI strip and its panels stay mounted across one (the page is
 * re-rendered with new props, deliberately, so the strip does not flicker), so a section
 * filter set on July would silently narrow August to sections that may not even be in it.
 *
 * Set-state-during-render rather than an effect, which is the supported way to derive
 * state from props: an effect renders one frame with the OLD filters against the NEW
 * month, which is a visibly wrong table, and it trips react-hooks/set-state-in-effect.
 */
export function useDrillFilters(
  resetKey?: string,
  /**
   * The state the panel OPENS in, and the state Clear filters returns to — not merely a
   * seed. The hours drill arrives from a section bar with that section preselected, and
   * "Clear filters" dropping it would take away the context you clicked with; it clears
   * back to the section you came in on. Which is also why the count treats it as active:
   * that filter IS narrowing the table, however it got there.
   */
  initial: () => DrillFilters = clearDrillFilters,
) {
  const [filters, setFilters] = useState<DrillFilters>(initial);
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setFilters(initial());
  }

  return {
    filters,
    count: activeFilterCount(filters),
    toggle: (key: DrillFilterKey, value: string) => setFilters((f) => toggleFilterValue(f, key, value)),
    setAll: (key: DrillFilterKey, values: string[]) => setFilters((f) => setFilterValues(f, key, values)),
    setRange: (from: string, to: string) => setFilters((f) => setFilterRange(f, from, to)),
    clear: () => setFilters(initial()),
  };
}

export type DrillFilterState = ReturnType<typeof useDrillFilters>;
