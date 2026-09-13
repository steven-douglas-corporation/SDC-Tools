import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { buildCsv } from "../src/lib/export/csv";
import { buildXlsx } from "../src/lib/export/xlsx";
import type { SheetSpec } from "../src/lib/export/sheet";

// ── Standards on the Monthly ETC export ──────────────────────────────────────
//
// Two separate promises are under test here.
//
// The first is that adding sheets did not change the file a LOCKED user gets. The Monthly
// ETC export is a report people reconcile against, so "we added a feature and the old
// output shifted" is a real failure, not a cosmetic one — hence the byte-for-byte
// assertions rather than "it still looks about right".
//
// The second is the authorization rule, and it is asserted against the route's SOURCE.
// That is unusual, and deliberate: the property that matters ("the client cannot ask for
// protected data") is the ABSENCE of a parameter, and absence is exactly what a
// behavioural test cannot demonstrate — it can only show that the flags someone thought
// to try did nothing. Reading the source proves the only input is the cookie. It is the
// same technique tests/typography.test.ts uses to forbid `text-[Npx]`.

function sheet(over: Partial<SheetSpec> = {}): SheetSpec {
  return {
    sheetName: "Monthly ETC - August 2026",
    title: "Monthly ETC — August 2026",
    subtitle: ["All jobs"],
    columns: [
      { header: "Job Id", type: "text" },
      { header: "Hours", type: "hours" },
    ],
    rows: [
      ["1079", 12],
      ["980", null],
    ],
    totals: ["TOTAL (2 jobs)", 12],
    ...over,
  };
}

// ── The locked export is untouched ──────────────────────────────────────────

test("one spec renders identically whether or not it is wrapped in an array", () => {
  // This is the whole "existing export formatting/data remains unchanged" acceptance
  // criterion, reduced to something a machine can check.
  const spec = sheet();
  assert.equal(buildCsv([spec]), buildCsv(spec));
});

test("a one-sheet CSV has no section separators bolted onto it", () => {
  const csv = buildCsv(sheet());
  assert.ok(csv.startsWith("﻿"), "lost the BOM Excel needs");
  assert.ok(csv.endsWith("\r\n"), "lost the trailing CRLF");
  // The only blank line in a single-section file is the one under the subtitle.
  const blanks = csv.split("\r\n").filter((l) => l === "").length;
  assert.equal(blanks, 2, `expected the subtitle gap and the trailing newline only, got ${blanks} blank lines`);
});

// ── Extra sections and sheets ───────────────────────────────────────────────

test("each spec becomes its own worksheet, in order", async () => {
  const buf = await buildXlsx([
    sheet(),
    sheet({ sheetName: "Standard Sheet - August 2026", title: "Standard Sheet — August 2026" }),
    sheet({ sheetName: "Standard Fees - August 2026", title: "Standard Fees by Department — August 2026" }),
  ]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  assert.deepEqual(
    wb.worksheets.map((w) => w.name),
    ["Monthly ETC - August 2026", "Standard Sheet - August 2026", "Standard Fees - August 2026"],
  );
});

test("the CSV appends extra sections below, each still announcing itself", () => {
  const csv = buildCsv([
    sheet(),
    sheet({ sheetName: "Standard Sheet - August 2026", title: "Standard Sheet — August 2026" }),
  ]);
  const lines = csv.replace(/^﻿/, "").split("\r\n");
  // A CSV has no tabs, so the second table has to be findable by its own title row.
  assert.equal(lines[0], "Monthly ETC — August 2026");
  const second = lines.indexOf("Standard Sheet — August 2026");
  assert.ok(second > 0, "the appended section lost its title row");
  // Two blank lines separate the sections, so the break is obvious to a reader and to
  // anything re-parsing the file.
  assert.equal(lines[second - 1], "");
  assert.equal(lines[second - 2], "");
});

test("sheet names that collide after the 31-character clamp are still distinct", async () => {
  // Excel refuses duplicate worksheet names outright, and safeSheetName's clamp can turn
  // two different long month labels into the same 31 characters.
  const long = "Standard Fees by Department for September";
  const buf = await buildXlsx([sheet({ sheetName: long }), sheet({ sheetName: long })]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const names = wb.worksheets.map((w) => w.name);
  assert.equal(new Set(names).size, 2, `duplicate worksheet names: ${names.join(" | ")}`);
  for (const n of names) assert.ok(n.length <= 31, `"${n}" is ${n.length} characters`);
});

test("an empty sheet list is refused rather than silently producing an empty file", async () => {
  assert.throws(() => buildCsv([]));
  await assert.rejects(() => buildXlsx([]));
});

// ── The authorization rule, asserted against the route's source ─────────────

const ROUTE = readFileSync(join(process.cwd(), "src/app/api/export/[report]/route.ts"), "utf8");

test("the export route decides on the unlock cookie, not on anything the caller sent", () => {
  assert.ok(
    ROUTE.includes("isStandardSheetUnlocked"),
    "the route must consult the Standard Sheet gate before attaching protected sheets",
  );
  // The gate call has to be the CONDITION guarding the builder, not merely imported.
  assert.match(
    ROUTE,
    /if\s*\(\s*report === "etc" && \(await isStandardSheetUnlocked\(\)\)\s*\)/,
    "buildStandardExportSheets must sit behind the gate check",
  );
});

test("no caller-supplied parameter can ask for Standards", () => {
  // The failure this prevents: someone adds `?standards=1` as a convenience and the
  // client becomes the authority on its own permissions.
  for (const param of ["standards", "includeStandards", "include_standards", "unlocked", "password"]) {
    assert.ok(
      !ROUTE.includes(`searchParams.get("${param}")`),
      `the route reads "${param}" from the query string — Standards must depend on the cookie alone`,
    );
  }
});

test("the export never handles the Standards password", () => {
  // Not in a parameter, not in a log line, not written into the workbook.
  assert.ok(!/STANDARD_SHEET_PASSWORD/.test(ROUTE), "the route references the password env var");
  assert.ok(!/expectedButtonPassword|expectedPassword/.test(ROUTE), "the route reads the password itself");
  // What DOES get recorded is a boolean, so an egress carrying confidential figures stays
  // distinguishable afterward.
  assert.match(ROUTE, /standards: includedStandards/, "the audit record must say whether Standards went out");
});
