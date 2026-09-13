import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { parseSheetDate, readInventorySheet } from "../src/lib/job-cost-inventory-sync";

// ── Job Cost Explorer: monthly inventory ingestion (2026-08-11) ─────────────
//
// parseSheetDate and readInventorySheet are pure/IO-free (no DB, no network),
// so — unlike the DB-touching resolvers in job-cost-source.ts — these get real
// fixture-based tests rather than source-inspection regexes. A live re-check
// against the actual Finance-folder workbook lives in
// scripts/verify-job-cost-snapshot.ts.

test("parseSheetDate matches every real sheet-name shape seen in the workbook", () => {
  assert.equal(parseSheetDate("SDC inventory 6.30.26"), "2026-06-30");
  assert.equal(parseSheetDate("SDC inventory 5.31.26"), "2026-05-31");
  assert.equal(parseSheetDate("SDC inventory 9.30.25 UPDATED"), "2025-09-30");
  assert.equal(parseSheetDate("SDC inventory 9.30.25 original"), "2025-09-30");
  assert.equal(parseSheetDate("SDC inventory 02.29.24"), "2024-02-29");
});

test("parseSheetDate rejects Lisa's OWN other tabs in the same workbook", () => {
  // These share the workbook with the inventory sheets but are a different
  // tracking system entirely (this app's ETC source is EtcEntry, not these) —
  // confirmed by listing all 58 real sheet names, none of them say "inventory".
  assert.equal(parseSheetDate("25-June ETC"), null);
  assert.equal(parseSheetDate("2025_October_ETC"), null);
  assert.equal(parseSheetDate("Monthly Est to Compl 9.30.24"), null);
  assert.equal(parseSheetDate("12.31 CTC Dec_version 4"), null);
  assert.equal(parseSheetDate("12.31 Monthly Est to Complete2"), null);
});

test("parseSheetDate rejects a name with 'inventory' but no parseable date", () => {
  assert.equal(parseSheetDate("SDC inventory summary"), null);
});

function makeSheet(rows: (string | number)[][]): ExcelJS.Worksheet {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("test");
  rows.forEach((row, i) => ws.getRow(i + 1).values = row);
  return ws;
}

// The real header: three title rows, then the real per-column header at row 5
// ("Job #" | "Customer" | "Machine Desc" | "Total Sold Price" | … | "% Complete"),
// with a MERGED super-header one row above it (row 4) that ALSO says
// "% Complete" — labeling the unrelated "change from prior month" column
// instead of the real one. This is the exact shape that caused a real bug:
// the real % Complete column got read from the wrong column, and the sheet's
// own title/footnote rows got counted as job rows.
const REAL_SHAPE_HEADER = [
  ["Steven Douglas Corp."],
  ["Inventory"],
  ["Mon Jun 29 2026 20:00:00 GMT-0400 (Eastern Daylight Time)"],
  ["", "", "", "", "", "", "", "", "", "$ Complete", "% Complete"], // decoy row — row 4
  ["Job #", "Customer", "Machine Desc", "Total Sold Price", "Change Quotes", "Remaining Invoicing", "Estimate to Complete", "Inventory", "% Complete", "Change from", "Change from"], // real header — row 5
  ["", "", "", "", "", "", "", "", "", "prior month", "prior month"],
];

test("readInventorySheet anchors % Complete to the SAME row as Job #, not a decoy header above it", () => {
  const ws = makeSheet([
    ...REAL_SHAPE_HEADER,
    ["1079", "Parker", "Duplicate Paragon", 596115, "", 0, 0, 0, 1, 0, 0],
    ["1101", "Steris", "Coil Stacker", 2692160, 42500, 626986, 543403, 83583, 0.801290465, 66018, 0.0245],
  ]);
  const rows = readInventorySheet(ws);
  assert.deepEqual(rows, [
    { jobId: "1079", salesPrice: 596115, percentComplete: 100 },
    { jobId: "1101", salesPrice: 2692160, percentComplete: 80.1 },
  ]);
});

test("readInventorySheet excludes the title rows above the header", () => {
  const ws = makeSheet([...REAL_SHAPE_HEADER, ["1079", "Parker", "x", 596115, "", 0, 0, 0, 1, 0, 0]]);
  const rows = readInventorySheet(ws);
  assert.equal(rows.length, 1, "only the one real data row — none of the three title rows above the header");
});

test("readInventorySheet excludes freeform note rows below the last real job (real bug: both had a Sales $ value too)", () => {
  const ws = makeSheet([
    ...REAL_SHAPE_HEADER,
    ["1079", "Parker", "x", 596115, "", 0, 0, 0, 1, 0, 0],
    ["1160 includes a late penalty clause", "", "", 44158540, "", "", "", "", "", "", ""],
    ["Prior month inventory", "", "", 251421.19, "", "", "", "", "", "", ""],
  ]);
  const rows = readInventorySheet(ws);
  assert.deepEqual(rows, [{ jobId: "1079", salesPrice: 596115, percentComplete: 100 }]);
});

test("readInventorySheet normalizes a zero-padded job id — real bug: '0979' never matched Job.jobId '979'", () => {
  const ws = makeSheet([...REAL_SHAPE_HEADER, ["0979", "x", "x", 73000, "", 0, 0, 0, 1, 0, 0]]);
  const rows = readInventorySheet(ws);
  assert.equal(rows[0]?.jobId, "979");
});

test("readInventorySheet returns nothing when a required header is missing", () => {
  const ws = makeSheet([["Job #", "Customer"], ["1079", "Parker"]]);
  assert.deepEqual(readInventorySheet(ws), []);
});
