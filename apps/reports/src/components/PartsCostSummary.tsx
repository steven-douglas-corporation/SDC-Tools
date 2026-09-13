"use client";

import { usd } from "@/components/ui/format";
import { card } from "@/components/ui/classnames";
// reconcilePartsCostRounding dropped from this import 2026-09-04 — line 341 already
// explains why it is no longer used here, and the unused binding was the file's only
// lint warning.
import { sharedBarMax, scaleToPct, type PartsCostFinancials } from "@/lib/parts-cost-financials-shared";
import type { PartsDrillMode } from "@/components/PartsCostDrill";

// Fixed palette (2026-08-11, by request) — no longer the SDC-blue ramp, but
// still fixed constants rather than anything data-derived, so the same dollar
// role is always the same colour on every job and every screen. Certainty
// still reads bottom-to-top (darkest = actually spent and most certain,
// yellow = still a forecast), same idea the blue ramp encoded, new colours.
const BAR_BUDGET = "#5489EF";
const BAR_INVOICED = "#061D39"; // Invoiced — GL-posted, most certain
// BAR_SPENT (#AACEE8) removed 2026-09-03: it was the swatch for the informational
// "Left to be invoiced" chip, and the breakdown table marks reference rows with a
// hollow ring instead — a filled colour there implied a fourth band in the bar.
const BAR_PROJECTED = "#FFDE51"; // remaining exposure the ETC covers
// Remaining exposure the ETC does NOT cover (2026-09-03). The app's own --sdc-red,
// not a new tone: this is the same "needs attention" signal the rest of the card
// uses, and a second red would imply a second kind of problem.
const BAR_UNCOVERED = "#C0392B";

// Height taller than before (2026-08-10, by request) so the second bar's
// three segments have room to read as distinct shapes rather than thin stripes.
//
// ── Width: a deliberate match to the ETC chart's own bar, not a column fit
// (2026-08-12, by request — "the two charts' bars should be the same width")
// ─────────────────────────────────────────────────────────────────────────
//
// Every earlier version of this constant (4.5rem, then 4rem via §81, then
// 5rem last pass) answered a DIFFERENT question — "how wide does the bar
// need to be to fill its own column, so the label/caption above it don't
// leave dead padding beside a too-narrow bar" — and kept growing because the
// label kept growing. That question is retired now: the bar's width is no
// longer derived from anything in THIS card. It is a literal copy of
// SectionHierarchyChart's own bar cap (JobHoursDashboard.tsx's `Bar`
// component, `max-w-5` = 1.25rem), so a Budget bar and an ETC-chart section
// bar read as the same physical width side by side, which is the whole ask.
//
// That means the bar is now narrower than its own label/caption most of the
// time (a 10-character dollar figure at text-xs/font-bold is ~65-70px, and
// "Projection" alone is ~57px — both well past 18.75px) — this is EXPECTED
// and no longer a bug the way it was when this constant used to chase the
// label. The column each bar sits in is a `flex-col items-center` (below),
// so it simply centers the narrow bar under whichever of {label, caption} is
// wider, the same way SectionHierarchyChart's own narrow bars sit centered
// under their own (comparatively wide) value labels — nothing here is doing
// anything that chart doesn't already do with an even bigger size gap.
const BAR_W = "1.25rem";

// ── Height: measured to share ONE baseline with the ETC chart beside it ──────
//
// The two cards are siblings in JobHoursDashboard's `lg:grid-cols-[2fr_1fr]`
// row, and SectionHierarchyChart (same file as that grid) draws its bars in a
// grid with a hard `height: 300`. Measured live at 15px root: that grid's
// bottom sat 74.4px BELOW these bars' bottom — the empty band under this
// card's bars, reported with the gap circled.
//
// 294 is not a guess: both cards start at the same y (one grid row), and
// everything above the bars in each card is fixed-height — the ETC chart's bar
// grid starts 72px below its card's top, and this card's bar BOX starts 77.6px
// below its own (padding + header + py-1 + the value label + its gap). So
// 372 - 77.6 ≈ 294 puts the two baselines on the same line BY CONSTRUCTION,
// which is what makes the alignment survive the drill-open state too: opening a
// section drill switches that grid from `items-stretch` to `items-start`, so
// this card stops being stretched — a height tuned against the STRETCHED
// spacer instead would drift the moment that happened.
//
// It also absorbs the 72.8px `flex-1` spacer that used to sit between the bars
// and the summary below, which is where the "excessive whitespace" came from:
// the card's own height is set by the taller ETC card next to it, and that
// spacer was soaking up the difference.
// 540, up from 414 (2026-08-14, by request — "increase vertical height ~30%")
// — the same +126 SectionHierarchyChart's own BAR_H just took (420→546), not
// a number picked independently.
//
// The "77.6px" derivation above is stale as of the value-label fix later in
// this file (2026-08-14, same day): that offset counted "the value label +
// its gap" as flow height sitting BEFORE the bar box, which was true only
// because the label used to live outside it. It now lives INSIDE the same
// BAR_H frame (packed against the bottom with the fill, so it tracks the
// fill's actual top instead of floating at the frame's top) — the frame
// itself starts higher up than 77.6px did, by roughly that label's own
// line-height plus its gap. BAR_H is unchanged and still kept in step with
// SectionHierarchyChart's own 546 (both took the identical +126 this pass),
// but re-deriving an exact new offset/baseline match is a live-measurement
// exercise neither this pass nor the one before it was asked to do.
const BAR_H = 540; // px — see above; keep in step with SectionHierarchyChart's own 546
// The caption band under each bar ("Budget" / "Actual / Projection").
//
// Used to be shared with a second constant (LEGEND_BOTTOM_OFFSET) that placed
// the legend band to end level with the bar box, back when the legend was an
// absolutely-positioned column stretched to BAR_H — removed 2026-08-12c along
// with that whole positioning scheme (see the legend's own comment below);
// CAPTION_H itself stays, since the two caption boxes still need it.
const CAPTION_H = "2rem";


// ── History: pinned → horizontal group → vertical list (2026-08-12c/d) ─────
//
// The original design pinned each marker to its own segment's exact pixel
// midpoint (placeMarkers/MARKER_SLOT, removed — see git history if that math
// is ever needed again), on the theory that a marker should visually point
// at the thing it names. That held up fine until this card's bars ALSO grew
// (2026-08-12a/b, matching the ETC chart's height and bar width): three
// markers spread across a 414px bar, each anchored to a segment that can be
// a sliver or the whole bar, read as "stacked awkwardly, spread out
// vertically" — correct positioning, on a bar tall enough that "precisely
// where the segment sits" and "reads as one tidy group" stopped being the
// same thing.
//
// The first fix (2026-08-12c) replaced pinning with a horizontal flex-wrap
// group, capped at a fixed max-width so it would wrap to a second line
// instead of spreading. That made the CARD's own minimum width follow the
// wrap width instead of the bars beside it — "unbalanced and stretched",
// reported directly — because a flex-wrap child's contribution to an outer
// flex row's sizing is its unwrapped, one-line max-content width, not
// whatever width it actually wraps to at render time; the cap controlled the
// wrap, not the space this block asked its parent for.
//
// 2026-08-12d drops the cap and the wrap along with it: a plain vertical
// list (`flex-col`), one row per segment, sized to its own longest row —
// nothing here can be wider than "Left to be invoiced $41,418", which is
// narrower than the card already needs for its OWN captions ("Actual /
// Projection"), so this block was never actually the thing forcing the card
// wide; it only looked that way while wrapping was in the mix.
/**
 * Which drill view a bar segment opens.
 *
 * `uncovered` maps to the open-exposure rows rather than to a view of its own: it is
 * an arithmetic slice of that exposure (To complete − Current ETC), not a label any
 * PO line carries, so there is no set of rows that IS the uncovered amount. Sending
 * it to the exposure it belongs to — with the panel stating the split — is the
 * honest answer; inventing a filter would imply a line-level attribution that does
 * not exist.
 */
function segmentDrillMode(key: string): PartsDrillMode {
  if (key === "etc") return "etc";
  if (key === "uncovered") return "left";
  return "invoiced";
}


// Parts Cost money block for the Job Hour Details page — the app's version of
// the Power BI report's Parts Cost visual.
//
// ── History ───────────────────────────────────────────────────────────────
//   §52: 4-5 separate horizontal bars — replaced because unlabeled rows made
//        "how do these relate" a multi-glance comparison instead of a
//        one-glance one.
//   §61: ONE vertical bar whose three segments were increments stacked to a
//        shared total — replaced because Dan wanted the metrics separable
//        again, not folded into one bar's segments.
//   §78: back to four separate rows, each stating its own ABSOLUTE amount
//        against a common max, with a direct dollar value beside every label.
//   2026-08-10a: two vertical bars on ONE shared scale — Budget on its own,
//        Actual/Projection as a single cumulative bar summing to Projection.
//   2026-08-10b: tried scaling each bar to ITSELF instead, so Projection
//        couldn't influence Budget's height at all — reverted the same day:
//        the two bars are meant to be compared by height (a bigger number
//        must draw taller), which a self-scaled Budget bar can never show.
//   2026-08-10c: back to the shared scale from (a), with the actual bug fixed
//        instead — the three segment labels beside Bar 2 now sit in normal
//        document flow rather than pinned to each segment's exact pixel
//        position, which is what let two labels overlap the moment one of
//        them wrapped onto a second line.
//   2026-08-11a: colors switched to a fixed palette (#5489EF Budget;
//        #061D39/#AACEE8/#FFDE51 for the three Bar-2 segments) instead of
//        the SDC-blue ramp. Same three values, same stacking, same shared
//        scale — colors and labels only.
//   2026-08-11b (this one, by request): Budget and Bar 2 tightened into one
//        gap-1.5 pair (same spacing the ETC chart's own Quoted/Actual bar
//        pairs use) instead of sitting a full gap-4 apart, and the three
//        segment labels renamed again — Invoiced / Left to be invoiced / ETC
//        — replacing the (a) names. Colors, values and stacking unchanged.
//   2026-08-17 (double-count fix, by request): Bar 2 dropped from three
//        stacked segments to TWO — Invoiced, then ETC — because "Left to be
//        invoiced" was already inside ETC (ETC draws down by GL-posted spend
//        only, never by an open PO's balance — see
//        parts-budget-projection.ts's header for the mechanism and real
//        numbers). Left to be invoiced is still shown, as an informational
//        chip beside the bars labelled "Included in ETC", not as a segment.
//        "Total Parts Cost Spent" (Invoiced + Left to be invoiced) is
//        unchanged — that sum was never the bug.
//
// These KPIs originally lived inside PartsCostSection (77c6187) and were lost
// when the two-tab Procurement drawer replaced that component wholesale
// (739e2c5 — "drops the now-unused PartsCostSection import"). Restored here as
// summary-ONLY: PartsCostSection also carried slicers and an 800-row parts
// table, and Procurement's Parts List tab is now the place for per-line detail.
//
// A client component so it composes as a grid item beside the two hours charts
// in JobHoursDashboard (§52) — it takes plain numbers rather than the whole
// JobPartsCost, since the parts `lines` array is already serialized once for
// Procurement and there's no reason to ship it twice.
export function PartsCostSummary({
  financials,
  jobCount = 1,
  onDrill,
  drillMode = null,
}: {
  // The one Parts Cost reconciliation (src/lib/parts-cost-financials.ts,
  // audit "Audit Parts Cost Projection Formula Across All Projects",
  // 2026-08-15) — replaces the four separate props this card used to take
  // (`purchased`, `actual`, `estimated`, `budgetProjection`), each previously
  // re-derived by the page rather than read from one shared function. Same
  // underlying numbers, same formula; this just means every consumer of this
  // card reads them from the same place instead of risking a second
  // re-derivation drifting from the first.
  financials: PartsCostFinancials;
  // How many jobs these totals cover. The money figures aggregate correctly
  // across a multi-job selection (unlike the BOM below them), so the card
  // follows the slicer — it just has to say how many jobs it's adding up.
  jobCount?: number;
  // ── Drill-through (2026-09-02) ────────────────────────────────────────────
  //
  // The card raises WHICH part of the bar was clicked; the panel itself is rendered
  // by the page, full width below the charts row, because an eleven-column part-level
  // table cannot be read in the ~15% column this card occupies. Optional, so the card
  // still renders as a plain summary anywhere with nowhere to put a drill.
  onDrill?: (mode: PartsDrillMode) => void;
  /** Which drill is open, so the segment that opened it can show it is the active one. */
  drillMode?: PartsDrillMode | null;
}) {
  const failedJobs = financials.failedJobs;
  // Treat a ZERO quote as "nothing on file", not as a $0 target — an absent
  // estimate must not read as $0 estimated. (getPartsCostFinancials already
  // applies this: budget is null unless quoted > 0.)
  const estimate = financials.budget;

  // ── The Actual/Projection bar's TWO segments (2026-08-17 fix) ─────────────
  //
  // Used to be three, stacked as increments — Invoiced, then Left to be
  // invoiced, then ETC — on the theory that Actual sits inside committed
  // spend and committed spend sits inside Projection. That theory doesn't
  // hold: ETC (the app's Parts New ETC) is drawn down by GL-posted spend
  // only, never by an open PO's balance, so "Left to be invoiced" money stays
  // fully present inside ETC until it's actually invoiced — stacking it a
  // second time between Invoiced and ETC double-counted it. See
  // parts-budget-projection.ts's header for the full mechanism and the real
  // numbers that surfaced it.
  //
  // The bar now stacks exactly what Projection sums: Invoiced (GL-posted,
  // most certain) then the remaining residual on top — usually the ETC
  // forecast, but as of 2026-08-19 (job 1119, Karl Storz — Projection reading
  // BELOW Total Parts Cost Spent) it floors at "Left to be invoiced" whenever
  // ETC hasn't caught up to it, so this second segment can be either term
  // depending on which is larger (see projIncrement below). "Left to be
  // invoiced" is still shown — just as an informational side figure below,
  // not a segment of this bar — because it answers a real question ("how
  // much of ETC is already spoken for by an open PO") that showing only two
  // segments would otherwise drop.
  //
  // The BASE segment is Parts Actual — GL-posted spend — not `paid` (2026-08-10).
  // `paid` counts invoices flagged never to post to the general ledger, so it read
  // high against the job ledger people check this card against.
  const invoiced = financials.invoiced; // base segment — "Invoiced"
  const spent = financials.totalSpent; // Invoiced + Left to be invoiced — NOT the bar's total (see below)
  const projTotal = financials.projection; // = invoiced + max(leftToInvoice, etc) as of 2026-08-19 — the bar's own total height
  // `financials.leftToInvoice` is deliberately NOT read here any more. It is the
  // open balance over ALL rows; the card's "Left to invoice" row shows the EXTERNAL
  // figure (financials.yetToInvoice, in-house SDC excluded), because that is the one
  // the projection is built on. Reading both would put two different numbers under
  // one name on the same card.
  // "ETC" — the bar's second (and last) segment. Deliberately the RESIDUAL
  // (projTotal - invoiced), not `financials.etc` directly (2026-08-19): since
  // the fix for job 1119 (Karl Storz), `projTotal` can be `invoiced +
  // leftToInvoice` rather than `invoiced + etc` whenever a stale/small ETC
  // hasn't caught up to an open commitment — see
  // parts-budget-projection.ts's `projectionResidual`. Reading it as a
  // residual keeps this segment's rendered HEIGHT consistent with the total
  // no matter which of the two terms actually won; reading `financials.etc`
  // directly would draw a shorter segment than the bar's own total implies
  // in exactly that case.
  // ── Dan's projection model (2026-09-03) ───────────────────────────────────
  //
  //         RED      additionalExposure = max(0, yetToInvoice - adjustedEtc)
  //     ---------    coverageLine       = invoiced + adjustedEtc
  //        YELLOW    adjustedEtc        = max(0, priorEtc - partsSpentThisMonth)
  //         BLUE     invoiced
  //
  // Every figure comes from getPartsCostFinancials — lib/parts-projection.ts holds
  // the arithmetic and its tests (both worked examples from the spec, plus job
  // 1101's real numbers), and lib/parts-prior-etc.ts resolves the two ETC inputs off
  // the selected month's own Monthly ETC row. The card re-derives nothing, so it
  // cannot disagree with the drill-through or the grid.
  //
  // Note the yellow segment is NOT the current month's New ETC. It is the PRIOR
  // month's forecast drawn down by this month's spend — §20 is explicit that
  // confusing the two is the mistake to avoid, and an earlier version of this card
  // made exactly it.
  const openBalanceAmount = financials.openBalance;
  const adjustedEtcAmount = financials.adjustedEtc;
  const additionalAmount = financials.additionalExposure;
  const coverageLineAmount = financials.coverageLine;
  const hasAdditional = additionalAmount > 0.5 && coverageLineAmount != null;
  const etcUnknown = financials.etcUnknown;

  // ── Rounding that can't visibly contradict itself (audit finding) ─────────
  //
  // Two independent reconciliations now, for the two captions that each sum a
  // different pair of displayed figures:
  //   - "Total Parts Cost Spent" = Invoiced + Left to be invoiced (unchanged
  //     by the 2026-08-17 fix — still real money moved or committed).
  //   - The bar's own two segments = Invoiced + ETC, which must sum to the
  //     separately-rounded Projection total the same way.
  // Rounding each figure independently, then summing the DISPLAYED numbers,
  // doesn't always equal a total rounded on its own — e.g. 23207.616 +
  // 189298.04 = 212505.66 exactly, but round(23207.616) + round(189298.04) =
  // 212506, one dollar more than round(212505.66) = 212506... the fix is to
  // round for DISPLAY only, letting the LAST term in each sum absorb whatever
  // rounding residue is left, so both displayed subtotals always equal the
  // sum of the figures shown beside them.
  const projTotalDisplay = Math.round(projTotal);

  // ── Which figure absorbs the rounding residue (fixed 2026-09-03) ──────────
  //
  // The three printed segments must sum to the printed total, or the card visibly
  // fails to add up. Rounding each independently does not guarantee that, so one of
  // them absorbs the difference.
  //
  // It used to be the ETC ADJUSTED figure, and that was the wrong choice — it
  // produced a bug reported on job 1101. There, prior-month ETC is $5,621.59 against
  // $10,795.96 spent this month, so the adjusted ETC is negative and floors to
  // exactly $0: there is no yellow segment at all. But the residue still landed on
  // it, and the card printed:
  //
  //     ETC adjusted    $1
  //     $5,622 prior-month ETC − $10,796 spent this month
  //
  // A row whose own stated arithmetic gives a negative number, displaying $1. Worse
  // than a cosmetic slip: it invents a forecast that does not exist, on the one row
  // people are checking, directly under the subtraction that disproves it.
  //
  // INVOICED absorbs it instead. It is the largest term by orders of magnitude
  // ($730,483 against $0 here), so a ±$1 shift is invisible in it, and — the actual
  // point — a term that is genuinely zero now prints as zero, because it is rounded
  // from its own value rather than derived by subtraction.
  //
  // reconcilePartsCostRounding is no longer used here: it distributes a residue
  // across a set, which is the wrong shape for this. What is needed is one named
  // absorber, chosen because it can afford it.
  const adjustedEtcDisplay = Math.round(adjustedEtcAmount);
  const additionalDisplay = Math.round(additionalAmount);
  const invoicedDisplay = projTotalDisplay - adjustedEtcDisplay - additionalDisplay;

  // ── ONE shared scale for both bars (2026-08-10c, by request) ──────────────
  //
  // Budget and Bar 2 (Actual/Projection) are plotted against the SAME maximum,
  // so a taller bar always means more dollars regardless of which side it's
  // on — $1,566,916 draws visibly taller than $1,300,000. A previous version
  // scaled each bar to itself so Projection could never influence Budget's own
  // height; by request that's reverted, since the two bars ARE meant to be
  // compared by height, and the fixed-scale version made every job's Budget
  // bar look identical regardless of its actual size.
  //
  // `maxValue` and `pct` (now `sharedBarMax`/`scaleToPct`, extracted to
  // parts-cost-financials-shared.ts 2026-08-17 so the invariant below is
  // provable with real arithmetic, not just readable) are the ONLY two things
  // that decide a bar's height — there is deliberately no second, per-bar
  // scale anywhere else in this file. Reported concern: "the second bar looks
  // taller despite a lower total" — the shared domain here already makes that
  // impossible by construction (see tests/parts-cost-bar-scale.test.ts). On
  // the specific figures reported the actual gap was a real but small ~1.4%,
  // genuinely hard to eyeball at a glance — especially with a bright yellow
  // segment on top of one bar and none on the other; brighter colour reads as
  // "more" even at equal or lesser height. The pixel math itself was already
  // correct; headroom (below) is the one concrete thing that was missing.
  const maxValue = sharedBarMax(estimate ?? 0, projTotal);
  // Headroom (2026-08-17, by request: "only a small headroom for labels if
  // needed") — the value LABEL sits inside the same fixed-height frame as the
  // fill (see the frame's own comment below), packed against its bottom edge
  // alongside the fill. At a full 100% fill, the label has to render above the
  // frame's own top edge with nothing reserved for it. Capping the domain's
  // ceiling at 94% instead of 100% means even the tallest bar on the shared
  // scale leaves a consistent 6% band clear at the top for the label — the
  // SAME cap for both bars, so it changes nothing about their relative
  // heights (a value at 50% of maxValue is still exactly half the height of a
  // value at 100% of maxValue; both simply top out at 94% of BAR_H rather than
  // 100%), only where "full height" now sits inside the frame.
  const FILL_CEILING_PCT = 94;
  const pct = (v: number) => scaleToPct(v, maxValue, FILL_CEILING_PCT);
  // A percentage-of-scale as an actual PIXEL height against BAR_H — see the
  // value-label fix below for why this replaced the old `${pct}%` heights.
  const barPx = (percent: number) => (BAR_H * percent) / 100;

  // Segments bottom-to-top, each sized against the SAME shared scale as
  // Budget — Bar 2's own rendered height is the sum of these two, which
  // equals pct(projTotal) exactly, so "the bar's total height is Projection"
  // still holds. Always the actual; the ETC segment only exists (and is only
  // labelled) when there IS a projection to show — you can't state a share
  // of a figure that was never computed.
  // `value` here is the RECONCILED whole-dollar figure (see above) — what's
  // displayed beside the bar — while `heightPct` still scales off the raw,
  // full-precision figure, since the bar's geometry has no rounding-sum
  // problem to begin with (only the printed dollar labels do).

  // ── The stack, bottom to top (spec §1 and §12) ────────────────────────────
  //
  // The red section "may or may not be anything" (§11): it is pushed only when the
  // remaining exposure actually exceeds the adjusted forecast, so an on-plan job
  // carries no red at all.
  const segments: { key: string; label: string; note?: string; value: number; color: string; heightPct: number }[] = [
    { key: "invoiced", label: "Invoiced actual", value: invoicedDisplay, color: BAR_INVOICED, heightPct: pct(invoiced) },
  ];
  if (adjustedEtcAmount > 0.5) {
    segments.push({
      key: "etc",
      label: "Adjusted ETC remaining",
      note: etcUnknown ? undefined : "prior-month ETC less this month's spend",
      value: adjustedEtcDisplay,
      color: BAR_PROJECTED,
      heightPct: pct(adjustedEtcAmount),
    });
  }
  if (hasAdditional) {
    segments.push({
      key: "uncovered",
      label: "Uncovered invoice exposure",
      note: "beyond the adjusted ETC",
      value: additionalDisplay,
      color: BAR_UNCOVERED,
      heightPct: pct(additionalAmount),
    });
  }

  // ── The breakdown table (2026-09-03, by request) ──────────────────────────
  //
  // Reported: "instead of raw text at the bottom, could I have a table showing what
  // each colour denotes, and also how that number was arrived at — sort of showing
  // the clear calculation, making it more reliable."
  //
  // So each row carries three things rather than two: the SWATCH that ties it to a
  // band in the bar, the figure, and the ARITHMETIC that produced the figure written
  // out with its own inputs substituted in. A reader can check every number on the
  // card against the row above it without opening the drill-through.
  //
  // Built from the same `financials` the bar is drawn from — not recomputed — so a
  // row can never state a derivation the bar did not use. The three coloured rows
  // sum to the `total` row by construction: that is the same
  // `invoiced + adjustedEtc + additionalExposure` the projection is defined as, and
  // the printed figures are the rounding-reconciled ones, so the column adds up on
  // screen as well as in the arithmetic.
  //
  // `reference` rows are the inputs the coloured rows are derived FROM. They are
  // separated because they are not parts of the bar — listing them with a filled
  // swatch would imply a fourth and fifth band.
  type BreakdownRow = {
    key: string;
    swatch: string | null;
    label: string;
    /** How this figure was arrived at, with the actual inputs in it. */
    derivation: string;
    value: number;
    kind: "segment" | "total" | "reference";
  };

  const spentThisMonth = financials.partsSpentThisMonth;
  const priorEtcAmount = financials.priorEtc;

  // ── Five rows, by request (2026-09-03) ────────────────────────────────────
  //
  // Purchased, Invoiced, Left to invoice, ETC adjusted, Total projection — and each
  // one carries the arithmetic that produced it, so the column can be checked on
  // sight rather than taken on trust.
  //
  // The earlier eight-row version listed the inputs separately (prior-month ETC,
  // yet-to-invoice, uncovered exposure, in-house excluded). Those figures have not
  // gone anywhere: each is now inside the derivation of the row it feeds, which is
  // where a reader wants it. The full set is still in the drill-through.
  //
  // ── One thing that had to be got right, or the column would not tie ──────
  //
  // "Left to invoice" here is the EXTERNAL remaining exposure — it excludes in-house
  // SDC, because that work never produces a supplier invoice. So it is NOT simply
  // `Purchased − Invoiced`: on job 1101 that subtraction gives $61,126 while the
  // external figure is $44,992, and the projection is built on the second. Writing
  // "Purchased − Invoiced" as this row's derivation would have been a visible lie in
  // a table whose whole purpose is to be checkable, so the derivation names the
  // exclusion explicitly and the numbers reconcile.
  // Reported, not subtracted: in-house work is committed cost, it simply will not
  // arrive as a supplier invoice. Subtracting it from the total was the 2026-09-03
  // bug that made the projection fall below Purchased.
  const inHouseNote =
    financials.inHouseExcluded > 0.5
      ? ` · ${usd(Math.round(financials.inHouseExcluded))} of it in-house (no supplier invoice)`
      : "";

  const breakdown: BreakdownRow[] = [
    {
      key: "purchased",
      swatch: null,
      label: "Purchased",
      derivation: "every parts line's total cost on this job",
      value: Math.round(financials.purchased),
      kind: "reference",
    },
    {
      key: "invoiced",
      swatch: BAR_INVOICED,
      label: "Invoiced",
      derivation: "GL-posted parts spend, all POs, lifetime",
      value: invoicedDisplay,
      kind: "segment",
    },
    {
      key: "left",
      swatch: hasAdditional ? BAR_UNCOVERED : null,
      label: "Left to invoice",
      // The WHOLE open balance now, so this row is exactly Purchased − Invoiced and
      // the column ties without a caveat. The in-house split is reported alongside
      // rather than subtracted out — it is committed cost either way, and removing it
      // from the total was the bug this replaced.
      derivation: `${usd(Math.round(financials.purchased))} purchased − ${usd(invoicedDisplay)} invoiced${inHouseNote}`,
      value: Math.round(openBalanceAmount),
      kind: hasAdditional ? "segment" : "reference",
    },
    // ── Billed, not posted (2026-09-04) ─────────────────────────────────────
    //
    // A COMPONENT of the row above, indented under it, never an addend — adding it
    // anywhere would double-count. Shown only when it is non-zero, which on most jobs
    // it is: a job with no Sage-first-but-unclassified spend should not carry a row
    // explaining that it has none.
    //
    // It exists because this figure was invisible until somebody compared eight jobs by
    // hand (docs/PARTS-COST-VARIANCE-2026-09.md). Job 1106 carries $253,015 of it, all
    // five of them ETO-side corrections rather than anything awaiting an invoice.
    ...(Math.abs(financials.billedNotPosted) >= 1
      ? [
          {
            key: "billednotposted",
            swatch: null,
            label: "· billed, not GL-posted",
            derivation:
              "already invoiced on a document flagged never-to-export, so it stays in Left to invoice — see docs/PARTS-COST-VARIANCE-2026-09.md",
            value: Math.round(financials.billedNotPosted),
            kind: "reference" as const,
          },
        ]
      : []),
    {
      key: "etc",
      swatch: adjustedEtcAmount > 0.5 ? BAR_PROJECTED : null,
      label: "ETC adjusted",
      derivation:
        priorEtcAmount == null
          ? "no prior-month ETC on file for this job"
          : `${usd(Math.round(priorEtcAmount))} prior-month ETC − ${usd(Math.round(spentThisMonth))} spent this month`,
      value: adjustedEtcDisplay,
      kind: adjustedEtcAmount > 0.5 ? "segment" : "reference",
    },
    {
      key: "total",
      swatch: null,
      label: "Total projection",
      // Spelling out WHICH of the two rides on top of Invoiced, rather than printing
      // `max(...)` at someone. The red band, when there is one, is named here too —
      // it has no row of its own now, and an unexplained colour in the bar would be
      // worse than a longer sentence.
      derivation: hasAdditional
        ? `${usd(invoicedDisplay)} invoiced + ${usd(adjustedEtcDisplay)} ETC adjusted + ${usd(additionalDisplay)} beyond it (red)`
        : `${usd(invoicedDisplay)} invoiced + ${usd(adjustedEtcDisplay)} ETC adjusted`,
      value: projTotalDisplay,
      kind: "total",
    },
  ];


  // ── A thin segment still has to be seeable (2026-09-03, by request) ───────
  //
  // Reported: when the ETC is small against Invoiced, the yellow cap is too thin to
  // notice, so a reader cannot tell ETC coverage exists at all. On the reported job
  // it is $5,622 of a $791,609 bar — 0.7%, about 3.6px of the 540px frame.
  //
  // So a segment with a non-zero value is given a floor of MIN_SEG_PX, and the
  // pixels are BORROWED FROM THE TALLEST segment rather than added to the stack.
  // That is what keeps the promise this card is built on: the bar's total height
  // stays exactly `invoiced + toComplete`, so it still compares correctly against
  // the Budget bar beside it on the shared scale. Adding the pixels instead would
  // make an under-planned job draw taller than a fully-planned one with the same
  // total, which is a worse lie than the one being fixed.
  //
  // The borrow is imperceptible in practice — 6px off a ~470px Invoiced segment on
  // the reported job — and it is bounded: the donor can never fall below
  // MIN_SEG_PX itself, so this cannot invert the visual order of two segments.
  //
  // NOTHING numeric changes. The values, the totals, the label above the bar, the
  // legend and the drill-through all still read the true figures; only the rendered
  // pixel heights move. `heightPct` (the true share) is kept alongside so the two
  // can never be confused at the call site.
  const MIN_SEG_PX = 10;
  const renderPx: number[] = segments.map((seg) => barPx(seg.heightPct));
  {
    let borrowed = 0;
    for (let i = 0; i < renderPx.length; i++) {
      // A zero segment is not drawn at all — a floor there would invent a band for
      // money that does not exist.
      if (segments[i].heightPct <= 0) continue;
      if (renderPx[i] < MIN_SEG_PX) {
        borrowed += MIN_SEG_PX - renderPx[i];
        renderPx[i] = MIN_SEG_PX;
      }
    }
    if (borrowed > 0) {
      let tallest = 0;
      for (let i = 1; i < renderPx.length; i++) if (renderPx[i] > renderPx[tallest]) tallest = i;
      renderPx[tallest] = Math.max(MIN_SEG_PX, renderPx[tallest] - borrowed);
    }
  }

  // Where the dotted line sits, in RENDERED pixels rather than true share: it marks
  // the top of the yellow cap, so it has to move with the cap when the cap is
  // floored — otherwise the line would cut through the middle of the segment it is
  // supposed to bound. The figure it REPORTS is still the true `coverageLine`.
  const coverageLinePx = (() => {
    let px = 0;
    for (let i = 0; i < segments.length; i++) {
      px += renderPx[i];
      if (segments[i].key === "etc") return px;
    }
    // No covered segment (an ETC of 0): the boundary is the top of Invoiced.
    return renderPx[0] ?? 0;
  })();


  // ONE meter: where the job is HEADING against what it was sold for.
  //
  // Was two (purchased-vs-budget and projected-vs-budget), which showed the same
  // "87.2% of $636,234" twice on a job that has finished buying — two controls
  // saying one thing. Purchased is already in the bars above; the only figure
  // that needed its own control is the forward-looking one.
  //
  // Stated as a signed VARIANCE rather than a share: "12.8% under" is the
  // sentence someone actually needs, where "87.2% of budget" makes the reader do
  // the subtraction. Sign convention matches the Projects grid — under budget is
  // green, over is red.
  // Nothing bought and nothing projected. The variance maths is technically
  // right — $0 against an $8,600 quote IS 100% under — but "100.0% under" in
  // green announces a triumph on a job where the buying simply hasn't started,
  // and that's the reading someone acts on. An absence of data isn't a saving.
  const noPartsActivity = spent === 0 && projTotal === 0;

  const variance =
    estimate != null && financials.variance != null && !noPartsActivity
      ? {
          estimate,
          dollars: financials.variance, // + = over
          pct: financials.variancePct! / 100,
        }
      : null;

  return (
    // The four KPI cards that used to sit beside this chart are gone by
    // request — every figure they showed is already labelled below.
    // Horizontal padding tightened from the shared p-4 to px-3 (§79), then to
    // px-2 (§81, alongside the row's 85/15 split): on this card's ~15%-of-row
    // column, every rem of horizontal padding is a bigger share of the card
    // than it was at 33% or even 20%. Vertical padding (py-4) is untouched.
    //
    // Deliberately NOT `min-w-0` (§81): that would let the 3fr grid track in
    // JobHoursDashboard shrink this card to EXACTLY 15%, no matter what —
    // and on a job with 8-figure dollar amounts, 15% is narrower than the
    // (unbreakable) money text needs, which without this is a card that
    // shrinks until its own numbers overlap. Leaving the browser's ordinary
    // "a grid item never shrinks below its own content's minimum" behaviour
    // in place instead means the row renders at a true 85/15 whenever the
    // figures fit that (every job seen so far), and gives this card only the
    // few extra pixels its own numbers actually need on the rare job that
    // doesn't — the same "legible over exact" trade this file's own history
    // keeps making, just enforced one level up instead of inside the card.
    <div className={`${card("px-2 py-4")} flex h-full flex-col`}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="font-heading text-base font-bold tracking-tight text-sdc-navy">Parts Cost</p>
        <p className="text-note text-sdc-gray-400">
          {jobCount > 1 ? `Summed across all ${jobCount} selected jobs` : "For the selected job"}
        </p>
      </div>
      {failedJobs > 0 && (
        <p className="mb-2 rounded border border-sdc-yellow bg-sdc-yellow-bg px-2 py-1 text-note text-sdc-yellow-text">
          {failedJobs} of {jobCount} jobs couldn&apos;t be reached in Total ETO, so their parts are missing from these totals. The
          figures below are a floor, not the full picture.
        </p>
      )}

      {/* ── The two bars (2026-08-11) ────────────────────────────────────────
          Budget and Bar 2 sit in their OWN tight-gap row (`gap-1.5`) — the
          same pair spacing the Estimate to Complete vs Actual chart uses
          between its own Quoted/Actual bars (SectionHierarchyChart's `Bar`
          pair) — nested inside the wider row that also holds the legend, so
          tightening the pair doesn't also crowd the labels beside it. Budget
          and Bar 2 share one scale (`pct`), so Budget draws visibly shorter
          than a larger Actual/Projection bar. Bar 2 is one cumulative column
          (Invoiced, then ETC — 2026-08-17, was Invoiced/Left to be
          invoiced/ETC until the double-count fix, see this file's header);
          its OWN rendered height is the sum of the two, which is
          Projection's own share of the shared scale. No border on the
          fills, no reference lines, no brackets — the colour step is the
          only thing separating one segment from the next. The segment rows
          sit in a compact vertical list beside the bars (2026-08-12d),
          ordered to match the bar's top-to-bottom stacking, so no row can
          ever overlap another and nothing here can be wider than its own longest row — see that
          list's own comment below.

          Both captions are pinned to a fixed `h-8` box (2026-08-11b) — NOT
          left to size to their own text — because a flex column's width is
          set by its WIDEST child, and one-line "Actual / Projection" was
          wider than either bar, pushing bar 2 outward inside its own column
          and reopening the gap `gap-1.5` was supposed to close. Wrapping it
          onto two shorter lines fixes the width; the fixed caption height
          fixes a second-order effect of that same fix — a 2-line caption is
          taller than "Budget"'s 1 line, and `items-end` bottom-aligns the
          two columns AS WHOLES, so without a shared reserved height the
          taller column would push its own bar down, breaking the shared
          baseline the two bars are supposed to sit on.

          The captions were never the whole story, though (2026-08-11d) — the
          DOLLAR VALUE above each bar is wider still (measured ~58-80px
          depending on the amount), so even with the caption fixed the column
          stayed exactly that much wider than the bar, and the leftover
          padding on each side of a too-narrow bar was almost the entire
          visible gap. Widening the bar to fill that column (2026-08-11d
          through 2026-08-12a) made `gap-1.5` the real, whole gap between the
          two bars — measured at the time: dropped from ~44.6px to exactly
          5.625px once the bar matched its column's width.

          2026-08-12b supersedes that specific fix, by request: the bar is
          now a fixed 1.25rem — matching the ETC chart's own bar width rather
          than filling this column — so the dead padding beside a narrower
          bar is BACK, deliberately. The apparent gap between the two bars
          reads close to that original ~44.6px again, not 5.625px; this is
          the direct, accepted cost of "same bar width as the other chart"
          rather than a regression of the §81/2026-08-11d fix. Both bars
          still center correctly under their own label/caption (`items-center`
          on each column, untouched) and stay the SAME width as each other,
          which is what "balanced" asks for — it just no longer also means
          "touching". */}
      {/* `items-center`, not `items-end` (2026-08-12c) — the legend group is
          no longer stretched to BAR_H (see its own comment), so it's a much
          shorter block than the bar pair beside it; centering the two
          against each other is what makes a short legend and a tall bar
          pair read as one balanced row instead of the legend looking glued
          to the bottom. This only affects how these TWO top-level children
          align against each other — the bar pair's OWN internal alignment
          (Budget vs Actual/Projection, `items-end` on the nested row below)
          is untouched. */}
      {/* ── The legend moved BELOW this row (2026-09-03, by request) ─────────
          This row held two children — the bar pair and the segment legend — side by
          side, and the legend's own width (its longest row) is several times the
          pair's. In a ~15%-of-row card that pushed the bars hard against the card's
          left edge, and each bar's value label is WIDER than its 1.25rem bar (see
          BAR_W), so the leftmost label overhung the card border and clipped.

          With the legend gone from this row, `justify-center` centres a genuinely
          compact pair in the card's full inner width. `px-3` is the guard that makes
          the clearance a guarantee rather than a consequence of centring: at any zoom
          or responsive width the value labels keep that much space from the border,
          so neither can reach the edge even on a job whose figures are unusually
          wide. The columns stay content-sized (never `min-w-0`), so each label still
          sets its own column's minimum and cannot overlap its neighbour. */}
      <div className="flex items-center justify-center gap-1 px-3 py-1">
        {/* Bar pair: compact and content-sized, NOT `flex-1` — an intervening
            pass (§81) made this row and both columns `flex-1` so the pair
            would "grow to use whatever width the card has left", which
            pushed Budget and Actual/Projection apart instead: each column
            grew past its own bar's `maxWidth: BAR_W`, and the leftover width
            became padding around an already-centered bar — the exact kind of
            artificial gap this card's whole history has been about removing.
            Reverted here: dropping `flex-1` (still WITHOUT `min-w-0`, so the
            automatic per-column minimum below still stops the two dollar
            labels from ever colliding) lets the pair size itself to its
            content, so the outer row's `justify-center` centers a genuinely
            compact group, and `gap-1.5` — the same pair spacing the Estimate
            to Complete vs Actual chart uses between its own Quoted/Actual
            bars (SectionHierarchyChart's `Bar` pair) — is once again the
            real, whole gap between the two bars instead of being swallowed
            by column growth.

            `min-w-0` was tried (separately) and reverted: it let the columns
            shrink past their labels, and the two dollar figures overlapped by
            ~23px at a 1440px viewport (measured) — the labels are unbreakable
            single tokens ("$367,170"), so a column narrower than its label
            can only end in overlap, never a wrap. Each bar box is now a FIXED
            `width: BAR_W` (2026-08-12b), not `w-full` of its column — see
            BAR_W's own comment for why the bar deliberately no longer tracks
            the column at all. A long dollar label (a big job's "$1,525,498")
            still can't overlap its neighbour, for the same reason as before:
            it's the column's own content-based minimum doing that, same as
            it always has, independent of whatever the bar itself is doing. */}
        <div className="flex items-end gap-1.5">
          <div className="flex flex-col items-center gap-1.5">
            {/* ── Value label anchored to the bar's own top, not the frame's
                (2026-08-14, by request — "not properly anchored... floating
                too far left/right") ────────────────────────────────────────
                The label used to sit in normal flow ABOVE this fixed BAR_H
                frame, so it always hovered at the frame's top regardless of
                how tall the actual fill was — correct only when the fill
                happened to reach 100%, adrift by however much it didn't the
                rest of the time. SectionHierarchyChart's own `Bar` (the
                Hours chart this is meant to match) never has this problem
                because label and bar are packed together, bottom-aligned,
                inside their OWN full-height frame — the same fix applied
                here: this div IS the BAR_H reference frame (width/height set
                below), `justify-end` packs [label, fill] to its bottom edge,
                so the label sits exactly one gap above wherever the fill's
                top actually is, centered on it by the same `items-center`
                that already centered the frame under its caption.
                text-xs/font-bold/text-sdc-navy unchanged from before
                (2026-08-12, consistency with the ETC chart's own bar
                labels); leading-none + mb-0.5 added to match that chart's
                label-to-bar gap exactly (SectionHierarchyChart's `Bar`). */}
            <div className="flex flex-col items-center justify-end" style={{ width: BAR_W, height: BAR_H }}>
              <span className="mb-0.5 whitespace-nowrap font-mono text-xs font-bold leading-none tabular-nums text-sdc-navy">
                {estimate != null ? usd(estimate) : "—"}
              </span>
              {/* No background — a bg-sdc-gray-100 "track" here used to fill
                  the full frame regardless of value, so a bar under 100% of
                  maxValue showed a gray shortfall above its real fill that
                  read as the bar extending further than its actual number.
                  The card's own background shows through above the fill
                  instead. Height is now a PIXEL value (barPx), not a
                  percentage: as a plain flow child (no longer absolutely
                  positioned against a same-height parent) a `%` height here
                  would only resolve at all because the parent's height is
                  itself a definite pixel value — barPx says so directly and
                  keeps the segments below on the identical footing. */}
              {estimate != null && <div className="w-full rounded-t-sm" style={{ height: barPx(pct(estimate)), background: BAR_BUDGET }} />}
            </div>
            <div className="flex items-start justify-center text-center text-note font-medium leading-tight text-sdc-gray-600" style={{ height: CAPTION_H }}>Budget</div>
          </div>

          <div className="flex flex-col items-center gap-1.5">
            {/* Same fix as Budget's frame just above — see its comment.
                `relative` so the coverage line can sit at its own height inside the
                same frame the fills are measured in. */}
            <div className="relative flex flex-col items-center justify-end" style={{ width: BAR_W, height: BAR_H }}>
              {/* ── The ETC coverage boundary (2026-09-03, spec §4) ──────────
                  A red dotted line at `invoiced + etcCovered` — the top of the
                  portion the current ETC covers, and therefore the bottom of the
                  red. Drawn ONLY when something is uncovered: §5 says no line when
                  the ETC covers the whole exposure, because there is then no
                  boundary to mark.

                  Positioned from the BOTTOM in the same barPx units the segments
                  use, so it lands exactly on the seam between yellow and red rather
                  than being placed by eye.

                  Extended past the bar on both sides (-left-5/-right-5): the bar is
                  1.25rem wide and a dotted rule that narrow does not read as a
                  reference line. `pointer-events-none` so it cannot steal a click
                  from the drill-through segments underneath. */}
              {hasAdditional && (
                <div
                  className="pointer-events-none absolute -left-5 -right-5 z-10 border-t border-dashed"
                  style={{ bottom: coverageLinePx, borderColor: BAR_UNCOVERED }}
                  title={
                    "ETC coverage ends here. The red section above this line is remaining invoice exposure not " +
                    `covered by the adjusted ETC. Adjusted ETC ${usd(Math.round(adjustedEtcAmount))} against ` +
                    `${usd(Math.round(openBalanceAmount))} still to invoice; ${usd(additionalDisplay)} uncovered.`
                  }
                />
              )}
              {/* §10: the figure above the bar is `invoiced + toComplete`, whatever
                  the ETC says. It stays navy even when part of the exposure is
                  uncovered: the total is not itself an overspend, and colouring it
                  red would say the whole projection was the problem rather than the
                  gap in coverage. The tooltip carries the split. */}
              <span
                className="mb-0.5 whitespace-nowrap font-mono text-xs font-bold leading-none tabular-nums text-sdc-navy"
                title={
                  `Total projection ${usd(projTotalDisplay)} = invoiced ${usd(invoicedDisplay)} + adjusted ETC ` +
                  `${usd(adjustedEtcDisplay)}` +
                  (hasAdditional ? ` + uncovered exposure ${usd(additionalDisplay)}` : "") +
                  "."
                }
              >
                {usd(projTotalDisplay)}
              </span>
              {/* The two segments stack bottom-to-top inside their own
                  sub-column (flex-col-reverse: first array item —
                  "Invoiced" — ends up at the bottom, matching before).
                  Each gets a PIXEL height (barPx), so the stack's rendered
                  height is exactly Invoiced + ETC with no
                  percentage-of-an-auto-height-parent ambiguity — it sums to
                  barPx(pct(projTotal)) exactly (2026-08-17: was Invoiced +
                  Left to be invoiced + ETC before the double-count fix — see
                  this file's header). */}
              {/* ── Each segment is its own drill target (2026-09-02) ──────
                  A <button> per segment rather than one handler on the stack with
                  hit-testing by offsetY: the segments are already separate elements,
                  so the browser's hit-testing is exact, and each gets a real
                  accessible name, focus and Enter/Space for free. A segment can be a
                  couple of pixels tall on a lopsided job, which is why the CAPTION
                  below is a target too — a 2px click target is not a way to reach
                  anything. */}
              <div className="flex w-full flex-col-reverse">
                {segments.map((s, i) =>
                  onDrill ? (
                    <button
                      key={s.key}
                      type="button"
                      // ── Where each segment drills (2026-09-03) ─────────────
                      //
                      //   invoiced   the GL-posted lines. A real row-level set.
                      //   etc        the ETC drawdown by month, which is what that
                      //              figure is actually made of.
                      //   uncovered  the open-exposure rows. Deliberately NOT a
                      //              filter of its own: "uncovered" is a job-level
                      //              subtraction (To complete − ETC), not a property
                      //              any individual PO line carries, so there is no
                      //              honest way to list "the uncovered lines". It
                      //              opens the exposure it is part of, and the
                      //              panel's own breakdown states the split.
                      onClick={() => onDrill(segmentDrillMode(s.key))}
                      aria-label={`${s.label} ${usd(s.value)} — show the detail behind this`}
                      title={`${s.label} — click for detail`}
                      className={`motion-interactive w-full flex-shrink-0 cursor-pointer ${i === segments.length - 1 ? "rounded-t-sm" : ""} ${
                        drillMode === segmentDrillMode(s.key) ? "ring-2 ring-sdc-blue" : "hover:opacity-80"
                      }`}
                      // renderPx, not barPx(heightPct): a non-zero segment is floored
                      // to a visible height with the pixels borrowed from the tallest,
                      // so the stack's total is unchanged. See MIN_SEG_PX.
                      style={{ height: renderPx[i], background: s.color }}
                    />
                  ) : (
                    <div key={s.key} className={`w-full flex-shrink-0 ${i === segments.length - 1 ? "rounded-t-sm" : ""}`} style={{ height: renderPx[i], background: s.color }} />
                  ),
                )}
              </div>
            </div>
            {/* The caption is the whole-bar target — the reliable one, since it stays
                a fixed 32px however thin the segments above it become. */}
            {onDrill ? (
              <button
                type="button"
                onClick={() => onDrill("projection")}
                aria-label="Projected total — show every row behind this bar"
                title="Projected total = Invoiced + total remaining exposure. Click for the full parts-cost detail behind this bar"
                className={`motion-interactive flex h-8 flex-col items-center justify-start rounded text-center leading-tight ${
                  drillMode === "projection" ? "text-sdc-blue-dark" : "text-sdc-gray-600 hover:text-sdc-navy"
                }`}
              >
                {/* ── "Projected total", with the old name kept as helper text ──
                    (2026-09-03, by request: the captions should read "Budget" and
                    "Projected total".) "Actual / Projection" survives one size down
                    and muted rather than being deleted: it is the name on the Power
                    BI visual this card recreates and the phrase people have been
                    using for it, so dropping it outright would break the tie-back
                    for anyone reading the two side by side. */}
                <span className="text-note font-medium underline decoration-dotted underline-offset-2">
                  Projected total
                </span>
                <span className="text-micro text-sdc-gray-400">Actual / Projection</span>
              </button>
            ) : (
              <div className="flex h-8 flex-col items-center justify-start text-center leading-tight text-sdc-gray-600">
                <span className="text-note font-medium">Projected total</span>
                <span className="text-micro text-sdc-gray-400">Actual / Projection</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── The breakdown table (2026-09-03, by request) ─────────────────────
          Replaces the vertical chip list that used to sit here. Two problems with
          that list, both visible in the report: it stated figures without stating
          where they came from, and once it grew past four rows it ran into the
          "Total Parts Cost Spent" line below it.

          A real <table> rather than flex rows, because the alignment IS the point:
          the value column has to line up so the three coloured rows can be read as a
          column that sums to the total beneath them. `tabular-nums` on that column
          makes the digits align too.

          The swatch column is what ties a row to a band in the bar — the thing the
          request asked for first. Reference rows carry a hollow ring instead, since
          they are inputs to the calculation rather than parts of the bar. */}
      <div className="mt-3 overflow-x-auto px-2">
        <table className="w-full border-collapse text-micro">
          <caption className="sr-only">
            How the projected total is calculated, and what each colour in the bar denotes
          </caption>
          <thead>
            <tr className="border-b border-sdc-border text-sdc-gray-400">
              <th scope="col" className="w-3 pb-1" />
              <th scope="col" className="pb-1 text-left font-medium">
                Component
              </th>
              <th scope="col" className="pb-1 pl-2 text-right font-medium">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {breakdown.map((r, i) => {
              const isTotal = r.kind === "total";
              const firstReference = r.kind === "reference" && breakdown[i - 1]?.kind !== "reference";
              return (
                <tr
                  key={r.key}
                  className={`align-top ${isTotal ? "border-t border-sdc-border font-semibold" : ""} ${
                    // A rule above the first reference row separates the bar's own
                    // composition from the inputs it was derived from.
                    firstReference ? "border-t border-sdc-border" : ""
                  }`}
                >
                  <td className="py-1 pr-1">
                    {r.swatch ? (
                      <span
                        aria-hidden
                        className="mt-[3px] inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ background: r.swatch }}
                      />
                    ) : (
                      r.kind === "reference" && (
                        <span
                          aria-hidden
                          className="mt-[3px] inline-block h-2 w-2 shrink-0 rounded-full border border-sdc-gray-300"
                        />
                      )
                    )}
                  </td>
                  <td className="py-1">
                    <span className={isTotal ? "text-sdc-navy" : "text-sdc-gray-600"}>{r.label}</span>
                    {/* The arithmetic, one size down and muted: it is there to be
                        checked, not to compete with the figure it explains. */}
                    <span className="block text-[0.62rem] leading-snug text-sdc-gray-400">{r.derivation}</span>
                  </td>
                  <td
                    className={`py-1 pl-2 text-right font-mono tabular-nums ${
                      isTotal ? "text-sdc-navy" : "font-semibold text-sdc-navy"
                    }`}
                  >
                    {usd(r.value)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* The spacer now comes BEFORE "Total Parts Cost Spent" (2026-08-11c,
          by request) — it used to sit after it, which pinned Projection vs
          Budget to the card's bottom edge but left this caption stranded
          right under the bars with a tall gap beneath it. Moving the spacer
          up carries both down together, so the caption sits immediately
          above Projection vs Budget instead of immediately below the bars. */}
      <div className="flex-1" />

      {/* ── "Total Parts Cost Spent" folded into the table (2026-09-03) ──────
          It stood here as its own line — Invoiced + Left to be invoiced — and it was
          the line the breakdown table collided with in the report. Removing it is
          not a loss of information: the same figure is the table's
          "Purchased / committed" row, with its derivation stated, which is more than
          this line ever said.

          It also no longer belongs beside the projection. Under Dan's model the bar's
          total is Invoiced + Adjusted ETC + uncovered exposure, which EXCLUDES
          in-house SDC; this figure includes it. On job 1104 that is $780,324 against
          $821,469 — two totals a foot apart on the same card, differing by a rule
          neither of them stated. In the table they sit in one column with their
          arithmetic beside them, which is the whole point of the table. */}
      {/* Projection vs Budget — the one figure that says whether this job
          lands over what it was sold for, while there's still time to act.
          Its own border-t + pt-3 below separates it from the caption now
          immediately above it (the flex-1 spacer no longer sits between
          them, so this border is the only remaining gap between the two). */}
      {/* No activity yet: say that, rather than dressing a standing start up
          as a 100% saving. Only shown when there IS a quote to be measured
          against — with no estimate on file there's nothing to report. */}
      {variance == null && noPartsActivity && estimate != null && (
        <div className="border-t border-sdc-border pt-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs font-semibold text-sdc-gray-600">Projection vs Budget</p>
            <p className="font-heading text-sm font-bold text-sdc-muted">
              No parts activity yet · {usd(estimate)} budget
            </p>
          </div>
        </div>
      )}

      {variance != null && (
        <div className="border-t border-sdc-border pt-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs font-semibold text-sdc-gray-600">Projection vs Budget</p>
            <p className="font-heading text-sm font-bold tabular-nums">
              {/* Zero handled separately: "0.0% over" reads as a rounding
                  artefact where "on budget" is unambiguous. */}
              {Math.abs(variance.pct) < 0.0005 ? (
                <span className="text-sdc-muted">On budget · {usd(variance.estimate)}</span>
              ) : (
                <>
                  <span className={variance.dollars > 0 ? "text-sdc-red-text" : "text-sdc-green-text"}>
                    {Math.abs(variance.pct * 100).toFixed(1)}% {variance.dollars > 0 ? "over" : "under"}
                  </span>
                  {/* The dollar figure alongside the percentage: 13% of a $30K
                      job and 13% of a $1.4M job are very different problems. */}
                  <span className="text-sdc-muted">
                    {" "}
                    ({variance.dollars > 0 ? "+" : "−"}
                    {usd(Math.abs(variance.dollars))})
                  </span>
                </>
              )}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
