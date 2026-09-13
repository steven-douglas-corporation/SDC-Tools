import type { PartsCostLine } from "@/lib/sync-totaleto";
import { isSdcVendor } from "@/lib/vendor-normalize";

// ── Parts Cost projection: Dan's model ───────────────────────────────────────
//
// Specified 2026-09-03 from Dan's sketch, and it supersedes every earlier version
// of this calculation. The rule:
//
//   Start with the PRIOR month's ETC, reduce it by what was actually spent on parts
//   this month, compare what is left against the external exposure still to be
//   invoiced, and add only the uncovered difference.
//
//     adjustedEtc        = max(0, priorEtc - partsSpentThisMonth)
//     openBalance        = purchased - invoiced  (EVERY open commitment)
//     additionalExposure = max(0, openBalance - adjustedEtc)
//     totalProjection    = invoiced + adjustedEtc + additionalExposure
//                        = invoiced + max(adjustedEtc, openBalance)
//
// Which guarantees `totalProjection >= purchased`, because max(adjustedEtc,
// openBalance) >= openBalance and purchased = invoiced + openBalance. That invariant
// is the whole point of the 2026-09-03 correction below, and it is asserted per-job
// in tests/parts-projection.test.ts.
//
// The bar reads, bottom to top: invoiced (blue), adjustedEtc (yellow),
// additionalExposure (red, and only when there is any).
//
// ── What this replaced ──────────────────────────────────────────────────────
//
// Three earlier attempts, each recorded because each shipped:
//
//   1. `invoiced + max(committedNotPosted, submittedEtc)` — climbed dollar-for-dollar
//      with invoicing, because `invoiced` was live while the submitted ETC did not
//      shrink to match.
//   2. A frozen submission baseline — held still, but had to be reconstructed for
//      historical months and the reconstruction was wrong by $715,000 on the first
//      job it met.
//   3. `invoiced + toComplete`, with the CURRENT month's submitted ETC splitting the
//      remainder into covered and uncovered.
//
// (3) is closest, and two things separate it from this model. It used the current
// month's submitted New ETC where Dan starts from the PRIOR month's and draws it
// down by this month's spend (§20 is explicit that the two must not be confused).
// And its total was the whole open PO balance, where this one excludes in-house SDC
// exposure — work that never produces an external supplier invoice (§6).
//
// ── Why the total is still stable under normal conversion (§13) ─────────────
//
// An invoice landing does two things: `invoiced` rises, and the same dollars leave
// `yetToInvoice`. In the regime where `yetToInvoice` is the larger term, the total
// `invoiced + yetToInvoice` therefore does not move. In the regime where
// `adjustedEtc` is larger, the invoice also raises `partsSpentThisMonth`, which
// draws `adjustedEtc` down by the same amount — so the total holds there too. The
// stability is a consequence of the model rather than something pinned on top of it,
// which is what makes it trustworthy: nothing is snapshotted, so nothing can be
// reconstructed wrongly.

// ── In-house SDC (§6), and the mistake that was made with it ────────────────
//
// Dan: "do not include In-house SDC" in the remaining EXTERNAL INVOICE EXPOSURE —
// it is work SDC does itself, so no supplier invoice is ever coming for it, and
// counting it as exposure overstates what the job still owes the outside world.
//
// ── CORRECTED 2026-09-03: that exclusion must not reach the TOTAL ──────────
//
// The first implementation applied it to the projected total as well, which quietly
// asserts that in-house work costs the job nothing. It is on a purchase order, it is
// committed, and it is inside Purchased — so excluding it made the card project a
// job finishing for LESS than money already committed. Audited across ten jobs, 7
// projected below Purchased, and the shortfall was the in-house open balance almost
// to the dollar:
//
//     1101   purchased 791,609   projection 776,971   under by 14,639  (in-house 14,639)
//     1104   purchased 821,469   projection 783,096   under by 38,373  (in-house 38,373)
//     1142   purchased 1,584,820 projection 1,542,939 under by 41,880  (in-house 41,880)
//
// 1142 is the clearest failure: its EXTERNAL open balance is 0 and its in-house
// balance is 41,880, so the projection came out exactly equal to invoiced and ignored
// the committed work entirely. Reported by Abhi as "how can the projection be less
// than spent + open POs" — it could not, and that was the bug.
//
// So the exposure term in the total is now the whole open balance. The in-house
// figure survives as REPORTING — "of the open balance, this much will not arrive as a
// supplier invoice" — which is the useful half of §6 and the half that cannot
// corrupt a total.
//
// Rejected alternative: `invoiced + adjustedEtc + inHouseOpen`. It also fixes 1101,
// but on 1148 it gives 1,997,975 because it stacks in-house on top of an ETC that a
// manager would already have counted it inside — the double-count §16 forbids.
//
// The classification is on MANUFACTURER, and deliberately not on supplier. Measured
// across jobs 1101/1104/1131 (5,000 lines): manufacturer carries "SDC" (2,011 lines)
// and "SDC ASSY" (1). The supplier field's /sdc/i matches are
// "SDC Credit Card (Approved)" (19) and "Reconciling With Sage - SDC" (5) — those are
// PAYMENT MECHANISMS for genuine outside purchases, and excluding them would drop
// real external exposure from the figure.
//
// There is no canonical classification column to read instead: `manufacturer === "SDC"`
// is what the Parts List itself renders as "In-house (SDC)" (JobProcurement.tsx), so
// this is the same rule that display already applies, lifted into one named
// predicate rather than string-matched a second time at a second call site.
//
// The match is on a word boundary rather than equality so "SDC ASSY" is caught,
// while a hypothetical outside vendor like "SDCO Inc" is not.
// Delegates to lib/vendor-normalize.ts (2026-09-03) rather than carrying its own
// regex. It used to test /^SDC(\s|$)/ here — a second, independent definition of "is
// this SDC", which is precisely the duplication the vendor normalization was asked to
// remove. Two rules that agree today drift the moment one is edited, and this one
// decides money: it excludes in-house work from external invoice exposure.
//
// Same behaviour on today's data, checked: the manufacturer field carries only "SDC"
// (2,174 lines) and "SDC ASSY" (14), and isSdcVendor matches both. It is also STRICTER
// in the direction that matters — the payment and expense conduits are refused, so a
// card purchase from an outside maker can never be reclassified as work SDC never
// invoices.
export function isInHouseSdc(line: Pick<PartsCostLine, "manufacturer">): boolean {
  return isSdcVendor(line.manufacturer);
}

/** One row's remaining exposure, on the app's canonical basis. */
export function rowLeftToInvoice(line: Pick<PartsCostLine, "totalPrice" | "actualAmount">): number {
  // `actualAmount` (GL-posted), NOT `invoicedAmount` (billed) — the same expression
  // PartsCostDrill's own rows use and the same basis the card's job-level figure is
  // built on (§17, source consistency). Measured on job 1101 the two definitions
  // differ by $19,498: $61,126 against $41,628. Using the wrong one here would put
  // the card, the Parts List and this projection on three different footings.
  return line.totalPrice - line.actualAmount;
}

export type YetToInvoice = {
  /** Eligible external exposure — the figure the projection compares against the ETC. */
  amount: number;
  /** Remaining exposure on in-house SDC rows, excluded from `amount`. Reported, not hidden. */
  inHouseExcluded: number;
  /** How many rows were classified in-house, so the exclusion is auditable. */
  inHouseRows: number;
  /** Every row's exposure including in-house — what the card's "Left to be invoiced" has always shown. */
  allRows: number;
};

/**
 * Remaining external invoice exposure for a job's parts lines.
 *
 * Floored at zero on the AGGREGATE, not per row, which is the existing job-wide
 * convention (a line whose posted spend exceeds its purchased total is a credit, and
 * it should net against its neighbours rather than being clamped away individually).
 */
export function computeYetToInvoice(lines: readonly PartsCostLine[]): YetToInvoice {
  let all = 0;
  let inHouse = 0;
  let inHouseRows = 0;
  for (const l of lines) {
    const left = rowLeftToInvoice(l);
    all += left;
    if (isInHouseSdc(l)) {
      inHouse += left;
      inHouseRows++;
    }
  }
  const allFloored = Math.max(0, all);
  const eligible = Math.max(0, all - inHouse);
  return {
    amount: eligible,
    inHouseExcluded: allFloored - eligible,
    inHouseRows,
    allRows: allFloored,
  };
}

// ── The projection ──────────────────────────────────────────────────────────

export type PartsProjection = {
  /** Blue. GL-posted spend against the job, lifetime. */
  invoiced: number;
  /** The previous month's submitted New ETC — the forecast this month starts from. */
  priorEtc: number | null;
  /** This month's canonical parts spend, the amount the prior forecast is drawn down by. */
  partsSpentThisMonth: number;
  /** `priorEtc - partsSpentThisMonth`, which CAN be negative. Kept for the drill-through. */
  adjustedEtcRaw: number | null;
  /** Yellow. The same figure floored at 0, because a bar cannot have negative height. */
  adjustedEtc: number;
  /**
   * EVERY open commitment: purchased - invoiced. This is what the total is built on,
   * so the projection can never fall below what the job has already committed.
   */
  openBalance: number;
  /** Red. `max(0, openBalance - adjustedEtc)` — commitments the adjusted forecast does not cover. */
  additionalExposure: number;
  /** The bar's height: `invoiced + adjustedEtc + additionalExposure`. */
  totalProjection: number;
  /** Where the dotted line goes: `invoiced + adjustedEtc`. Null when there is no red to bound. */
  coverageLine: number | null;
  hasAdditionalExposure: boolean;
  /** True when no prior ETC could be resolved at all — see the reader for when that happens. */
  etcUnknown: boolean;
};

const num = (n: number | null | undefined): number =>
  typeof n === "number" && Number.isFinite(n) ? n : 0;

export function computePartsProjection(input: {
  invoiced: number;
  priorEtc: number | null;
  partsSpentThisMonth: number;
  /** purchased - invoiced. EVERY open commitment, in-house included — see the header. */
  openBalance: number;
}): PartsProjection {
  const invoiced = num(input.invoiced);
  const partsSpentThisMonth = num(input.partsSpentThisMonth);
  const openBalance = Math.max(0, num(input.openBalance));
  const etcKnown = input.priorEtc != null && Number.isFinite(input.priorEtc);
  const priorEtc = etcKnown ? (input.priorEtc as number) : null;

  // §3: the raw figure is kept for diagnostics, and only the DRAWN one is floored.
  // A negative adjusted ETC is real information — the month has already spent past
  // its own forecast — and the drill-through says so rather than rounding it away.
  const adjustedEtcRaw = priorEtc == null ? null : priorEtc - partsSpentThisMonth;
  const adjustedEtc = adjustedEtcRaw == null ? 0 : Math.max(0, adjustedEtcRaw);

  // §7 and §16: only the UNCOVERED difference is added. Adding the whole
  // `openBalance` on top of `adjustedEtc` would count the covered portion twice.
  const additionalExposure = Math.max(0, openBalance - adjustedEtc);
  const totalProjection = invoiced + adjustedEtc + additionalExposure;

  return {
    invoiced,
    priorEtc,
    partsSpentThisMonth,
    adjustedEtcRaw,
    adjustedEtc,
    openBalance,
    additionalExposure,
    totalProjection,
    // §12: the line marks where ETC coverage ends, so it only means something when
    // there is exposure above it. §7 forbids drawing it otherwise.
    coverageLine: additionalExposure > 0 ? invoiced + adjustedEtc : null,
    hasAdditionalExposure: additionalExposure > 0,
    etcUnknown: priorEtc == null,
  };
}
