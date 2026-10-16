import { test } from "node:test";
import assert from "node:assert/strict";
import { cardLines, cardTotal, type TmPartsSource } from "../src/lib/tm-parts-source";

// "SDC Credit Card - Travel" is employee travel put on the card — the same kind of
// spend the Expense Reports card carries. It was landing in Part Invoiced Amount.

const FILTERS = { startDate: "2026-09-01", endDate: "2026-09-30" };

type Line = TmPartsSource["lines"][number];
const line = (supplier: string | null, n: number): Line =>
  ({
    lineId: `ec:${supplier}:${n}`,
    jobId: "1101",
    jobName: "Test",
    supplier,
    purchaseDate: "2026-09-10",
    invoicedDate: "2026-09-10",
    totalPrice: n,
    invoicedAmount: n,
    actualAmount: n,
  }) as unknown as Line;

const keys = (lines: Line[], key: Parameters<typeof cardLines>[1]) => cardLines(lines, key, FILTERS).map((l) => l.supplier);

test("SDC Credit Card - Travel falls into Expense Reports with the expense-report vendors", () => {
  const lines = [
    line("SDC Credit Card - Travel", 100),
    line("Steven Douglas Corp. Expense Reports [Concord] (Unapproved)", 10),
    line("Amazon", 1),
  ];
  assert.deepEqual(keys(lines, "expenseReports"), ["SDC Credit Card - Travel", "Steven Douglas Corp. Expense Reports [Concord] (Unapproved)"]);
  assert.equal(cardTotal(lines, "expenseReports", FILTERS), 110);
});

test("and it leaves Part Invoiced Amount, so it is counted once", () => {
  const lines = [line("SDC Credit Card - Travel", 100), line("Amazon", 1)];
  assert.deepEqual(keys(lines, "partInvoicedAmount"), ["Amazon"]);
});

test("spacing, case and an AP approval suffix still match", () => {
  for (const s of ["sdc credit card-travel", "SDC  CREDIT CARD  -  TRAVEL", "SDC Credit Card - Travel (Approved)"]) {
    assert.deepEqual(keys([line(s, 5)], "expenseReports"), [s]);
  }
});

test("plain SDC Credit Card is real outside spend and stays in Part Invoiced Amount", () => {
  const lines = [line("SDC Credit Card", 50), line("SDC Credit Card (Approved)", 20)];
  assert.deepEqual(keys(lines, "expenseReports"), []);
  assert.deepEqual(keys(lines, "partInvoicedAmount"), ["SDC Credit Card", "SDC Credit Card (Approved)"]);
});
