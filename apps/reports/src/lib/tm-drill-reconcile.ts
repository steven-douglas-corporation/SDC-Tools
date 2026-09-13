import type { TmPartsDrillRow } from "@/lib/tm-report";
import type { TmHoursDrillRow } from "@/lib/tm-hours";

// ── The reconciliation check the task asks for ──────────────────────────────
//
// Split out from tm-report.ts/tm-hours.ts deliberately: tm-report.ts imports
// runDax (a Node-only Power BI client — @azure/msal-node,
// @azure/msal-node-extensions, keytar, fs) at module scope, and tm-hours.ts
// is `server-only` + Prisma — so anything value-imported FROM either drags
// that along too. This file is imported by TmReportClient.tsx (a "use
// client" component) for its dev-only console check, and needs to be
// runnable in a browser bundle — it only ever imports TYPES from those two
// (erased at build, unlike a value import), never runDax, Prisma, or
// anything that touches either backend.
//
// Pure and network-free (like buildTmFilters) so it's the same function used
// by both that console check and tests/tm-drill-reconcile.test.ts — one
// definition of "does the drill-through sum back to the KPI", not a copy in
// each caller that can quietly drift apart from the other.

/**
 * `rows` must be the FULL, unfiltered drill result — never the search-
 * narrowed subset a panel shows in its own "Shown" footer total, which is a
 * different, deliberately-narrower number.
 */
export function sumTmHoursDrill(rows: TmHoursDrillRow[]): number {
  return rows.reduce((sum, r) => sum + r.hours, 0);
}

export function sumTmPartsDrill(rows: TmPartsDrillRow[], amountKey: "totalPrice" | "invoicedAmount"): number {
  return rows.reduce((sum, r) => sum + r[amountKey], 0);
}

export type TmReconciliation = { kpiTotal: number; detailTotal: number; difference: number };

/**
 * KPI total, detail total, and their difference — rounded to 2 decimals so a
 * float-summation artifact (1e-10) doesn't read as a real mismatch. The
 * expected difference is always 0; see the dev-only console check that logs
 * this in TmReportClient.tsx, and the DAX-shape regression tests in
 * tests/tm-report.test.ts that guard the structural reason it holds.
 */
export function reconcileTmDrill(kpiTotal: number, detailTotal: number): TmReconciliation {
  const difference = Math.round((detailTotal - kpiTotal) * 100) / 100;
  return { kpiTotal, detailTotal, difference };
}
