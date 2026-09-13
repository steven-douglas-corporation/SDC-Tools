import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { csvCell, csvRow, buildCsv } from "../src/lib/export/csv";
import { exportFileName, safeSheetName, todayStamp, type SheetSpec } from "../src/lib/export/sheet";
import { buildProjectsQuery } from "../src/lib/projects-query";

// ── Exporting the table (§24) ────────────────────────────────────────────────
//
// The two formats render ONE spec, so most of what can go wrong is in the value
// mapping: a blank that becomes a zero, a zero that becomes a blank, a number that
// becomes text, a customer name with a comma in it that shreds a row. Those are the
// tests. The data builders themselves need a database and are exercised by
// scripts/export-smoke.ts against real rows.

// ── CSV values ──────────────────────────────────────────────────────────────

test("a cleared value exports as an EMPTY cell, not a zero", () => {
  // The whole point of DEVLOG §16 carried into the export: blank and 0 are different
  // answers, and a spreadsheet that turned one into the other would misreport the month.
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(0), "0");
  assert.notEqual(csvCell(null), csvCell(0));
});

test("numbers export raw — no separators, no currency symbol", () => {
  assert.equal(csvCell(1234567.5), "1234567.5");
  assert.equal(csvCell(-134.99), "-134.99");
  // A figure that cannot be represented is blank rather than the word "NaN", which would
  // poison the column's type on import.
  assert.equal(csvCell(NaN), "");
  assert.equal(csvCell(Infinity), "");
});

test("dates export as ISO days", () => {
  assert.equal(csvCell(new Date("2026-08-04T13:59:00.000Z")), "2026-08-04");
});

test("commas, quotes and newlines are escaped, not dropped", () => {
  // Real customer names contain commas ("Belcan, LLC"), and a raw join would shift every
  // column after them by one.
  assert.equal(csvCell("Belcan, LLC"), '"Belcan, LLC"');
  assert.equal(csvCell('He said "no"'), '"He said ""no"""');
  assert.equal(csvCell("line one\nline two"), '"line one\nline two"');
  assert.equal(csvRow(["a", "b,c", null, 0]), 'a,"b,c",,0');
});

test("a value starting with = is neutralised", () => {
  // CSV injection: Excel evaluates a cell beginning = + - @ as a formula, and these
  // files are opened by people who did not create them. Job/customer names come from
  // upstream systems, so this is not hypothetical.
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("+SUM(A1)"), "'+SUM(A1)");
  assert.equal(csvCell("@cmd"), "'@cmd");
  // A negative NUMBER is untouched — only text is prefixed.
  assert.equal(csvCell(-5), "-5");
});

// ── Hours columns are always whole, in every export format (2026-08-17) ─────
//
// The XLSX writer already gets this via a "#,##0" cell format applied to any
// `type: "hours"` column (xlsx.ts) — the value itself stays full precision,
// Excel just displays it rounded. CSV has no cell-format concept, so the only
// way to make the two exports show the same figure is to round the VALUE at
// write time for that one column type.

test("an hours-typed cell rounds to a whole number in CSV", () => {
  assert.equal(csvCell(23.6, "hours"), "24");
  assert.equal(csvCell(23.4, "hours"), "23");
  assert.equal(csvCell(-2.6, "hours"), "-3");
});

test("a non-hours numeric cell is untouched by the hours rounding rule", () => {
  assert.equal(csvCell(1234567.5), "1234567.5", "no type given: full precision, unchanged");
  assert.equal(csvCell(1234567.5, "currency"), "1234567.5", "currency must not be rounded like hours");
  assert.equal(csvCell(1234567.5, "number"), "1234567.5");
});

test("csvRow rounds only the columns whose type is hours, positionally", () => {
  const row = csvRow(["Job 1148", 23.6, 47192.5], ["text", "hours", "currency"]);
  assert.equal(row, "Job 1148,24,47192.5");
});

test("a full Hours-shaped sheet exports whole-number hours in both rows and totals", () => {
  const spec: SheetSpec = {
    sheetName: "Hours",
    title: "Hours",
    subtitle: [],
    columns: [
      { header: "Employee", type: "text" },
      { header: "Hours", type: "hours" },
    ],
    rows: [
      ["Jake Wiegand", 27.4],
      ["Paul Vinci", 5.6],
    ],
    totals: ["TOTAL", 33],
  };
  // No subtitle lines in this spec: title, blank, header, two rows, totals.
  const lines = buildCsv(spec).replace("﻿", "").trim().split("\r\n");
  assert.equal(lines[2], "Employee,Hours");
  assert.equal(lines[3], "Jake Wiegand,27");
  assert.equal(lines[4], "Paul Vinci,6");
  assert.equal(lines[5], "TOTAL,33");
});

test("the file is BOM-prefixed and CRLF-delimited, with the totals row last", () => {
  const spec: SheetSpec = {
    sheetName: "Projects",
    title: "Projects",
    subtitle: ["Filters: status Active"],
    columns: [
      { header: "Job Id", type: "text" },
      { header: "Quoted", group: "ME Gen", type: "hours" },
    ],
    rows: [["1101", 40], ["1102", null]],
    totals: ["TOTAL (2 projects)", 40],
  };
  const csv = buildCsv(spec);
  assert.ok(csv.startsWith("﻿"), "Excel needs the BOM to read UTF-8");
  assert.ok(csv.includes("\r\n"), "CRLF, as Excel writes them itself");
  const lines = csv.replace("﻿", "").trim().split("\r\n");
  // title, subtitle, blank, header, two rows, totals
  assert.equal(lines[0], "Projects");
  assert.equal(lines[3], "Job Id,ME Gen - Quoted", "the group is flattened into the header");
  assert.equal(lines[5], "1102,", "a blank stays blank");
  // No quoting: the label has no comma in it, and over-quoting would be just as wrong
  // as under-quoting for a reader diffing two exports.
  assert.equal(lines[6], "TOTAL (2 projects),40");
});

// ── Flattened ETC headers (§24.6) ───────────────────────────────────────────

test("every ETC column is addressable in a flat CSV header", () => {
  const spec: SheetSpec = {
    sheetName: "x",
    title: "x",
    subtitle: [],
    columns: [
      { header: "Prior ETC", group: "ME Gen (Engineering)", type: "hours" },
      { header: "New ETC", group: "ME Gen (Engineering)", type: "hours" },
      { header: "Prior ETC", group: "Design & Drawings (Engineering)", type: "hours" },
    ],
    rows: [],
  };
  // title, blank, header — this spec has no subtitle lines.
  const header = buildCsv(spec).split("\r\n")[2];
  assert.equal(header, "ME Gen (Engineering) - Prior ETC,ME Gen (Engineering) - New ETC,Design & Drawings (Engineering) - Prior ETC");
});

// ── File names (§24.10) ─────────────────────────────────────────────────────

test("file names are readable and filesystem-safe", () => {
  assert.equal(exportFileName(["Projects", "Active_Billable", "2026-08-04"], "xlsx"), "Projects_Active_Billable_2026-08-04.xlsx");
  assert.equal(exportFileName(["Monthly_ETC", "August_2026", "2026-08-04"], "csv"), "Monthly_ETC_August_2026_2026-08-04.csv");
});

test("characters a filesystem or a header would argue about are removed", () => {
  const name = exportFileName(["Projects", 'Belcan/GE "NASA": Phase 2', "2026-08-04"], "xlsx");
  assert.doesNotMatch(name, /["/\\:*?<>|]/);
  assert.ok(name.endsWith(".xlsx"));
  // Never empty, whatever it is handed.
  assert.equal(exportFileName([undefined, "", null], "csv"), "export.csv");
});

test("worksheet names respect Excel's own limits", () => {
  // Excel refuses > 31 chars and the characters below, and fails to OPEN the file rather
  // than complaining politely.
  assert.equal(safeSheetName("Monthly ETC - August 2026"), "Monthly ETC - August 2026");
  assert.equal(safeSheetName("A/B:C*D?E[F]G"), "A-B-C-D-E-F-G");
  assert.equal(safeSheetName("x".repeat(40)).length, 31);
  assert.equal(safeSheetName(""), "Sheet1");
});

test("the date stamp is the day, in ISO", () => {
  assert.equal(todayStamp(new Date("2026-08-04T23:30:00.000Z")), "2026-08-04");
});

// ── The export must match the VIEW (§24.2) ──────────────────────────────────
//
// buildProjectsQuery is the single rule the page and the export both use. These assert
// the three defaults that would silently change what a file contains.

const options = { allStatuses: ["Active", "HeadStart", "Complete"], allCustomers: ["Belcan", "GE"] };

test("no filters means the page's DEFAULT view, not everything", () => {
  const q = buildProjectsQuery({}, options);
  // Active/HeadStart and billable only — what the grid opens on. An export that quietly
  // included every Complete job would not be the table the manager was looking at.
  assert.deepEqual(q.where.status, { in: ["Active", "HeadStart"] });
  assert.equal((q.where as { billable?: boolean }).billable, true);
  assert.equal(q.filterLabel, "Active_Billable");
});

test("an explicit EMPTY filter selects nothing, and is not treated as absent", () => {
  const q = buildProjectsQuery({ statuses: "" }, options);
  assert.deepEqual(q.where.status, { in: [] });
});

test("an unset Customer filter must not become an `in` clause", () => {
  // Prisma's `in` never matches NULL, so filtering on all customers would permanently
  // hide every job with no Customer — including one just added on the page.
  assert.equal("customer" in buildProjectsQuery({}, options).where, false);
  assert.deepEqual(buildProjectsQuery({ customers: "Belcan" }, options).where.customer, { in: ["Belcan"] });
});

test("both billable boxes ticked is no filter; neither matches nothing", () => {
  const both = buildProjectsQuery({ billables: "Billable,Non-Billable" }, options).where;
  assert.equal("billable" in both, false);
  const neither = buildProjectsQuery({ billables: "" }, options).where as { id?: number };
  assert.equal(neither.id, -1, "an impossible id is how 'show nothing' is expressed");
});

test("a mistyped date bound is dropped, not passed to the database", () => {
  // An Invalid Date reaching Prisma throws and takes the request down; a bad bound must
  // narrow less rather than 500.
  assert.equal("startDate" in buildProjectsQuery({ from: "not-a-date" }, options).where, false);
  const ok = buildProjectsQuery({ from: "2026-07-01", to: "2026-07-31" }, options).where as {
    startDate?: { gte?: Date; lte?: Date };
  };
  assert.ok(ok.startDate?.gte instanceof Date);
  // `to` covers the whole day it names.
  assert.equal(ok.startDate?.lte?.toISOString(), "2026-07-31T23:59:59.999Z");
});

test("the date filter follows the chosen column", () => {
  const q = buildProjectsQuery({ dateField: "complete", from: "2026-07-01" }, options).where;
  assert.ok("completeDate" in q);
  assert.equal("startDate" in q, false);
});

test("sorting is validated against the known keys", () => {
  assert.equal(buildProjectsQuery({ sort: "jobId", dir: "desc" }, options).sortDir, "desc");
  // An unknown key falls back rather than reaching orderBy as a column that does not
  // exist (which Prisma rejects at runtime).
  assert.equal(buildProjectsQuery({ sort: "; DROP TABLE" }, options).sortKey, "jobId");
});

test("the Parts Cost Actual export column states its basis", () => {
  // docs/PARTS-COST-VARIANCE-2026-09.md exists because a column called "Parts Cost
  // Actual" in this export was compared against a column called the same thing in a
  // spreadsheet, on a different basis — GL-posted here, everything-billed there — and
  // neither said which. The difference read as an app error for weeks.
  //
  // The filename already carries todayStamp(now), so the as-of half is answered. This
  // is the other half: a comparison is either like-for-like or visibly not.
  const src = readFileSync(join(process.cwd(), "src", "lib", "export", "projects-export.ts"), "utf8");
  assert.match(src, /\{ header: "Parts Cost Actual \(GL-posted\)", type: "currency" \}/);
  assert.ok(
    !/\{ header: "Parts Cost Actual", type: "currency" \}/.test(src),
    "the unqualified header must be gone — it is the one that was ambiguous",
  );
});
