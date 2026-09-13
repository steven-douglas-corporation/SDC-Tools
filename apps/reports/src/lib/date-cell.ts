// Props for a grid date cell, and the selector the delegated handler finds it by.
//
// A plain module, not part of the client component: the two grids render these
// inputs from SERVER components, and every export of a `"use client"` file is a
// client reference that a server component cannot call. (Learned the hard way on
// 2026-08-03 — see lib/job-cell-menu.ts.)
export const DATE_CELL_ATTR = "data-date-cell";
export const DATE_CELL_SELECTOR = `[${DATE_CELL_ATTR}]`;

// `date-empty` (globals.css) hides the literal "mm/dd/yyyy" segments a native
// date input shows when blank, which otherwise read as noise down a whole column
// of empty dates. Applied here for the server render; GridDateCells keeps it in
// step as dates are picked and cleared.
export function dateCellProps({ name, defaultValue, ariaLabel }: { name: string; defaultValue: string; ariaLabel: string }) {
  return {
    type: "date" as const,
    name,
    defaultValue,
    // The server's value, for dirty-form.ts: submitted only when the picked date
    // differs from it.
    "data-baseline": defaultValue,
    "aria-label": ariaLabel,
    className: defaultValue === "" ? "date-empty" : undefined,
    [DATE_CELL_ATTR]: "",
  };
}
