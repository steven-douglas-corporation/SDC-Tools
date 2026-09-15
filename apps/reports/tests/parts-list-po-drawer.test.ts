import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  flattenBomParts,
  partsOnPo,
  scopePartToPo,
  findPoGroup,
  makePoGroup,
  poCellState,
  authoritativeVendorRollup,
  supplierKey,
  UNKNOWN_SUPPLIER,
} from "../src/lib/po-detail";
import { SDC_CANONICAL } from "../src/lib/vendor-normalize";
import type { BomNode, BomPart, JobBom, Vendor } from "../src/lib/job-bom";
import type { PartsCostLine } from "../src/lib/sync-totaleto";

// ── The Parts List row, the PO drawer, and the PO they agree on (2026-09-14) ──
//
// Five defects, one root: a FlatPart carries ONE displayed PO but may have been
// bought on several, and different consumers picked different ones.
//
//   * The row's PO # and supplier came from the BOM's own PO line (job-bom.ts
//     orders those by supplier NAME, so: the alphabetically-first vendor) while
//     its purchased date came from the newest purchase line. Three cells, two
//     purchases.
//   * The drawer found its parts by the displayed PO alone, so a PO the part
//     was bought on EARLIER matched nothing and the click did nothing, silently.
//   * The drawer then rendered each part's LIFETIME money under one PO's heading.
//   * Alternate-spelling recovery depended on SQL row order.
//   * Build Readiness compared a raw Total ETO supplier with a normalized one.
//
// These are fixture tests over flattenBomParts and the pure helpers, in the
// style of tests/parts-po-breakdown.test.ts — no database, no React. The few
// things only the components can promise are pinned by source shape at the end,
// the convention tests/parts-list-row-model.test.ts already uses.

let seq = 0;
const line = (o: Partial<PartsCostLine>): PartsCostLine => ({
  lineId: `pod:${++seq}`,
  purchaseDate: null,
  invoicedDate: null,
  supplier: null,
  manufacturer: null,
  category: null,
  poNumber: null,
  partNumber: "PN-A",
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
const section = (parts: BomPart[]): BomNode => ({
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
});
const bomOf = (parts: BomPart[], vendors: Vendor[] = []): JobBom => ({
  jobId: "1101",
  roots: [section(parts)],
  grandTotalCost: 0,
  grandTotalPartQty: 0,
  rowCount: parts.length,
  vendors,
});

// PN-A: the BOM's PO line is ACME's 100001 (alphabetically first). The NEWEST
// purchase is ZETA's 105000. Bought twice, from two vendors.
const PN_A = part({ id: 1, pn: "PN-A", poId: "100001", supplier: "ACME", qty: 2, unitPrice: 50 });
const OLD_LINE = line({ poNumber: "100001", supplier: "ACME", purchaseDate: "2025-01-05", invoicedDate: "2025-02-01", quantity: 2, totalPrice: 100, actualAmount: 100, invoicedAmount: 100 });
const NEW_LINE = line({ poNumber: "105000", supplier: "ZETA", purchaseDate: "2026-03-01", invoicedDate: null, quantity: 4, totalPrice: 200, actualAmount: 0, invoicedAmount: 0 });

// ── Finding 5: PO #, supplier and purchased date come from ONE line ──────────

test("the row's PO #, supplier and purchased date all describe the NEWEST purchase line", () => {
  const [row] = flattenBomParts(bomOf([PN_A]), [OLD_LINE, NEW_LINE]);
  assert.equal(row.poNumber, "105000", "PO # is the newest purchase's, not the BOM PO line's (ACME's 100001)");
  assert.equal(row.supplier, "ZETA", "supplier is that same line's");
  assert.equal(row.purchasedDate, "2026-03-01", "and so is the purchased date");
  assert.equal(row.invoicedDate, null, "the invoiced date too — no mixing in the older line's Feb invoice");
  // DEVLOG §70: "the first entry here IS the PO the Parts List row displays".
  assert.equal(row.poBreakdown[0].poNumber, row.poNumber);
  assert.equal(row.poBreakdown[0].supplier, row.supplier);
});

test("row order of the purchase lines does not change which one the row displays", () => {
  const [a] = flattenBomParts(bomOf([PN_A]), [OLD_LINE, NEW_LINE]);
  const [b] = flattenBomParts(bomOf([PN_A]), [NEW_LINE, OLD_LINE]);
  assert.equal(a.poNumber, b.poNumber);
  assert.equal(a.supplier, b.supplier);
  assert.equal(a.purchasedDate, b.purchasedDate);
});

test("with no purchase lines at all, the BOM's PO line is the fallback for PO # AND supplier", () => {
  const [row] = flattenBomParts(bomOf([PN_A]), []);
  assert.equal(row.poNumber, "100001");
  assert.equal(row.supplier, "ACME");
  assert.equal(row.purchasedDate, null);
  assert.equal(row.matchReason, "no-purchase");
});

test("the PO cell prints the row's poNumber ahead of the BOM's poId, so the cell and the row agree", () => {
  const [row] = flattenBomParts(bomOf([PN_A]), [OLD_LINE, NEW_LINE]);
  assert.equal(row.poId, "100001", "sanity: the BOM's own PO line is still on the row for anything that needs it");
  assert.deepEqual(poCellState(row), { kind: "po", po: "105000" });
  // A raw BomPart has no poNumber and still reads its poId.
  assert.deepEqual(poCellState(PN_A), { kind: "po", po: "100001" });
});

// ── Finding 7: alternate-spelling recovery is independent of SQL row order ───

// Job 1101's real case: the BOM says MASTN20_325; purchase lines exist under the
// underscore AND the hyphen spelling. Both fold to MASTN20325.
const MAST = part({ id: 7, pn: "MASTN20_325", poId: "100100", supplier: "REXEL" });
const EXACT_LINE = line({ partNumber: "MASTN20_325", poNumber: "100100", supplier: "REXEL", purchaseDate: "2025-05-01", totalPrice: 50, actualAmount: 50 });
const HYPHEN_LINE = line({ partNumber: "MASTN20-325", poNumber: "100200", supplier: "REXEL", purchaseDate: "2025-08-01", totalPrice: 635, actualAmount: 635 });

test("a differently-spelled line is recovered whether SQL returns the exact spelling first or second", () => {
  for (const lines of [[EXACT_LINE, HYPHEN_LINE], [HYPHEN_LINE, EXACT_LINE]]) {
    const rows = flattenBomParts(bomOf([MAST]), lines);
    assert.equal(rows.length, 1, `order ${lines.map((l) => l.partNumber).join(",")}: no orphan non-BOM row may be synthesized for the hyphen lines`);
    const [row] = rows;
    assert.equal(row.totalPrice, 685, "both spellings' money lands on the BOM row");
    assert.equal(row.lineCount, 2);
    assert.equal(row.matchReason, "join-punctuation");
    assert.equal(row.nonBom, false);
  }
});

test("a BOM part's own exact key never shadows a spelling that needs recovery", () => {
  // The regression itself: with the exact key registered first, the old index
  // handed the part its OWN exact lines under the folded key and the hyphen
  // lines went to the non-BOM bucket. Money must not be reported twice either.
  const rows = flattenBomParts(bomOf([MAST]), [EXACT_LINE, HYPHEN_LINE]);
  const total = rows.reduce((s, r) => s + r.totalPrice, 0);
  assert.equal(total, 685, "every dollar exactly once");
});

// ── Finding 2: resolving a PO through every part's breakdown, not its displayed PO ──

test("partsOnPo finds a part under a PO it was bought on EARLIER, not only its displayed one", () => {
  const parts = flattenBomParts(bomOf([PN_A]), [OLD_LINE, NEW_LINE]);
  assert.equal(parts[0].poNumber, "105000", "sanity: the row displays the newer PO");
  assert.deepEqual(partsOnPo(parts, "ACME", "100001").map((p) => p.pn), ["PN-A"], "the older PO still resolves");
  assert.deepEqual(partsOnPo(parts, "ZETA", "105000").map((p) => p.pn), ["PN-A"], "and so does the displayed one");
});

test("partsOnPo keys on supplier + number, so another vendor's identical PO number is not this PO", () => {
  const parts = flattenBomParts(bomOf([PN_A]), [OLD_LINE, NEW_LINE]);
  assert.deepEqual(partsOnPo(parts, "ZETA", "100001"), [], "ZETA never raised 100001");
  assert.deepEqual(partsOnPo(parts, "ACME", "999999"), [], "a PO nobody has is genuinely not found");
});

test("partsOnPo matches suppliers by normalized spelling, and null against the unknown bucket", () => {
  const sdcPart = part({ id: 9, pn: "PN-SDC", poId: "100300", supplier: "Steven Douglas Corp." });
  const sdcLine = line({ partNumber: "PN-SDC", poNumber: "100300", supplier: "Steven Douglas Corp.", purchaseDate: "2026-01-01", totalPrice: 10 });
  const parts = flattenBomParts(bomOf([sdcPart]), [sdcLine]);
  assert.equal(parts[0].supplier, SDC_CANONICAL, "sanity: FlatPart carries the normalized name");
  // Build Readiness hands over the RAW snapshot spelling.
  assert.equal(partsOnPo(parts, "Steven Douglas Corp.", "100300").length, 1);
  assert.equal(partsOnPo(parts, SDC_CANONICAL, "100300").length, 1);

  const noPo = part({ id: 10, pn: "PN-NONE", status: "noPO", poQty: 0 });
  const rows = flattenBomParts(bomOf([noPo]), []);
  assert.equal(partsOnPo(rows, null, null).length, 1, "the no-PO bucket for parts with no supplier");
  assert.equal(supplierKey(null), UNKNOWN_SUPPLIER);
  assert.equal(supplierKey(UNKNOWN_SUPPLIER), UNKNOWN_SUPPLIER);
});

test("a PO raised but not yet in the purchase pipeline (no lines) still opens from the displayed PO", () => {
  const parts = flattenBomParts(bomOf([PN_A]), []);
  assert.equal(partsOnPo(parts, "ACME", "100001").length, 1);
});

test("makePoGroup names the PO by its KEY, not by the first part's displayed PO", () => {
  const parts = flattenBomParts(bomOf([PN_A]), [OLD_LINE, NEW_LINE]);
  const g = makePoGroup("100001", partsOnPo(parts, "ACME", "100001"));
  assert.equal(g.poNumber, "100001", "the drawer must be titled with the PO that was clicked, not 105000");
});

// ── Finding 4: the drawer shows THAT PO's figures ────────────────────────────

test("scopePartToPo replaces the part's lifetime money with the one PO's own group figures", () => {
  const [row] = flattenBomParts(bomOf([PN_A]), [OLD_LINE, NEW_LINE]);
  assert.equal(row.totalPrice, 300, "sanity: the row's lifetime total spans both POs");
  assert.equal(row.invoicedAmount, 100);

  const onOld = scopePartToPo(row, "ACME", "100001");
  assert.equal(onOld.totalPrice, 100);
  assert.equal(onOld.invoicedAmount, 100);
  assert.equal(onOld.leftToSpend, 0);
  assert.equal(onOld.pctInvoiced, 100);
  assert.equal(onOld.purchasedQty, 2);
  assert.equal(onOld.effectiveUnitPrice, 50);
  assert.equal(onOld.lineCount, 1);
  assert.equal(onOld.poNumber, "100001");
  assert.equal(onOld.supplier, "ACME");
  assert.equal(onOld.purchasedDate, "2025-01-05");
  assert.equal(onOld.invoicedDate, "2025-02-01");
  assert.equal(onOld.poBreakdown.length, 1);

  const onNew = scopePartToPo(row, "ZETA", "105000");
  assert.equal(onNew.totalPrice, 200);
  assert.equal(onNew.invoicedAmount, 0);
  assert.equal(onNew.leftToSpend, 200);
  assert.equal(onNew.pctInvoiced, 0);
  assert.equal(onNew.purchasedQty, 4);
  assert.equal(onNew.effectiveUnitPrice, 50);

  // BOM-side facts are the part's, whichever PO it is viewed on.
  assert.equal(onOld.qty, 2);
  assert.equal(onNew.qty, 2);
  assert.equal(onOld.id, row.id);
});

test("the two scoped views sum back to the row — no money invented, none lost", () => {
  const [row] = flattenBomParts(bomOf([PN_A]), [OLD_LINE, NEW_LINE]);
  const a = scopePartToPo(row, "ACME", "100001");
  const b = scopePartToPo(row, "ZETA", "105000");
  assert.equal(a.totalPrice + b.totalPrice, row.totalPrice);
  assert.equal(a.invoicedAmount + b.invoicedAmount, row.invoicedAmount);
  assert.equal(a.purchasedQty + b.purchasedQty, row.purchasedQty);
});

test("scopePartToPo leaves a part untouched when it has no group for that PO, and for the no-PO bucket", () => {
  const [row] = flattenBomParts(bomOf([PN_A]), []);
  assert.equal(findPoGroup(row, "ACME", "100001"), undefined);
  assert.equal(scopePartToPo(row, "ACME", "100001"), row, "nothing bought on it — the BOM estimate stands");
  const [bought] = flattenBomParts(bomOf([PN_A]), [OLD_LINE, NEW_LINE]);
  assert.equal(scopePartToPo(bought, "ACME", null), bought);
});

// ── Finding 13: the supplier card's authoritative rollup matches SDC under any spelling ──

test("authoritativeVendorRollup normalizes both sides and sums every raw vendor row that folds to the name", () => {
  const vendors: Vendor[] = [
    { name: "Steven Douglas Corp.", pos: [{ poId: "1", itemCount: 4, received: 2, pct: 50, lines: [] }] },
    { name: "SDC", pos: [{ poId: "2", itemCount: 2, received: 2, pct: 100, lines: [] }] },
    { name: "REXEL", pos: [{ poId: "3", itemCount: 10, received: 0, pct: 0, lines: [] }] },
  ];
  // The card's supplier is the FlatPart's — already normalized.
  assert.deepEqual(authoritativeVendorRollup(vendors, SDC_CANONICAL), { received: 4, itemCount: 6, pct: 67 });
  // The raw spelling resolves to the same answer.
  assert.deepEqual(authoritativeVendorRollup(vendors, "Steven Douglas Corp."), { received: 4, itemCount: 6, pct: 67 });
  assert.deepEqual(authoritativeVendorRollup(vendors, "rexel"), { received: 0, itemCount: 10, pct: 0 });
  assert.equal(authoritativeVendorRollup(vendors, "NOBODY"), undefined);
});

// ── What only the components can promise, pinned by source shape ────────────

const SRC = join(import.meta.dirname, "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const strip = (raw: string) =>
  raw
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

test("openPoFor resolves through partsOnPo and says so when nothing is found, rather than returning silently", () => {
  const src = strip(read("components/JobProcurement.tsx"));
  const start = src.indexOf("const openPoFor = useCallback(");
  assert.ok(start >= 0);
  const body = src.slice(start, src.indexOf("[parts, bom.vendors", start));
  assert.match(body, /partsOnPo\(parts, sup, poNumber\)/, "the drawer's parts come from the breakdown-aware helper");
  assert.doesNotMatch(body, /p\.poNumber \?\? NO_PO_KEY\) === poKey/, "the old displayed-PO-only filter is gone");
  assert.match(body, /if \(!poParts\.length\) \{\s*toast\(/, "an empty result is a visible notice, not a bare return");
});

test("the PO drawer scopes every row to its own PO and totals the scoped rows", () => {
  const src = strip(read("components/procurement/PoDetailPanel.tsx"));
  const start = src.indexOf("export function PoPanel(");
  const body = src.slice(start, src.indexOf("function PanelBar(", start));
  assert.match(body, /const scopedParts = useMemo\(\(\) => po\.parts\.map\(\(p\) => scopePartToPo\(p, supplier, po\.poNumber\)\)/);
  assert.match(body, /sortRows\(scopedParts, lineSort\.sort, sortColumns\)/, "the table draws the scoped rows");
  assert.match(body, /for \(const p of scopedParts\) \{/, "the header sums the scoped rows");
  assert.match(body, /value \+= p\.totalPrice \|\| 0;/, "PO Value is this PO's purchased value, not BOM unitPrice x qty");
  assert.doesNotMatch(body, /\(p\.unitPrice \|\| 0\) \* \(p\.qty \|\| 0\)/);
});

test("the Parts List PO cell opens the PO it prints", () => {
  const src = strip(read("components/procurement/PoDetailPanel.tsx"));
  assert.match(src, /onOpenPo\(p\.supplier, cell\.po\)/);
});

test("Build Readiness's PO drawer resolves the same way, with the raw snapshot supplier normalized", () => {
  const src = strip(read("lib/build-readiness-po-actions.ts"));
  assert.match(src, /partsOnPo\(parts, supplier, poNumber\)/);
  assert.match(src, /supplierKey\(supplier\)/);
  assert.doesNotMatch(src, /\(p\.supplier \?\? "Unknown supplier"\) === supKey/, "no raw equality on the supplier");
});

// ── Finding 10: no sum of unit prices in the footer ──────────────────────────

test("the Parts List footer does not sum Unit $", () => {
  const src = strip(read("components/JobProcurement.tsx"));
  assert.doesNotMatch(src, /a\.unit \+= p\.unitPrice/, "a sum of unit prices is not a price of anything");
  assert.match(src, /case "unit": return "—";/, "the footer's Unit $ cell is blank");
});
