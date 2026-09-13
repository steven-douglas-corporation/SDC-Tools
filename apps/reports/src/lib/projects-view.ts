// The Projects grid's view contract — the presentational half of its "Sections" menu.
//
// Only the INFO columns are here (Job / Customer / Type / Billable / Status / Start Date
// / Complete Date). The section-column picker (`cols`) is deliberately NOT: hiding a
// section changes the Engineering and Shop hour totals, which the page computes
// server-side over the visible sections only (see `engCodes`/`shopCodes` in
// quoted/page.tsx). Recomputing those in the browser would mean reimplementing the
// grid's arithmetic in a second place, so `cols` still navigates and is still correct.
//
// Nothing anywhere derives a figure from an info column, which is what makes these safe
// to hide with CSS. See lib/grid-view.ts for the mechanism and why it exists.
//
// A plain module, not "use client": the server page imports it to seed the initial
// hidden set, and a Server Component importing from a client module gets a client
// reference rather than the value.

import { encodeParamList } from "@/lib/quoted-display-prefs";
import type { ViewKey } from "@/lib/grid-view";

/** Info columns the menu can hide, in the order the grid prints them. */
export const PROJECTS_INFO_COLUMNS = [
  { key: "job", label: "Job" },
  { key: "customer", label: "Customer" },
  { key: "type", label: "Type" },
  { key: "billable", label: "Billable" },
  { key: "status", label: "Status" },
  { key: "startDate", label: "Start Date" },
  { key: "completeDate", label: "Complete Date" },
] as const;

/**
 * Write the hidden info columns into `?hide=`.
 *
 * Ordered by the column list rather than click order, so the same visible set always
 * produces the same URL — which is what lets a saved View and a shared link compare equal.
 * `hide` really is snapshotted by the saved Views (VIEW_PARAMS in ProjectViewsMenu), which
 * read it from useSearchParams — and replaceState syncs that. Deleted when empty so a
 * default URL stays clean.
 *
 * Only touches `hide`. `cols` belongs to the server-side path and must survive
 * untouched, or hiding an info column would silently reset the section picker.
 */
export function projectsViewWriteParams(hidden: ReadonlySet<ViewKey>, qs: URLSearchParams): void {
  const keys = PROJECTS_INFO_COLUMNS.filter((c) => hidden.has(c.key)).map((c) => c.key);
  if (keys.length === 0) qs.delete("hide");
  else qs.set("hide", encodeParamList(keys));
}
