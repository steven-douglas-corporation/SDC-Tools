import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── The Hours tab's grouped view never shows a Punches column (2026-08-17) ──
//
// Source-inspection, matching the pattern used elsewhere for this app's
// React components/server modules (no DOM renderer or database in CI).
// HoursGroupedTree.tsx is the ONLY component that renders a grouped rollup
// (it renders whenever ANY Group By dimension, single or combined, is
// active — see page.tsx's `grouped` flag) and hours-export.ts's grouped
// branch is the only export path for that same view. Neither may declare a
// "Punches" column. The underlying data (`HoursGroupRow.punchCount`) is
// untouched — these tests only guard the PRESENTATION.

const ROOT = join(import.meta.dirname, "..");
function code(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");
}

test("the grouped tree declares no Punches header", () => {
  const src = code("src", "components", "HoursGroupedTree.tsx");
  assert.doesNotMatch(src, /label="Punches"/, 'no <SortableTh label="Punches" .../> may exist anywhere in the grouped tree');
});

test("the grouped tree never renders a punchCount value in a table cell", () => {
  const src = code("src", "components", "HoursGroupedTree.tsx");
  assert.doesNotMatch(src, /\.punchCount\.toLocaleString\(\)/, "a rendered punch-count cell would reintroduce the column visually even without the header");
});

test("HoursGroupRow's punchCount field itself is untouched — the backend still computes it", () => {
  // The type this component and hours-explorer.ts both share still carries
  // punchCount; only the RENDER of it was removed. If this type ever drops
  // the field, something upstream changed in a way this fix never asked for.
  const src = code("src", "lib", "hours-filters.ts");
  assert.match(src, /punchCount:\s*number/, "HoursGroupRow must still carry punchCount");
});

test("the grouped export declares no Punches column", () => {
  const src = code("src", "lib", "export", "hours-export.ts");
  const groupedStart = src.indexOf("if (groupByLevels.length > 0)");
  assert.ok(groupedStart >= 0, "the grouped export branch must exist");
  const groupedBranch = src.slice(groupedStart, src.indexOf("return {", groupedStart) + 200);
  assert.doesNotMatch(groupedBranch, /header:\s*"Punches"/, "the grouped export's columns must not include Punches");
  assert.doesNotMatch(groupedBranch, /g\.punchCount/, "the grouped export's row/column mapping must not reference punchCount");
});

test("the ungrouped (detail) export is untouched — it never had a Punches column to begin with", () => {
  const src = code("src", "lib", "export", "hours-export.ts");
  const groupedStart = src.indexOf("if (groupByLevels.length > 0)");
  const ungroupedBranch = src.slice(src.indexOf("return {", groupedStart) + 5);
  assert.doesNotMatch(ungroupedBranch, /header:\s*"Punches"/);
});
