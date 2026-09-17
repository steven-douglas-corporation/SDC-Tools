// ── The T&M Parts drill's search box, as ONE predicate ──────────────────────
//
// Same reasoning as tm-drill-search.ts (the Hours drill's own copy of this
// idea): pure and dependency-free so it runs unmodified in the client bundle
// (TmPartsDrillPanel's own filtering) and on the server
// (lib/export/tm-parts-export.ts), and a field added to the panel's search is
// added HERE so the export follows automatically — no second list to keep in
// sync.

export { normalizeTmDrillQuery as normalizeTmPartsQuery } from "@/lib/tm-drill-search";
import { normalizeTmDrillQuery } from "@/lib/tm-drill-search";

/**
 * The fields the T&M parts drill searches. Structural rather than
 * `TmPartsDrillRow` for the same reason TmDrillSearchable is: this module
 * should need no import of its own beyond the (dependency-free) normalizer.
 */
export type TmPartsSearchable = {
  jobId: string;
  jobName: string;
  partNumber: string;
  description: string;
  supplier: string;
  poNumber: string;
};

/** Does one row match the search box? `query` must already be normalized. */
export function matchesTmPartsQuery(row: TmPartsSearchable, query: string): boolean {
  if (!query) return true;
  return (
    row.jobId.toLowerCase().includes(query) ||
    row.jobName.toLowerCase().includes(query) ||
    row.partNumber.toLowerCase().includes(query) ||
    row.description.toLowerCase().includes(query) ||
    row.supplier.toLowerCase().includes(query) ||
    row.poNumber.toLowerCase().includes(query)
  );
}

/** The whole filter, for callers that hold an array — see filterTmDrillRows's own note. */
export function filterTmPartsDrillRows<T extends TmPartsSearchable>(rows: T[], query: string | null | undefined): T[] {
  const q = normalizeTmDrillQuery(query);
  if (!q) return rows;
  return rows.filter((r) => matchesTmPartsQuery(r, q));
}
