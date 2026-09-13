import "server-only";
import { getExecutionEtcByJob } from "@/lib/execution-etc";
import { projectionResidual } from "@/lib/parts-cost-financials-shared";
import type { PartsCostLine } from "@/lib/sync-totaleto";
import { leftToInvoiceForLines } from "@/lib/left-to-invoice";

// "Part Cost Budget Projection" — where a job lands by the time it's finished.
//
//   projection = invoiced (Parts Actual, GL-posted)
//              + max(committedNotPosted, estimateToPurchase)   [2026-08-19]
//
// The 2026-08-19 fix (see below, and projectionResidual's own comment) never
// sums BOTH remaining terms — only ever one, whichever is larger — so this is
// still the "no double-count" shape the 2026-08-17 fix established, with one
// added floor: projection can never land below `invoiced + committedNotPosted`
// (= Total Parts Cost Spent).
//
// ── 2026-08-17 fix: this used to be `purchased + estimateToPurchase`, which
// double-counts committed-but-unposted spend ───────────────────────────────
//
// `purchased` = `actual + committedNotPosted` (open PO balance + anything
// invoiced but not yet GL-posted — the card's "Left to be invoiced"). The
// formula's own reasoning (Dan, 2026-07-29, kept below for the parts still
// true) assumed `estimateToPurchase` (the app's Parts New ETC) is already NET
// of everything on an open PO — i.e. that a manager's New ETC represents
// "what's left to commit BEYOND what's already committed." That assumption
// requires `estimateToPurchase`'s own monthly drawdown to net against the SAME
// basis `committedNotPosted` is measured against (Purchased). It does not:
// `hoursWorked` on the PARTS_COST EtcEntry — the "money spent this month" that
// draws `priorEtc` down into New ETC — comes from `getPartsCostBookedByJob`,
// the AP-document/GL-posted basis (see sync-actuals.ts §41), the exact same
// basis as `actual`/"Invoiced".
//
// TRUE AS OF 2026-09-04, AND NOT BEFORE. This paragraph asserted that shared basis
// while getPartsCostBookedByJob carried no GL-posted test at all — $56,740.45 of
// August 2026 counted as money spent this month and NOT as Parts Actual. Both now
// route through the one `glPostedAp` predicate, so the sentence describes the code
// rather than the intention. See that function's own header.
//
// It is NEVER reduced by an open PO until that
// PO is actually invoiced. So a PO opened this month raises `committedNotPosted`
// immediately, but does nothing to New ETC until the invoice posts — possibly
// a different month, possibly never before a manager revises their estimate.
// Until then, that PO's dollars sit in BOTH `committedNotPosted` ("Left to be
// invoiced") AND, undiminished, inside `estimateToPurchase` ("ETC") — the exact
// double-count the 2026-08-15 audit's own `DOUBLE COUNT SUSPECTED` check named
// as a live, checkable mechanism ("this is the live, checkable shape of that
// gap, not a hypothetical") but treated as a diagnostic to watch rather than a
// defect to fix. Confirmed on real project data (screenshot review, 2026-08-17):
// Invoiced $47,192 + Left to be invoiced $84,877 + ETC $165,313 summed to
// $297,382, well past the $212,505 (Invoiced + ETC) a manager's own New ETC —
// which already represents "what it will cost to finish the job from here" —
// actually implies.
//
// The fix is `invoiced + estimateToPurchase`, not `purchased + estimateToPurchase`:
// a manager's Parts New ETC is the forward-looking estimate to COMPLETE the
// job, which already has to account for whatever is presently on order (a
// competent estimate of "what's left to finish this job" cannot exclude
// commitments already made) — so ETC alone, added to what's already posted to
// the ledger, is the projection. `committedNotPosted` ("Left to be invoiced")
// stays a real, displayed figure — it answers "how much of ETC is already
// spoken for by an open PO" — it is just never summed into the total again.
//
// ── Estimate to purchase IS the app's Parts New ETC ───────────────────────────
// Not a coincidence — it's the same arithmetic. The PARTS_COST EtcEntry for a
// month (syncPartsCost) stores exactly:
//
//   priorEtc    = the prior month's confirmed Parts New ETC
//                 → the estimate to complete AT THE START of this month
//   hoursWorked = money spent (GL-posted/AP-document basis) this month
//
// and the effective New ETC is suggestNewEtc(priorEtc, hoursWorked) = prior −
// spent. So this reads that field rather than recomputing it. Two payoffs: no
// start-of-month snapshot has to be guessed at, and the projection agrees with
// the Parts Cost row the managers review on the Monthly ETC grid — a manager's
// confirmed override is honoured instead of silently contradicted.
//
// ── Why NOT Power BI's [Part Cost Estimated To Complete] ─────────────────────
// It was the estimate half here until 2026-07-30, and it inflated every
// projection. That measure is SUM('Cost Estimated'[Cost Estimated To Complete]),
// a manually-maintained figure that opens at the quote and does NOT draw down as
// parts are bought — so adding it to Purchased double-counts money already
// spent. Measured across all 44 quoted jobs with parts on 2026-07-30:
//
//   job    quoted    purchased      PBI est-to-complete    app Parts New ETC
//   1150   147,770     148,113      147,200 (~full quote)             75,251
//   1152    63,000          40       62,900 (~full quote)             62,900
//   1158   225,000      60,877      213,086 (~full quote)            213,086
//   1142 1,300,000   1,406,923                  250,000                    0
//   1130 2,114,412   1,878,665                  650,000                    0
//
// Job 1150 is the clearest tell: fully purchased against its quote, yet the
// measure still claimed the entire quote was left to complete — projecting
// $295K on a $148K job. Where nothing has been purchased yet (1152, 1158) the
// two agree exactly, which is what you'd expect if one is the other before any
// draw-down. The old comment here read the app's zeros (1142, 1130) as the app
// being wrong; they're right — those jobs are done buying, so nothing is left to
// commit and the projection should equal Purchased.
//
// The claim in this paragraph ("projection >= purchased ALWAYS, by
// construction") was true of the OLD `purchased + estimateToPurchase` formula
// this section is defending, and had been treated as ACCEPTABLY false under the
// 2026-08-17 fix above it: `invoiced + estimateToPurchase` can land below
// `purchased` whenever ETC hasn't (yet) caught up to an open PO's full amount,
// which was reasoned to be an honest answer — a manager's estimate can
// legitimately lag behind what TotalETO already shows committed, and a small or
// zero ETC beside a large "Left to be invoiced" is a visible signal worth
// surfacing rather than papering over.
//
// ── 2026-08-19: that tradeoff is no longer acceptable, by explicit business
// rule ────────────────────────────────────────────────────────────────────────
// Reported live on job 1119 (Karl Storz Stamping Machine): Total Parts Cost
// Spent $133,428 (Invoiced $124,581 + Left to be invoiced $8,847) showing
// GREATER than Actual/Projection $127,219 (Invoiced $124,581 + ETC $2,638) —
// a projected FINAL cost reading below money already spent or committed, which
// is not a number anyone can act on. The mechanism is exactly what the
// paragraph above already named: this job's Parts New ETC ($2,638) hadn't
// caught up to its own open PO balance ($8,847).
//
// The fix keeps the double-count fix's own reasoning (never sum
// `committedNotPosted` AND `estimateToPurchase` — see below) while adding the
// one guarantee the business now requires: Projection must never fall below
// `actual + committedNotPosted` (= Total Parts Cost Spent). Instead of adding
// both terms, `total` takes `actual` plus WHICHEVER of the two remaining terms
// is larger — `committedNotPosted` (money already on an open PO, which WILL be
// invoiced) or `estimateToPurchase` (the manager's forward estimate). This is
// the same "no double-count" property (still only ever one term riding on top
// of `actual`, never both), plus the new floor: whichever term is smaller can
// never drag the total below what the other alone already guarantees.
//
// When a manager's ETC is current (the common, healthy case — ETC already
// meets or exceeds the open commitment), nothing changes: `total` is still
// exactly `actual + estimateToPurchase`, byte-identical to the 2026-08-17
// formula. The fix only changes the answer in the specific case that was
// reported — a stale/small ETC beside a real open commitment — where it now
// floors at the committed amount instead of dipping below it. A small ETC next
// to a large "Left to be invoiced" is still visible on screen (that chip is
// unchanged) — it just no longer ALSO understates Projection.
//
// Also not the report's [Budget Projection] measure, which is
//   invoiced-before-this-month + estimate-to-complete
// counting only invoiced money and dropping any PO not yet invoiced, so it can
// land BELOW what a job has already purchased — on 2026-07-29 that was true for
// 1142 (report said $547,428 against $1,406,923 purchased) and 1101. The
// report's definition, for reference (model TMDL at
// SDC-PowerBI-DEV/…/tables/Measure Tables.tmdl):
//
//   Budget Projection =
//     VAR CurrentMonth = DATE(YEAR(TODAY()), MONTH(TODAY()), 1)
//     VAR FilteredInvoiced =
//       CALCULATE([Part Invoiced Amount],
//         FILTER(ALL('Part Purchase'[Invoiced Date]),
//                'Part Purchase'[Invoiced Date] < CurrentMonth))
//     RETURN FilteredInvoiced + [Part Cost Estimated To Complete]
//
// Reconstructed and checked against the live measure across all 103 jobs that
// return a value — largest difference $0.000000 — so that shape is the measure,
// not an approximation of it. It is a defect, not a preference, which is why
// this doesn't copy it.

// Everything already committed to a PO, invoiced or not — the "Purchased"
// figure the Parts Cost tiles show.
export function purchasedTotal(lines: PartsCostLine[]): number {
  let total = 0;
  for (const l of lines) total += l.totalPrice;
  return total;
}

// Parts ACTUAL — GL-posted spend, the app's one definition of it (see
// getPartsActualByJob in lib/sync-totaleto.ts). This is the projection's base as
// of 2026-08-10; it used to be purchasedTotal, which folded every open PO's
// undelivered balance into a figure the UI presented as money already spent.
export function actualTotal(lines: PartsCostLine[]): number {
  let total = 0;
  for (const l of lines) total += l.actualAmount;
  return total;
}

// Invoiced dollars strictly BEFORE the 1st of the current month — the report
// measure's FilteredInvoiced. Not part of the projection; kept because
// reconciling this page against the report needs it.
//
// `now` is injected rather than read here so the caller owns the clock (the DAX
// measure's own TODAY() resolves on the Power BI side, which is why the two can
// disagree across a month boundary).
export function invoicedBeforeCurrentMonth(lines: PartsCostLine[], now: Date): number {
  const firstOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  let total = 0;
  for (const l of lines) {
    if (!l.invoicedDate || !l.invoicedAmount) continue;
    const t = new Date(l.invoicedDate).getTime();
    if (Number.isNaN(t) || t >= firstOfMonth) continue;
    total += l.invoicedAmount;
  }
  return total;
}

// Returns `committedNotPosted` alongside the total for display (the card's
// "Left to be invoiced") — it is never SUMMED with `estimateToPurchase` into
// `total` (that's the 2026-08-17 double-count fix), but as of 2026-08-19 it
// does act as a FLOOR on `total` via projectionResidual: whichever of the two
// is larger is what rides on top of `actual`. `actual + committedNotPosted`
// is still the old `purchased` figure, kept available to callers that want it.
export type PartsBudgetProjection = {
  /** Parts Actual — GL-posted spend. The projection's base (2026-08-10). */
  actual: number;
  /**
   * Committed but not on the ledger: open PO balance plus anything billed on an
   * invoice that never posts to the GL. Shown on the card as "Left to be
   * invoiced" — because a manager's `estimateToPurchase` (Parts New ETC)
   * SHOULD already account for whatever is presently on order, summing this
   * alongside `estimateToPurchase` double-counts the common case (2026-08-17
   * fix) — but when the ETC estimate hasn't caught up to it yet,
   * `committedNotPosted` is what floors `total` instead (2026-08-19 fix,
   * projectionResidual). actual + committedNotPosted is still the old
   * `purchased` figure, kept available to callers that want it.
   */
  committedNotPosted: number;
  estimateToPurchase: number;
  total: number;
};

// The projection for a set of jobs. `jobPks` are Job.id primary keys (not job
// numbers) since that's what the ETC rollup is keyed by, and `month` is the ETC
// month to read the estimate from — normally the latest one.
//
// Null when there's no ETC month at all: an absent estimate is not the same as
// an estimate of zero, and the caller hides the bar rather than drawing a
// projection with half its formula missing. A job that HAS an ETC month but no
// Parts Cost row contributes 0, which is the real answer — syncPartsCost only
// skips jobs with no opening balance and no spend.
export async function computePartsBudgetProjection(
  jobPks: number[],
  lines: PartsCostLine[],
  month: string | null,
): Promise<PartsBudgetProjection | null> {
  if (!month || jobPks.length === 0) return null;
  const etc = await getExecutionEtcByJob(jobPks, month);
  let estimateToPurchase = 0;
  for (const pk of jobPks) estimateToPurchase += etc.get(pk)?.parts ?? 0;
  // Floor at 0: a month whose spend overran what it opened estimating has
  // nothing left to commit. Negative would push the projection below money
  // already spent — the exact defect the report measure has.
  estimateToPurchase = Math.max(0, estimateToPurchase);
  // Base = GL-posted actual. `committedNotPosted` is computed and returned for
  // display ("Left to be invoiced") but — 2026-08-17 — is NOT summed into
  // `total` alongside `estimateToPurchase`: `estimateToPurchase` (ETC) is drawn
  // down by GL-posted spend only (see the header), never by an open PO's
  // balance, so it still contains whatever `committedNotPosted` represents
  // until that PO is actually invoiced. Adding both to `actual` counts that
  // money twice.
  const actual = actualTotal(lines);
  // THE shared definition (lib/left-to-invoice.ts), which is exactly what this
  // expression already was: max(0, Sum(totalPrice) - Sum(actualAmount)). Lifetime
  // here on purpose - the projection asks where the job LANDS, not where it stood at
  // some month end.
  const committedNotPosted = leftToInvoiceForLines(lines);
  return {
    actual,
    committedNotPosted,
    estimateToPurchase,
    total: actual + projectionResidual(committedNotPosted, estimateToPurchase),
  };
}
