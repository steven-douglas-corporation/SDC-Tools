// The Monthly ETC grid's view contract: the keys its presentational filters use, and
// how they are written to the query string.
//
// ── Why this is its own module and not part of EtcGridView ──────────────────
//
// It is imported by BOTH the server page (etc/page.tsx, which parses `?dept=` and seeds
// the initial hidden set) and two client components. A "use client" module cannot
// supply it: when a Server Component imports from one, it receives a client REFERENCE
// rather than the value, so `new Set(ETC_DEPT_GROUPS)` fails with "function is not
// iterable" — which is exactly how this was found. A plain module has no boundary and
// both sides get the real value.
//
// Nothing here touches the database or the request, so it deliberately carries no
// `server-only` marker.

import { deptParamFromHidden, type ViewKey } from "@/lib/grid-view";

/**
 * The two billing groups the "Section columns" filter switches between.
 *
 * These strings are simultaneously the checkbox labels, the `data-col` keys on ~2,000
 * cells, and the values in `?dept=` — so there is one definition rather than three
 * that can drift.
 */
export const ETC_DEPT_GROUPS = ["Engineering", "Shop"] as const;

/**
 * Which billing groups are hidden after clicking one of the "Section columns" boxes.
 *
 * Pure and tested because the first version of this had its boolean inverted and simply
 * did nothing — the checkbox was clicked, no group was hidden, and there was no error to
 * notice. A silently inert filter is the exact failure §40 is about, so the rule lives
 * here rather than inline in an onChange.
 *
 * `visible` is the set currently shown. Returns the groups to hide; unticking the last
 * visible group returns none, because the grid cannot render zero section columns and
 * `?dept=` has no way to say "neither" (see deptParamFromHidden).
 */
export function nextHiddenGroups(
  visible: ReadonlySet<string>,
  clicked: string,
): string[] {
  const next = ETC_DEPT_GROUPS.filter((g) => (g === clicked ? visible.has(g) : !visible.has(g)));
  return next.length === ETC_DEPT_GROUPS.length ? [] : [...next];
}

/**
 * Write the hidden set into the query string.
 *
 * The URL still has to be correct even though nothing navigates, so a reload or a shared
 * link opens the same view. (Not for Export — that reads only the row filters and always
 * includes every column; see the note in lib/grid-view.ts.) Mutates `qs`, matching
 * useDraftParamsMenu's buildParams.
 */
export function etcViewWriteParams(hidden: ReadonlySet<ViewKey>, qs: URLSearchParams): void {
  const dept = deptParamFromHidden(ETC_DEPT_GROUPS, hidden);
  if (dept) qs.set("dept", dept);
  else qs.delete("dept");
  if (hidden.has("jobname")) qs.set("jobname", "0");
  else qs.delete("jobname");
}

/**
 * The cosmetic consequences of hiding the Job Name column, as CSS rather than
 * classNames — a className would mean re-rendering 49 rows to move one border, which is
 * the cost the whole mechanism exists to avoid.
 */
export function etcViewExtraRules(hidden: ReadonlySet<ViewKey>, scope: string): string {
  if (!hidden.has("jobname")) return "";
  return (
    // The heavy grey divider separating the frozen columns from the section blocks
    // lives on Job Name; with it gone, Job Id is the last frozen column.
    `${scope} [data-etc-jobid]{border-right:8px solid #808080}` +
    // ...and the footer's "Total" label moves onto Job Id with it.
    `${scope} [data-etc-total-fallback]{visibility:visible}`
  );
}
