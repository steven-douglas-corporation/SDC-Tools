"use client";

import { useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { TOOLBAR_BTN, TOOLBAR_BTN_MUTED } from "@/components/ui/classnames";
import { HOURS_FILTER_PARAMS } from "@/lib/hours-filters";

// "Clear filters" for the Hours toolbar (2026-09-02).
//
// One control that puts the page back to its unfiltered default, instead of
// visiting four menus and emptying each — Filters (jobs, employees,
// section-functions, departments), Dates, Group By, the loaded View, the sort
// and the page number.
//
// ── Why it navigates rather than resetting each menu ──────────────────────
//
// The Hours tab keeps ALL of its filter state in the query string; every menu
// derives what it shows from the server's answer to that (see
// useDraftParamMenu's `committed`). So dropping the params IS the reset — the
// checkmarks, the "(2)" counts, the date fields, the group-by chips and the
// active-view name all resync from it, and there is no second copy of the state
// to fall out of step. Reaching into each menu to clear it would create exactly
// the parallel state this page has deliberately avoided.
//
// The param list is imported, not written out here, so a filter added later
// cannot quietly become one this button fails to clear.
export function HoursClearFiltersButton({ activeCount }: { activeCount: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const nothingToClear = activeCount === 0;

  return (
    <button
      type="button"
      // Disabled when nothing is active: the request says to prefer that over a
      // no-op, and a control that does nothing when pressed is worse than one
      // that says so first.
      disabled={nothingToClear || pending}
      aria-label={nothingToClear ? "Clear filters (nothing to clear)" : `Clear all ${activeCount} filters`}
      onClick={() =>
        startTransition(() => {
          // pathname, with no query at all — every filter param is in the query,
          // so this is the page's own default view by construction.
          router.push(pathname, { scroll: false });
        })
      }
      className={`${TOOLBAR_BTN} ${TOOLBAR_BTN_MUTED} disabled:cursor-not-allowed disabled:opacity-45 ${pending ? "opacity-60" : ""}`}
      title={
        nothingToClear
          ? "No filters are active"
          : `Clear every filter on this page (${activeCount} active): selections, dates, grouping, sort and the loaded view`
      }
    >
      Clear filters
      {activeCount > 0 && ` (${activeCount})`}
    </button>
  );
}

/** Named for the page that owns it; the list itself lives with the parser. */
export { HOURS_FILTER_PARAMS };
