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
 * The Parts Cost block's hide key. Its header, body and footer cells carry
 * `data-col="parts"`, the same way the hours blocks carry their billing group.
 */
export const ETC_PARTS_KEY = "parts";

/**
 * The three main blocks of the grid as far as the View menu is concerned: Engineering
 * hours, Shop hours (each with its share of Total (New ETC)), and Parts Cost. At least
 * one has to stay visible — a grid with none is just a list of job names.
 */
export const ETC_BLOCKS = [...ETC_DEPT_GROUPS, ETC_PARTS_KEY] as const;

/**
 * The hidden set after clicking one of the block boxes in the View menu.
 *
 * Pure and tested because the first version of the old group rule had its boolean
 * inverted and simply did nothing — the checkbox was clicked, no group was hidden, and
 * there was no error to notice. A silently inert filter is the exact failure §40 is
 * about, so the rule lives here rather than inline in an onChange.
 *
 * Clicking a visible block hides it; clicking a hidden one shows it. Hiding the LAST
 * visible block is refused and the set comes back unchanged (the menu also disables that
 * box, so this is the backstop). Keys that are not blocks — `jobname` — are carried
 * through untouched.
 */
export function nextHiddenBlocks(hidden: ReadonlySet<string>, clicked: string): string[] {
  const current = [...hidden];
  if (!(ETC_BLOCKS as readonly string[]).includes(clicked)) return current;
  if (hidden.has(clicked)) return current.filter((k) => k !== clicked);
  const stillVisible = ETC_BLOCKS.filter((b) => b !== clicked && !hidden.has(b));
  return stillVisible.length === 0 ? current : [...current, clicked];
}

/**
 * The view's query-string params, as the page receives them. The saved-view cookie uses
 * the same three names (lib/etc-view-cookie.ts), so one parser reads both.
 */
export type EtcViewParams = { dept?: string; jobname?: string; parts?: string };

/**
 * The hidden set a URL (or the saved-view cookie) describes. The ONE parser: the page
 * seeds the grid from it, and the round-trip test pins it against the writer below.
 *
 *   dept     "Engineering" / "Shop" / both, comma-separated — the groups SHOWN; "none" for
 *            neither; absent, empty or unrecognised means both.
 *   parts    "0" hides Parts Cost.
 *   jobname  "0" hides the Job Name column.
 *
 * Hiding everything is not a state the grid can render, so it is normalised to showing
 * every block. That can only come from a hand-edited URL or cookie — the menu cannot
 * produce it — and the safe reading of nonsense is the full grid, not an empty one.
 */
export function hiddenFromEtcParams(p: EtcViewParams): string[] {
  const named = (p.dept ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((g): g is (typeof ETC_DEPT_GROUPS)[number] => g === "Engineering" || g === "Shop");
  const shownGroups: readonly string[] = named.length ? named : (p.dept ?? "").trim() === "none" ? [] : ETC_DEPT_GROUPS;
  const partsHidden = p.parts === "0";
  const nothingShown = shownGroups.length === 0 && partsHidden;
  return [
    ...(nothingShown ? [] : ETC_DEPT_GROUPS.filter((g) => !shownGroups.includes(g))),
    ...(p.jobname === "0" ? ["jobname"] : []),
    ...(partsHidden && !nothingShown ? [ETC_PARTS_KEY] : []),
  ];
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
  if (hidden.has(ETC_PARTS_KEY)) qs.set("parts", "0");
  else qs.delete("parts");
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
