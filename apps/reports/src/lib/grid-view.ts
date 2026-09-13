// Presentational grid state that never asks the server.
//
// ── The defect this exists for (§40.2) ──────────────────────────────────────
//
// Some of the filters on these grids change WHICH DATA is fetched — a status or a
// customer decides which jobs the query returns, and there is no way to answer that
// in the browser. Others change only WHICH OF THE ALREADY-RENDERED CELLS YOU CAN
// SEE: the Monthly ETC "Section columns" and "Job Name column" toggles, and the
// Projects "Info columns" toggles. Those were paying the same price as the first
// kind — a full route navigation, a fresh RSC payload, and a React reconciliation
// of the entire table.
//
// Measured on the production build before this existed (DEVLOG §24.1):
//
//   Monthly ETC, hide one section group : 4,113 DOM mutations, 97ms blocked, ~280ms
//   Monthly ETC, hide Job Name column   : 3,649 DOM mutations, 118ms blocked, ~240ms
//   Projects, hide one info column      : 3,330 DOM mutations, 440ms blocked, ~250ms
//
// Three and a half thousand DOM mutations to stop showing one column that was
// already on screen. The server round-trip itself was never the problem (11-50ms);
// the cost was re-rendering 4,272 cells to change the visibility of 51 of them.
//
// ── What replaces it ────────────────────────────────────────────────────────
//
// The grid is rendered COMPLETE, once. Every cell is tagged with the key that
// decides whether it shows (`data-col`), and visibility is one generated stylesheet
// — so hiding a column is a single text update to one <style> element instead of a
// re-render, and costs the same whether the grid has 50 cells or 5,000.
//
// The URL still carries the view, for two reasons that were checked rather than
// assumed: a shared link or a reload has to open the same view, and the Projects saved
// Views snapshot `hide` (see VIEW_PARAMS in ProjectViewsMenu) by reading
// `useSearchParams`. It is written with history.replaceState, which Next supports
// explicitly for this and which syncs useSearchParams WITHOUT re-rendering the route —
// see node_modules/next/dist/docs/01-app/02-guides/single-page-applications.md
// ("Shallow routing on the client").
//
// NOT for Export, despite the obvious guess: /api/export/[report] reads only the ROW
// filters (customers/types/statuses/billables/sort/dates, plus `month` for ETC) and
// deliberately includes every column, so column visibility has never affected a
// download and still does not. Verified — the same request with and without
// `hide=customer,type,status` returns byte-identical CSV.
//
// ── Why a <style> element and not inline styles or classes ──────────────────
//
// Because the work has to be O(1) in the number of cells. Setting `style.display`
// on each hidden cell is O(cells) and reintroduces exactly the cost being removed;
// toggling a class on each cell is the same. One stylesheet rule per hidden key
// lets the browser's selector matching do it, which is what it is for.

/** A cell/column/row is addressed by a stable key: a section code, an info-column key, or a billing group. */
export type ViewKey = string;

/**
 * The CSS that hides everything currently hidden, scoped to one grid.
 *
 * `scope` is a selector for the grid (e.g. `[data-grid="etc"]`) so two grids on one
 * page cannot hide each other's columns.
 *
 * Returns "" for an empty hidden set rather than an empty rule, so the common case
 * (nothing hidden) puts no rules in the document at all.
 */
export function buildGridViewCss(scope: string, hidden: Iterable<ViewKey>): string {
  const keys = [...hidden].filter(isSafeViewKey);
  if (keys.length === 0) return "";
  // One rule listing every hidden key, rather than one rule per key: the selector
  // list is what the browser optimises, and it keeps the <style> text short enough
  // that rewriting it is free.
  const sel = keys.map((k) => `${scope} [data-col~="${k}"]`).join(",");
  // `display: none` on a table cell removes it from its row entirely, which is what
  // makes the remaining columns close up. visibility:hidden would leave the gap.
  return `${sel}{display:none}`;
}

/**
 * Keys come from a URL, so they reach a stylesheet as attacker-influenced text. Only
 * the shapes this app actually uses are allowed through — section codes ("10-311"),
 * info-column keys ("startDate"), billing groups ("Engineering"). Anything with a
 * quote, brace, backslash or angle bracket is dropped rather than escaped, because a
 * key that needs escaping is a key this app never generates.
 */
export function isSafeViewKey(k: string): boolean {
  return /^[A-Za-z0-9 _-]{1,64}$/.test(k);
}

/**
 * The colSpan a banded header cell should carry, given which of the leaf columns it
 * spans are hidden.
 *
 * The banded headers on both grids (phase / billing group / sub-group rows) span
 * several leaf columns each, and a colSpan is a number in the DOM — no stylesheet
 * can change it. So hiding a column has to fix up the bands above it, and that is
 * the ONE piece of per-change DOM work here. It is O(bands) — about twenty cells on
 * the Monthly ETC grid — not O(cells).
 *
 * ── Each entry is a leaf's FULL key set, not just its code ──────────────────
 *
 * `entries` mirrors the `data-col` attribute of the leaf columns: one entry per leaf,
 * each a space-separated list of every key that can hide it ("10-411 Shop"). A leaf is
 * hidden if ANY of its keys is hidden, exactly as the `[data-col~=]` selector decides.
 *
 * This is not a detail. The first version compared section codes only, so hiding a
 * billing GROUP hid all its cells but shrank none of the bands above them — the phase
 * row still spanned 78 columns over a 58-column body, and the whole banded header
 * sheared sideways. Measured, not imagined: see the alignment assertions in the tests.
 *
 * `mult` is how many sub-columns each leaf column occupies (Monthly ETC prints five
 * per section; Projects prints one).
 *
 * Returns 0 when every leaf column under the band is hidden, which is the caller's
 * signal to hide the band itself — a colSpan of 0 means "span the rest of the
 * column group" in HTML, not "span nothing", so it must never be written.
 */
export function bandColSpan(entries: readonly string[], hidden: ReadonlySet<ViewKey>, mult = 1): number {
  let visible = 0;
  for (const entry of entries) {
    const keys = entry.split(" ").filter(Boolean);
    if (!keys.some((k) => hidden.has(k))) visible++;
  }
  return visible * mult;
}

/** Toggle one key in a hidden set, returning a new array (stable order for the URL). */
export function toggleHidden(hidden: readonly ViewKey[], key: ViewKey): ViewKey[] {
  return hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key];
}

/**
 * The `dept` param the Monthly ETC URL uses, derived from which billing groups are
 * hidden. Kept here rather than in the menu so the URL this writes and the URL the
 * server parses are described in one place.
 *
 * Both groups hidden is not a state the grid can render (§ the menu restores both
 * when the last one is unticked), so it is normalised to "show both" — the same
 * thing the server does with an absent or empty `dept`.
 */
export function deptParamFromHidden(
  allGroups: readonly string[],
  hidden: ReadonlySet<ViewKey>,
): string | null {
  const shown = allGroups.filter((g) => !hidden.has(g));
  if (shown.length === 0 || shown.length === allGroups.length) return null; // default: both
  return shown.join(",");
}
