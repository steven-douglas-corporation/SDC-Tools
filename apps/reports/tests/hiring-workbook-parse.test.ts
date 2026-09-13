import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseHiringWorkbook, isOpenPosition, HiringWorkbookError, type HiringPositionSourceRow } from "../src/lib/hiring-workbook-parse";

const HEADERS = [
  "Job Created Date",
  "Job Title",
  "Job ID",
  "Job Status",
  "Job Sub Status",
  "Function Code",
  "Function Description",
  "Section # Code",
  "Section # Description",
  "Hiring Department",
  "Work Loc Description",
  "Archive Date",
  "Archived?",
  "Internal?",
  "Remote?",
  "Job Created by User First Name",
  "Job Created by User Last Name",
  "Job Modified by User First Name",
  "Job Modified by User Last Name",
];

function buildWorkbook(rows: Record<string, string>[]): Buffer {
  const aoa = [HEADERS, ...rows.map((r) => HEADERS.map((h) => r[h] ?? ""))];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Report");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function row(overrides: Partial<Record<(typeof HEADERS)[number], string>>): Record<string, string> {
  return { "Job ID": "1", "Job Title": "Test Position", "Job Status": "Published", ...overrides };
}

test("parses real columns into a HiringPositionSourceRow", () => {
  const buf = buildWorkbook([
    row({
      "Job ID": "4394790",
      "Job Title": "Electrical Controls Engineer",
      "Job Status": "Published",
      "Job Sub Status": "None",
      "Job Created Date": "08/05/2026",
      "Job Created by User First Name": "Ashley",
      "Job Created by User Last Name": "Cohen",
    }),
  ]);
  const rows = parseHiringWorkbook(buf);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { sourceId: rows[0].sourceId, title: rows[0].title, status: rows[0].status, createdBy: rows[0].createdBy },
    { sourceId: "4394790", title: "Electrical Controls Engineer", status: "Published", createdBy: "Ashley Cohen" },
  );
});

test("a row with no Job ID is skipped — there is no stable identifier to track it by", () => {
  const buf = buildWorkbook([row({ "Job ID": "" }), row({ "Job ID": "2" })]);
  const rows = parseHiringWorkbook(buf);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceId, "2");
});

test("a duplicate Job ID is de-duplicated, keeping the first occurrence", () => {
  const buf = buildWorkbook([row({ "Job ID": "1", "Job Title": "First" }), row({ "Job ID": "1", "Job Title": "Second" })]);
  const rows = parseHiringWorkbook(buf);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "First");
});

test("missing required columns throws headers_missing rather than silently reading blanks", () => {
  const sheet = XLSX.utils.aoa_to_sheet([["Job Title"], ["Something"]]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Report");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  assert.throws(() => parseHiringWorkbook(buf), (err: unknown) => err instanceof HiringWorkbookError && err.stage === "headers_missing");
});

test("an empty sheet (headers only, no data rows) parses to zero rows without throwing", () => {
  const buf = buildWorkbook([]);
  assert.deepEqual(parseHiringWorkbook(buf), []);
});

function sourceRow(overrides: Partial<HiringPositionSourceRow>): HiringPositionSourceRow {
  return {
    sourceId: "1",
    title: "Test",
    status: "Published",
    subStatus: null,
    functionCode: null,
    functionDescription: null,
    sectionCode: null,
    sectionDescription: null,
    hiringDepartment: null,
    workLocDescription: null,
    createdDate: null,
    createdBy: null,
    modifiedBy: null,
    archived: false,
    archiveDate: null,
    remote: false,
    internal: false,
    ...overrides,
  };
}

test("isOpenPosition: a plain Published posting is open", () => {
  assert.equal(isOpenPosition(sourceRow({ status: "Published" })), true);
});

test("isOpenPosition: Archived? = Yes closes it regardless of Job Status text", () => {
  assert.equal(isOpenPosition(sourceRow({ status: "Published", archived: true })), false);
});

test("isOpenPosition: a populated Archive Date closes it even if Archived? somehow reads No", () => {
  assert.equal(isOpenPosition(sourceRow({ status: "Published", archived: false, archiveDate: "08/01/2026" })), false);
});

test("isOpenPosition: Job Status text naming Filled/Closed/Cancelled closes it even if not yet archived", () => {
  assert.equal(isOpenPosition(sourceRow({ status: "Filled" })), false);
  assert.equal(isOpenPosition(sourceRow({ status: "Closed" })), false);
  assert.equal(isOpenPosition(sourceRow({ status: "Published", subStatus: "Cancelled" })), false);
});
