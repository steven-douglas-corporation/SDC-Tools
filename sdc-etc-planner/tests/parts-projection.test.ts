import test from "node:test";
import assert from "node:assert/strict";
import {
  computePartsProjection,
  computeYetToInvoice,
  isInHouseSdc,
  rowLeftToInvoice,
} from "../src/lib/parts-projection";
import type { PartsCostLine } from "../src/lib/sync-totaleto";

const proj = (invoiced: number, priorEtc: number | null, spent: number, openBalance: number) =>
  computePartsProjection({ invoiced, priorEtc, partsSpentThisMonth: spent, openBalance });

// Unique per call, not a shared constant: lineId is a purchase line's identity,
// and anything that groups by it would silently collapse two fixtures into one.
let lineSeq = 0;
const line = (over: Partial<PartsCostLine>): PartsCostLine => ({
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
  ...over,
});

// ── The specification's own two examples ────────────────────────────────────

test("EXAMPLE 9 — the adjusted ETC covers the remaining exposure", () => {
  // Prior ETC 100,000; spent 25,000; invoiced 500,000; yet to invoice 60,000.
  const p = proj(500_000, 100_000, 25_000, 60_000);
  assert.equal(p.adjustedEtc, 75_000, "100,000 - 25,000");
  assert.equal(p.additionalExposure, 0, "60,000 <= 75,000, so nothing is uncovered");
  assert.equal(p.totalProjection, 575_000);
  // §7: no red, and therefore no line to bound it.
  assert.equal(p.hasAdditionalExposure, false);
  assert.equal(p.coverageLine, null);
});

test("EXAMPLE 10 — yet to invoice exceeds the adjusted ETC", () => {
  // Prior ETC 100,000; spent 40,000; invoiced 500,000; yet to invoice 85,000.
  const p = proj(500_000, 100_000, 40_000, 85_000);
  assert.equal(p.adjustedEtc, 60_000);
  assert.equal(p.additionalExposure, 25_000, "85,000 - 60,000");
  assert.equal(p.totalProjection, 585_000);
  assert.equal(p.hasAdditionalExposure, true);
  assert.equal(p.coverageLine, 560_000, "the line sits at invoiced + adjusted ETC");
});

// ── §8: the two forms of the total must agree, always ──────────────────────

test("the total is both the sum of the three segments and invoiced + max(adjusted, yetToInvoice)", () => {
  for (const invoiced of [0, 500_000, 730_483.31]) {
    for (const priorEtc of [0, 5_621.59, 100_000]) {
      for (const spent of [0, 9_770.96, 40_000, 250_000]) {
        for (const yet of [0, 2_907.25, 45_041.5, 85_000]) {
          const p = proj(invoiced, priorEtc, spent, yet);
          assert.equal(
            p.invoiced + p.adjustedEtc + p.additionalExposure,
            p.totalProjection,
            "the three segments must sum to the bar's height",
          );
          assert.equal(
            p.totalProjection,
            invoiced + Math.max(p.adjustedEtc, yet),
            "and that must equal invoiced + max(adjustedEtc, yetToInvoice)",
          );
        }
      }
    }
  }
});

test("§16 — the covered portion is never counted twice", () => {
  // The forbidden form is invoiced + adjustedEtc + FULL yetToInvoice.
  const p = proj(500_000, 100_000, 40_000, 85_000);
  const doubleCounted = p.invoiced + p.adjustedEtc + p.openBalance;
  assert.equal(doubleCounted, 645_000);
  assert.equal(p.totalProjection, 585_000);
  assert.equal(doubleCounted - p.totalProjection, 60_000, "exactly the adjusted ETC, counted twice");
});

// ── §23's required cases ───────────────────────────────────────────────────

test("adjusted ETC greater than, equal to, and less than yet to invoice", () => {
  // Greater: nothing uncovered.
  const greater = proj(100_000, 50_000, 0, 20_000);
  assert.equal(greater.additionalExposure, 0);
  assert.equal(greater.totalProjection, 150_000);

  // Equal: still nothing uncovered — the forecast covers it exactly.
  const equal = proj(100_000, 50_000, 0, 50_000);
  assert.equal(equal.additionalExposure, 0);
  assert.equal(equal.hasAdditionalExposure, false);
  assert.equal(equal.totalProjection, 150_000);

  // Less: the difference is uncovered.
  const less = proj(100_000, 50_000, 0, 70_000);
  assert.equal(less.additionalExposure, 20_000);
  assert.equal(less.totalProjection, 170_000);
});

test("a negative adjusted ETC is floored for the bar but kept for the record (§3)", () => {
  // Job 1101's real August figures: prior ETC 5,621.59, spent 9,770.96.
  const p = proj(730_483.31, 5_621.59, 9_770.96, 45_041.5);
  assert.ok(Math.abs(p.adjustedEtcRaw! - -4_149.37) < 0.005, "the raw figure is negative and preserved");
  assert.equal(p.adjustedEtc, 0, "the drawn segment cannot be negative");
  // With no forecast left, the whole eligible exposure is uncovered.
  assert.equal(p.additionalExposure, 45_041.5);
  assert.ok(Math.abs(p.totalProjection - 775_524.81) < 0.005);
});

test("no invoices yet", () => {
  const p = proj(0, 100_000, 0, 30_000);
  assert.equal(p.invoiced, 0);
  assert.equal(p.adjustedEtc, 100_000);
  assert.equal(p.additionalExposure, 0);
  assert.equal(p.totalProjection, 100_000);
});

test("fully invoiced — nothing left to invoice and nothing forecast", () => {
  const p = proj(500_000, 0, 0, 0);
  assert.equal(p.adjustedEtc, 0);
  assert.equal(p.additionalExposure, 0);
  assert.equal(p.totalProjection, 500_000, "the bar is just the invoiced actual");
  assert.equal(p.coverageLine, null);
});

test("a zero adjusted ETC leaves the whole exposure uncovered", () => {
  const p = proj(200_000, 10_000, 10_000, 15_000);
  assert.equal(p.adjustedEtc, 0);
  assert.equal(p.additionalExposure, 15_000);
  assert.equal(p.coverageLine, 200_000, "the line sits at invoiced, with no covered band above it");
});

test("no prior ETC resolvable at all reads as unknown, not as zero", () => {
  const p = proj(200_000, null, 5_000, 15_000);
  assert.equal(p.etcUnknown, true);
  assert.equal(p.priorEtc, null);
  assert.equal(p.adjustedEtcRaw, null, "there is no adjustment to report");
  assert.equal(p.adjustedEtc, 0);
  // The exposure is still reported in full.
  assert.equal(p.additionalExposure, 15_000);
  assert.equal(p.totalProjection, 215_000);
});

// ── §13: stability under normal conversion ─────────────────────────────────

test("the total holds while dollars move from forecast to actual", () => {
  // The spec's own walkthrough: 10,000 of forecast becomes invoiced spend.
  const before = proj(500_000, 100_000, 25_000, 60_000);
  assert.equal(before.adjustedEtc, 75_000);
  assert.equal(before.totalProjection, 575_000);

  // The invoice raises invoiced AND this month's parts spend by the same 10,000,
  // which is what draws the forecast down.
  const after = proj(510_000, 100_000, 35_000, 50_000);
  assert.equal(after.adjustedEtc, 65_000);
  assert.equal(after.totalProjection, 575_000, "blue grew, yellow shrank, the total held");
});

test("stability also holds in the uncovered regime", () => {
  // Where yetToInvoice is the larger term, an invoice moves the same dollars out of
  // it, so the total is invoiced + yetToInvoice and does not move either.
  let prev: number | null = null;
  for (let step = 0; step <= 40_000; step += 5_000) {
    const p = proj(500_000 + step, 10_000, 10_000, 40_000 - step);
    if (prev != null) assert.equal(p.totalProjection, prev);
    prev = p.totalProjection;
  }
  assert.equal(prev, 540_000);
});

test("the total DOES move when real exposure changes, which is the point", () => {
  // A new purchase commitment raises the exposure and should raise the projection.
  const before = proj(500_000, 10_000, 10_000, 20_000);
  const after = proj(500_000, 10_000, 10_000, 35_000);
  assert.equal(after.totalProjection - before.totalProjection, 15_000);
});

// ── §6: in-house SDC is excluded from the exposure ─────────────────────────

test("in-house SDC is matched on manufacturer, on a word boundary", () => {
  assert.equal(isInHouseSdc({ manufacturer: "SDC" }), true);
  assert.equal(isInHouseSdc({ manufacturer: "sdc" }), true, "case-insensitive");
  assert.equal(isInHouseSdc({ manufacturer: "  SDC  " }), true, "whitespace-tolerant");
  // Real value found in the data (1 line across three jobs).
  assert.equal(isInHouseSdc({ manufacturer: "SDC ASSY" }), true);
  // Must NOT catch an outside vendor whose name merely starts with those letters.
  assert.equal(isInHouseSdc({ manufacturer: "SDCO Inc" }), false);
  assert.equal(isInHouseSdc({ manufacturer: "Weidmuller" }), false);
  assert.equal(isInHouseSdc({ manufacturer: null }), false);
});

test("the SUPPLIER field is not used for in-house classification", () => {
  // Measured in the live data: the /sdc/i supplier values are
  // "SDC Credit Card (Approved)" and "Reconciling With Sage - SDC" — payment
  // mechanisms for genuine OUTSIDE purchases. Excluding them would drop real
  // external exposure out of the figure.
  assert.equal(isInHouseSdc({ manufacturer: "Weidmuller" } as never), false);
  const creditCard = line({ manufacturer: "Mersen", supplier: "SDC Credit Card (Approved)", totalPrice: 500 });
  assert.equal(isInHouseSdc(creditCard), false, "a card purchase from an outside maker is external exposure");
  const y = computeYetToInvoice([creditCard]);
  assert.equal(y.amount, 500);
  assert.equal(y.inHouseExcluded, 0);
});

test("yet to invoice excludes in-house rows and reports what it excluded", () => {
  const lines = [
    line({ manufacturer: "Weidmuller", totalPrice: 1_000, actualAmount: 400 }), // 600 external
    line({ manufacturer: "SDC", totalPrice: 900, actualAmount: 100 }), // 800 in-house
    line({ manufacturer: "SDC ASSY", totalPrice: 200, actualAmount: 0 }), // 200 in-house
    line({ manufacturer: "Mersen", totalPrice: 500, actualAmount: 500 }), // 0, fully posted
  ];
  const y = computeYetToInvoice(lines);
  assert.equal(y.amount, 600, "only the external remainder");
  assert.equal(y.inHouseExcluded, 1_000, "800 + 200");
  assert.equal(y.inHouseRows, 2);
  assert.equal(y.allRows, 1_600, "what the card's Left to be invoiced has always shown");
  // The exclusion is exactly the difference, so the drill-through reconciles.
  assert.equal(y.allRows - y.amount, y.inHouseExcluded);
});

test("the row basis is totalPrice minus the GL-POSTED amount (§17)", () => {
  // Not `invoicedAmount`. On job 1101 the two definitions differ by $19,498
  // ($61,126 against $41,628), which would put the card, the Parts List and this
  // projection on three different footings.
  const l = line({ totalPrice: 1_000, invoicedAmount: 900, actualAmount: 400 });
  assert.equal(rowLeftToInvoice(l), 600);
});

test("credits net against their neighbours rather than being clamped per row", () => {
  // A line whose posted spend exceeds its purchased total is a credit. The floor is
  // applied to the AGGREGATE, matching the existing job-wide convention.
  const lines = [
    line({ manufacturer: "Weidmuller", totalPrice: 1_000, actualAmount: 200 }), // +800
    line({ manufacturer: "Mersen", totalPrice: 0, actualAmount: 300 }), // -300 credit
  ];
  assert.equal(computeYetToInvoice(lines).amount, 500, "800 - 300, not 800");
});

test("a job whose credits exceed its open balance floors at zero, not negative", () => {
  const lines = [line({ manufacturer: "Mersen", totalPrice: 0, actualAmount: 5_000 })];
  const y = computeYetToInvoice(lines);
  assert.equal(y.amount, 0);
  assert.equal(y.allRows, 0);
});

test("freight, tariffs and non-BOM rows are ordinary external exposure", () => {
  // They have no in-house manufacturer, so nothing excludes them — which is right:
  // a freight charge does produce a supplier invoice.
  const lines = [
    line({ manufacturer: null, description: "Shipping", totalPrice: 865, actualAmount: 0 }),
    line({ manufacturer: null, description: "TARIFF", totalPrice: 27, actualAmount: 27 }),
  ];
  const y = computeYetToInvoice(lines);
  assert.equal(y.amount, 865);
  assert.equal(y.inHouseRows, 0);
});

// ── Guards ─────────────────────────────────────────────────────────────────

test("bad data cannot produce a NaN or negative segment", () => {
  for (const p of [
    proj(NaN, 100_000, 25_000, 60_000),
    proj(500_000, 100_000, NaN, 60_000),
    proj(500_000, 100_000, 25_000, NaN),
    proj(500_000, NaN, 25_000, 60_000),
  ]) {
    assert.ok(Number.isFinite(p.totalProjection));
    assert.ok(p.adjustedEtc >= 0 && p.additionalExposure >= 0 && p.openBalance >= 0);
    assert.equal(p.invoiced + p.adjustedEtc + p.additionalExposure, p.totalProjection);
  }
  assert.equal(proj(500_000, NaN, 25_000, 60_000).etcUnknown, true, "a NaN prior ETC is unknown, not zero");
});

test("a negative open balance is not exposure", () => {
  const p = proj(500_000, 10_000, 0, -2_000);
  assert.equal(p.openBalance, 0);
  assert.equal(p.additionalExposure, 0);
  assert.equal(p.totalProjection, 510_000);
});

// ── The invariant that was missing (2026-09-03) ─────────────────────────────
//
// Reported: "how can the projection be less than spent + open POs?" It could not, and
// the answer was that the exposure term excluded in-house SDC while Purchased did
// not. Audited over ten jobs, 7 projected BELOW Purchased by exactly the in-house
// open balance. This is the guard that would have caught it.

test("the projection can NEVER fall below what is already committed", () => {
  // purchased = invoiced + openBalance, and the projection adds
  // max(adjustedEtc, openBalance) on top of invoiced — so it is >= purchased by
  // construction. Swept rather than sampled, including the shapes that broke it.
  for (const invoiced of [0, 1, 732_019, 1_542_939]) {
    for (const openBalance of [0, 1, 41_880, 59_590, 525_808]) {
      for (const priorEtc of [null, 0, 1, 5_622, 649_898]) {
        for (const spent of [0, 10_796, 38_204]) {
          const p = proj(invoiced, priorEtc, spent, openBalance);
          const purchased = invoiced + openBalance;
          assert.ok(
            p.totalProjection >= purchased - 0.005,
            `projection ${p.totalProjection} < purchased ${purchased} ` +
              `(invoiced ${invoiced}, open ${openBalance}, prior ${priorEtc}, spent ${spent})`,
          );
        }
      }
    }
  }
});

test("the audited jobs that used to project below Purchased no longer do", () => {
  // The three clearest failures from the audit, with their real figures.
  //
  //   1101  purchased 791,609  was projecting 776,971  (in-house open 14,639)
  //   1104  purchased 821,469  was projecting 783,096  (in-house open 38,373)
  //   1142  purchased 1,584,820 was projecting 1,542,939 — its EXTERNAL open balance
  //         is 0 and its in-house balance is 41,880, so the old formula came out
  //         exactly equal to invoiced and ignored the committed work entirely.
  const cases: [string, number, number, number | null, number, number][] = [
    // label, invoiced, openBalance, priorEtc, spentMonth, expected projection
    ["1101", 732_019, 59_590, 5_622, 10_796, 791_609],
    ["1104", 770_858, 50_611, 6_426, 5_962, 821_469],
    ["1142", 1_542_939, 41_880, 0, 0, 1_584_819],
  ];
  for (const [label, invoiced, open, prior, spent, expected] of cases) {
    const p = proj(invoiced, prior, spent, open);
    assert.ok(
      Math.abs(p.totalProjection - expected) < 1.5,
      `${label}: projection ${p.totalProjection}, expected about ${expected}`,
    );
    assert.ok(p.totalProjection >= invoiced + open - 0.005, `${label} still projects below purchased`);
  }
});

test("an ETC above the open balance still drives the projection, and stays above Purchased", () => {
  // Job 1148: adjusted ETC 649,898 against an open balance of 525,808. The forecast
  // is the larger term, so it rides on top — and the result clears Purchased with
  // room, which is the correct reading of "we expect to spend more than we have
  // committed so far".
  const p = proj(1_205_120, 688_101, 38_204, 525_808);
  assert.equal(p.adjustedEtc, 649_897);
  assert.equal(p.totalProjection, 1_205_120 + 649_897);
  assert.ok(p.totalProjection > 1_205_120 + 525_808);
  // And in-house is nowhere in this figure — it is not stacked on top of the ETC,
  // which would be the double-count the header's rejected alternative describes.
});
