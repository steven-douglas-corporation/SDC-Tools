// ── The T&M drill's search box, as ONE predicate ────────────────────────────
//
// Pure and dependency-free (no Prisma, no "server-only", no React), for the same
// reason tm-drill-validate.ts and tm-hours-classify.ts are: it has to run in the
// client bundle (TmHoursDrillPanel's own filtering) AND on the server
// (lib/export/tm-hours-export.ts), and neither environment should drag the
// other's assumptions in.
//
// ── Why this is shared rather than written twice (2026-09-08) ───────────────
//
// The drill panel filters client-side: the search box narrows rows in a useMemo
// across eight fields, and that query string is NOT in the URL. When the export
// was added, the server had to apply the same narrowing or the file would not
// match the table — the guarantee every other export in §24 makes ("the filters
// are not re-described here, they are simply forwarded").
//
// Re-implementing the eight-field OR on the server would have been a SECOND
// definition of one filter, sitting a few files from the first. This app has
// been bitten by exactly that twice in the same feature: HOURS_CODES_BY_KEY
// (deleted 2026-09-01, a duplicate of the classifier the totals used) and
// tm-drill-actions.ts's hand-written HOURS_KEYS, which silently outlived the
// fifth Hours card and made the Other Hours drill throw on every click from the
// day it shipped. So the predicate lives here once and both callers import it.
//
// Consequence worth stating: a field added to the panel's search is added HERE,
// and the export follows automatically. There is no second list to remember.
//
// Contrast with the Hours page's own export (lib/export/hours-export.ts), which
// deliberately does NOT try to reproduce which tree nodes the manager expanded:
// that is genuinely irreproducible client state — a set of open nodes, not
// expressible as a parameter. A search string is one string; it forwards fine.

/**
 * The fields the T&M hours drill searches. Structural rather than
 * `TmHoursDrillRow` so this module needs no import at all — tm-hours.ts carries
 * `import "server-only"`, and depending on it even for a type is a coupling this
 * file exists to avoid.
 */
export type TmDrillSearchable = {
  employee: string;
  department: string;
  jobId: string;
  jobName: string;
  rawSection: string;
  rawSectionName: string;
  rawFunction: string;
  standardTaskDescription: string;
};

/** Normalizes a raw query the same way both callers must: trimmed, lowercased. */
export function normalizeTmDrillQuery(query: string | null | undefined): string {
  return (query ?? "").trim().toLowerCase();
}

/**
 * Does one row match the search box? `query` must already be normalized by
 * normalizeTmDrillQuery — taken pre-normalized so a filter over thousands of
 * rows does not re-trim and re-lowercase the same string once per row.
 *
 * An empty query matches everything, which is what makes "no search" and
 * "search cleared" the same case for both callers.
 */
export function matchesTmDrillQuery(row: TmDrillSearchable, query: string): boolean {
  if (!query) return true;
  return (
    row.employee.toLowerCase().includes(query) ||
    row.department.toLowerCase().includes(query) ||
    row.jobId.toLowerCase().includes(query) ||
    row.jobName.toLowerCase().includes(query) ||
    row.rawSection.toLowerCase().includes(query) ||
    row.rawSectionName.toLowerCase().includes(query) ||
    row.rawFunction.toLowerCase().includes(query) ||
    row.standardTaskDescription.toLowerCase().includes(query)
  );
}

/**
 * The whole filter, for callers that hold an array. Generic so it returns the
 * caller's own row type (TmHoursDrillRow in both cases today) rather than
 * widening it to TmDrillSearchable.
 *
 * Returns a mutable T[] rather than readonly T[] so the result can be handed
 * straight to table-sort.ts's sortRows (which takes T[]); with no query the
 * caller's own array is passed through untouched rather than copied.
 */
export function filterTmDrillRows<T extends TmDrillSearchable>(rows: T[], query: string | null | undefined): T[] {
  const q = normalizeTmDrillQuery(query);
  if (!q) return rows;
  return rows.filter((r) => matchesTmDrillQuery(r, q));
}
