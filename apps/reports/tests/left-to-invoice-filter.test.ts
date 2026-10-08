import test from "node:test";
import assert from "node:assert/strict";
import { hasInvoiceBalance, partHasInvoiceBalance } from "../src/lib/left-to-invoice";

// The Parts List's "Left to invoice" filter. Reported 2026-10-05: turning it on made
// the list look blank — parent rows were hidden, and rows whose own Left to Invoice
// cell was positive but which had no PO breakdown were dropped outright. Since
// 2026-10-08 it keeps anything that is not $0.00, over-invoiced (negative) included.

const g = (leftToInvoice: number) => ({ leftToInvoice });

test("hasInvoiceBalance: positive and negative count, zero and sub-cent residue do not", () => {
  assert.equal(hasInvoiceBalance(1250), true);
  assert.equal(hasInvoiceBalance(-0.01), true);
  assert.equal(hasInvoiceBalance(0), false);
  assert.equal(hasInvoiceBalance(0.004), false);
  assert.equal(hasInvoiceBalance(-0.004), false);
});

test("a part with an open PO has a balance, even when the blended total is not positive", () => {
  // An over-invoiced PO (-50) cancels the open one (+30) in leftToSpend.
  assert.equal(partHasInvoiceBalance({ poBreakdown: [g(-50), g(30)], leftToSpend: -20 }), true);
});

test("an over-invoiced part (negative PO) is kept", () => {
  assert.equal(partHasInvoiceBalance({ poBreakdown: [g(0), g(-5)], leftToSpend: -5 }), true);
});

test("a part whose POs are all exactly settled has no balance", () => {
  assert.equal(partHasInvoiceBalance({ poBreakdown: [g(0), g(0)], leftToSpend: 0 }), false);
});

test("a part with no POs but a non-zero own Left to Invoice has a balance (positive or negative)", () => {
  assert.equal(partHasInvoiceBalance({ poBreakdown: [], leftToSpend: 1250 }), true);
  assert.equal(partHasInvoiceBalance({ poBreakdown: [], leftToSpend: -75 }), true);
});

test("a part with no POs and nothing owed, or an unresolved (null) figure, has no balance", () => {
  assert.equal(partHasInvoiceBalance({ poBreakdown: [], leftToSpend: 0 }), false);
  assert.equal(partHasInvoiceBalance({ poBreakdown: [], leftToSpend: null }), false);
});

test("a part WITH POs is judged on them, not on its own figure", () => {
  assert.equal(partHasInvoiceBalance({ poBreakdown: [g(0)], leftToSpend: 999 }), false);
});
