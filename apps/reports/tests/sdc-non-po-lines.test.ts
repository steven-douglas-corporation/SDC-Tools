import { test } from "node:test";
import assert from "node:assert/strict";
import { groupLinesByPo, isNonPoLine } from "../src/lib/po-detail";
import type { PartsCostLine } from "../src/lib/sync-totaleto";

// "SDC never invoices itself" applies to SDC-made parts on an internal PO. A non-PO AP
// invoice from SDC — job 1106's $209,625 "Adjustment to match Sage" — is real money the
// job totals already count, and the Parts List must too.

function line(p: Partial<PartsCostLine>): PartsCostLine {
  return {
    lineId: "pod:1", itemId: null, purchaseDate: null, invoicedDate: null, supplier: "Steven Douglas Corp.", manufacturer: null,
    category: null, poNumber: null, partNumber: null, description: null, quantity: 1, unitPrice: 0,
    totalPrice: 0, invoicedAmount: 0, actualAmount: 0, ...p,
  };
}

test("isNonPoLine: extra-cost and PO-less AP lines are non-PO; PO lines are not", () => {
  assert.equal(isNonPoLine(line({ lineId: "ec:6652::209625" })), true);
  assert.equal(isNonPoLine(line({ lineId: "apdd:9", poNumber: null })), true);
  assert.equal(isNonPoLine(line({ lineId: "apdd:9", poNumber: "106331" })), false);
  assert.equal(isNonPoLine(line({ lineId: "pod:5", poNumber: "106331" })), false);
});

test("an SDC non-PO AP invoice keeps its invoiced amount", () => {
  const adj = line({ lineId: "ec:6652::209625", poNumber: "1106 correction", totalPrice: 209625, invoicedAmount: 209625, actualAmount: 209625 });
  const [g] = groupLinesByPo([adj], [], 1, new Map());
  assert.equal(g.invoicedAmount, 209625);
});

test("an SDC-made part on a PO still counts as $0 invoiced", () => {
  const made = line({ lineId: "pod:77", poNumber: "106331", totalPrice: 500, invoicedAmount: 500, actualAmount: 500 });
  const [g] = groupLinesByPo([made], [], 1, new Map());
  assert.equal(g.invoicedAmount, 0);
});
