import type { PartsCostLine } from "@/lib/sync-totaleto";
import { reconcileRounding } from "@/lib/rounding";

// Split out of parts-cost-financials.ts (2026-08-15): that file starts with
// `import "server-only"`, so a CLIENT component importing anything more than
// a bare type from it — as PartsCostSummary.tsx needs to for
// `reconcilePartsCostRounding`, a plain runtime function with no server
// dependency at all — pulls the whole module (Prisma, the live TotalETO
// query) into the client bundle and trips Next's server-only guard. This
// file holds exactly the things safe for either side to import: the shape of
// the reconciliation, and the pure arithmetic (rounding fix, bar-scale math,
// and — 2026-08-19 — `projectionResidual`). The async `getPartsCostFinancials`
// that actually PRODUCES a `PartsCostFinancials` stays server-only, in
// parts-cost-financials.ts; `computePartsBudgetProjection` similarly stays in
// parts-budget-projection.ts (its own `import "server-only"`, since it calls
// getExecutionEtcByJob), importing `projectionResidual` from here rather than
// defining it there — the same reason `projectionResidual` also needs to be
// importable from a plain node:test file with no live database (a value
// import of anything with `import "server-only"` throws unconditionally under
// this project's test runner — the module has to not have it at all).

export type PartsCostFinancials = {
  /** Job.costQuoted, summed across the requested jobs. Null when none has a quote on file. */
  budget: number | null;
  /** GL-posted spend, lifetime, full precision. THE app-wide definition of Parts Actual. */
  invoiced: number;
  /** Committed but not GL-posted (open PO balance + non-GL-posted invoices), full precision, floored at 0. */
  leftToInvoice: number;
  /**
   * This job's Parts New ETC for the applicable month (see `asOfDate`), already net of
   * this month's booked spend and floored at 0. Null — not 0 — when there is no ETC
   * month at all for these jobs: an absent estimate is not the same as an estimate of
   * zero (mirrors computePartsBudgetProjection's own null case).
   */
  etc: number | null;
  /** invoiced + leftToInvoice — "how much has actually been committed to date" (= Purchased). */
  totalSpent: number;
  /**
   * invoiced + max(leftToInvoice, etc ?? 0) — where this job is projected to
   * land (2026-08-19). Never below `totalSpent` (invoiced + leftToInvoice):
   * whichever of leftToInvoice/etc is larger is the one added, never both
   * (that would double-count — the 2026-08-17 fix) and never neither's floor
   * (a stale/small etc can't drag this below totalSpent — the 2026-08-19 fix).
   */
  projection: number;
  // ── Dan's projection model (2026-09-03) ───────────────────────────────────
  //
  // `projection` = invoiced + adjustedEtc + additionalExposure, which is also
  // invoiced + max(adjustedEtc, yetToInvoice). See lib/parts-projection.ts for the
  // derivation and lib/parts-prior-etc.ts for where the two ETC inputs come from.
  // Every figure below is stated separately because the drill-through has to prove
  // the bar (spec §14).
  /** Purchased / committed — every line's total cost. Shown in the drill-through. */
  purchased: number;
  /**
   * Billed but NOT posted to the general ledger — `invoicedAmount − actualAmount`.
   *
   * ── Why this is on the card and not left to an audit ────────────────────
   *
   * `APDocDoNotExport` marks a document that must not be exported to Sage again. Some
   * are Sage-first purchases, already paid and already on the job ledger; those count
   * as spend (SAGE_FIRST_VENDORS in lib/sync-totaleto.ts). The rest do not, and their
   * dollars therefore sit in "Left to invoice" indefinitely even though nobody is
   * waiting on an invoice for them.
   *
   * That was invisible until somebody compared eight jobs by hand and wrote
   * docs/PARTS-COST-VARIANCE-2026-09.md. Job 1106 alone carries $253,015 of it — five
   * ETO-side corrections. A figure that large should not need an audit to notice, so
   * it is stated on the card whenever it is non-zero.
   *
   * Reported, never subtracted: it is a component OF Left to invoice, not a separate
   * bucket, and adding it anywhere would double-count.
   */
  billedNotPosted: number;
  /** The previous month's confirmed New ETC: the forecast this month starts from. */
  priorEtc: number | null;
  /** Whether `priorEtc` was carried forward or, on a first ETC month, taken from the quote. */
  priorEtcSource: "carry-forward" | "quoted-parts" | "none";
  /** The selected month's canonical booked parts cost ("Money Spent Month" on the grid). */
  partsSpentThisMonth: number;
  /** `priorEtc − partsSpentThisMonth`, which CAN be negative. Kept for diagnostics. */
  adjustedEtcRaw: number | null;
  /** Yellow: the same figure floored at 0. */
  adjustedEtc: number;
  /**
   * EVERY open commitment: `purchased − invoiced`. The projection is built on this,
   * which is what keeps it from ever falling below what the job has committed.
   */
  openBalance: number;
  /**
   * The part of `openBalance` that will arrive as a SUPPLIER invoice — in-house SDC
   * excluded. Reported only; it must not size the total. Applying this exclusion to
   * the projection was the 2026-09-03 bug (see lib/parts-projection.ts).
   */
  externalOpen: number;
  /** Remaining exposure on in-house SDC rows, excluded from `yetToInvoice`. */
  inHouseExcluded: number;
  inHouseRows: number;
  /** Red: `max(0, yetToInvoice − adjustedEtc)`. */
  additionalExposure: number;
  /** Where the dotted line goes: `invoiced + adjustedEtc`. Null when there is no red. */
  coverageLine: number | null;
  /** True when no prior ETC could be resolved for the month at all. */
  etcUnknown: boolean;
  /** The ETC month these figures describe. */
  etcMonth: string | null;
  /** projection − budget. Null when budget is null. */
  variance: number | null;
  /** variance / budget × 100. Null when budget is null or zero. */
  variancePct: number | null;
  /** How many of the requested jobs' live TotalETO reads failed or timed out. */
  failedJobs: number;
  /** Total PartsCostLine rows aggregated (0 when every job failed). */
  lineCount: number;
  /**
   * The raw per-line rows this was aggregated from — exposed so a caller that
   * also needs line-level detail (e.g. JobProcurement's parts list) can reuse
   * this same TotalETO fetch instead of issuing a second one for the same jobs.
   */
  lines: PartsCostLine[];
};

// ── The one arithmetic step the 2026-08-19 fix is ───────────────────────────
//
// Reported live on job 1119 (Karl Storz Stamping Machine): Total Parts Cost
// Spent $133,428 (invoiced + committedNotPosted) read GREATER than
// Actual/Projection $127,219 (invoiced + estimateToPurchase) — that job's ETC
// hadn't caught up to its own open PO balance. `committedNotPosted` and
// `estimateToPurchase` are never BOTH added on top of `actual` (that's the
// 2026-08-17 double-count fix — see parts-budget-projection.ts's header) —
// only ever the LARGER of the two rides on top, which keeps that same "one
// term, not two" shape while adding the floor this fix requires: whichever
// term is smaller can never drag the total below what the other alone
// already guarantees. When `estimateToPurchase` is current (>=
// committedNotPosted, the common/healthy case), this returns
// `estimateToPurchase` unchanged — byte-identical to the 2026-08-17 formula.
export function projectionResidual(committedNotPosted: number, estimateToPurchase: number): number {
  return Math.max(committedNotPosted, estimateToPurchase);
}

// ── Rounding that can't visibly contradict itself ────────────────────────────
//
// Audit finding: rounding Invoiced/Left to Invoice/ETC to whole dollars
// INDEPENDENTLY, then summing those three rounded numbers, does not always
// equal the (separately, correctly) rounded Projection total — a classic
// "sum of roundings ≠ rounding of the sum" artifact, not a calculation error.
// Measured on the job that prompted this audit: 23207.616 + 101371.554 +
// 189298.04 = 313877.21 exactly (full precision reconciles to the cent) —
// but round(23207.616)=23208, round(101371.554)=101372, round(189298.04)=
// 189298, and 23208+101372+189298 = 313878, one dollar more than
// round(313877.21) = 313877. Both individual roundings are each correct in
// isolation; a user manually re-adding the DISPLAYED numbers gets a
// different total than the one displayed, which reads as the app being
// wrong even though nothing in the underlying math is.
//
// Fixed with the standard "largest remainder" allocation — see
// src/lib/rounding.ts's `reconcileRounding` for the full explanation and the
// actual implementation. This name is kept as a thin re-export (2026-08-17,
// when the algorithm was generalized for the Hours tab's own grouped rollups)
// purely so every existing import of `reconcilePartsCostRounding` keeps
// working unchanged; there is exactly one canonical implementation now.
export function reconcilePartsCostRounding(parts: number[]): number[] {
  return reconcileRounding(parts);
}

// ── One shared bar-height scale, extracted so it's independently testable
// with real arithmetic (2026-08-17) ────────────────────────────────────────
//
// Reported: "the second [Actual/Projection] bar is visually taller even
// though its total value is lower than the Budget bar." The bars were
// already scaled off one shared domain (PartsCostSummary.tsx's `maxValue` and
// `pct`), not independently normalized — this extraction doesn't change that
// behavior, it moves the two calls that decide it into a plain function a
// test can call directly with real numbers, rather than only being provable
// by reading the component's source.
//
// `sharedBarMax` floors at 1 (never 0) so a job with no budget on file and no
// projection yet doesn't produce a divide-by-zero `NaN` height for either bar.
export function sharedBarMax(...values: number[]): number {
  return Math.max(1, ...values);
}

// `ceilingPct` < 100 reserves headroom for a value label sitting inside the
// same fixed-height frame as the fill (see PartsCostSummary.tsx) — the SAME
// ceiling applies to every value scaled against a given `sharedMax`, so it
// changes where "full height" sits inside the frame without changing any
// value's height RELATIVE to another (half of `sharedMax` is still exactly
// half the height of `sharedMax` itself, just capped at `ceilingPct` of the
// frame instead of 100%).
export function scaleToPct(value: number, sharedMax: number, ceilingPct = 94): number {
  return Math.min(ceilingPct, (value / sharedMax) * ceilingPct);
}
