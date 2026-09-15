import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── One row per part, and a row that self-adds (2026-09-10) ────────────────
//
// Three things the Parts List now promises, none of which a type can enforce:
//
//   1. The PO # cell states its own multiplicity ("N POs") rather than
//      picking one PO to show as if it were the row's only purchase. This
//      superseded "# Subs" (2026-09-10, retired 2026-09-15): that column
//      counted purchase LINES offset by one, which conflated "bought twice on
//      one PO" with "bought on two different POs" and needed a hover tooltip
//      to be legible at all — see the test below.
//
//   2. Unit $ x Purch Qty === Total $. That identity needs BOTH new columns:
//      `qty` is the BOM REQUIREMENT (eps.ItemQty) and is load-bearing for
//      readiness, so it could not be repurposed as the purchased quantity.
//      Job 1116's 2198-C1004-ERS is required once and was bought five times.
//
//   3. The part number opens the part's PO history rather than acting as
//      decoration on the row's own click.
//
// Source-shape guards, in this repo's established convention for rules that
// span files (see procurement-uncovered-consistency.test.ts) — there is no
// React test renderer here. The arithmetic itself is unit-tested for real in
// tests/parts-po-breakdown.test.ts.

const SRC = join(import.meta.dirname, "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const strip = (raw: string) =>
  raw
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

test("# Subs is retired, and the PO cell states its own multiplicity instead", () => {
  const panel = strip(read("components/procurement/PoDetailPanel.tsx"));

  assert.doesNotMatch(panel, /"subs"/, "# Subs must not exist anywhere — not in ColKey, ALL_COLS, or a case label");
  assert.doesNotMatch(panel, /\+\{p\.lineCount - 1\}/, "the old badge must not come back inside the PO cell either");
  // More than one PO: plain text, not a button — a click must fall through to
  // the row's own expand toggle rather than picking one PO to navigate to.
  assert.match(panel, /return p\.poBreakdown\.length > 1 \? \(/, "the po case must branch on the real distinct-PO count");
  assert.match(panel, /\{p\.poBreakdown\.length\} POs/, "it must say how many, not just that there are more");
  // Exactly one PO (regardless of how many LINES are on it — see FR-103 in the
  // ETC fixture) keeps the original clickable single-PO number unchanged.
  assert.match(panel, /title="View PO"/, "a single PO keeps its own number as a real link");
});

test("Unit $ x Purch Qty = Total $ is derived, not recomputed", () => {
  const detail = strip(read("lib/po-detail.ts"));

  // The identity holds because effectiveUnitPrice is defined as the quotient of
  // the very two fields the row displays. Deriving it from the lines again
  // would let rounding or a changed filter pull them apart.
  assert.match(
    detail,
    /effectiveUnitPrice: purchasedQty !== 0 \? totalPrice \/ purchasedQty : null/,
    "effectiveUnitPrice must be totalPrice / purchasedQty",
  );
  assert.match(
    detail,
    /const purchasedQty = poBreakdown\.reduce\(\(sum, g\) => sum \+ g\.qty, 0\)/,
    "purchasedQty must be the sum of the breakdown's own quantities",
  );
  // Guarded: job 1116 carries lines whose quantities net to zero.
  assert.match(detail, /purchasedQty !== 0 \?/, "a zero purchased quantity must not divide");
});

test("Qty keeps its meaning — the purchased quantity did NOT take it over", () => {
  const rules = strip(read("lib/job-bom-rules.ts"));
  const detail = strip(read("lib/po-detail.ts"));

  // If `qty` ever became the purchased quantity, readiness would silently
  // change everywhere: this is the comparison that would start lying.
  assert.match(
    rules,
    /coveredQty \+= Math\.min\(safeQty\(p\?\.receivedQty\), qty\)/,
    "readiness must still compare receivedQty against the BOM qty",
  );
  // purchasedQty is its own field, not an overwrite of qty on the spread.
  assert.match(detail, /purchasedQty: number;/, "purchasedQty must be its own field");
  assert.doesNotMatch(detail, /^\s*qty: purchasedQty/m, "qty must not be reassigned from the purchased quantity");
});

test("the part number opens the part panel, and does not also fire the row's click", () => {
  const panel = strip(read("components/procurement/PoDetailPanel.tsx"));
  const pnCase = panel.match(/case "pn":([\s\S]*?)\n {6}case /);
  assert.ok(pnCase, "PartRowCells must still have a 'pn' case");
  assert.match(pnCase[1], /onOpenPart\?\.\(p\)/, "the part number must open the part panel");
  assert.match(pnCase[1], /e\.stopPropagation\(\)/, "without also triggering the row's filter-clearing jump");
});

test("the panel shows every PO with its own figures, and never averages them", () => {
  const part = strip(read("components/procurement/PartPoPanel.tsx"));

  // Each column reads the group's OWN field. A blend anywhere here would defeat
  // the panel's entire purpose.
  for (const [label, field] of [
    ["PO #", "g.poNumber"], ["Supplier", "g.supplier"], ["Qty", "g.qty"], ["Unit $", "g.unitPrice"],
    ["Total $", "g.totalPrice"], ["Invoiced", "g.invoicedAmount"], ["Left to Invoice", "g.leftToInvoice"],
    ["Purchased", "g.purchaseDate"], ["Expected", "g.expectedDate"], ["Delivered", "g.deliveredDate"],
  ] as const) {
    assert.match(part, new RegExp(field.replace(".", "\\.")), `the panel must render ${label} from ${field}`);
  }
  // Rows keyed on the source line ids: two suppliers can raise the same PO
  // number, and an extra-cost row has none at all.
  assert.match(part, /key=\{g\.lineIds\.join\("\|"\)\}/, "rows must be keyed on the stable line ids");
  // It states its own reconciliation rather than only asserting it in a test.
  assert.match(part, /const reconciles = Math\.abs\(tot\.total - part\.totalPrice\) < 0\.005/, "the panel must check its own footer against the row");
});

test("a unit price keeps its cents; totals stay whole dollars", () => {
  const panel = strip(read("components/procurement/PoDetailPanel.tsx"));
  const part = strip(read("components/procurement/PartPoPanel.tsx"));
  // usd() is maximumFractionDigits: 0. On job 1116 that rounds 489 of 700 unit
  // prices and renders five real parts as "$0" — 9452K143 actually costs
  // $0.1409. A price column has to keep its cents; Total $ is happier without.
  assert.match(panel, /\{usd2\(p\.effectiveUnitPrice\)\}/, "the row's Unit $ must use usd2");
  assert.match(part, /: usd2\(g\.unitPrice\)\}/, "the panel's per-PO Unit $ must use usd2");
  assert.match(panel, /\{p\.totalPrice > 0 \? usd\(p\.totalPrice\) : /, "Total $ keeps the whole-dollar convention");
});

test("Purch Qty ships visible, and needs no stored-state migration", () => {
  const job = strip(read("components/JobProcurement.tsx"));
  const hidden = job.match(/DEFAULT_HIDDEN_COLS: ColKey\[\] = \[([^\]]*)\]/);
  assert.ok(hidden, "DEFAULT_HIDDEN_COLS must still exist");
  assert.doesNotMatch(hidden[1], /"purchqty"/, "Purch Qty is what makes the money row checkable");
  // Every column needs a width or the fixed-layout table collapses it.
  assert.match(job, /DEFAULT_COL_WIDTH: Record<ColKey, number> = \{[\s\S]*?purchqty:\s*\d+/, "purchqty needs a default width");
  // "subs" must not have snuck back into the exhaustive width map either — it
  // isn't a ColKey any more, so TypeScript itself would catch it here, but a
  // regex-based source guard is what actually runs in this file's style.
  assert.doesNotMatch(job, /DEFAULT_COL_WIDTH: Record<ColKey, number> = \{[\s\S]*?\bsubs:\s*\d+/, "subs must not have a width — it isn't a column any more");
});
