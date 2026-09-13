"use client";

import { useState } from "react";
import { cycleSortState, type SortState } from "@/lib/table-sort";

// Shared sort STATE for a drill-through table's header row — shaped like
// useDrillFilters.ts's {filters, count, toggle, ...}, so a component already reading
// that hook family recognises this one.
//
// Deliberately thin: the actual `sortRows(...)` call stays inline at each call site,
// next to whatever filter/group `useMemo` it composes with — every table's row shape and
// column set differs enough that forcing the sort itself through a shared hook would be
// a leakier abstraction than the one line it would replace.
export function useColumnSort<K extends string>(initial: SortState<K> = null) {
  const [sort, setSort] = useState<SortState<K>>(initial);
  return {
    sort,
    onSort: (key: K) => setSort((s) => cycleSortState(s, key)),
    setSort,
    reset: () => setSort(initial),
  };
}
