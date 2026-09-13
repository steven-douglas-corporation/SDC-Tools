import type { PartsCostLine } from "@/lib/sync-totaleto";

// ── Left to Invoice — ONE formula, one cutoff, every caller ───────────────────
//
// REPORTED 2026-09-03: Monthly ETC → Parts Cost → Left to Invoice disagreed with
// Job Details → Parts List filtered through 08/31/2026.
//
// ── What the audit found (scripts/audit-left-to-invoice-parity.ts) ───────────
//
// Measured over August 2026's 49 Parts Cost jobs, against the same upstream rows:
//
//     Monthly ETC as shipped          $2,238,624.84
//     Parts List through 2026-08-31   $2,137,726.85
//     difference                        $100,897.99
//
// and the difference decomposes exactly:
//
//     $100,376.71   lines PURCHASED AFTER 2026-08-31 (Sept 1–3 POs)
//         $521.28   the aggregate floor at 0 (one job, 1134, sits at −$427.54)
//
// That is the whole gap. Everything the report asked me to check for came back
// clean, and it is worth writing down which, because each one is a thing that did
// NOT need fixing:
//
//   • date field        Both read PartsCostLine.purchaseDate / .invoicedDate from
//                       the same query template (partsDetailSql).
//   • timezone          Upstream sends ISO `YYYY-MM-DD…` strings. Both sides do
//                       `.slice(0, 10)` and compare as strings. No Date object is
//                       ever constructed, so there is no zone to get wrong.
//   • end-date bound    Inclusive on both sides (`day > to` excludes), so
//                       2026-08-31 keeps that day's purchases.
//   • invoiced vs GL    Both use `actualAmount` (GL-posted), not `invoicedAmount`
//                       (billed). Worth $378,989.26 in August if they diverged —
//                       they do not. po-detail.ts fixed its side on 2026-09-02.
//   • refunds/credits   `applyRefundSign` runs inside getPartsCostForJobs, so both
//                       callers receive already-signed lines.
//   • zero-value rows   `meaningfulLines` drops them inside the same function.
//   • partial invoices  A line's own `totalPrice − actualAmount` carries its
//                       remaining balance; nothing here needs to know it is partial.
//   • duplicate lines   Both sum every PO line once. The Parts List additionally
//                       share-splits a line across the BOM rows that claim it
//                       (`shareOf`), which redistributes but never duplicates.
//   • supplier/mfr      normalizeVendor touches display and filtering only. It has
//                       never been in the money path.
//   • job filtering     Both start from the same job set for the month.
//   • BOM/non-BOM       Not a money distinction. See the note on the footer below.
//
// So this file does not introduce a second formula to make two numbers agree. It
// extracts the ONE formula those numbers were already computing — in four places,
// written out four times — and gives it the cutoff that Monthly ETC never had.
//
// ── The cutoff is the actual defect ─────────────────────────────────────────
//
// Monthly ETC's figure was "as of right now" on a page whose entire job is closing
// a named month. Opening August on September 3rd counted three days of September
// POs as August exposure, and the number moved every day the month stayed open. A
// month-end figure has to be a month-end figure.
//
// ── What "as of" means here, and the one thing it does NOT do ───────────────
//
// `asOf` excludes lines PURCHASED after the cutoff. It does not un-apply invoices
// posted after it. That is deliberate: it is what the Parts List's own date filter
// does (Purchase mode is the only mode that yields this column at all — an
// Invoiced-mode range renders it as "—", by design, because a windowed invoiced
// figure against a lifetime purchased figure is not a subtraction anyone should
// read), and the Parts List is the stated source of truth.
//
// It is worth knowing what that costs, because it is not zero: in August,
// $76,866.43 of GL-posted actual landed after the 31st against POs placed on or
// before it. Under this rule those dollars reduce the August figure retroactively,
// so August's Left to Invoice keeps drifting down as September posts. A true
// as-of-31-August snapshot — `asOfPosting: true` below — holds still instead.
// Both are implemented; the Parts List's rule is the default because it is the one
// that was asked for.

/** An inclusive `YYYY-MM-DD` cutoff, or null for "everything, lifetime". */
export type LeftToInvoiceScope = {
  /**
   * Include only lines purchased on or before this day. Null/absent = lifetime,
   * which is what the Parts Cost card and the job-level tiles want.
   */
  asOf?: string | null;
  /**
   * Also ignore GL postings dated after `asOf`, giving a true point-in-time
   * snapshot rather than "August's POs, today's invoices". Off by default: the
   * Parts List does not do this, and the Parts List is the source of truth.
   */
  asOfPosting?: boolean;
};

/** `2026-08` → `2026-08-31`. Null for anything that is not a `YYYY-MM` month. */
export function monthEndCutoff(month: string | null | undefined): string | null {
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const [y, m] = month.split("-").map(Number);
  // Day 0 of the next month is the last day of this one — leap years included,
  // and computed in local time on a date that is only ever read as Y/M/D.
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
}

/**
 * The cutoff written for a human: `2026-08` → `August 31, 2026`.
 *
 * Lives here, beside monthEndCutoff, so the words and the arithmetic cannot name
 * different days — it was an inline IIFE in etc/page.tsx, which is a 2,500-line server
 * component no test can call. `new Date(y, m - 1, d)` is the numeric constructor on a
 * value that only ever gets formatted, never compared, so it carries no timezone risk;
 * the money path still never parses a date string.
 */
export function monthEndLabel(month: string | null | undefined): string {
  const cutoff = monthEndCutoff(month);
  if (!cutoff) return "the end of the month";
  const [y, m, d] = cutoff.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/**
 * The day part of an upstream timestamp, as a string.
 *
 * Never `new Date(...)`. Upstream sends ISO `YYYY-MM-DD…`, and lexical comparison
 * of those prefixes is exact — whereas parsing to a Date and back reintroduces the
 * server's UTC offset, which can move a purchase across a month boundary. This is
 * the same `.slice(0, 10)` the Parts List's own filter uses, deliberately.
 */
export function dayOf(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const d = ts.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/**
 * Is this line part of the picture as of the cutoff?
 *
 * A line with NO purchase date is INCLUDED. This is the one place this file
 * deliberately departs from the Parts List's filter, which drops undated rows via
 * its `if (!d) return false` guard — a rule that is right for a table (you cannot
 * sort undated rows into a date range) and wrong for a total (an undated
 * commitment is still a commitment, and silently dropping it understates the
 * exposure). It cost nothing in August — every line had a purchase date, so
 * `droppedNoPurchaseDate` measured $0.00 — but "currently zero" is not a reason to
 * build in a leak.
 */
export function isWithinAsOf(line: PartsCostLine, asOf: string | null | undefined): boolean {
  if (!asOf) return true;
  const purchased = dayOf(line.purchaseDate);
  if (purchased === null) return true;
  return purchased <= asOf; // inclusive, matching the Parts List's `day > to` exclusion
}

/**
 * One line's contribution: what was committed on it, less what has posted to the GL.
 *
 * Signed. A line whose posted spend exceeds its purchased total is a credit and
 * must net against its neighbours rather than being clamped away on its own — the
 * flooring belongs on the aggregate, and only there.
 */
export function lineLeftToInvoice(line: PartsCostLine, scope: LeftToInvoiceScope = {}): number {
  const posted =
    scope.asOfPosting && scope.asOf && (dayOf(line.invoicedDate) ?? "9999-12-31") > scope.asOf ? 0 : line.actualAmount;
  return line.totalPrice - posted;
}

/**
 * Left to Invoice for a set of lines — THE definition, for every caller.
 *
 * Floored at 0 on the AGGREGATE. A job cannot owe negative money to its suppliers,
 * and this figure seeds a forecast; the per-line signed value stays available above
 * for the Parts List's own column, which shows real negatives on purpose.
 */
export function leftToInvoiceForLines(lines: readonly PartsCostLine[], scope: LeftToInvoiceScope = {}): number {
  return Math.max(0, rawLeftToInvoice(lines, scope));
}

/** The same sum WITHOUT the aggregate floor — what the Parts List footer column shows. */
export function rawLeftToInvoice(lines: readonly PartsCostLine[], scope: LeftToInvoiceScope = {}): number {
  let total = 0;
  for (const line of lines) {
    if (!isWithinAsOf(line, scope.asOf)) continue;
    total += lineLeftToInvoice(line, scope);
  }
  return total;
}

export type LeftToInvoiceExplanation = {
  total: number;
  /** Before the aggregate floor — differs from `total` only on an over-posted job. */
  raw: number;
  linesIncluded: number;
  linesExcluded: number;
  /** What the cutoff removed, and what it was worth. Empty when `asOf` is null. */
  excludedByCutoff: { poNumber: string | null; partNumber: string | null; purchaseDate: string | null; invoicedDate: string | null; amount: number }[];
  /** GL postings dated after the cutoff that this rule still subtracts (see the header). */
  postedAfterCutoff: number;
};

/**
 * The same arithmetic, showing its work.
 *
 * Exists because "these two numbers differ" must never be answerable only by
 * re-deriving both by hand. When a reconciliation test fails, or a manager asks why
 * a job moved, this names the PO lines responsible and what each was worth.
 */
export function explainLeftToInvoice(
  lines: readonly PartsCostLine[],
  scope: LeftToInvoiceScope = {},
): LeftToInvoiceExplanation {
  const excluded: LeftToInvoiceExplanation["excludedByCutoff"] = [];
  let raw = 0;
  let included = 0;
  let postedAfterCutoff = 0;
  for (const line of lines) {
    if (!isWithinAsOf(line, scope.asOf)) {
      excluded.push({
        poNumber: line.poNumber,
        partNumber: line.partNumber,
        purchaseDate: dayOf(line.purchaseDate),
        invoicedDate: dayOf(line.invoicedDate),
        amount: line.totalPrice - line.actualAmount,
      });
      continue;
    }
    included++;
    raw += lineLeftToInvoice(line, scope);
    if (scope.asOf && (dayOf(line.invoicedDate) ?? "") > scope.asOf) postedAfterCutoff += line.actualAmount;
  }
  return {
    total: Math.max(0, raw),
    raw,
    linesIncluded: included,
    linesExcluded: excluded.length,
    excludedByCutoff: excluded,
    postedAfterCutoff,
  };
}

// ── The cell: a computed DEFAULT that a manager may override ─────────────────
//
// Third revision of this rule, and the one that resolves the tension in the first two.
//
//   2026-09-03  editable, so it could disagree with the Parts List by any amount.
//   2026-09-04  computed and read-only, so it always agreed — and a manager who knew
//               better than Total ETO had nowhere to say so.
//   2026-09-04  this: the computed figure is the DEFAULT, the cell is editable, and an
//               override is HIGHLIGHTED. Reconciliation is the default state rather
//               than an enforced one, and a divergence is visible rather than
//               impossible — which is what both requests were actually asking for.
//
// So `EtcEntry.leftToInvoice` has exactly one meaning: the manager's override. NULL
// means "use the computed default", not "nothing here". That matters for reading
// existing rows — every stored value is an override and stays one, which is the
// "existing manual overrides must not be lost" requirement.
//
// It also means the submission must NOT write the computed figure into that column.
// Freezing it there (which the read-only revision did) would make a frozen default
// indistinguishable from a deliberate override the moment anyone looked at the row
// again. `newEtc` is the frozen figure, as it always was.

/** Where a displayed Left to Invoice came from. */
export type LeftToInvoiceSource =
  /** The computed Parts List figure at this month's cutoff — nobody has overridden it. */
  | "default"
  /** A manager typed something else. This is the state that gets highlighted. */
  | "override"
  /** Upstream is unreachable and nothing was stored. Renders as an em dash. */
  | "unavailable";

export type LeftToInvoiceInputs = {
  /** The Parts List figure at this month's cutoff, or null when upstream failed. */
  computed: number | null;
  /** `EtcEntry.leftToInvoice` — the override, or null for "use the default". */
  stored: number | null;
};

export type ResolvedLeftToInvoice = {
  value: number | null;
  source: LeftToInvoiceSource;
  /**
   * Show the manually-adjusted highlight.
   *
   * False when the stored value EQUALS the computed default — "if the value is restored
   * back to the original amount, remove the manual-change highlight". Comparing rather
   * than clearing the column keeps that reversible without a second write.
   *
   * Also false when the default is unknown: with upstream down there is nothing to
   * differ FROM, and a highlight that appears during an outage and vanishes afterwards
   * would be worse than none.
   */
  overridden: boolean;
  /** The figure the override replaced, for the tooltip. Null when there is no override. */
  defaultValue: number | null;
};

export function resolveLeftToInvoice(x: LeftToInvoiceInputs): ResolvedLeftToInvoice {
  if (x.stored !== null) {
    const differs = x.computed !== null && Math.abs(x.stored - x.computed) > 0.004;
    return {
      value: x.stored,
      source: differs ? "override" : "default",
      overridden: differs,
      defaultValue: x.computed,
    };
  }
  if (x.computed !== null) {
    return { value: x.computed, source: "default", overridden: false, defaultValue: x.computed };
  }
  return { value: null, source: "unavailable", overridden: false, defaultValue: null };
}

// ── New ETC needs BOTH halves ────────────────────────────────────────────────
//
// "New ETC should remain empty until both Left to Invoice and Left to Purchase have
// values entered. Do not treat blanks as 0."
//
// The previous rule counted a blank half as 0 as soon as the other had a figure, which
// meant a row with only Left to Invoice filled displayed a New ETC that asserted
// "nothing left to buy" — a forecast nobody had made, on the field the submission, the
// export and next month's Prior ETC all read. Blank now means blank all the way
// through, and every consumer asks this one function.

/**
 * New ETC for a Parts Cost row, or null while either half is unanswered.
 *
 * Zero IS a value: a manager who enters 0 in Left to Purchase has said there is nothing
 * more to buy, and that is an answer. Only null is blank — which is exactly the
 * distinction the old `?? 0` destroyed.
 */
export function partsNewEtc(leftToInvoice: number | null, leftToPurchase: number | null): number | null {
  if (leftToInvoice === null || leftToPurchase === null) return null;
  return Math.round((leftToInvoice + leftToPurchase) * 100) / 100;
}
