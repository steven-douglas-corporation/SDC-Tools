import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RATES,
  computeJobCost,
  isUtilityJob,
  laborForType,
  rateForYear,
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
