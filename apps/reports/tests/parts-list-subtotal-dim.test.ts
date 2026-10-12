import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { moneyIsSubtotal } from "../src/lib/po-detail";

// An open part's money is drawn twice (the row, then its POs) and the footer counts only
// the row. The row's money is dimmed while open so the screen stops reading as
// double-counted — except under the "Left to invoice" filter, where the POs shown are
// only some of the part's, so they do not sum to the row.

const po = (n: number) => ({ poBreakdown: Array.from({ length: n }, () => ({}) as never) });

test("an open part with several POs shows its money as a subtotal", () => {
  assert.equal(moneyIsSubtotal(po(2), true, false), true);
});

test("a folded part is a normal row", () => {
  assert.equal(moneyIsSubtotal(po(3), false, false), false);
});

test("a part on one PO has no sub-rows, so nothing to subtotal", () => {
  assert.equal(moneyIsSubtotal(po(1), true, false), false);
  assert.equal(moneyIsSubtotal(po(0), true, false), false);
});

test("under the Left to invoice filter the sub-rows are narrowed, so the row is not a subtotal", () => {
  assert.equal(moneyIsSubtotal(po(3), true, true), false);
});

test("the Parts List wires it to the row, and the footer still sums the rows themselves", () => {
  const src = join(import.meta.dirname, "..", "src", "components");
  const job = readFileSync(join(src, "JobProcurement.tsx"), "utf8");
  assert.match(job, /subtotal=\{moneyIsSubtotal\(p, expanded\.has\(p\.id\), onlyLeftToInvoice\)\}/);
  const panel = readFileSync(join(src, "procurement", "PoDetailPanel.tsx"), "utf8");
  for (const col of ["total", "invoiced", "pctinv", "leftspend"]) {
    const label = `case "${col}":`;
    // PartRowCells is the first switch in the file; its case ends where the next one starts.
    const from = panel.indexOf(label) + label.length;
    const body = panel.slice(from).split('case "')[0];
    assert.match(body, /moneyTone\(/, `${col} must dim while the row is a subtotal`);
  }
});
