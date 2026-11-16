import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RATES, computeJobCost, type JobCostRow } from "../src/lib/job-cost";
import { explainJobCell, explainHours } from "../src/lib/job-cost-explain";

function row(o: Partial<JobCostRow> = {}): JobCostRow {
  return {
    jobId: "1200", jobName: "T", status: "Active", customerName: null, jobType: "Custom", machineType: null,
    actualHours: 0, engineeringHours: 0, shopHours: 0, otherHours: 0, serviceHours: null,
    partCost: 0, partInvoiced: 0, salesPrice: 100_000, startDate: null, completeDate: "2024-06-30",
    percentComplete: 50, hoursByYear: {}, etcEngHours: 0, etcShopHours: 0, etcPartsCost: 0,
    ...o,
  };
}

const RATES = { engRate: 100, shopRate: 50, pmPct: 3, mfgPct: 2 };
const OVERRIDES = { "2024": { engRate: 120, shopRate: 60, pmPct: 4, mfgPct: 5 } };

test("Eng Hrs hover lists hours per year, then the migration-snapshot remainder, then the total", () => {
  const r = row({ engineeringHours: 100, hoursByYear: { "2025": { eng: 30, shop: 0 }, "2024": { eng: 50, shop: 0 } } });
  const text = explainHours(r, undefined, "eng");
  assert.equal(
    text,
    ["Eng Hrs by year", "2024: 50.0 hrs", "2025: 30.0 hrs", "No year (migration snapshot, through 2025-01-31): 20.0 hrs", "Total: 100.0 hrs"].join("\n"),
  );
});

test("Shop Hrs hover is separate from Eng and skips years with no shop hours", () => {
  const r = row({ shopHours: 40, hoursByYear: { "2024": { eng: 99, shop: 40 }, "2025": { eng: 5, shop: 0 } } });
  assert.equal(explainHours(r, undefined, "shop"), ["Shop Hrs by year", "2024: 40.0 hrs", "Total: 40.0 hrs"].join("\n"));
});

test("a manual allocation replaces the automatic split in the hover", () => {
  const r = row({ engineeringHours: 100, hoursByYear: { "2025": { eng: 100, shop: 0 } } });
  const text = explainHours(r, { eng: [{ year: "2023", hours: 60 }, { year: "2024", hours: 40 }], shop: [] }, "eng");
  assert.match(text, /manual allocation/);
  assert.match(text, /2023: 60\.0 hrs\n2024: 40\.0 hrs\nTotal: 100\.0 hrs/);
});

test("PM $ hover shows Sales × % with the Rate Matrix year it came from, and matches the grid value", () => {
  const c = computeJobCost(row(), RATES, OVERRIDES, undefined);
  const text = explainJobCell("pmCost", c, RATES, OVERRIDES, undefined)!;
  assert.match(text, /2024 Rate Matrix row/);
  assert.match(text, /\$100,000\.00 × 4% = \$4,000\.00/);
  assert.equal(c.pmCost, 4000);
  const mfg = explainJobCell("mfgCost", c, RATES, OVERRIDES, undefined)!;
  assert.match(mfg, /\$100,000\.00 × 5% = \$5,000\.00/);
});

test("PM % hover names the default when there is no Complete Date or the year is after the matrix", () => {
  const none = computeJobCost(row({ completeDate: null }), RATES, OVERRIDES, undefined);
  assert.match(explainJobCell("pmCost", none, RATES, OVERRIDES, undefined)!, /default rate \(job has no Complete Date\)/);
  const late = computeJobCost(row({ completeDate: "2027-01-01" }), RATES, OVERRIDES, undefined);
  assert.match(explainJobCell("pmCost", late, RATES, OVERRIDES, undefined)!, /default rate \(2027 is after/);
});

test("Total Cost, Profit and Margin hovers add up to the grid's own numbers", () => {
  const r = row({
    engineeringHours: 100, shopHours: 40,
    hoursByYear: { "2024": { eng: 100, shop: 40 } },
    etcEngHours: 10, etcShopHours: 20, etcPartsCost: 5000, partCost: 8000, partInvoiced: 6000,
  });
  const c = computeJobCost(r, RATES, OVERRIDES, undefined);
  // labor = 100×120 + 40×60 + 10×100 + 20×50 = 16,400; PM 4,000; Mfg 5,000;
  // parts = 6,000 + max(open 2,000, ETC 5,000) = 11,000
  assert.equal(c.laborCost, 16_400);
  assert.equal(c.totalCost, 16_400 + 4_000 + 5_000 + 11_000);
  const total = explainJobCell("totalCost", c, RATES, OVERRIDES, undefined)!;
  assert.match(total, /\$16,400\.00 \+ \$4,000\.00 \+ \$5,000\.00 \+ \$11,000\.00 = \$36,400\.00/);
  const profit = explainJobCell("profit", c, RATES, OVERRIDES, undefined)!;
  assert.match(profit, /\$100,000\.00 − \$36,400\.00 = \$63,600\.00/);
  const margin = explainJobCell("margin", c, RATES, OVERRIDES, undefined)!;
  assert.match(margin, /\$63,600\.00 ÷ \$100,000\.00 × 100 = 63\.60%/);
});

test("Profit and Margin hovers say why they are blank when there is no Sales Price", () => {
  const c = computeJobCost(row({ salesPrice: null }), DEFAULT_RATES, {}, undefined);
  assert.match(explainJobCell("profit", c, DEFAULT_RATES, {}, undefined)!, /no Sales Price/);
  assert.match(explainJobCell("margin", c, DEFAULT_RATES, {}, undefined)!, /no Sales Price/);
});

test("columns without a per-job hover return undefined", () => {
  const c = computeJobCost(row(), DEFAULT_RATES, {}, undefined);
  assert.equal(explainJobCell("salesPrice", c, DEFAULT_RATES, {}, undefined), undefined);
});
