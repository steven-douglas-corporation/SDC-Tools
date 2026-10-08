import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenBomParts } from "../src/lib/po-detail";
import { attributeInvoicedWindow, collectBomItemIds, collectBomPartNumbers, lineLeftoverKey } from "../src/lib/parts-cost-window-attribution";
import type { BomNode, BomPart, JobBom } from "../src/lib/job-bom";
import type { PartsCostLine } from "../src/lib/sync-totaleto";

// ── Purchase lines join a BOM row on Total ETO's item id, not on text (2026-10-08) ──
//
// A BOM row's `id` is the item id (ChildID); a purchase line now carries the same key
// (`itemId`, POD.ItemID). The part number each side PRINTS is a different field — the
// BOM shows ItemCompanyID, the line shows the supplier's own spelling — so text can
// name the wrong item or none. These pin the rules that follow:
//
//   * a line with an item id belongs to that item's row and to no other
//   * two rows that print the same part number but are different items do not split
//     each other's money
//   * a line with NO item id (Extra Costs, non-PO AP) still falls back to text
//   * the table still adds up: every line lands on exactly one row

let seq = 0;
const line = (o: Partial<PartsCostLine>): PartsCostLine => ({
  lineId: `pod:${++seq}`,
  itemId: null,
  purchaseDate: null,
  invoicedDate: null,
  supplier: "ACME",
  manufacturer: null,
  category: null,
  poNumber: "100",
  partNumber: null,
  description: null,
  quantity: 1,
  unitPrice: 0,
  totalPrice: 0,
  invoicedAmount: 0,
  actualAmount: 0,
  ...o,
});

const part = (o: Partial<BomPart> & { id: number; pn: string }): BomPart => ({
  desc: "",
  manufacturer: "",
  qty: 1,
  poQty: 1,
  receivedQty: 0,
  unitPrice: 0,
  costBasis: "none",
  source: "po",
  release: "contentsOnly",
  isAssembly: false,
  pullQty: 0,
  requiredDate: null,
  expectedDate: null,
  originalDate: null,
  revisedDate: null,
  poDate: null,
  receivedDate: null,
  status: "ordered",
  hold: false,
  supplier: null,
  poId: null,
  packetId: null,
  packetLabel: null,
  ...o,
});

const STATS = { total: 0, received: 0, noPO: 0, ordered: 0, stock: 0, pct: 0 };
const bomOf = (parts: BomPart[]): JobBom => {
  const root: BomNode = {
    key: "s1",
    id: 1,
    depth: 0,
    label: "Section 1",
    pn: "",
    desc: "Test",
    isAssembly: false,
    release: "contentsOnly",
    self: null,
    packetId: null,
    packetLabel: null,
    children: [],
    parts,
    stats: STATS,
    totalCost: 0,
    totalPartQty: 0,
    nestedAssemblies: 0,
  };
  return { jobId: "1101", roots: [root], grandTotalCost: 0, grandTotalPartQty: 0, rowCount: parts.length, vendors: [] };
};

const total = (rows: { totalPrice: number }[]) => rows.reduce((s, r) => s + r.totalPrice, 0);

test("a line joins its BOM row by item id even when the supplier's spelling shares nothing with the BOM's", () => {
  // No punctuation / suffix / leading-zero relation, so the old alternate-spelling
  // recovery could never have found it either.
  const bom = bomOf([part({ id: 7, pn: "SENSOR-24V" })]);
  const l = line({ itemId: 7, partNumber: "PROX/INDUCTIVE M12 (SUPPLIER CODE 88213)", totalPrice: 120 });
  const rows = flattenBomParts(bom, [l]);
  assert.equal(rows.length, 1, "no separate Not-on-the-BOM row");
  assert.equal(rows[0].nonBom, false);
  assert.equal(rows[0].totalPrice, 120);
  assert.equal(rows[0].matchReason, "matched");
});

test("a line with an item id is never claimed by a BOM row that only shares its TEXT", () => {
  // BOM item 1 prints "WIDGET"; the line is item 2 and the supplier happens to spell it "WIDGET".
  const bom = bomOf([part({ id: 1, pn: "WIDGET" })]);
  const l = line({ itemId: 2, partNumber: "WIDGET", totalPrice: 50 });
  const rows = flattenBomParts(bom, [l]);
  const bomRow = rows.find((r) => r.id === 1)!;
  const leftover = rows.find((r) => r.nonBom)!;
  assert.equal(bomRow.totalPrice, 0, "the BOM row of a different item takes none of it");
  assert.equal(bomRow.matchReason, "no-purchase");
  assert.equal(leftover.totalPrice, 50, "the money is still on the table, as its own row");
  assert.equal(total(rows) - bomRow.totalPrice, 50);
});

test("two BOM rows that print one part number but are different items keep their own money — no halving", () => {
  const bom = bomOf([part({ id: 1, pn: "DUP-1" }), part({ id: 2, pn: "DUP-1" })]);
  const rows = flattenBomParts(bom, [
    line({ itemId: 1, partNumber: "DUP-1", totalPrice: 100, actualAmount: 100, invoicedAmount: 100 }),
    line({ itemId: 2, partNumber: "DUP-1", totalPrice: 300, actualAmount: 0, invoicedAmount: 0 }),
  ]);
  const one = rows.find((r) => r.id === 1)!;
  const two = rows.find((r) => r.id === 2)!;
  assert.equal(one.totalPrice, 100);
  assert.equal(one.invoicedAmount, 100);
  assert.equal(two.totalPrice, 300);
  assert.equal(two.invoicedAmount, 0);
  assert.equal(total(rows), 400, "every line lands once");
});

test("a line with NO item id (extra cost, non-PO AP) still falls back to the part number text", () => {
  const bom = bomOf([part({ id: 1, pn: "FREIGHT-X" })]);
  const rows = flattenBomParts(bom, [line({ lineId: "ec:1", itemId: null, partNumber: "freight-x", totalPrice: 40 })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalPrice, 40);
});

test("text-only lines still share between rows that print the same number; item lines on the same rows do not", () => {
  const bom = bomOf([part({ id: 1, pn: "DUP-2" }), part({ id: 2, pn: "DUP-2" })]);
  const rows = flattenBomParts(bom, [
    line({ lineId: "ec:9", itemId: null, partNumber: "DUP-2", totalPrice: 100 }),
    line({ itemId: 1, partNumber: "DUP-2", totalPrice: 10 }),
  ]);
  const one = rows.find((r) => r.id === 1)!;
  const two = rows.find((r) => r.id === 2)!;
  assert.equal(one.totalPrice, 50 + 10);
  assert.equal(two.totalPrice, 50);
  assert.equal(total(rows), 110);
});

test("one item bought under two spellings, not on the BOM, is ONE row — not one per spelling", () => {
  const rows = flattenBomParts(bomOf([]), [
    line({ itemId: 9, partNumber: "GASKET-A", description: "Gasket", totalPrice: 10 }),
    line({ itemId: 9, partNumber: "GASKET A", description: null, totalPrice: 15 }),
    line({ itemId: 10, partNumber: "GASKET-A", description: "Gasket", totalPrice: 5 }),
  ]);
  assert.equal(rows.length, 2, "item 9 once, item 10 once");
  assert.equal(rows.find((r) => r.nonBom && r.totalPrice === 25)?.lineCount, 2);
  assert.equal(total(rows), 30);
});

test("lineLeftoverKey: item id first, then the text key", () => {
  assert.equal(lineLeftoverKey({ itemId: 5, partNumber: "X", description: "y" }), "item:5");
  assert.equal(lineLeftoverKey({ itemId: null, partNumber: " x ", description: "y" }), "X");
  assert.equal(lineLeftoverKey({ itemId: null, partNumber: null, description: "y" }), "\u0000blank:Y");
});

// ── Invoiced + date range ────────────────────────────────────────────────────

test("attributeInvoicedWindow buckets an item-id line by item, and sends an unknown item's line to Not-on-the-BOM", () => {
  const bom = bomOf([part({ id: 7, pn: "SENSOR-24V" })]);
  const inBom = line({ itemId: 7, partNumber: "SUPPLIER SPELLING", invoicedAmount: 80 });
  const lookalike = line({ itemId: 99, partNumber: "SENSOR-24V", invoicedAmount: 20 });
  const r = attributeInvoicedWindow([inBom, lookalike], collectBomPartNumbers(bom.roots), collectBomItemIds(bom.roots));
  assert.equal(r.byItemId.get(7), 80);
  assert.equal(r.linesByItemId.get(7)?.length, 1);
  assert.equal(r.byPartNumber.has("SENSOR-24V"), false, "a line with an item id never lands in the text map");
  assert.equal(r.unattachedAmount, 20, "the lookalike is unattached, not silently added to item 7");
  assert.equal(r.nonBomByKey.get("item:99")?.amount, 20);
});

test("attributeInvoicedWindow: an item-id line with no BOM set passed is unattached rather than text-matched", () => {
  const r = attributeInvoicedWindow([line({ itemId: 7, partNumber: "A", invoicedAmount: 5 })], new Set(["A"]));
  assert.equal(r.byPartNumber.size, 0);
  assert.equal(r.unattachedAmount, 5);
});

test("an item whose window events net to zero is absent from byItemId", () => {
  const r = attributeInvoicedWindow(
    [line({ itemId: 7, invoicedAmount: 10 }), line({ itemId: 7, invoicedAmount: -10 })],
    new Set(),
    new Set([7]),
  );
  assert.equal(r.byItemId.has(7), false);
  assert.equal(r.linesByItemId.has(7), false);
});

test("a windowed Parts List row takes the window's item-id money whole, and its PO lines list those invoices", () => {
  const bom = bomOf([part({ id: 7, pn: "SENSOR-24V" }), part({ id: 8, pn: "SENSOR-24V" })]);
  const windowLines = [
    line({ lineId: "apdd:1", itemId: 7, partNumber: "SUPPLIER SPELLING", poNumber: "P7", invoicedAmount: 80, actualAmount: 80, totalPrice: 80 }),
    line({ lineId: "apdd:2", itemId: 8, partNumber: "SENSOR-24V", poNumber: "P8", invoicedAmount: 30, actualAmount: 30, totalPrice: 30 }),
  ];
  const attribution = attributeInvoicedWindow(windowLines, collectBomPartNumbers(bom.roots), collectBomItemIds(bom.roots));
  const lifetime = [
    line({ lineId: "pod:1", itemId: 7, poNumber: "P7", totalPrice: 500 }),
    line({ lineId: "pod:2", itemId: 8, poNumber: "P8", totalPrice: 900 }),
  ];
  const rows = flattenBomParts(bom, lifetime, attribution);
  const seven = rows.find((r) => r.id === 7)!;
  const eight = rows.find((r) => r.id === 8)!;
  assert.equal(seven.invoicedAmount, 80, "not halved by the shared printed part number");
  assert.equal(eight.invoicedAmount, 30);
  assert.deepEqual(seven.windowPoBreakdown?.map((g) => g.poNumber), ["P7"]);
  assert.deepEqual(eight.windowPoBreakdown?.map((g) => g.poNumber), ["P8"]);
});
