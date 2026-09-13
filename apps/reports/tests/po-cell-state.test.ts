import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { poCellState } from "../src/lib/po-detail";

// ── The PO column's own rule ────────────────────────────────────────────────
//
// The counts were already right (the card, the readiness line and the Parts
// List filter all run isUncoveredPart). The CELL was not: three call sites
// each derived the badge inline from `poId ? … : stock ? … : process ? … :
// red NO PO`, which is the raw "po_number is blank" definition.
//
// Measured across all 47 active jobs with a BOM before the fix: 1,270 rows
// painted red against 749 genuinely actionable parts.
//
//   OVER  job 6000 showed 65 red rows with 0 actionable; 1148 59 with 0;
//         1154 32 with 0; 1136 21 with 0; 1129 91 with 24. Every extra was a
//         held part or an already-received one.
//   UNDER and worse: 1147 showed 0 red with 2 actionable, because each of
//         those parts had a PO row carrying POQty 0, so the cell rendered a PO
//         link over a real gap. Same on 1143 (PO 103689, qty -1) and 1162.
//
// poCellState is now that one rule, and it checks isUncoveredPart FIRST so a
// zero-quantity PO cannot mask a gap.

type P = Parameters<typeof poCellState>[0];
const part = (over: Partial<P>): P => ({ status: "ordered", hold: false, source: "po", ...over }) as P;

test("a part with a real PO shows the PO", () => {
  const c = poCellState(part({ source: "po", poNumber: "104393" }));
  assert.equal(c.kind, "po");
  assert.equal(c.kind === "po" && c.po, "104393");
});

test("a stock pull is STOCK, never red", () => {
  assert.equal(poCellState(part({ status: "ordered", source: "stock", poNumber: null })).kind, "stock");
});

test("an in-house process part is its own state, never red", () => {
  assert.equal(poCellState(part({ status: "ordered", source: "process", poNumber: null })).kind, "process");
});

test("an already-received part with no PO is NOT an actionable gap", () => {
  // 4 such rows on job 1129, 6 on 1136, 3 on 1138 — all previously red.
  assert.equal(poCellState(part({ status: "received", source: "none", poNumber: null })).kind, "received");
});

test("a held part with no PO reads as paused, not as a gap", () => {
  // The big one: 65 rows on job 6000, 58 on 1148, 63 on 1129 — all previously
  // red despite isUncoveredPart deliberately excluding held parts.
  const c = poCellState(part({ status: "noPO", hold: true, source: "none", poNumber: null }));
  assert.equal(c.kind, "hold");
});

test("a genuinely uncovered part is red", () => {
  const c = poCellState(part({ status: "noPO", hold: false, source: "none", poNumber: null }));
  assert.equal(c.kind, "none");
  assert.equal(c.kind === "none" && c.stalePo, null);
});

test("a PO that covers no quantity does NOT mask the gap", () => {
  // The under-labelled direction. sourceFor already returns "none" for these
  // (POQty 0 or negative), so the part IS uncovered — but the cell used to see
  // a poId and render a link. It is red now, and names the empty PO.
  const c = poCellState(part({ status: "noPO", hold: false, source: "none", poNumber: "104393" }));
  assert.equal(c.kind, "none", "a zero-quantity PO must not present as covered");
  assert.equal(c.kind === "none" && c.stalePo, "104393", "the stale PO should still be named to the user");
});

test("red is reachable ONLY when isUncoveredPart would be true", () => {
  // The reconciliation guarantee behind "the card count equals the red rows".
  // isUncoveredPart is `status === "noPO" && !hold`, so every other combination
  // must resolve to some non-red state.
  const statuses = ["received", "ordered", "noPO"] as const;
  const sources = ["po", "stock", "process", "none"] as const;
  for (const status of statuses)
    for (const source of sources)
      for (const hold of [true, false])
        for (const poNumber of [null, "999"]) {
          const kind = poCellState(part({ status, source, hold, poNumber })).kind;
          const actionable = status === "noPO" && !hold;
          assert.equal(
            kind === "none",
            actionable,
            `status=${status} source=${source} hold=${hold} po=${poNumber} -> ${kind}, actionable=${actionable}`,
          );
        }
});

// ── No call site may re-derive the badge inline again ───────────────────────

test("no component derives the PO badge from a raw poId/poNumber chain", () => {
  const SRC = join(import.meta.dirname, "..", "src");
  const files = [
    join(SRC, "components", "JobProcurement.tsx"),
    join(SRC, "components", "procurement", "PoDetailPanel.tsx"),
  ];
  for (const file of files) {
    const src = readFileSync(file, "utf8")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // The exact shape that was wrong in three places: a stock/process ternary
    // falling through to a red NO PO. If that pattern is back, the cell is
    // deciding coverage for itself again.
    assert.doesNotMatch(
      src,
      /source === "stock" \?[\s\S]{0,400}?source === "process" \?[\s\S]{0,400}?NO PO/,
      `${file.split(/[\\/]/).pop()} must call poCellState rather than re-deriving the PO badge inline`,
    );
  }
});
