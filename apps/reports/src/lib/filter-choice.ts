// ── A dropdown filter that cannot silently filter on nothing ─────────────────
//
// THE BUG (reported 2026-09-03). The Parts List tab read "327", the BOM/Non-BOM chips
// read "296 / 31", all three dropdowns read "All categories / All manufacturers / All
// suppliers", every date box was blank, the search was blank — and the table said
// "No parts match the current filters. 0 line items."
//
// Nothing on screen was lying about the data. The dropdowns were lying about the
// FILTER, and here is the mechanism:
//
//   1. JobProcurement persists category/manufacturer/supplier to localStorage under a
//      single key for the whole app — not per job. So a supplier picked on job 1101 is
//      still the selected supplier when job 1163 opens.
//   2. `<select value={...}>` is CONTROLLED. When the value is not among the options
//      the browser has nothing to select, so it paints the FIRST option — "All
//      suppliers" — while React state still holds the old value.
//   3. The filter predicate compared against that state. `supplier !== "all"` was true,
//      so every one of the job's 327 parts was tested against a supplier the job has
//      never bought from, and every one failed.
//
// So the screen showed "no filter" and the predicate applied one, and the only way out
// was a Clear button whose presence was the sole visible symptom.
//
// ── Why it went from a corner case to everybody's first click ────────────────
//
// The SDC vendor normalization (lib/vendor-normalize.ts) collapsed "SDC ASSY", "STEVEN
// DOUGLAS CORP" and the rest into one canonical "SDC" option, and the Parts List
// compares through `normalizeVendor` on both sides so a chosen option matches every
// alias behind it. Correct — but it also retired every pre-normalization spelling. Any
// browser holding one of those in localStorage was left with a selection that now
// matches NOTHING ON ANY JOB, invisibly, permanently, until somebody pressed Clear.
// The normalization did not remap or drop a single part; it orphaned a saved choice,
// and the orphan is what emptied the table.
//
// ── The rule ────────────────────────────────────────────────────────────────
//
// A selection that is not on offer is not a filter. `resolveFilterChoice` is the one
// place that decides, and both the predicate and the `<select>` read the resolved
// value — which is the actual fix. The old code could not have been patched by
// "checking the value more carefully" in one of those two places, because the defect
// was that they disagreed.

/**
 * The sentinel meaning "no restriction". Never a category, manufacturer or supplier.
 */
export const FILTER_ALL = "all";

/**
 * Which choice should actually be applied, given what the dropdown can offer.
 *
 * Returns `FILTER_ALL` for the sentinel, for a blank/absent value, and — the point of
 * this function — for any value the options do not contain. Feed the SAME answer to
 * the predicate and to the `<select>`, so the control can never display one filter
 * while the table applies another.
 *
 * `options` should be every value the filter could offer for the data set as a whole,
 * NOT the currently visible subset. Narrowing it to the visible rows would make a
 * legitimate choice look orphaned the moment another filter hid its last row, and this
 * function would then quietly discard it — the same class of silent reset it exists to
 * prevent.
 */
export function resolveFilterChoice(value: string | null | undefined, options: readonly string[]): string {
  if (value == null) return FILTER_ALL;
  const v = value.trim();
  if (v === "" || v === FILTER_ALL) return FILTER_ALL;
  return options.includes(v) ? v : FILTER_ALL;
}

/**
 * Option values for a filter dropdown, with the sentinel made unreachable.
 *
 * A datum literally spelled "all" would be indistinguishable from "no restriction" —
 * selecting it would widen the table instead of narrowing it, which is the confusing
 * direction of a real ambiguity. It is dropped from the OPTIONS only: the rows
 * themselves keep showing, because they are never filtered on a sentinel.
 *
 * Blank and whitespace-only values are dropped for the same reason they are not
 * filters: there is nothing for a user to recognise in an empty dropdown row.
 */
export function filterOptionValues(values: Iterable<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const raw of values) {
    if (raw == null) continue;
    const v = raw.trim();
    if (!v || v === FILTER_ALL) continue;
    set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * A restored multi-select status selection, reduced to keys that still exist.
 *
 * Two failure modes, both of which end as "the table is empty and the control looks
 * fine":
 *
 *   • Keys that no longer exist. A renamed or retired status sits in localStorage and
 *     matches no row, so a selection of stale keys hides everything it applies to
 *     while the badge counts them as though they were doing something.
 *   • Nothing left. An empty selection means "match no status", which is a legitimate
 *     thing to CHOOSE in a session and a terrible thing to silently RESTORE — a user
 *     opening a fresh job would find an empty table with no filter visibly set.
 *
 * So this is for the restore path only. An empty set a user builds by unticking boxes
 * in front of them is their own doing and is left alone.
 */
export function sanitizeStatusSelection<T extends string>(
  stored: unknown,
  known: readonly T[],
  fallback: readonly T[],
): T[] {
  if (!Array.isArray(stored)) return [...fallback];
  const knownSet = new Set<string>(known);
  const kept = [...new Set(stored.filter((k): k is T => typeof k === "string" && knownSet.has(k)))];
  return kept.length > 0 ? kept : [...fallback];
}
