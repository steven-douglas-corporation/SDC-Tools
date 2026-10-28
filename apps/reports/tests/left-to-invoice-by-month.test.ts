import test from "node:test";
import assert from "node:assert/strict";
import type { PartsCostLine } from "../src/lib/sync-totaleto";
import { leftToInvoiceForLines } from "../src/lib/left-to-invoice";
import { addBuckets, bucketOf, describeBuckets, emptyBuckets, leftToInvoiceByMonth, monthName, sortedMonths } from "../src/lib/left-to-invoice-by-month";

// Left to Invoice split by the PO line's required date. The one property that matters: the
// split is the headline, never a second number.

const TODAY = "2026-10-28";

let n = 0;
const line = (o: Partial<PartsCostLine> & { total: number; posted?: number }): PartsCostLine => ({
  lineId: `pod:${++n}`,
  itemId: null,
  purchaseDate: "2026-06-01",
  invoicedDate: null,
  requiredDate: null,
  supplier: null,
  manufacturer: null,
  category: null,
  poNumber: null,
  partNumber: null,
  description: null,
  quantity: 1,
  unitPrice: o.total,
  totalPrice: o.total,
  invoicedAmount: o.posted ?? 0,
  actualAmount: o.posted ?? 0,
  ...o,
});

const sum = (b: ReturnType<typeof leftToInvoiceByMonth>) =>
  b.overdue + b.noDate + b.floorAdjustment + Object.values(b.months).reduce((a, v) => a + v, 0);

test("bucketOf: past → overdue, today and later → its month, none → no-date", () => {
  assert.equal(bucketOf(line({ total: 1, requiredDate: "2026-10-27" }), TODAY), "overdue");
  assert.equal(bucketOf(line({ total: 1, requiredDate: "2026-10-28" }), TODAY), "2026-10");
  assert.equal(bucketOf(line({ total: 1, requiredDate: "2026-12-05" }), TODAY), "2026-12");
  assert.equal(bucketOf(line({ total: 1, requiredDate: null }), TODAY), "no-date");
  assert.equal(bucketOf(line({ total: 1 }), TODAY), "no-date");
  // an ISO timestamp is read by its day, like every other date in this money path
  assert.equal(bucketOf(line({ total: 1, requiredDate: "2026-11-02T00:00:00.000Z" }), TODAY), "2026-11");
});

test("the buckets add back to the headline, to the cent", () => {
  const lines = [
    line({ total: 1000, posted: 400, requiredDate: "2026-05-10" }), // 600 overdue
    line({ total: 250.55, requiredDate: "2026-10-30" }), // 250.55 this month
    line({ total: 99.45, requiredDate: "2026-11-15" }),
    line({ total: 300, requiredDate: "2026-11-20" }), // Nov = 399.45
    line({ total: 75, lineId: "ec:1:x:75" }), // Extra Cost, no date
  ];
  const b = leftToInvoiceByMonth(lines, {}, TODAY);
  assert.equal(b.overdue, 600);
  assert.equal(b.months["2026-10"], 250.55);
  assert.ok(Math.abs(b.months["2026-11"] - 399.45) < 1e-9);
  assert.equal(b.noDate, 75);
  assert.equal(b.floorAdjustment, 0);
  assert.ok(Math.abs(b.total - leftToInvoiceForLines(lines, {})) < 1e-9);
  assert.ok(Math.abs(sum(b) - b.total) < 1e-9);
});

test("an over-posted job: the floor adjustment makes the split equal the floored headline", () => {
  const lines = [
    line({ total: 100, requiredDate: "2026-12-01" }),
    line({ total: 50, posted: 400, requiredDate: "2026-04-01" }), // credit of -350, overdue
  ];
  const b = leftToInvoiceByMonth(lines, {}, TODAY);
  assert.equal(b.overdue, -350);
  assert.equal(b.months["2026-12"], 100);
  assert.equal(b.total, 0); // raw -250 floored
  assert.equal(b.floorAdjustment, 250);
  assert.equal(sum(b), 0);
});

test("the same cutoff the headline uses: lines purchased after asOf are left out, posting is as-of", () => {
  const scope = { asOf: "2026-09-30", asOfPosting: true };
  const lines = [
    line({ total: 500, purchaseDate: "2026-10-05", requiredDate: "2026-11-01" }), // bought after the cutoff
    line({
      total: 1000,
      posted: 1000,
      invoicedDate: "2026-10-07",
      postings: [{ day: "2026-10-07", amount: 1000 }], // billed after the cutoff → still owed at 09/30
      requiredDate: "2026-07-01",
    }),
  ];
  const b = leftToInvoiceByMonth(lines, scope, TODAY);
  assert.equal(b.overdue, 1000);
  assert.deepEqual(b.months, {});
  assert.equal(b.total, leftToInvoiceForLines(lines, scope));
});

test("a fully invoiced line adds nothing to any bucket", () => {
  const b = leftToInvoiceByMonth([line({ total: 80, posted: 80, requiredDate: "2026-11-01" })], {}, TODAY);
  assert.deepEqual(b.months, {});
  assert.equal(b.total, 0);
});

test("addBuckets sums jobs, and sortedMonths orders them", () => {
  const a = leftToInvoiceByMonth([line({ total: 10, requiredDate: "2026-12-01" }), line({ total: 5, requiredDate: "2026-04-01" })], {}, TODAY);
  const b = leftToInvoiceByMonth([line({ total: 7, requiredDate: "2026-11-09" }), line({ total: 3, requiredDate: "2026-12-09" })], {}, TODAY);
  const t = addBuckets(addBuckets(emptyBuckets(), a), b);
  assert.equal(t.overdue, 5);
  assert.equal(t.total, 25);
  assert.deepEqual(sortedMonths(t), [
    { month: "2026-11", amount: 7 },
    { month: "2026-12", amount: 13 },
  ]);
});

test("monthName", () => {
  assert.equal(monthName("2026-11"), "Nov 2026");
  assert.equal(monthName("nonsense"), "nonsense");
});

test("describeBuckets: one readable line, empty buckets left out", () => {
  const b = leftToInvoiceByMonth(
    [line({ total: 1200, requiredDate: "2026-03-01" }), line({ total: 300, requiredDate: "2026-11-09" }), line({ total: 40 })],
    {},
    TODAY,
  );
  assert.equal(describeBuckets(b, (n) => "$" + n), "Overdue $1200 · Nov 2026 $300 · No date $40");
  assert.equal(describeBuckets(emptyBuckets(), (n) => "$" + n), "");
});

import { buildOverview, bucketSum } from "../src/lib/left-to-invoice-by-month";

test("buildOverview: rows sum to their own total, the Total row sums the rows, months are unioned and sorted", () => {
  const a = leftToInvoiceByMonth([line({ total: 100, requiredDate: "2026-03-01" }), line({ total: 50, requiredDate: "2026-12-01" })], {}, TODAY);
  const b = leftToInvoiceByMonth([line({ total: 400, requiredDate: "2026-11-01" }), line({ total: 25 })], {}, TODAY);
  const empty = leftToInvoiceByMonth([], {}, TODAY);
  const o = buildOverview([
    { jobId: "1001", jobName: "A", buckets: a },
    { jobId: "1002", jobName: "B", buckets: b },
    { jobId: "1003", jobName: "Nothing", buckets: empty },
  ]);
  assert.deepEqual(o.rows.map((r) => r.jobId), ["1002", "1001"]); // largest first, empty job dropped
  assert.deepEqual(o.months, ["2026-11", "2026-12"]);
  assert.equal(bucketSum(a), 150);
  assert.equal(o.totals.overdue, 100);
  assert.equal(o.totals.months["2026-11"], 400);
  assert.equal(o.totals.noDate, 25);
  assert.equal(o.totals.sum, 575);
  assert.equal(o.totals.sum, o.rows.reduce((s, r) => s + r.sum, 0));
});
