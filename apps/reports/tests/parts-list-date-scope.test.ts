import { test } from "node:test";
import assert from "node:assert/strict";
import { groupLinesByPo, scopePartToGroups, scopePartToWindow, dayInRange, type FlatPart } from "../src/lib/po-detail";
import { attributeInvoicedWindow } from "../src/lib/parts-cost-window-attribution";
import type { PartsCostLine } from "../src/lib/sync-totaleto";

// Job 1150, Sept 2026. Three defects in one Parts List, all pinned here with fixtures:
//  1. a "to 9/30" range listed October POs under a row and added them into its columns;
//  2. SDC billing was zeroed per ROW (by the newest PO's supplier), not per invoice line:
//     1150-F-008 counted SDC's $1,500 as invoiced because the newest PO was Pemco's;
//  3. the date range kept a row whole, so Total $ / Invoiced $ / Left to Invoice carried
//     POs outside the range.

let seq = 0;
function line(p: Partial<PartsCostLine>): PartsCostLine {
  return {
    lineId: `pod:${++seq}`, itemId: null, purchaseDate: null, invoicedDate: null, supplier: "Pemco Incorporated", manufacturer: null,
    category: null, poNumber: "1", partNumber: "P-1", description: null, quantity: 1, unitPrice: 0,
    totalPrice: 0, invoicedAmount: 0, actualAmount: 0, ...p,
  };
}
const NO_DATES = new Map<string, { expectedDate: string | null; receivedDate: string | null }>();

// ── 2. SDC is judged per invoice line ───────────────────────────────────────────

test("a part bought from SDC and an outside supplier keeps the outside invoice, whichever PO is newest", () => {
  const pemco = line({ poNumber: "105775", supplier: "Pemco Incorporated", purchaseDate: "2026-08-01", totalPrice: 956, invoicedAmount: 956, actualAmount: 956 });
  const sdc = line({ poNumber: "105560", supplier: "Steven Douglas Corp.", purchaseDate: "2026-08-15", totalPrice: 1500, invoicedAmount: 1500, actualAmount: 1500 });
  const groups = groupLinesByPo([pemco, sdc], [], 1, NO_DATES);
  assert.equal(groups.reduce((s, g) => s + g.invoicedAmount, 0), 956, "only the outside invoice counts, SDC newest or not");
  assert.equal(groups.reduce((s, g) => s + g.leftToInvoice, 0), 0);
  assert.equal(groups.reduce((s, g) => s + g.totalPrice, 0), 2456, "Total $ still carries the SDC PO's value");
});

test("attributeInvoicedWindow leaves SDC billing lines out of every bucket, keeps outside ones", () => {
  const lines = [
    line({ partNumber: "1150-F-008", supplier: "Pemco Incorporated", invoicedAmount: 956, actualAmount: 956 }),
    line({ partNumber: "1150-F-008", supplier: "Steven Douglas Corp.", invoicedAmount: 1500, actualAmount: 1500 }),
    line({ partNumber: "SHIPPING", supplier: "Steven Douglas Corp.", invoicedAmount: 40, actualAmount: 40 }),
    line({ lineId: "ec:1", partNumber: null, description: "Adjustment to match Sage", supplier: "Steven Douglas Corp.", poNumber: "1106 correction", invoicedAmount: 209625, actualAmount: 209625 }),
  ];
  const r = attributeInvoicedWindow(lines, new Set(["1150-F-008"]));
  assert.equal(r.byPartNumber.get("1150-F-008"), 956);
  assert.equal(r.linesByPartNumber.get("1150-F-008")?.length, 1);
  assert.equal(r.nonBomByKey.has("SHIPPING"), false, "an SDC-billed off-BOM line is excluded");
  assert.equal(r.unattachedAmount, 209625, "a no-PO SDC invoice is a normal expense and stays");
});

// ── 1 + 3. The range scopes a row to the POs inside it ──────────────────────────

function rowFrom(lines: PartsCostLine[], over: Partial<FlatPart> = {}): FlatPart {
  const poBreakdown = groupLinesByPo(lines, [], 1, NO_DATES);
  const totalPrice = poBreakdown.reduce((s, g) => s + g.totalPrice, 0);
  const invoicedAmount = poBreakdown.reduce((s, g) => s + g.invoicedAmount, 0);
  return {
    pn: "X", desc: "Expense reimbursement", qty: 1, source: "po", nonBom: true, supplier: "Steven Douglas Corp. Expense Reports",
    totalPrice, invoicedAmount, pctInvoiced: 100, leftToSpend: poBreakdown.reduce((s, g) => s + g.leftToInvoice, 0),
    purchasedDate: poBreakdown[0]?.purchaseDate ?? null, invoicedDate: poBreakdown[0]?.invoicedDate ?? null,
    poNumber: poBreakdown[0]?.poNumber ?? null, poBreakdown, purchasedQty: poBreakdown.reduce((s, g) => s + g.qty, 0),
    lineCount: lines.length, effectiveUnitPrice: null, poQty: 0, ...over,
  } as unknown as FlatPart;
}
const exp = (n: number, d: string) =>
  line({ lineId: `ec:${++seq}`, poNumber: `2026.${d}`, purchaseDate: d, invoicedDate: d, totalPrice: n, invoicedAmount: n, actualAmount: n, supplier: "Steven Douglas Corp. Expense Reports" });

test("a Purchase range keeps the row, drops the out-of-range POs, and re-sums from what is left", () => {
  const row = rowFrom([exp(65, "2026-04-17"), exp(1971.36, "2026-09-18"), exp(2212.58, "2026-10-02")]);
  assert.ok(Math.abs(row.totalPrice - 4248.94) < 1e-9);
  const scoped = scopePartToGroups(row, (g) => dayInRange(g.purchaseDate, "", "2026-09-30"))!;
  assert.equal(scoped.poBreakdown.length, 2, "the 10/2 PO is not listed");
  assert.ok(scoped.poBreakdown.every((g) => (g.purchaseDate ?? "") <= "2026-09-30"));
  assert.ok(Math.abs(scoped.totalPrice - 2036.36) < 1e-9);
  assert.ok(Math.abs(scoped.invoicedAmount - 2036.36) < 1e-9);
  assert.equal(scoped.purchasedDate, "2026-09-18", "the row's date is now its newest IN-RANGE PO");
  assert.equal(scoped.poNumber, "2026.2026-09-18");
});

test("a row with nothing in range is dropped; one entirely in range is returned untouched", () => {
  const row = rowFrom([exp(10, "2026-10-02"), exp(20, "2026-10-05")]);
  assert.equal(scopePartToGroups(row, (g) => dayInRange(g.purchaseDate, "", "2026-09-30")), null);
  assert.equal(scopePartToGroups(row, (g) => dayInRange(g.purchaseDate, "", "2026-12-31")), row);
});

test("Left to Invoice follows the POs in range: an open October PO does not count in a September view", () => {
  const open = line({ poNumber: "106955", supplier: "VMI BARNUM", purchaseDate: "2026-10-05", totalPrice: 231.03, invoicedAmount: 0, actualAmount: 0 });
  const done = line({ poNumber: "106529", supplier: "VMI BARNUM", purchaseDate: "2026-09-01", invoicedDate: "2026-09-01", totalPrice: 391.74, invoicedAmount: 391.74, actualAmount: 391.74 });
  const row = rowFrom([open, done], { nonBom: false });
  assert.ok(Math.abs((row.leftToSpend ?? 0) - 231.03) < 1e-9);
  const scoped = scopePartToGroups(row, (g) => dayInRange(g.purchaseDate, "", "2026-09-30"))!;
  assert.equal(scoped.leftToSpend, 0);
  assert.ok(Math.abs(scoped.totalPrice - 391.74) < 1e-9);
});

test("an in-house or stock row keeps its zeroed Left to Invoice when scoped", () => {
  const row = rowFrom([exp(10, "2026-09-01"), exp(20, "2026-10-02")], { source: "stock", leftToSpend: 0 } as Partial<FlatPart>);
  assert.equal(scopePartToGroups(row, (g) => dayInRange(g.purchaseDate, "", "2026-09-30"))!.leftToSpend, 0);
});

test("a row with no PO groups is not touched by the group scope (the caller judges its own date)", () => {
  const row = rowFrom([]);
  assert.equal(scopePartToGroups(row, () => false), row);
});

// ── Invoiced + range ────────────────────────────────────────────────────────────

test("Invoiced + range lists the window's own invoice events, and Total $ is as of the end date", () => {
  const lifetime = [exp(65, "2026-04-17"), exp(1971.36, "2026-09-18"), exp(2212.58, "2026-10-02")];
  const windowLines = [lifetime[0], lifetime[1]].map((l) => line({ ...l, lineId: `apdd:${++seq}` }));
  const row = rowFrom(lifetime, { invoicedAmount: 2036.36, pctInvoiced: null, leftToSpend: null } as unknown as Partial<FlatPart>);
  const withWindow: FlatPart = { ...row, windowPoBreakdown: groupLinesByPo(windowLines, [], 1, NO_DATES) };
  const scoped = scopePartToWindow(withWindow, "2026-09-30");
  assert.equal(scoped.invoicedAmount, 2036.36, "the windowed Invoiced $ is left exactly as attributed");
  assert.equal(scoped.poBreakdown.length, 2, "no October line under a September filter");
  assert.ok(Math.abs(scoped.totalPrice - 2036.36) < 1e-9, "Total $ excludes a PO placed after the end date");
  assert.ok(Math.abs(scoped.poBreakdown.reduce((s, g) => s + g.invoicedAmount, 0) - scoped.invoicedAmount) < 1e-9, "sub-rows add up to the row");
  assert.equal(scoped.leftToSpend, null);
});

test("scopePartToWindow leaves a row without a window breakdown alone", () => {
  const row = rowFrom([exp(1, "2026-09-01")]);
  assert.equal(scopePartToWindow(row, "2026-09-30"), row);
});

test("dayInRange: inclusive on both ends, open when a bound is empty, a missing date passes only an open-ended range", () => {
  assert.equal(dayInRange("2026-09-30T00:00:00.000Z", "", "2026-09-30"), true);
  assert.equal(dayInRange("2026-10-01", "", "2026-09-30"), false);
  assert.equal(dayInRange("2026-09-01", "2026-09-01", ""), true);
  assert.equal(dayInRange("2026-08-31", "2026-09-01", ""), false);
  assert.equal(dayInRange(null, "", "2026-09-30"), true);
  assert.equal(dayInRange(null, "2026-09-01", ""), true);
  assert.equal(dayInRange(undefined, "2026-09-01", "2026-09-30"), false);
});
