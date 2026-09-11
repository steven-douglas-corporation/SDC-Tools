import { test } from "node:test";
import assert from "node:assert/strict";
import { groupLinesByPo } from "../src/lib/po-detail";
import type { PartsCostLine } from "../src/lib/sync-totaleto";

// ── One row per part, all its POs in the panel (2026-09-10) ─────────────────
//
// The Parts List row is one part, and its money is the SUM of every PO that
// part was ever bought on. `poBreakdown` is the honest form of that sum: one
// entry per PO, each keeping its own price, quantity, invoiced amount and
// dates, because averaging them away is what made the table unreadable in the
// first place (a "+2" badge and an em dash where the unit price should be).
//
// These are real unit tests, not source-shape guards: `groupLinesByPo` is a
// pure function over line arrays, so the arithmetic can be checked directly.
// The properties that matter are all conservation properties — what goes in
// must come out, exactly once, at the right weight — and those are the ones a
// future refactor is most likely to break silently.
//
// Checked against live jobs too (job 1116: 1067 PO groups over 748 rows; job
// 1101: 1282 over 587), where sum-of-groups equals sum-of-rows to the cent
// once the BOM estimates on never-purchased parts are set aside.

let seq = 0;
const line = (o: Partial<PartsCostLine>): PartsCostLine => ({
  lineId: `pod:${++seq}`,
  purchaseDate: null,
  invoicedDate: null,
  supplier: null,
  manufacturer: null,
  category: null,
  poNumber: null,
  partNumber: "PN-1",
  description: null,
  quantity: 0,
  unitPrice: 0,
  totalPrice: 0,
  invoicedAmount: 0,
  actualAmount: 0,
  ...o,
});

const NO_DATES = new Map<string, { expectedDate: string | null; receivedDate: string | null }>();

// The worked example from the request, with this app's own numbers: one part,
// three POs, three different prices.
const THREE_POS = [
  line({ poNumber: "100815", quantity: 2, unitPrice: 30, totalPrice: 60, actualAmount: 60, purchaseDate: "2025-01-05", supplier: "REXEL" }),
  line({ poNumber: "102944", quantity: 1, unitPrice: 35, totalPrice: 35, actualAmount: 35, purchaseDate: "2025-06-11", supplier: "REXEL" }),
  line({ poNumber: "104211", quantity: 3, unitPrice: 41.33, totalPrice: 124, actualAmount: 124, purchaseDate: "2026-02-02", supplier: "EBAY" }),
];

test("each PO keeps its own price — nothing is averaged into a single number", () => {
  const groups = groupLinesByPo(THREE_POS, [], 1, NO_DATES);
  assert.equal(groups.length, 3);
  const byPo = new Map(groups.map((g) => [g.poNumber, g]));
  assert.equal(byPo.get("100815")!.unitPrice, 30);
  assert.equal(byPo.get("102944")!.unitPrice, 35);
  assert.equal(byPo.get("104211")!.unitPrice, 124 / 3);
  // Supplier is per PO, not per part: the same part came from two vendors.
  assert.equal(byPo.get("100815")!.supplier, "REXEL");
  assert.equal(byPo.get("104211")!.supplier, "EBAY");
});

test("newest purchase first, so the row's displayed PO is the panel's first entry", () => {
  const groups = groupLinesByPo(THREE_POS, [], 1, NO_DATES);
  assert.deepEqual(groups.map((g) => g.poNumber), ["104211", "102944", "100815"]);
});

test("unit x qty is exactly the group's own total, on every entry", () => {
  for (const g of groupLinesByPo(THREE_POS, [], 1, NO_DATES)) {
    assert.ok(g.unitPrice !== null);
    assert.ok(Math.abs(g.unitPrice * g.qty - g.totalPrice) < 1e-9, `${g.poNumber}: ${g.unitPrice} x ${g.qty} != ${g.totalPrice}`);
  }
});

test("the groups sum to what the row shows — no money hidden, none invented", () => {
  const groups = groupLinesByPo(THREE_POS, [], 1, NO_DATES);
  assert.equal(groups.reduce((s, g) => s + g.totalPrice, 0), 219);
  assert.equal(groups.reduce((s, g) => s + g.invoicedAmount, 0), 219);
  assert.equal(groups.reduce((s, g) => s + g.qty, 0), 6);
});

test("a part bought twice on ONE PO is one entry that says so, not two rows", () => {
  // 33 of job 1116's 1045 part/PO pairs are genuinely like this.
  const groups = groupLinesByPo(
    [
      line({ poNumber: "101999", quantity: 2, totalPrice: 100, actualAmount: 100, purchaseDate: "2026-01-01" }),
      line({ poNumber: "101999", quantity: 3, totalPrice: 150, actualAmount: 150, purchaseDate: "2026-01-04" }),
    ],
    [], 1, NO_DATES,
  );
  assert.equal(groups.length, 1, "one PO is one entry");
  assert.equal(groups[0].lineCount, 2, "and it reports how many lines it sums");
  assert.equal(groups[0].qty, 5);
  assert.equal(groups[0].totalPrice, 250);
  assert.equal(groups[0].unitPrice, 50);
  assert.equal(groups[0].lineIds.length, 2, "both source ids are carried");
  assert.equal(groups[0].purchaseDate, "2026-01-04", "the newest of the group's dates");
});

test("the share divisor is applied, so two BOM rows sharing a part number do not double-count", () => {
  // Two BOM rows both entitled to the same purchase lines each take half; the
  // pair still sums to the whole. This is the invariant `shareOf` exists for.
  const half = groupLinesByPo(THREE_POS, [], 2, NO_DATES);
  assert.equal(half.reduce((s, g) => s + g.totalPrice, 0), 219 / 2);
  assert.equal(half.reduce((s, g) => s + g.qty, 0), 3);
  // And a halved group still self-adds: unit price is unchanged by the split,
  // because both numerator and denominator were halved.
  const byPo = new Map(half.map((g) => [g.poNumber, g]));
  assert.equal(byPo.get("100815")!.unitPrice, 30);
});

test("recovered lines are NOT divided — they belong wholly to the row that claimed them", () => {
  // The asymmetry po-detail.ts documents: an exact line is shared, a
  // differently-spelled one is claimed by exactly one row, so dividing it would
  // send the remainder nowhere. Measured as real money lost on jobs 1104/1125.
  const groups = groupLinesByPo(
    [line({ poNumber: "A", quantity: 2, totalPrice: 100, actualAmount: 100 })],
    [line({ poNumber: "B", quantity: 2, totalPrice: 80, actualAmount: 80 })],
    2, NO_DATES,
  );
  const byPo = new Map(groups.map((g) => [g.poNumber, g]));
  assert.equal(byPo.get("A")!.totalPrice, 50, "exact line halved");
  assert.equal(byPo.get("B")!.totalPrice, 80, "recovered line whole");
});

test("a zero-quantity PO reports no unit price rather than Infinity", () => {
  // Job 1116 carries cancelled and correcting lines whose quantities net to 0.
  const [g] = groupLinesByPo([line({ poNumber: "104441", quantity: 0, totalPrice: 0 })], [], 1, NO_DATES);
  assert.equal(g.unitPrice, null);
  assert.ok(!Number.isFinite(0 / 0));
});

test("lines with no PO number stay separate instead of merging into one bucket", () => {
  const groups = groupLinesByPo(
    [line({ poNumber: null, totalPrice: 10, quantity: 1 }), line({ poNumber: null, totalPrice: 20, quantity: 1 })],
    [], 1, NO_DATES,
  );
  assert.equal(groups.length, 2, "two unrelated charges are two rows, not one $30 row");
});

test("expected and delivered dates come from the stable line id, not the part number", () => {
  const dates = new Map([["pod:900", { expectedDate: "2026-03-01", receivedDate: "2026-03-05" }]]);
  const [g] = groupLinesByPo([line({ lineId: "pod:900", poNumber: "P1", quantity: 1, totalPrice: 5 })], [], 1, dates);
  assert.equal(g.expectedDate, "2026-03-01");
  assert.equal(g.deliveredDate, "2026-03-05");

  // A line the BOM's PO query never returned (Shipping/FEE/TARIFF are excluded
  // from it) reports no dates rather than borrowing another line's.
  const [none] = groupLinesByPo([line({ lineId: "pod:no-match", poNumber: "P2", quantity: 1, totalPrice: 5 })], [], 1, dates);
  assert.equal(none.expectedDate, null);
  assert.equal(none.deliveredDate, null);
});

test("every line id reaches exactly one group — none dropped, none duplicated", () => {
  const groups = groupLinesByPo(THREE_POS, [], 1, NO_DATES);
  const ids = groups.flatMap((g) => g.lineIds);
  assert.equal(ids.length, THREE_POS.length);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), THREE_POS.map((l) => l.lineId).sort());
});

test("the same PO number from two suppliers is two POs, not one", () => {
  // A PO number is not a PO. Keyed on the number alone, REXEL's and EBAY's
  // "200100" would have summed into one row wearing REXEL's name — the exact
  // blend this panel exists to avoid, and one the `lineIds` React key would
  // have hidden because the merged row still had unique ids.
  const groups = groupLinesByPo(
    [
      line({ poNumber: "200100", supplier: "REXEL", quantity: 2, totalPrice: 20, actualAmount: 20, purchaseDate: "2026-01-01" }),
      line({ poNumber: "200100", supplier: "EBAY", quantity: 1, totalPrice: 50, actualAmount: 0, purchaseDate: "2026-02-01" }),
    ],
    [],
    1,
    NO_DATES,
  );
  assert.equal(groups.length, 2);
  const bySupplier = new Map(groups.map((g) => [g.supplier, g]));
  assert.equal(bySupplier.get("REXEL")!.unitPrice, 10);
  assert.equal(bySupplier.get("EBAY")!.unitPrice, 50);
  // Conservation still holds across the split.
  assert.equal(groups.reduce((a, g) => a + g.totalPrice, 0), 70);
  assert.equal(groups.reduce((a, g) => a + g.leftToInvoice, 0), 50);
});

test("two lines for one part on ONE supplier's PO still roll into a single row", () => {
  const groups = groupLinesByPo(
    [
      line({ poNumber: "300200", supplier: "REXEL", quantity: 1, totalPrice: 10 }),
      line({ poNumber: "300200", supplier: "REXEL ", quantity: 3, totalPrice: 30 }),
    ],
    [],
    1,
    NO_DATES,
  );
  // Vendor names are normalized before keying, so a trailing space in the feed
  // does not split one PO into two.
  assert.equal(groups.length, 1);
  assert.equal(groups[0].lineCount, 2);
  assert.equal(groups[0].qty, 4);
  assert.equal(groups[0].unitPrice, 10);
});
