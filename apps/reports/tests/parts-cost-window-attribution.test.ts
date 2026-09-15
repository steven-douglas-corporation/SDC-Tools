import { test } from "node:test";
import assert from "node:assert/strict";
import { normPn, attributeInvoicedWindow, collectBomPartNumbers } from "../src/lib/parts-cost-window-attribution";
import type { PartsCostLine } from "../src/lib/sync-totaleto";
import type { BomNode } from "../src/lib/job-bom-rules";

// parts-cost-window-attribution.ts is the I/O-free half of the Parts List
// invoiced-window fix — no DB, no React, so (unlike everything else touching
// this feature) it gets real fixture-based tests rather than source-inspection
// regexes. `lines` in every test below is exactly the shape
// getJobPartsInvoicedInMonth already returns (one row per real AP invoice
// event within a window), which is what loadPartsListInvoicedInWindow hands
// to attributeInvoicedWindow unchanged.

// Unique per call, not a shared constant: lineId is a purchase line's identity,
// and anything that groups by it would silently collapse two fixtures into one.
let lineSeq = 0;
function line(partial: Partial<PartsCostLine>): PartsCostLine {
  return {
    lineId: `fixture:${++lineSeq}`,
    purchaseDate: null,
    invoicedDate: null,
    supplier: null,
    manufacturer: null,
    category: null,
    poNumber: null,
    partNumber: null,
    description: null,
    quantity: 1,
    unitPrice: 0,
    totalPrice: 0,
    invoicedAmount: 0,
    actualAmount: 0,
    ...partial,
  };
}

function bomOf(...partNumbers: string[]): Set<string> {
  return new Set(partNumbers.map(normPn));
}

// ── normPn ───────────────────────────────────────────────────────────────────

test("normPn trims, collapses whitespace, and upper-cases", () => {
  assert.equal(normPn("  abc   123 "), "ABC 123");
});

test("normPn treats null/undefined as an empty string", () => {
  assert.equal(normPn(null), "");
  assert.equal(normPn(undefined), "");
});

// ── attributeInvoicedWindow — the reorder case (the bug the fix targets) ─────

test("sums invoiced amounts for the SAME part number across DIFFERENT PO lines", () => {
  // The exact scenario a naive PurchaseDetailID-keyed fix would undercount:
  // two distinct PO lines (a reorder), both invoiced within the window.
  const lines: PartsCostLine[] = [
    line({ partNumber: "ABC-123", invoicedAmount: 100 }),
    line({ partNumber: "abc-123", invoicedAmount: 50 }), // same part, different case/PO line
  ];
  const { byPartNumber } = attributeInvoicedWindow(lines, bomOf("ABC-123"));
  assert.equal(byPartNumber.get("ABC-123"), 150);
});

test("keeps different part numbers in separate buckets", () => {
  const lines: PartsCostLine[] = [line({ partNumber: "A", invoicedAmount: 10 }), line({ partNumber: "B", invoicedAmount: 20 })];
  const { byPartNumber } = attributeInvoicedWindow(lines, bomOf("A", "B"));
  assert.equal(byPartNumber.get("A"), 10);
  assert.equal(byPartNumber.get("B"), 20);
});

// ── Non-PO / unattached lines — never silently dropped ───────────────────────

test("a line with no part number (non-PO AP line) is counted as unattached, not dropped", () => {
  const lines: PartsCostLine[] = [line({ partNumber: null, invoicedAmount: 5252.77, description: "Freight" })];
  const { byPartNumber, unattachedAmount, unattachedCount } = attributeInvoicedWindow(lines, bomOf());
  assert.equal(byPartNumber.size, 0);
  assert.equal(unattachedAmount, 5252.77);
  assert.equal(unattachedCount, 1);
});

test("unattached lines accumulate across multiple non-PO events", () => {
  const lines: PartsCostLine[] = [line({ partNumber: null, invoicedAmount: 100 }), line({ partNumber: "", invoicedAmount: 25 })];
  const { unattachedAmount, unattachedCount } = attributeInvoicedWindow(lines, bomOf());
  assert.equal(unattachedAmount, 125);
  assert.equal(unattachedCount, 2);
});

test("PO-attached and unattached lines are correctly separated in the same window", () => {
  const lines: PartsCostLine[] = [line({ partNumber: "A", invoicedAmount: 10 }), line({ partNumber: null, invoicedAmount: 5 })];
  const { byPartNumber, unattachedAmount } = attributeInvoicedWindow(lines, bomOf("A"));
  assert.equal(byPartNumber.get("A"), 10);
  assert.equal(unattachedAmount, 5);
});

// ── A resolved part number that isn't in the CURRENT BOM ─────────────────────
//
// Found live, not theorized: verifying against job 1142/July 2026 (reference
// $113,101.89 from getPartsCostBookedByJob) showed a $2,957.11 shortfall —
// nine real AP lines (several "Shipping" line items, a corrosion inhibitor,
// cable-tie mounts...) that DO resolve to a part number, just not one present
// in the job's current BOM tree. Without checking against the BOM's own part
// numbers, that money would sit in byPartNumber under a key no Parts List row
// ever looks up — missing from both a row AND the reconciliation footer,
// silently. This is the regression guard for that exact gap.

test("a line whose part number resolves but ISN'T in the current BOM is unattached, not silently dropped from byPartNumber", () => {
  const lines: PartsCostLine[] = [line({ partNumber: "Shipping", invoicedAmount: 1000, poNumber: "103046" })];
  const { byPartNumber, unattachedAmount, unattachedCount } = attributeInvoicedWindow(lines, bomOf("A", "B")); // "Shipping" is not a BOM part
  assert.equal(byPartNumber.has("SHIPPING"), false);
  assert.equal(unattachedAmount, 1000);
  assert.equal(unattachedCount, 1);
});

test("the same part number is attached when it IS a BOM part, and unattached when it ISN'T — same line, different BOM", () => {
  const lines: PartsCostLine[] = [line({ partNumber: "3843 B-M5", invoicedAmount: 198.11 })];
  const attached = attributeInvoicedWindow(lines, bomOf("3843 B-M5"));
  assert.equal(attached.byPartNumber.get("3843 B-M5"), 198.11);
  assert.equal(attached.unattachedAmount, 0);

  const notAttached = attributeInvoicedWindow(lines, bomOf("some-other-part"));
  assert.equal(notAttached.byPartNumber.has("3843 B-M5"), false);
  assert.equal(notAttached.unattachedAmount, 198.11);
});

test("reconciles to the cent: attached + unattached sums to the full reference total, regardless of BOM membership", () => {
  const lines: PartsCostLine[] = [
    line({ partNumber: "IN-BOM", invoicedAmount: 110143.78 }),
    line({ partNumber: "3843 B-M5", invoicedAmount: 198.109952 }),
    line({ partNumber: "644-TMEH-S25-X0", invoicedAmount: 274 }),
    line({ partNumber: "Shipping", invoicedAmount: 8.49 }),
    line({ partNumber: "Shipping", invoicedAmount: 10.36 }),
    line({ partNumber: "Shipping", invoicedAmount: 1000 }),
    line({ partNumber: "1015BC-14/41-0", invoicedAmount: 512.5 }),
    line({ partNumber: "Shipping", invoicedAmount: 85 }),
    line({ partNumber: "400118", invoicedAmount: 838.3 }),
    line({ partNumber: "5787T97", invoicedAmount: 30.34926 }),
  ];
  const { byPartNumber, unattachedAmount } = attributeInvoicedWindow(lines, bomOf("IN-BOM"));
  const attachedSum = [...byPartNumber.values()].reduce((s, v) => s + v, 0);
  const total = lines.reduce((s, l) => s + l.invoicedAmount, 0);
  assert.ok(Math.abs(attachedSum + unattachedAmount - total) < 1e-9);
  assert.ok(Math.abs(unattachedAmount - 2957.109212) < 1e-9);
});

// ── Zero-invoice exclusion — mirrors getJobPartsInvoicedInMonth's own rule ───

test("a part number whose events net to exactly zero in the window is absent from byPartNumber", () => {
  // An invoice and a same-amount credit memo, same part, same window.
  const lines: PartsCostLine[] = [line({ partNumber: "A", invoicedAmount: 100 }), line({ partNumber: "A", invoicedAmount: -100 })];
  const { byPartNumber } = attributeInvoicedWindow(lines, bomOf("A"));
  assert.equal(byPartNumber.has("A"), false);
});

test("a part number with no lines at all in the window is simply absent, not present at $0", () => {
  const { byPartNumber } = attributeInvoicedWindow([], bomOf("ANYTHING"));
  assert.equal(byPartNumber.has("ANYTHING"), false);
});

// ── Negative amounts (credit memos) net off rather than being dropped ────────

test("a net credit for a part number is kept as a negative value, not floored at zero", () => {
  const lines: PartsCostLine[] = [line({ partNumber: "A", invoicedAmount: 30 }), line({ partNumber: "A", invoicedAmount: -50 })];
  const { byPartNumber } = attributeInvoicedWindow(lines, bomOf("A"));
  assert.equal(byPartNumber.get("A"), -20);
});

// ── No double-counting / no dedupe applied ───────────────────────────────────
//
// getPartsCostBookedByJob's own comment states the AP-document-line grain
// needs no dedupe — two genuinely separate invoice events for the same part in
// the same window must both be summed, not collapsed into one.

test("does not dedupe repeat invoice events for the same part — both are summed", () => {
  const lines: PartsCostLine[] = [
    line({ partNumber: "A", invoicedAmount: 10, invoicedDate: "2026-07-05" }),
    line({ partNumber: "A", invoicedAmount: 10, invoicedDate: "2026-07-05" }), // a genuine second event, same day
  ];
  const { byPartNumber } = attributeInvoicedWindow(lines, bomOf("A"));
  assert.equal(byPartNumber.get("A"), 20);
});

// ── collectBomPartNumbers walks node.self as well as node.parts (2026-09-14) ──
//
// A "Both Assembly and Contents" assembly is itself a thing to buy (BomNode.self)
// and has its own Parts List row, but JobProcurement.tsx's inline set-builder read
// `node.parts` only — so in a windowed Invoiced view an invoice against that
// assembly's own number was "not in the BOM" and fell to the unattached total.

test("collectBomPartNumbers includes a node's own self-buy part number, its parts, and its children's", () => {
  const stats = { total: 0, received: 0, noPO: 0, ordered: 0, stock: 0, pct: 0 };
  const bomPart = (id: number, pn: string) => ({
    id, pn, desc: "", manufacturer: "", qty: 1, poQty: 0, receivedQty: 0, unitPrice: 0, costBasis: "none" as const, source: "po" as const,
    release: "contentsOnly" as const, isAssembly: false, pullQty: 0, requiredDate: null, expectedDate: null, originalDate: null,
    revisedDate: null, poDate: null, receivedDate: null, status: "ordered" as const, hold: false, supplier: null, poId: null, packetId: null, packetLabel: null,
  });
  const node = (key: string, self: ReturnType<typeof bomPart> | null, parts: ReturnType<typeof bomPart>[], children: BomNode[] = []): BomNode => ({
    key, id: key, depth: 1, label: key, pn: key, desc: "", isAssembly: true, release: self ? "bothAssemblyAndContents" : "contentsOnly",
    self, packetId: null, packetLabel: null, children, parts, stats, totalCost: 0, totalPartQty: 0, nestedAssemblies: 0,
  });
  const roots = [
    node("section", null, [bomPart(1, "loose-1")], [
      node("1116-DB-000", bomPart(2, "1116-DB-000"), [bomPart(3, " sub  a ")], [
        node("1116-DB-100", bomPart(4, "1116-DB-100"), []),
      ]),
    ]),
  ];
  const set = collectBomPartNumbers(roots);
  assert.deepEqual([...set].sort(), ["1116-DB-000", "1116-DB-100", "LOOSE-1", "SUB A"]);
});

test("an invoice against a self-buy assembly's own number attributes to its row rather than the unattached total", () => {
  const stats = { total: 0, received: 0, noPO: 0, ordered: 0, stock: 0, pct: 0 };
  const self = {
    id: 2, pn: "1116-DB-000", desc: "", manufacturer: "", qty: 1, poQty: 0, receivedQty: 0, unitPrice: 0, costBasis: "none" as const, source: "po" as const,
    release: "bothAssemblyAndContents" as const, isAssembly: true, pullQty: 0, requiredDate: null, expectedDate: null, originalDate: null,
    revisedDate: null, poDate: null, receivedDate: null, status: "ordered" as const, hold: false, supplier: null, poId: null, packetId: null, packetLabel: null,
  };
  const roots: BomNode[] = [{
    key: "s", id: 1, depth: 0, label: "s", pn: "", desc: "", isAssembly: false, release: "contentsOnly", self: null, packetId: null, packetLabel: null,
    children: [{ key: "a", id: "a", depth: 1, label: "a", pn: "1116-DB-000", desc: "", isAssembly: true, release: "bothAssemblyAndContents", self, packetId: null, packetLabel: null, children: [], parts: [], stats, totalCost: 0, totalPartQty: 0, nestedAssemblies: 0 }],
    parts: [], stats, totalCost: 0, totalPartQty: 0, nestedAssemblies: 1,
  }];
  const result = attributeInvoicedWindow([line({ partNumber: "1116-DB-000", invoicedAmount: 1430 })], collectBomPartNumbers(roots));
  assert.equal(result.byPartNumber.get("1116-DB-000"), 1430);
  assert.equal(result.unattachedAmount, 0);
});
