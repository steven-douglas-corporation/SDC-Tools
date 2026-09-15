import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  monthEndCutoff,
  dayOf,
  isWithinAsOf,
  lineLeftToInvoice,
  leftToInvoiceForLines,
  rawLeftToInvoice,
  explainLeftToInvoice,
  monthEndLabel,
  resolveLeftToInvoice,
  partsNewEtc,
} from "../src/lib/left-to-invoice";
import type { PartsCostLine } from "../src/lib/sync-totaleto";

// ── Monthly ETC's Left to Invoice must BE the Parts List's ───────────────────
//
// Reported 2026-09-03. Measured over August 2026's 49 Parts Cost jobs
// (scripts/audit-left-to-invoice-parity.ts): Monthly ETC $2,238,624.84 against the
// Parts List's $2,137,726.85 through 08/31 — $100,376.71 of it POs placed on
// September 1st–3rd, counted as August exposure because Monthly ETC had no cutoff
// at all, plus $521.28 of aggregate flooring.
//
// The rule these tests hold to:
//
//     leftToInvoice(job, month M) === leftToInvoice(job, asOf = last day of M)
//
// It is one function now, so parity is not a coincidence to be re-checked — but the
// FIXTURES below are what make that meaningful, because they carry every case the
// report asked about (partial invoices, credits, zero rows, undated lines, month
// boundaries, over-invoicing) rather than only the happy path.

// Unique per call, not a shared constant: lineId is a purchase line's identity,
// and anything that groups by it would silently collapse two fixtures into one.
let lineSeq = 0;
const line = (o: Partial<PartsCostLine>): PartsCostLine => ({
  lineId: `fixture:${++lineSeq}`,
  purchaseDate: null,
  invoicedDate: null,
  supplier: null,
  manufacturer: null,
  category: null,
  poNumber: null,
  partNumber: null,
  description: null,
  quantity: 1,
  unitPrice: 0,
  totalPrice: 0,
  invoicedAmount: 0,
  actualAmount: 0,
  ...o,
});

// Three jobs, each carrying a different edge case, plus the August/September
// boundary that produced the reported gap.
const JOBS: Record<string, PartsCostLine[]> = {
  // Straightforward: one fully invoiced line, one open, one part-invoiced.
  "1130": [
    line({ poNumber: "A1", partNumber: "P-1", purchaseDate: "2026-07-14T00:00:00.000Z", invoicedDate: "2026-07-20T00:00:00.000Z", totalPrice: 1000, invoicedAmount: 1000, actualAmount: 1000 }),
    line({ poNumber: "A2", partNumber: "P-2", purchaseDate: "2026-08-03T00:00:00.000Z", totalPrice: 2500, invoicedAmount: 0, actualAmount: 0 }),
    line({ poNumber: "A3", partNumber: "P-3", purchaseDate: "2026-08-19T00:00:00.000Z", invoicedDate: "2026-08-28T00:00:00.000Z", totalPrice: 800, invoicedAmount: 300, actualAmount: 300 }),
    // The reported leak: a September PO on a page closing August.
    line({ poNumber: "A4", partNumber: "P-4", purchaseDate: "2026-09-02T00:00:00.000Z", totalPrice: 4016.07, invoicedAmount: 0, actualAmount: 0 }),
  ],
  // A credit, and a line billed but not GL-posted — the two places a naive
  // implementation picks the wrong field or clamps the wrong thing.
  "1134": [
    line({ poNumber: "B1", partNumber: "Q-1", purchaseDate: "2026-08-05T00:00:00.000Z", invoicedDate: "2026-08-11T00:00:00.000Z", totalPrice: 500, invoicedAmount: 500, actualAmount: 500 }),
    line({ poNumber: "B2", partNumber: "Q-2", purchaseDate: "2026-08-06T00:00:00.000Z", invoicedDate: "2026-08-12T00:00:00.000Z", totalPrice: -427.54, invoicedAmount: 0, actualAmount: 0 }),
    // Billed $900 but only $200 posted to the GL. actualAmount is the field.
    line({ poNumber: "B3", partNumber: "Q-3", purchaseDate: "2026-08-07T00:00:00.000Z", invoicedDate: "2026-08-30T00:00:00.000Z", totalPrice: 900, invoicedAmount: 900, actualAmount: 200 }),
  ],
  // An undated line, and a line whose posting lands after month end.
  "1162": [
    line({ poNumber: "C1", partNumber: "R-1", purchaseDate: null, totalPrice: 344, invoicedAmount: 0, actualAmount: 0 }),
    line({ poNumber: "C2", partNumber: "R-2", purchaseDate: "2026-08-31T00:00:00.000Z", totalPrice: 2561.22, invoicedAmount: 0, actualAmount: 0 }),
    line({ poNumber: "C3", partNumber: "R-3", purchaseDate: "2026-08-20T00:00:00.000Z", invoicedDate: "2026-09-04T00:00:00.000Z", totalPrice: 5000, invoicedAmount: 5000, actualAmount: 5000 }),
    line({ poNumber: "C4", partNumber: "R-4", purchaseDate: "2026-09-01T00:00:00.000Z", totalPrice: 61499.68, invoicedAmount: 0, actualAmount: 0 }),
  ],
};

/** Money compared to the cent — see the note in the asOfPosting test. */
const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * The Parts List's own arithmetic, written out independently here.
 *
 * Deliberately NOT importing the shared function: a parity test that calls the same
 * code on both sides proves only that a function equals itself. This is the Parts
 * List's rule as the component applies it — filter rows by the purchase-date bound
 * the way JobProcurement's predicate does, then sum the per-row signed column the
 * way PartsTableView's footer does.
 */
const partsListLeftToInvoice = (lines: PartsCostLine[], to: string | null): number => {
  let total = 0;
  for (const l of lines) {
    const d = l.purchaseDate ? l.purchaseDate.slice(0, 10) : null;
    if (to && d !== null && d > to) continue; // the component's `day > to` exclusion
    total += l.totalPrice - l.actualAmount; // the component's leftToSpend column
  }
  return total;
};

test("month end is the inclusive last day, leap years included", () => {
  assert.equal(monthEndCutoff("2026-08"), "2026-08-31");
  assert.equal(monthEndCutoff("2026-09"), "2026-09-30");
  assert.equal(monthEndCutoff("2026-02"), "2026-02-28");
  assert.equal(monthEndCutoff("2024-02"), "2024-02-29", "leap year");
  assert.equal(monthEndCutoff("2026-12"), "2026-12-31");
  // Unparseable degrades to "no cutoff" — the lifetime figure this used to be —
  // rather than to a cutoff that excludes everything.
  for (const bad of ["", "2026", "2026-13", "2026-00", "August", null, undefined]) {
    assert.equal(monthEndCutoff(bad), null, `${bad} must not produce a cutoff`);
  }
});

test("dates are compared as strings — no Date, no timezone", () => {
  // The whole timezone question is answered by never constructing a Date. Parsing
  // "2026-08-31T00:00:00.000Z" on a UTC-5 server gives August 30th locally, which
  // would move a purchase out of the month that paid for it.
  assert.equal(dayOf("2026-08-31T00:00:00.000Z"), "2026-08-31");
  assert.equal(dayOf("2026-08-31"), "2026-08-31");
  assert.equal(dayOf(null), null);
  assert.equal(dayOf(""), null);
  assert.equal(dayOf("not-a-date"), null);
  // Structural: the file may construct a Date exactly once, and only from NUMBERS —
  // `new Date(y, m, 0)`, the day-count trick in monthEndCutoff. Any `new Date(<string>)`
  // is the timezone bug walking back in.
  const code = readFileSync(join(process.cwd(), "src", "lib", "left-to-invoice.ts"), "utf8")
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const constructions = code.match(/new Date\([^)]*\)/g) ?? [];
  // Both permitted constructions take NUMBERS: the month-length trick in
  // monthEndCutoff, and monthEndLabel's formatting-only date. Neither parses a string,
  // which is the whole timezone question. `new Date(<string>)` anywhere here is the bug
  // walking back in.
  assert.deepEqual(
    [...new Set(constructions)].sort(),
    ["new Date(y, m - 1, d)", "new Date(y, m, 0)"],
    "every Date must be built from numbers, never parsed from a string",
  );
});

test("the end date is inclusive — the 31st belongs to August", () => {
  const l = line({ purchaseDate: "2026-08-31T18:45:00.000Z", totalPrice: 100 });
  assert.equal(isWithinAsOf(l, "2026-08-31"), true, "same day, later clock time, still in");
  assert.equal(isWithinAsOf(line({ purchaseDate: "2026-09-01T00:00:00.000Z" }), "2026-08-31"), false);
  assert.equal(isWithinAsOf(l, null), true, "no cutoff includes everything");
});

test("an undated line is a commitment, not a row to drop", () => {
  // The Parts List's table filter drops undated rows (`if (!d) return false`) because
  // it cannot place them in a range. A TOTAL must not: an undated commitment is still
  // owed. Measured $0.00 in August, which is a reason to keep it correct rather than
  // a reason to skip it.
  const undated = line({ purchaseDate: null, totalPrice: 344 });
  assert.equal(isWithinAsOf(undated, "2026-08-31"), true);
  assert.equal(leftToInvoiceForLines([undated], { asOf: "2026-08-31" }), 344);
});

test("GL-posted actual is the field, never the billed amount", () => {
  // $900 billed, $200 posted. Using invoicedAmount would report $0 left on a line
  // that still owes $700. Worth $378,989.26 across August if the two ever diverged.
  const l = line({ totalPrice: 900, invoicedAmount: 900, actualAmount: 200 });
  assert.equal(lineLeftToInvoice(l), 700);
});

test("a credit nets against its neighbours; only the total is floored", () => {
  const credit = line({ purchaseDate: "2026-08-06", totalPrice: -427.54 });
  const normal = line({ purchaseDate: "2026-08-05", totalPrice: 500, actualAmount: 500 });
  // Per line: signed, so the Parts List column can show the credit as a negative.
  assert.equal(lineLeftToInvoice(credit), -427.54);
  // In aggregate: the credit reduces the pair rather than being clamped away alone.
  assert.equal(rawLeftToInvoice([normal, credit]), -427.54);
  assert.equal(leftToInvoiceForLines([normal, credit]), 0, "a job cannot owe negative money");
  // And it nets properly when there is something to net against.
  const open = line({ purchaseDate: "2026-08-07", totalPrice: 1000 });
  assert.equal(leftToInvoiceForLines([open, credit]), 572.46);
});

test("a fully invoiced line contributes nothing, a zero row changes nothing", () => {
  assert.equal(lineLeftToInvoice(line({ totalPrice: 1000, invoicedAmount: 1000, actualAmount: 1000 })), 0);
  assert.equal(lineLeftToInvoice(line({})), 0);
  assert.equal(leftToInvoiceForLines([]), 0, "no lines is a real $0, not NaN");
});

test("PARITY: Monthly ETC for month M equals the Parts List through the last day of M", () => {
  // The headline requirement, per job and in total, over fixtures carrying every
  // edge case above. The right-hand side is the independent re-implementation.
  const asOf = monthEndCutoff("2026-08");
  let etcTotal = 0;
  let listTotal = 0;
  for (const [job, lines] of Object.entries(JOBS)) {
    const etc = rawLeftToInvoice(lines, { asOf });
    const list = partsListLeftToInvoice(lines, asOf);
    assert.equal(etc, list, `job ${job}: Monthly ETC ${etc} vs Parts List ${list} through ${asOf}`);
    etcTotal += etc;
    listTotal += list;
  }
  assert.equal(etcTotal, listTotal, "and in total across every job");

  // Concretely, so the numbers are readable rather than merely equal:
  //   1130  2500 + (800-300) = 3000, September's 4016.07 excluded
  //   1134  0 + (-427.54) + (900-200) = 272.46
  //   1162  344 + 2561.22 + 0 = 2905.22, September's 61499.68 excluded
  assert.equal(rawLeftToInvoice(JOBS["1130"], { asOf }), 3000);
  assert.equal(rawLeftToInvoice(JOBS["1134"], { asOf }), 272.46);
  assert.equal(cents(rawLeftToInvoice(JOBS["1162"], { asOf })), 2905.22);
});

test("PARITY holds for every month, not just the one that was reported", () => {
  for (const month of ["2026-06", "2026-07", "2026-08", "2026-09", "2026-12", "2024-02"]) {
    const asOf = monthEndCutoff(month);
    for (const [job, lines] of Object.entries(JOBS)) {
      assert.equal(
        rawLeftToInvoice(lines, { asOf }),
        partsListLeftToInvoice(lines, asOf),
        `job ${job}, month ${month}`,
      );
    }
  }
});

test("the cutoff is what the fix IS — without it August inherits September", () => {
  // The regression this exists to catch: dropping the cutoff silently restores the
  // reported bug, and every other assertion here would still pass.
  const asOf = monthEndCutoff("2026-08");
  const withCutoff = rawLeftToInvoice(JOBS["1162"], { asOf });
  const lifetime = rawLeftToInvoice(JOBS["1162"], {});
  assert.equal(lifetime - withCutoff, 61499.68, "a September PO is not August exposure");
  assert.notEqual(withCutoff, lifetime);
  // And the ETC page must actually pass a month — a default of "lifetime" here reads
  // as working code and is the whole defect.
  const page = readFileSync(join(process.cwd(), "src", "app", "(app)", "etc", "page.tsx"), "utf8");
  // `\r?\n`, not `\n`: this repo's worktree is CRLF, and an earlier pass of this file
  // happened to be written with LF, so the guard passed for a reason that had nothing
  // to do with what it checks. A source guard must not depend on line endings.
  assert.match(page, /readPartsEtcBreakout\([\s\S]{0,400}?\r?\n\s*month,\s*\r?\n\s*\)/, "the ETC page must pass its month");
  const breakout = readFileSync(join(process.cwd(), "src", "lib", "parts-etc-breakout.ts"), "utf8");
  // explainLeftToInvoice, not leftToInvoiceForLines — same arithmetic (`total` IS what
  // leftToInvoiceForLines returns), and it also yields the floor and drift figures the
  // tooltip discloses. The assertion that matters is that the CUTOFF is passed.
  assert.match(breakout, /explainLeftToInvoice\(lines, \{ asOf \}\)/);
  assert.match(breakout, /month: string \| null,/, "month must be required, not optional");
});

test("there is ONE formula — no caller re-expresses it", () => {
  // The report's actual instruction: reuse the shared calculation, do not add a
  // second one. This fails the moment somebody spells the subtraction out again.
  const files = [
    ["src/lib/parts-etc-breakout.ts", "Monthly ETC"],
    ["src/lib/po-detail.ts", "the Parts List rows"],
    ["src/lib/parts-budget-projection.ts", "the projection"],
    ["src/lib/parts-cost-financials.ts", "the Parts Cost card"],
  ] as const;
  for (const [rel, who] of files) {
    const src = readFileSync(join(process.cwd(), ...rel.split("/")), "utf8");
    const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(code, /from "@\/lib\/left-to-invoice"/, `${who} must import the shared formula`);
    assert.ok(
      !/totalPrice\s*-\s*(l\.)?actualAmount/.test(code),
      `${who} re-expresses "totalPrice − actualAmount" instead of calling the shared function`,
    );
  }
});

test("a mismatch names the rows that caused it", () => {
  // "log enough detail to show which part/PO rows are causing it rather than silently
  // returning different numbers."
  const asOf = monthEndCutoff("2026-08");
  const x = explainLeftToInvoice(JOBS["1162"], { asOf });
  assert.equal(cents(x.total), 2905.22);
  assert.equal(cents(x.raw), 2905.22);
  assert.equal(x.linesIncluded, 3);
  assert.equal(x.linesExcluded, 1);
  assert.deepEqual(
    x.excludedByCutoff.map((e) => [e.poNumber, e.partNumber, e.purchaseDate, e.amount]),
    [["C4", "R-4", "2026-09-01", 61499.68]],
  );
  // The figure this rule knowingly leaves moving: $5,000 posted on 2026-09-04
  // against a PO placed 2026-08-20 already reduces August's number.
  assert.equal(x.postedAfterCutoff, 5000);

  // The floor is reported too, so "$0" is never mistaken for "nothing outstanding".
  const over = explainLeftToInvoice([line({ purchaseDate: "2026-08-02", totalPrice: -427.54 })], { asOf });
  assert.equal(over.total, 0);
  assert.equal(over.raw, -427.54);
});

test("asOfPosting freezes the month instead of letting it drift", () => {
  // Not the default — the Parts List does not do this and the Parts List is the
  // stated source of truth — but implemented and pinned, because the difference is
  // real money ($76,866.43 in August) and switching must be one option, not a rewrite.
  const asOf = monthEndCutoff("2026-08");
  const drifting = rawLeftToInvoice(JOBS["1162"], { asOf });
  const frozen = rawLeftToInvoice(JOBS["1162"], { asOf, asOfPosting: true });
  // Cents, not raw floats: 344 + 2561.22 lands on 2905.2199999999998 in binary
  // floating point, and a money assertion that fails on the 13th decimal is noise.
  assert.equal(cents(drifting), 2905.22, "September posting already reduces August");
  assert.equal(cents(frozen), 7905.22, "as of 31 August that $5,000 had not posted yet");
  assert.equal(cents(frozen - drifting), 5000);
  // On a job with no late postings the two agree, so this is inert where it should be.
  assert.equal(
    rawLeftToInvoice(JOBS["1130"], { asOf }),
    rawLeftToInvoice(JOBS["1130"], { asOf, asOfPosting: true }),
  );
});

// ── The two remaining differences must be visible, not just documented ───────
//
// Neither is a calculation error and neither is going away:
//
//   FLOOR    Monthly ETC floors each job at 0; the Parts List's column is a signed
//            per-row sum and must stay signed, because over-invoicing is the reason
//            to look at it. Two jobs in August 2026 — 1134 (−$427.54) and 1149
//            (−$93.74), $521.28 together.
//   DRIFT    The Parts List's rule pairs a purchase-date cutoff with LIFETIME
//            invoicing, so a posting dated after month end still reduces that month.
//            31 of 49 jobs, $76,866.43. It does NOT break parity — both surfaces
//            drift together — but a closed month's figure keeps moving.
//
// A difference a manager can only find by re-adding the numbers is the same class of
// problem as the mismatch this change fixed, so both are surfaced on the cell.

test("monthEndLabel names the same day the arithmetic uses", () => {
  // One derivation, so the words and the cutoff cannot disagree. It was an IIFE inside
  // etc/page.tsx, which no test could call.
  assert.equal(monthEndLabel("2026-08"), "August 31, 2026");
  assert.equal(monthEndLabel("2026-02"), "February 28, 2026");
  assert.equal(monthEndLabel("2024-02"), "February 29, 2024", "leap year");
  assert.equal(monthEndLabel("2026-12"), "December 31, 2026");
  for (const bad of ["", "2026-13", "nonsense", null, undefined]) {
    assert.equal(monthEndLabel(bad), "the end of the month", `${bad} must not invent a date`);
  }
  // And it always describes the day monthEndCutoff actually applies.
  for (const m of ["2026-01", "2026-06", "2026-08", "2024-02"]) {
    const cutoff = monthEndCutoff(m)!;
    assert.ok(monthEndLabel(m).includes(String(Number(cutoff.slice(8, 10)))), `${m}: label must name day ${cutoff}`);
  }
});

test("an over-invoiced job reports its floor instead of a bare $0", () => {
  // Job 1134's shape: one settled line and a credit, netting negative.
  const overInvoiced = [
    line({ purchaseDate: "2026-08-05", invoicedDate: "2026-08-11", totalPrice: 500, actualAmount: 500 }),
    line({ purchaseDate: "2026-08-06", invoicedDate: "2026-08-12", totalPrice: -427.54 }),
  ];
  const x = explainLeftToInvoice(overInvoiced, { asOf: monthEndCutoff("2026-08") });
  assert.equal(x.total, 0, "the cell shows 0 — a job cannot owe negative money");
  assert.equal(cents(x.raw), -427.54, "and the raw figure is carried so the cell can say why");
  assert.ok(x.raw < x.total, "raw below total is exactly the floored case");
  // The Parts List's column is the raw one. That is the difference, and it is now
  // derivable from what the grid carries rather than only from a comment.
  assert.equal(cents(x.raw), cents(partsListLeftToInvoice(overInvoiced, monthEndCutoff("2026-08"))));
});

test("a job with no late postings reports no caveat at all", () => {
  // The disclosure has to be inert where it does not apply, or it is noise on 18 of
  // August's 49 jobs.
  const clean = explainLeftToInvoice(JOBS["1130"], { asOf: monthEndCutoff("2026-08") });
  assert.equal(clean.postedAfterCutoff, 0);
  assert.equal(clean.raw, clean.total, "nothing floored");
});


// ── Why there is no submission-time snapshot ─────────────────────────────────
//
// Considered on 2026-09-04 and rejected on the evidence, which these tests pin so the
// idea is not re-proposed from memory:
//
//   1. The submission never reads this figure. monthly-report.ts freezes
//      `newEtcDraft ?? suggestNewEtc(priorEtc, hoursWorked)` — the carry-forward
//      suggestion. The upstream Left to Invoice number never enters history.
//   2. Nothing downstream reads it. Its ONLY consumer is the empty cell's tooltip.
//   3. A frozen copy would no longer equal the Parts List, which is always live —
//      reintroducing the reported mismatch in a narrower place.
//
// What the drift actually justified is smaller and free: on a closed month, do not
// quote a moving number at all.


test("the upstream figure is read once, and never bypasses the resolution rule", () => {
  // It IS the cell's default now rather than a tooltip-only hint, but it must still reach
  // the cell only THROUGH resolveLeftToInvoice — a second consumer would be a figure that
  // ignores an override.
  const page = readFileSync(join(process.cwd(), "src", "app", "(app)", "etc", "page.tsx"), "utf8");
  const code = page.replace(/\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  // Read once.
  assert.equal((code.match(/partsBreakout\?\.byJobPk\.get/g) ?? []).length, 1);
  assert.ok(!/leftToInvoiceValue = [^;]*suggest/.test(code), "the suggestion must never become the cell's value");
  assert.ok(
    !/partsCostGrandTotal\.leftToInvoice \+= [^;]*suggest/.test(code),
    "the suggestion must never enter the footer total",
  );
  // And it reaches the value only via the resolution rule.
  assert.match(code, /const leftToInvoiceValue = resolvedInvoice\.value;/);
});

test("the grid carries the drift caveat out of the data layer", () => {
  // Structural: a figure the page cannot explain is a figure that will be re-reported as
  // a bug. The FLOOR caveat went when the cell started showing the signed figure; the
  // drift is still real and still disclosed.
  const breakout = readFileSync(join(process.cwd(), "src", "lib", "parts-etc-breakout.ts"), "utf8");
  assert.match(breakout, /rawLeftToInvoice: number \| null;/);
  assert.match(breakout, /postedAfterCutoff: number;/);
  assert.match(breakout, /const x = explainLeftToInvoice\(lines, \{ asOf \}\);/);

  const page = readFileSync(join(process.cwd(), "src", "app", "(app)", "etc", "page.tsx"), "utf8");
  assert.match(page, /const cutoffLabel = monthEndLabel\(month\);/, "the page must use the shared label");
  assert.ok(!/const monthEndLabel = \(\(\) =>/.test(page), "the untestable inline copy must be gone");
  assert.match(page, /suggestionLatePostings/, "the drift must reach the tooltip");
  assert.match(page, /not yet invoiced as of \$\{cutoffLabel\}/, "and the tooltip must name the cutoff");
  // The cell is editable again, so the tooltip has to say the figure is a DEFAULT rather
  // than claim it cannot be changed.
  assert.match(page, /This is the default and you can type over it/);
  assert.ok(!/Computed, not typed/.test(page), "the read-only wording must be gone");
});

test("the submission derives Parts Cost New ETC from the two halves — and freezes nothing into them", () => {
  // Revised twice. The read-only version froze the computed figure into
  // `leftToInvoice` so a closed month could not drift. It cannot any more: that column
  // means "the manager's override" and nothing else, so a frozen default would light up
  // the manually-adjusted highlight on rows nobody had touched.
  const report = readFileSync(join(process.cwd(), "src", "lib", "monthly-report.ts"), "utf8");
  assert.match(report, /breakoutSum: partsNewEtc\(resolvedInvoice, purchase\)/, "both halves, or nothing");
  // The halves no longer come FIRST (2026-09-14): they are one input to the one Parts
  // rule in lib/etc.ts — frozen, draft, cleared, the figure a REOPENED row was
  // confirmed at, and only then the live sum. Taking the live sum first is what let a
  // no-edit re-submission of a reopened month replace a manager's signed Parts figure
  // with whatever the invoices had drifted to.
  assert.match(report, /newEtc = partsCostEffectiveNewEtc\(entry, live\);/);
  assert.ok(!/breakoutSum \?\?\s*newEtcForSubmission/.test(report), "the live sum must not outrank the confirmed figure");
  assert.match(report, /resolveLeftToInvoice\(\{/, "through the shared rule, not a private copy");
  // `newEtc` is the frozen figure, as it always was — and the override column is left
  // exactly as the manager left it.
  const code = report.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/leftToInvoice: resolvedInvoice/.test(code), "the submission must not write the override column");
  // An upstream outage must not be able to block closing a month.
  assert.match(report, /Left to Invoice unavailable at submission/);
});

test("New ETC needs BOTH halves, and a blank is never $0", () => {
  // The headline rule, as a unit test rather than only as a source guard.
  assert.equal(partsNewEtc(10_000, null), null, "one half filled is still blank");
  assert.equal(partsNewEtc(null, 2_500), null);
  assert.equal(partsNewEtc(null, null), null);
  assert.equal(partsNewEtc(10_000, 2_500), 12_500, "the report's own example");
  // Zero IS an answer: a manager who types 0 into Left to Purchase has said there is
  // nothing more to buy. Only null is blank — the distinction the old `?? 0` destroyed.
  assert.equal(partsNewEtc(10_000, 0), 10_000);
  assert.equal(partsNewEtc(0, 0), 0);
  // Cents survive, because this figure is money and the Diff beside it is exact.
  assert.equal(partsNewEtc(1_000.01, 2_000.02), 3_000.03);
  // A negative half is legitimate — an over-invoiced job's Left to Invoice is negative,
  // matching the Parts List column — and must not be clamped on the way into the sum.
  assert.equal(partsNewEtc(-427.54, 1_000), 572.46);
});

test("the cell shows the override when there is one, else the computed default", () => {
  const dflt = resolveLeftToInvoice({ computed: 35_496.12, stored: null });
  assert.equal(dflt.value, 35_496.12);
  assert.equal(dflt.source, "default");
  assert.equal(dflt.overridden, false, "an untouched cell is not an adjustment");

  const over = resolveLeftToInvoice({ computed: 35_496.12, stored: 10_000 });
  assert.equal(over.value, 10_000);
  assert.equal(over.source, "override");
  assert.equal(over.overridden, true, "this is the state that gets highlighted");
  assert.equal(over.defaultValue, 35_496.12, "and the tooltip can name what it replaced");
});

test("a stored value equal to the default is not an adjustment", () => {
  // "If the value is restored back to the original amount, remove the highlight."
  const same = resolveLeftToInvoice({ computed: 35_496.12, stored: 35_496.12 });
  assert.equal(same.overridden, false);
  assert.equal(same.source, "default");
  // To the cent, and no wider: a $0.01 difference IS an adjustment on a money column
  // whose Diff is exact.
  assert.equal(resolveLeftToInvoice({ computed: 100, stored: 100.01 }).overridden, true);
  // But floating-point noise is not. 0.1 + 0.2 is the canonical case.
  assert.equal(resolveLeftToInvoice({ computed: 0.1 + 0.2, stored: 0.3 }).overridden, false);
});

test("with no default to compare against, nothing is highlighted", () => {
  // Upstream down. A highlight that appeared during an outage and vanished afterwards
  // would be worse than none, so the value shows and the marker does not.
  const r = resolveLeftToInvoice({ computed: null, stored: 12_345 });
  assert.equal(r.value, 12_345);
  assert.equal(r.overridden, false);
  assert.equal(r.defaultValue, null);
  // And with neither, the cell is genuinely empty — not $0.
  const none = resolveLeftToInvoice({ computed: null, stored: null });
  assert.equal(none.value, null);
  assert.equal(none.source, "unavailable");
});

test("zero is a real override, not an absence", () => {
  // A manager who types 0 has said "nothing left to invoice", which on a job whose
  // default is $35,496 is very much an adjustment.
  const r = resolveLeftToInvoice({ computed: 35_496.12, stored: 0 });
  assert.equal(r.value, 0);
  assert.equal(r.overridden, true);
});
