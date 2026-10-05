import test from "node:test";
import assert from "node:assert/strict";
import { partOwesInvoice } from "../src/lib/left-to-invoice";

// The Parts List's "Left to invoice" filter. Reported 2026-10-05: turning it on made
// the list look blank — parent rows were hidden, and rows whose own Left to Invoice
// cell was positive but which had no PO breakdown were dropped outright.

const g = (leftToInvoice: number) => ({ leftToInvoice });

test("a part with an open PO owes, even when the blended total is not positive", () => {
  // An over-invoiced PO (-50) cancels the open one (+30) in leftToSpend.
  assert.equal(partOwesInvoice({ poBreakdown: [g(-50), g(30)], leftToSpend: -20 }), true);
});

test("a part whose POs are all settled or over-invoiced does not owe", () => {
  assert.equal(partOwesInvoice({ poBreakdown: [g(0), g(-5)], leftToSpend: -5 }), false);
});

test("a part with no POs but a positive own Left to Invoice still owes (the row was being dropped)", () => {
  assert.equal(partOwesInvoice({ poBreakdown: [], leftToSpend: 1250 }), true);
});

test("a part with no POs and nothing owed, or an unresolved (null) figure, does not owe", () => {
  assert.equal(partOwesInvoice({ poBreakdown: [], leftToSpend: 0 }), false);
  assert.equal(partOwesInvoice({ poBreakdown: [], leftToSpend: null }), false);
});

test("a part WITH POs is judged on them, not on its own figure", () => {
  assert.equal(partOwesInvoice({ poBreakdown: [g(0)], leftToSpend: 999 }), false);
});
