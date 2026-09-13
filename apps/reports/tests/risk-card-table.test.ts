import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── The three risk cards must be ONE table, not three shapes ────────────────
//
// Delivery Slip, No Purchase Order and Upcoming Deliveries used to render two
// different row components with different column counts — PoRiskRow was
// `PO | Supplier | count | dates…`, where even the number of date columns
// varied per card (Delivery had Required+Expected, No PO had Required only,
// Upcoming had Expected+Required in the opposite order), and PartRiskRow was
// `Part | Desc | Supplier | Required | Expected`. None had a header row and
// none showed Qty, so the three cards sitting side by side did not line up
// with each other or agree on what a column meant.
//
// They now share one column template, one header and one row component. This
// is a source-shape guard (no React test renderer in this repo — same
// convention as tests/job-procurement-collapse.test.ts).

const SRC = readFileSync(
  join(import.meta.dirname, "..", "src", "components", "JobProcurement.tsx"),
  "utf8",
);
const CODE = SRC.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

test("there is exactly one column template, and both row modes use it", () => {
  assert.equal(
    (CODE.match(/const RISK_COLS = /g) ?? []).length,
    1,
    "more than one column template means the cards can drift apart again",
  );
  // The header and the row must both lay out on it — that is what makes the
  // columns line up rather than merely look similar.
  assert.equal(
    (CODE.match(/gridTemplateColumns: RISK_COLS/g) ?? []).length,
    2,
    "the header row and the data row should each use RISK_COLS, and nothing else should",
  );
});

test("the header names the six required columns in order", () => {
  const head = CODE.slice(CODE.indexOf("function RiskTableHead"), CODE.indexOf("function RiskTableRow"));
  const labels = [...head.matchAll(/>([^<>{}]+)<\/span>/g)].map((m) => m[1].trim()).filter(Boolean);
  // "Desc" rather than "Description": it is the label the Parts List's own
  // ALL_COLS already uses for this column, and at the narrowest the cards get
  // (three across from 1280px) the longer word truncated in the HEADING —
  // which a heading must never do. The full word is the cell's title.
  assert.deepEqual(labels, ["PO # / Part #", "Qty", "Desc", "Supplier", "Required", "Expected"]);
});

test("all three cards render the header, and each has exactly one", () => {
  assert.equal(
    (CODE.match(/<RiskTableHead \/>/g) ?? []).length,
    3,
    "Delivery Slip, No Purchase Order and Upcoming Deliveries must each show the header",
  );
});

test("both grouping modes go through the one shared row component", () => {
  // PoRiskRow (PO grouping) and PartRiskRow (part grouping) are thin adapters;
  // neither may lay out its own cells, or the two modes stop matching.
  const po = CODE.slice(CODE.indexOf("function PoRiskRow"), CODE.indexOf("function PartRiskRow"));
  const part = CODE.slice(CODE.indexOf("function PartRiskRow"));
  for (const [name, body] of [["PoRiskRow", po], ["PartRiskRow", part]] as const) {
    assert.match(body, /<RiskTableRow/, `${name} must render RiskTableRow`);
    assert.doesNotMatch(body, /gridTemplateColumns/, `${name} must not define its own columns`);
  }
});

test("the No Purchase Order card never uses the words \"No PO\" as a row identifier", () => {
  // The point of the first column is to identify the record. "No PO" is not an
  // identifier — it repeats the card's own title and hides the part number the
  // reader actually needs.
  const po = CODE.slice(CODE.indexOf("function PoRiskRow"), CODE.indexOf("function PartRiskRow"));
  assert.doesNotMatch(po, /poNumber \?\? "No PO"/, "identify a PO-less group by its first part number instead");
});

test("dates in the cards go through the shared fmtDate", () => {
  const row = CODE.slice(CODE.indexOf("function RiskTableRow"), CODE.indexOf("function PoRiskRow"));
  assert.equal((row.match(/fmtDate\(/g) ?? []).length, 4, "both date cells should format via fmtDate (value + title)");
  assert.doesNotMatch(row, /toLocaleDateString|new Intl\.DateTimeFormat/, "no second date format in the cards");
});

test("qty goes through the same num() helper the Parts List qty cell uses", () => {
  const row = CODE.slice(CODE.indexOf("function RiskTableRow"), CODE.indexOf("function PoRiskRow"));
  assert.match(row, /\{num\(qty\)\}/);
});
