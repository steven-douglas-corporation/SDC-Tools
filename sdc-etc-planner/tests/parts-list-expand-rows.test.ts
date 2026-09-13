import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── A part's POs unfold under its row (2026-09-13) ──────────────────────────
//
// The side panel (PartPoPanel) is the full view of a part's purchases; this is
// the glance — a chevron on the Parts List row that lays the same POs out inline,
// one sub-row per PO, under the parent row's own columns.
//
// What has to hold, none of it enforceable by a type:
//
//   1. The windowing arithmetic counts DISPLAY rows (parts + open sub-rows), and
//      every sub-row is exactly ROW_H tall — otherwise the window drifts against
//      the scrollbar the moment anything is expanded.
//   2. The footer still sums `parts`. A sub-row is a view of money its parent row
//      already counts; summing display rows would double every expanded part.
//   3. Each sub-row cell reads the PO group's OWN field. A blend here would defeat
//      the point (the parent row is the blend).
//   4. The chevron exists only where there is something to unfold.
//
// Source-shape guards, in this repo's convention for rules that span files (see
// parts-list-row-model.test.ts). The grouping arithmetic behind `poBreakdown` is
// unit-tested for real in tests/parts-po-breakdown.test.ts.

const SRC = join(import.meta.dirname, "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const strip = (raw: string) =>
  raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

test("the window and the spacers are measured over display rows, every one ROW_H tall", () => {
  const job = strip(read("components/JobProcurement.tsx"));
  assert.match(job, /useRowWindow\(displayRows\.length, scrollRef\)/, "the window must count parts AND open sub-rows");
  assert.match(job, /padBottom = Math\.max\(0, \(displayRows\.length - win\.end\) \* ROW_H\)/, "the bottom spacer must cover the sub-rows too");
  // The sub-row <tr> pins its height to the same constant as the parent row.
  const subRow = job.match(/data-po-subrow-of=\{String\(row\.p\.id\)\}[\s\S]*?<PartPoSubRowCells/);
  assert.ok(subRow, "the PO sub-row must be identifiable and render PartPoSubRowCells");
  assert.match(subRow![0], /style=\{\{ height: ROW_H \}\}/, "a sub-row that is not ROW_H tall drifts the window");
  // The drill-to-row scroll indexes the same list the offset is made of.
  assert.match(job, /displayRows\.findIndex\(\(r\) => r\.kind === "part" && String\(r\.p\.id\) === drillKey\)/);
});

test("display rows interleave each open part with its PO groups, in poBreakdown order", () => {
  const job = strip(read("components/JobProcurement.tsx"));
  assert.match(
    job,
    /for \(const p of sortedParts\) \{\s*rows\.push\(\{ kind: "part", p \}\);\s*if \(expanded\.has\(p\.id\)\) for \(const g of p\.poBreakdown\) rows\.push\(\{ kind: "po", p, g \}\);/,
    "sub-rows must follow their parent and come from poBreakdown, the same source the side panel uses",
  );
  // Expanded state is keyed by part id, so a re-sort keeps the same parts open.
  assert.match(job, /useState<ReadonlySet<number>>\(\(\) => new Set\(\)\)/);
});

test("the footer still sums parts, never display rows", () => {
  const job = strip(read("components/JobProcurement.tsx"));
  assert.match(job, /const tot = parts\.reduce\(/, "footer totals must come from `parts`");
  assert.doesNotMatch(job, /displayRows\.reduce\(/, "summing display rows would double every expanded part");
  assert.doesNotMatch(job, /visibleRows\.reduce\(/);
});

test("each sub-row cell reads the PO group's own field", () => {
  const panel = strip(read("components/procurement/PoDetailPanel.tsx"));
  // The function body only — it sits above PoPanel, which legitimately reads the
  // parent row's figures.
  const sub = panel.match(/export function PartPoSubRowCells[\s\S]*?\n\}\n/);
  assert.ok(sub, "PartPoSubRowCells must exist in PoDetailPanel.tsx");
  for (const [label, field] of [
    ["PO #", "g.poNumber"], ["Supplier", "g.supplier"], ["Purch Qty", "g.qty"], ["Unit $", "g.unitPrice"],
    ["Total $", "g.totalPrice"], ["Invoiced $", "g.invoicedAmount"], ["Left to Invoice", "g.leftToInvoice"],
    ["Purchased", "g.purchaseDate"], ["Expected", "g.expectedDate"], ["Received", "g.deliveredDate"],
  ] as const) {
    assert.match(sub![0], new RegExp(field.replace(".", "\\.")), `the sub-row must render ${label} from ${field}`);
  }
  // Never the parent's money: a sub-row that printed p.totalPrice would show the
  // blend on every PO line.
  for (const forbidden of ["p.totalPrice", "p.invoicedAmount", "p.effectiveUnitPrice", "p.purchasedQty"]) {
    assert.doesNotMatch(sub![0], new RegExp(forbidden.replace(".", "\\.")), `${forbidden} is the parent's figure, not this PO's`);
  }
  // The PO number opens the PO drawer, addressed by supplier + number.
  assert.match(sub![0], /onOpenPo\(g\.supplier, g\.poNumber\)/);
});

test("the chevron appears only where there is something to unfold, and the PO drawer's table gets none", () => {
  const panel = strip(read("components/procurement/PoDetailPanel.tsx"));
  assert.match(panel, /expand\?: \{ open: boolean; onToggle: \(\) => void \}/, "expand is optional — the PO drawer renders PartRowCells without it");
  assert.match(panel, /\{expand && p\.poBreakdown\.length > 0 \? \(/, "no chevron on a part with no purchases");
  assert.match(panel, /aria-expanded=\{expand\.open\}/, "the state must be announced, not only drawn");
  const job = strip(read("components/JobProcurement.tsx"));
  assert.match(job, /expand=\{\{ open: expanded\.has\(p\.id\), onToggle: \(\) => toggleExpanded\(p\.id\) \}\}/, "the Parts List wires the chevron");
  // Expand-all lives in the Part No header, and only counts parts that can open.
  assert.match(job, /c\.key === "pn" && expandableIds\.length > 0 && \(/);
  assert.match(job, /sortedParts\.filter\(\(p\) => p\.poBreakdown\.length > 0\)\.map\(\(p\) => p\.id\)/);
});
