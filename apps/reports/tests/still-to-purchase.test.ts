import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeStillToPurchase, bomUncoveredEstimate } from "../src/lib/still-to-purchase";
import { computePartsProjection } from "../src/lib/parts-projection";
import type { PartsCostLine } from "../src/lib/sync-totaleto";

// ── "Still to purchase" (2026-10-19) ─────────────────────────────────────────
//
// The card's projection has always been  Invoiced + the larger of (Adjusted ETC, open POs).  The ETC
// means "all cost still to come", so it already contains the open POs; taking them out leaves what has
// not been ordered. These pin that the new wording — Purchased to date + Still to purchase — is the SAME
// number, not a second formula, and that the second route (still to purchase last month less purchases
// this month) lands on it.

const line = (o: Partial<PartsCostLine> & Pick<PartsCostLine, "totalPrice" | "actualAmount" | "purchaseDate">): PartsCostLine => ({
  lineId: `pod:${Math.random()}`, itemId: 1, invoicedDate: null, supplier: "Acme", manufacturer: null, category: null,
  poNumber: "1", partNumber: "A", description: "x", quantity: 1, unitPrice: o.totalPrice, invoicedAmount: o.actualAmount, ...o,
});

// ── The identity, on a grid of figures ───────────────────────────────────────

test("Invoiced + max(ETC, open) is exactly Invoiced + open + still to purchase, on every combination", () => {
  for (const invoiced of [0, 1234.56, 199504.88, 3_000_000]) {
    for (const open of [0, 249.1, 60585.35, 104879.45]) {
      for (const prior of [null, 0, 5000, 70064.75, 113451.9, 250000]) {
        for (const spent of [0, 818.75, 2721.42, 90000]) {
          const p = computePartsProjection({ invoiced, priorEtc: prior, partsSpentThisMonth: spent, openBalance: open });
          const stp = Math.max(0, p.adjustedEtc - open);
          assert.ok(
            Math.abs(p.totalProjection - (invoiced + open + stp)) < 1e-6,
            `invoiced ${invoiced}, open ${open}, prior ${prior}, spent ${spent}`,
          );
        }
      }
    }
  }
});

// ── Job 1160, October 2026, to the cent ──────────────────────────────────────

test("1160: $70,064.75 − $818.75 = $69,246.00 adjusted; − $60,585.35 open POs = $8,660.65 still to purchase", () => {
  const r = computeStillToPurchase({
    priorEtc: 70064.75, partsSpentThisMonth: 818.75, adjustedEtc: 69246, openBalance: 60585.35,
    purchased: 260090.23, projection: 268750.88, etcUnknown: false, etcMonth: "2026-10", lines: [], todayMonth: "2026-10",
  });
  assert.equal(Math.round(r.stillToPurchase * 100) / 100, 8660.65);
  assert.equal(Math.round(r.stillToPurchase), 8661);
  assert.equal(r.floored, false);
  // Purchased to date + still to purchase is the projected total the card has always shown.
  assert.ok(Math.abs(260090.23 + r.stillToPurchase - 268750.88) < 0.005);
});

test("1158: still to purchase is $5,851 and purchased + it equals the $257,227 projection", () => {
  // purchased 251,376.32 = invoiced 146,496.88 + open 104,879.45; adjusted ETC 113,451.90 − 2,721.42.
  const adjusted = 113451.9 - 2721.42;
  const r = computeStillToPurchase({
    priorEtc: 113451.9, partsSpentThisMonth: 2721.42, adjustedEtc: adjusted, openBalance: 104879.45,
    purchased: 251376.32, projection: 257227.36, etcUnknown: false, etcMonth: "2026-10", lines: [], todayMonth: "2026-10",
  });
  assert.equal(Math.round(r.stillToPurchase), 5851);
  assert.ok(Math.abs(251376.32 + r.stillToPurchase - 257227.36) < 0.01);
});

// ── The edge cases the card must say plainly ─────────────────────────────────

test("a forecast below the open POs: still to purchase is $0, flagged, and never negative", () => {
  const r = computeStillToPurchase({
    priorEtc: 10000, partsSpentThisMonth: 2000, adjustedEtc: 8000, openBalance: 30000,
    purchased: 100000, projection: 100000, etcUnknown: false, etcMonth: "2026-10", lines: [], todayMonth: "2026-10",
  });
  assert.equal(r.stillToPurchase, 0);
  assert.equal(r.floored, true);
});

test("no prior-month ETC on file: still to purchase is $0 and the second route does not apply", () => {
  const r = computeStillToPurchase({
    priorEtc: null, partsSpentThisMonth: 0, adjustedEtc: 0, openBalance: 5000,
    purchased: 20000, projection: 20000, etcUnknown: true, etcMonth: null, lines: [], todayMonth: "2026-10",
  });
  assert.equal(r.stillToPurchase, 0);
  assert.equal(r.etcUnknown, true);
  assert.equal(r.floored, false, "an absent forecast is not a forecast below the POs");
  assert.equal(r.secondRoute, null);
});

// ── The second route: what was still to buy last month, less what was bought this month ──

//   L1  bought Aug, invoiced Sep      -> fully invoiced before October: not open at 9/30
//   L2  bought Aug, invoiced 10/05    -> open at 9/30, invoiced this month ($6,000 of October's invoices)
//   L3  bought 10/03, not invoiced    -> bought this month, open now ($2,000)
const LINES: PartsCostLine[] = [
  line({ purchaseDate: "2026-08-15", totalPrice: 10000, actualAmount: 10000, invoicedDate: "2026-09-05" }),
  line({ purchaseDate: "2026-08-20", totalPrice: 6000, actualAmount: 6000, invoicedDate: "2026-10-05" }),
  line({ purchaseDate: "2026-10-03", totalPrice: 2000, actualAmount: 0 }),
];
const base = { etcMonth: "2026-10", todayMonth: "2026-10", lines: LINES, purchased: 18000, etcUnknown: false };

test("worked both ways the figure is the same: $5,000 − $2,000 bought = $3,000 = $5,000 − $2,000 open", () => {
  // Prior ETC at the end of September: $6,000 open POs + $5,000 still to purchase = $11,000.
  // This month: $6,000 invoiced, $2,000 bought.
  const r = computeStillToPurchase({
    ...base, priorEtc: 11000, partsSpentThisMonth: 6000, adjustedEtc: 11000 - 6000, openBalance: 2000, projection: 18000 + 3000,
  });
  assert.equal(r.openAtLastMonthEnd, 6000, "L2 was still to be invoiced at 9/30 (its invoice posted in October)");
  assert.equal(r.stillToPurchaseLastMonth, 5000);
  assert.equal(r.purchasedThisMonth, 2000, "only L3 was bought in October");
  assert.equal(r.secondRoute, 3000);
  assert.equal(r.stillToPurchase, 3000);
  assert.equal(r.difference, 0);
  assert.equal(r.lastMonthEnd, "2026-09-30");
});

test("an invoice left out of 'invoiced this month' (SDC billing itself) shows up as the difference, to the dollar", () => {
  // $33 of the October invoices is an SDC self-billing: not in "spent", but the line's open balance is
  // gone all the same. The first route sees $33 more forecast than the second.
  const r = computeStillToPurchase({
    ...base, priorEtc: 11000, partsSpentThisMonth: 6000 - 33, adjustedEtc: 11000 - 5967, openBalance: 2000, projection: 21033,
  });
  assert.equal(r.stillToPurchase, 3033);
  assert.equal(r.secondRoute, 3000);
  assert.equal(r.difference, 33);
});

test("the second route is left out for a past ETC month — today's lines would not describe it", () => {
  const r = computeStillToPurchase({
    ...base, priorEtc: 11000, partsSpentThisMonth: 6000, adjustedEtc: 5000, openBalance: 2000, projection: 21000,
    etcMonth: "2026-08", todayMonth: "2026-10",
  });
  assert.equal(r.secondRoute, null);
  assert.equal(r.difference, null);
  assert.equal(r.stillToPurchase, 3000, "the first route still applies");
});

test("a floored second route never goes negative", () => {
  const r = computeStillToPurchase({
    ...base, priorEtc: 7000, partsSpentThisMonth: 6000, adjustedEtc: 1000, openBalance: 2000, projection: 18000,
  });
  assert.equal(r.secondRoute, 0, "7,000 − 6,000 open = 1,000 still to buy last month, less 2,000 bought this month");
});

// ── The BOM cross-check ──────────────────────────────────────────────────────

test("the BOM figure counts only BOM rows with nothing bought AND nothing covering them", () => {
  const rows = [
    { nonBom: false, matchReason: "no-purchase", totalPrice: 249.28, status: "noPO", hold: false }, // counts
    { nonBom: false, matchReason: "no-purchase", totalPrice: 500, status: "received", hold: false }, // covered from stock
    { nonBom: false, matchReason: "no-purchase", totalPrice: 300, status: "noPO", hold: true }, // on hold
    { nonBom: false, matchReason: "no-purchase", totalPrice: 80, status: "process", hold: false }, // in process
    { nonBom: false, matchReason: "matched", totalPrice: 900, status: "noPO", hold: false }, // has a purchase line
    { nonBom: true, matchReason: "no-purchase", totalPrice: 700, status: "noPO", hold: false }, // freight etc., not a BOM part
  ];
  assert.deepEqual(bomUncoveredEstimate(rows), { amount: 249.28, parts: 1 });
  assert.deepEqual(bomUncoveredEstimate([]), { amount: 0, parts: 0 });
});

// ── Wiring: structural guards ────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const noComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

test("the card reads still to purchase from the one reconciliation; the forecast estimate is only the fallback", () => {
  assert.match(noComments(read("src", "components", "PartsCostSummary.tsx")), /const stillToPurchaseAmount = financials\.stillToPurchase;/);
  assert.match(noComments(read("src", "lib", "still-to-purchase.ts")), /const stillToPurchase = Math\.max\(0, i\.adjustedEtc - i\.openBalance\);/);
  assert.match(noComments(read("src", "components", "PartsCostDrill.tsx")), /financials\.stillToPurchase/);
});

test("the projection is Purchased + Still to purchase (2026-10-21); the old model stays as the fallback estimate", () => {
  const projection = noComments(read("src", "lib", "parts-projection.ts"));
  assert.match(projection, /const additionalExposure = Math\.max\(0, openBalance - adjustedEtc\);/);
  assert.match(projection, /const totalProjection = invoiced \+ adjustedEtc \+ additionalExposure;/);
  const financials = noComments(read("src", "lib", "parts-cost-financials.ts"));
  assert.match(financials, /const projectionTotal = purchased \+ stp\.stillToPurchase;/, "projected total = purchased + still to purchase");
});

test("the card never waits on the BOM: the cross-check loads on demand, in the panel only", () => {
  assert.doesNotMatch(noComments(read("src", "lib", "parts-cost-financials.ts")), /job-bom|getJobBom/, "reading a BOM can take 100s of seconds");
  assert.doesNotMatch(noComments(read("src", "components", "PartsCostSummary.tsx")), /parts-bom-check-actions|loadBomStillToBuy/);
  assert.match(noComments(read("src", "components", "StillToPurchasePanel.tsx")), /loadBomStillToBuy\(jobKey\)/);
  assert.match(noComments(read("src", "components", "PartsCostDrill.tsx")), /<StillToPurchasePanel financials=\{financials\} jobIds=\{jobIds\}/);
});

test("the BOM check is read-only, signed-in only, and gives up rather than hang", () => {
  const src = noComments(read("src", "lib", "parts-bom-check-actions.ts"));
  assert.match(src, /^"use server";/m);
  assert.match(src, /const session = await auth\(\);\s*\n\s*if \(!session\?\.user\) throw new Error\("Not signed in\."\);/);
  assert.match(src, /const BOM_CHECK_BUDGET_MS = 90_000;/);
  assert.match(src, /withTimeoutOrNull\(/);
  assert.doesNotMatch(src, /\.(create|update|delete|upsert)\(|\b(INSERT|UPDATE|DELETE)\b/);
});

test("the old red 'uncovered' band and its dotted line are gone, replaced by the Not yet invoiced segment", () => {
  const card = noComments(read("src", "components", "PartsCostSummary.tsx"));
  assert.doesNotMatch(card, /BAR_UNCOVERED|hasAdditional|coverageLinePx|Uncovered invoice exposure/);
  assert.match(card, /const BAR_OPEN = /);
});

test("the segment drills: Not yet invoiced opens its rows, Still to purchase opens this explanation", () => {
  const card = noComments(read("src", "components", "PartsCostSummary.tsx"));
  assert.match(card, /if \(key === "stp" \|\| key === "excess"\) return "etc";/);
  assert.match(card, /if \(key === "open"\) return "left";/);
});

// ── Left to Purchase last month − purchased this month (2026-10-21) ──────────

import { jobStillToPurchase, sumStillToPurchase, purchasedSinceMonthStart } from "../src/lib/still-to-purchase";

test("still to purchase = last month's Left to Purchase − purchased this month", () => {
  const r = jobStillToPurchase({ leftToPurchaseLastMonth: 10000, purchasedThisMonth: 4000, fallback: 999 });
  assert.equal(r.signed, 6000);
  assert.equal(r.stillToPurchase, 6000);
  assert.equal(r.excess, 0);
  assert.equal(r.source, "monthly-etc");
});

test("more purchased than was left to purchase is −$2,000, not $0, and is reported as excess", () => {
  const r = jobStillToPurchase({ leftToPurchaseLastMonth: 10000, purchasedThisMonth: 12000, fallback: 0 });
  assert.equal(r.signed, -2000);
  assert.equal(r.stillToPurchase, 0);
  assert.equal(r.excess, 2000);
});

test("a job with no Left to Purchase last month uses the forecast estimate", () => {
  const r = jobStillToPurchase({ leftToPurchaseLastMonth: null, purchasedThisMonth: 5000, fallback: 321 });
  assert.equal(r.source, "forecast");
  assert.equal(r.stillToPurchase, 321);
  assert.equal(r.excess, 0);
});

test("jobs are summed one by one: an excess is not netted against another job's remainder", () => {
  const t = sumStillToPurchase([
    { leftToPurchaseLastMonth: 10000, purchasedThisMonth: 12000, fallback: 0 },
    { leftToPurchaseLastMonth: 8000, purchasedThisMonth: 3000, fallback: 0 },
    { leftToPurchaseLastMonth: null, purchasedThisMonth: 100, fallback: 50 },
  ]);
  assert.equal(t.stillToPurchase, 5050);
  assert.equal(t.excess, 2000);
  assert.equal(t.signed, 3050);
  assert.equal(t.leftToPurchaseLastMonth, 18000);
  assert.equal(t.purchasedThisMonth, 15000);
  assert.equal(t.jobsFromMonthlyEtc, 2);
  assert.equal(t.jobsFromForecast, 1);
});

test("purchases count from the first day of the ETC month onward", () => {
  const lines = [
    line({ totalPrice: 100, actualAmount: 0, purchaseDate: "2026-09-30" }),
    line({ totalPrice: 200, actualAmount: 0, purchaseDate: "2026-10-01" }),
    line({ totalPrice: 300, actualAmount: 0, purchaseDate: "2026-10-20T08:00:00" }),
    line({ totalPrice: 400, actualAmount: 0, purchaseDate: null }),
  ];
  assert.equal(purchasedSinceMonthStart(lines, "2026-10"), 500);
  assert.equal(purchasedSinceMonthStart(lines, null), 0);
});

// ── Live behaviour: every purchase moves the figures, the total, and the red excess ──

test("as purchases rise the projected total holds until the Left to Purchase is used up, then climbs as excess", () => {
  const base = 100000; // purchased to date before this month's buying
  for (const [bought, expTotal, expStp, expExcess] of [
    [0, 110000, 10000, 0],
    [4000, 110000, 6000, 0],
    [10000, 110000, 0, 0],
    [12000, 112000, 0, 2000], // job 1101's shape: 10,000 left, 12,000 bought
    [15000, 115000, 0, 5000],
  ] as const) {
    const t = sumStillToPurchase([{ leftToPurchaseLastMonth: 10000, purchasedThisMonth: bought, fallback: 0 }]);
    assert.equal(t.stillToPurchase, expStp, `bought ${bought}`);
    assert.equal(t.excess, expExcess, `bought ${bought}`);
    assert.equal(base + bought + t.stillToPurchase, expTotal, `bought ${bought}`);
  }
});

test("a new month reads the PREVIOUS month's row, so next month's Left to Purchase takes over by itself", async () => {
  const { previousMonthKey } = await import("../src/lib/still-to-purchase");
  assert.equal(previousMonthKey("2026-11"), "2026-10");
  assert.equal(previousMonthKey("2027-01"), "2026-12");
});

test("the card renders the red excess band, dotted line and label from the figures alone", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { PartsCostSummary } = await import("../src/components/PartsCostSummary");
  const f = {
    budget: 215565, invoiced: 90000, leftToInvoice: 10000, etc: 0, totalSpent: 100000, projection: 100000,
    purchased: 100000, stillToPurchase: 0, excessPurchased: 2000, stillToPurchaseSigned: -2000,
    leftToPurchaseLastMonth: 10000, purchasedThisMonth: 12000, stpJobsFromMonthlyEtc: 1, stpJobsFromForecast: 0,
    billedNotPosted: 0, priorEtc: 5000, priorEtcSource: "carry-forward", partsSpentThisMonth: 1000, adjustedEtcRaw: 4000,
    adjustedEtc: 4000, openBalance: 10000, externalOpen: 10000, inHouseExcluded: 0, inHouseRows: 0, additionalExposure: 0,
    coverageLine: null, etcUnknown: false, etcMonth: "2026-10", variance: -115565, variancePct: -53.6, failedJobs: 0,
    lineCount: 0, lines: [], transfersNet: 0, transfers: [], transferItems: [], transfersUnavailable: false,
  } as unknown as Parameters<typeof PartsCostSummary>[0]["financials"];
  const html = renderToStaticMarkup(React.createElement(PartsCostSummary, { financials: f }));
  assert.match(html, /incl\. \$2,000 excess/);
  assert.match(html, /border-top:2px dotted #C0392B/i);
  assert.match(html, /background:#C0392B/i);
  assert.match(html, /[-−]\$2,000<\/td>/, "still to purchase reads negative");
  assert.match(html, /text-sdc-red-text">[-−]\$2,000/, "and in red");
  const none = renderToStaticMarkup(React.createElement(PartsCostSummary, {
    financials: { ...f, excessPurchased: 0, stillToPurchase: 3000, stillToPurchaseSigned: 3000, projection: 103000, purchasedThisMonth: 7000 },
  }));
  assert.doesNotMatch(none, /excess|2px dotted|background:#C0392B/i);
});
