import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_RATES,
  computeJobCost,
  isUtilityJob,
  laborForType,
  rateForYear,
  partsCostForProfit,
  jobCostTotals,
  type JobCostComputed,
  type JobCostRow,
} from "../src/lib/job-cost";

// These pin down the port from the standalone Job Cost Explorer app's
// compute()/laborForType() (D:\AI Projects\new app\public\app.js:330-378) —
// the formulas must not change without a deliberate, documented reason.

function baseRow(overrides: Partial<JobCostRow> = {}): JobCostRow {
  return {
    jobId: "1200",
    jobName: "Test Job",
    status: "Active",
    customerName: "Acme",
    machineType: null,
    actualHours: 100,
    engineeringHours: 60,
    shopHours: 40,
    otherHours: 0,
    partCost: 1000,
    partInvoiced: 800,
    salesPrice: 50000,
    startDate: "2025-01-01",
    completeDate: null,
    percentComplete: 50,
    hoursByYear: {},
    etcEngHours: 10,
    etcShopHours: 5,
    etcPartsCost: 200,
    ...overrides,
  };
}

test("rateForYear falls back to the default for any unset field", () => {
  const r = rateForYear("2025", DEFAULT_RATES, { "2025": { engRate: 250 } });
  assert.equal(r.engRate, 250);
  assert.equal(r.shopRate, DEFAULT_RATES.shopRate);
  assert.equal(r.pmPct, DEFAULT_RATES.pmPct);
});

test("rateForYear with no override at all returns the default untouched", () => {
  const r = rateForYear("2030", DEFAULT_RATES, {});
  assert.deepEqual(r, DEFAULT_RATES);
});

test("laborForType costs the aggregate hours at the default rate with no year data", () => {
  const row = baseRow({ hoursByYear: {}, engineeringHours: 60 });
  const cost = laborForType(row, DEFAULT_RATES, {}, undefined, "eng");
  assert.equal(cost, 60 * DEFAULT_RATES.engRate);
});

test("laborForType costs each year's hours at that year's rate when hoursByYear is present", () => {
  const row = baseRow({ hoursByYear: { "2025": { eng: 20, shop: 0 }, "2026": { eng: 40, shop: 0 } } });
  const overrides = { "2025": { engRate: 100 } };
  const cost = laborForType(row, DEFAULT_RATES, overrides, undefined, "eng");
  assert.equal(cost, 20 * 100 + 40 * DEFAULT_RATES.engRate);
});

test("laborForType prefers a manual allocation over the automatic year breakdown", () => {
  const row = baseRow({ hoursByYear: { "2025": { eng: 999, shop: 0 } } });
  const allocation = { eng: [{ hours: 30, year: "2025" }], shop: [] };
  const cost = laborForType(row, DEFAULT_RATES, {}, allocation, "eng");
  assert.equal(cost, 30 * DEFAULT_RATES.engRate);
});

test("computeJobCost: PM/Mfg % apply at the completion-year rate, not the work-year rate", () => {
  const row = baseRow({
    salesPrice: 10000,
    completeDate: "2026-03-01",
    hoursByYear: {},
    engineeringHours: 0,
    shopHours: 0,
    etcEngHours: 0,
    etcShopHours: 0,
    etcPartsCost: 0,
    partCost: 0,
  });
  const overrides = { "2026": { pmPct: 5, mfgPct: 2 } };
  const c = computeJobCost(row, DEFAULT_RATES, overrides, undefined);
  assert.equal(c.pmCost, 10000 * 0.05);
  assert.equal(c.mfgCost, 10000 * 0.02);
});

test("computeJobCost: a Complete job zeroes ETC before costing and forces 100% complete", () => {
  const row = baseRow({ status: "Complete", etcEngHours: 999, etcShopHours: 999, etcPartsCost: 999, percentComplete: 40 });
  const c = computeJobCost(row, DEFAULT_RATES, {}, undefined);
  assert.equal(c.etcEngHours, 0);
  assert.equal(c.etcShopHours, 0);
  assert.equal(c.etcPartsCost, 0);
  assert.equal(c.percentComplete, 100);
});

test("computeJobCost: an Active job's ETC is not zeroed and percentComplete passes through", () => {
  const row = baseRow({ status: "Active", etcEngHours: 12, percentComplete: 40 });
  const c = computeJobCost(row, DEFAULT_RATES, {}, undefined);
  assert.equal(c.etcEngHours, 12);
  assert.equal(c.percentComplete, 40);
});

test("computeJobCost: ETC (future) hours always cost at the default rate, never a year override", () => {
  const row = baseRow({
    status: "Active",
    hoursByYear: {},
    engineeringHours: 0,
    shopHours: 0,
    etcEngHours: 10,
    etcShopHours: 0,
    etcPartsCost: 0,
    partCost: 0,
    partInvoiced: 0, // parts must contribute nothing here — see partsCostForProfit
    salesPrice: 0,
    completeDate: null,
  });
  // A year override that would change the answer if it were (wrongly) applied to ETC hours.
  const overrides = { [String(new Date().getFullYear())]: { engRate: 99999 } };
  const c = computeJobCost(row, DEFAULT_RATES, overrides, undefined);
  assert.equal(c.laborCost, 0); // no worked hours, no sales-based PM/Mfg
  assert.equal(c.profit, 0 - 10 * DEFAULT_RATES.engRate);
});

test("computeJobCost: profit is null with no sales price on file, not zero", () => {
  const row = baseRow({ salesPrice: null });
  const c = computeJobCost(row, DEFAULT_RATES, {}, undefined);
  assert.equal(c.profit, null);
  assert.equal(c.margin, null);
});

test("computeJobCost: margin is profit as a percentage of sales", () => {
  const row = baseRow({
    salesPrice: 1000,
    hoursByYear: {},
    engineeringHours: 0,
    shopHours: 0,
    etcEngHours: 0,
    etcShopHours: 0,
    etcPartsCost: 0,
    partCost: 200,
    partInvoiced: 200, // fully GL-posted, nothing open — so y is simply 200
    completeDate: null,
  });
  const c = computeJobCost(row, DEFAULT_RATES, {}, undefined);
  // x = laborCost (0 + PM/Mfg on 1000 at defaults 10%/10% = 200) = 200; y = 200
  assert.equal(c.profit, 1000 - 200 - 200);
  assert.equal(c.margin, ((1000 - 200 - 200) / 1000) * 100);
});

test("isUtilityJob matches the known clearing/placeholder IDs and blank IDs, not real jobs", () => {
  assert.equal(isUtilityJob("4000"), true);
  assert.equal(isUtilityJob("1083"), true);
  assert.equal(isUtilityJob(""), true);
  assert.equal(isUtilityJob("   "), true);
  assert.equal(isUtilityJob("1200"), false);
});

// ── Parts in the profit line: no double-count of the open PO balance (2026-09-14) ──
//
// `partCost` (Parts Purchased) = GL-posted actual + every open PO's uninvoiced
// balance. `etcPartsCost` (Parts New ETC) = leftToInvoice + leftToPurchase since
// 2026-08 — and leftToInvoice IS that open balance. `partCost + etcPartsCost`
// therefore subtracted the open balance twice on every non-Complete job. Profit
// now subtracts the Parts Cost card's projection: actual + max(open, New ETC).

test("partsCostForProfit: actual 100k, open PO 50k, New ETC 70k (50k LTI + 20k LTP) -> 170k, not 220k", () => {
  const r = partsCostForProfit({ partCost: 150_000, partInvoiced: 100_000, status: "Active" }, 70_000);
  assert.equal(r.actual, 100_000);
  assert.equal(r.committedNotPosted, 50_000);
  assert.equal(r.projected, 170_000);
});

test("partsCostForProfit: a stale New ETC below the open balance cannot drag the figure under what is committed", () => {
  // ETC 30k says "30k left", but 50k is already on order: the floor holds at
  // actual + open = 150k (parts-cost-financials-shared.ts's projectionResidual).
  assert.equal(partsCostForProfit({ partCost: 150_000, partInvoiced: 100_000, status: "Active" }, 30_000).projected, 150_000);
  // No ETC month at all: still actual + open, never actual alone.
  assert.equal(partsCostForProfit({ partCost: 150_000, partInvoiced: 100_000, status: "Active" }, null).projected, 150_000);
});

test("partsCostForProfit: a Complete job subtracts GL-posted actual only", () => {
  assert.equal(partsCostForProfit({ partCost: 150_000, partInvoiced: 100_000, status: "Complete" }, 70_000).projected, 100_000);
});

test("partsCostForProfit: with no GL-posted figure at all the commitment stands in, never a silent zero", () => {
  const r = partsCostForProfit({ partCost: 150_000, partInvoiced: null, status: "Active" }, null);
  assert.equal(r.actual, 150_000);
  assert.equal(r.projected, 150_000);
  assert.equal(partsCostForProfit({ partCost: null, partInvoiced: null, status: "Active" }, 5_000).projected, 5_000);
});

test("computeJobCost: profit subtracts the projected parts figure and exposes it as partsProjected", () => {
  const row = baseRow({
    salesPrice: 1_000_000,
    hoursByYear: {},
    engineeringHours: 0,
    shopHours: 0,
    etcEngHours: 0,
    etcShopHours: 0,
    partCost: 150_000,
    partInvoiced: 100_000,
    etcPartsCost: 70_000,
    completeDate: null,
  });
  const c = computeJobCost(row, DEFAULT_RATES, {}, undefined);
  assert.equal(c.partsProjected, 170_000);
  // x = PM 10% + Mfg 10% of sales = 200k; y = 170k
  assert.equal(c.profit, 1_000_000 - 200_000 - 170_000);
  // The columns keep their honest meanings: Purchased is still commitment.
  assert.equal(c.partCost, 150_000);
  assert.equal(c.partInvoiced, 100_000);
  assert.equal(c.etcPartsCost, 70_000);
});

// ── The export's totals row never sums a percentage ─────────────────────────

function computed(o: Partial<JobCostComputed>): JobCostComputed {
  return { ...baseRow(), pmCost: 0, mfgCost: 0, laborCost: 0, partsProjected: 0, profit: null, margin: null, ...o };
}

test("jobCostTotals: margin is Σprofit ÷ Σsales, not Σ of the row margins", () => {
  const rows = [
    computed({ salesPrice: 100, profit: 50, margin: 50 }),
    computed({ salesPrice: 900, profit: 90, margin: 10 }),
  ];
  const t = jobCostTotals(rows, ["salesPrice", "profit", "margin"]);
  assert.equal(t.salesPrice, 1000);
  assert.equal(t.profit, 140);
  assert.ok(Math.abs((t.margin ?? NaN) - 14) < 1e-9, `140 / 1000 = 14 — the old code printed 60; got ${t.margin}`);
});

test("jobCostTotals: percentComplete is sales-weighted, and blank when nothing can weight it", () => {
  const rows = [
    computed({ salesPrice: 100, percentComplete: 100 }),
    computed({ salesPrice: 900, percentComplete: 0 }),
    computed({ salesPrice: null, percentComplete: 100 }), // no weight — ignored
  ];
  assert.equal(jobCostTotals(rows, ["percentComplete"]).percentComplete, 10);
  assert.equal(jobCostTotals([computed({ salesPrice: null, percentComplete: 50 })], ["percentComplete"]).percentComplete, null);
  assert.equal(jobCostTotals([], ["margin", "percentComplete"]).margin, null);
});

test("jobCostTotals: additive columns sum (null as 0); text, dates and unknown keys are blank", () => {
  const rows = [computed({ actualHours: 10, partCost: 5, profit: 1 }), computed({ actualHours: null, partCost: 7, profit: -3 })];
  const t = jobCostTotals(rows, ["actualHours", "partCost", "profit", "customerName", "startDate", "status", "somethingNew"]);
  assert.equal(t.actualHours, 10);
  assert.equal(t.partCost, 12);
  assert.equal(t.profit, -2);
  assert.equal(t.customerName, null);
  assert.equal(t.startDate, null);
  assert.equal(t.status, null);
  assert.equal(t.somethingNew, null, "a key this function does not know is not assumed additive");
});

test("the export action checks the page's own permission and totals through jobCostTotals", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "lib", "export", "job-cost-export.ts"), "utf8");
  assert.match(src, /await assertActionPermission\("profitability:view"\);/, "the same permission /job-cost-explorer is gated on");
  assert.match(src, /rows = validRows\(rows\);/, "the audit row's count is the count of VALIDATED rows");
  assert.match(src, /jobCostTotals\(rows, cols\)/);
  assert.doesNotMatch(src, /const sum = \(k: string\) => rows\.reduce/, "the sum-everything-numeric totals row is gone");
});
