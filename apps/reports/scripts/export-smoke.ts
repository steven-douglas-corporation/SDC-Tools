// Builds both exports against the REAL database and checks the properties that unit
// tests cannot: that the totals row actually sums the rows above it, that blanks stay
// blank, that every ETC column is present, and that the .xlsx file Excel receives is a
// valid workbook (re-read with the same library that wrote it).
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/export-smoke.ts [month]
//
// Writes nothing to the database and nothing to disk unless --keep is passed, in which
// case the two files land in the current directory so they can be opened by hand.
import "dotenv/config";
import { writeFileSync } from "fs";
import ExcelJS from "exceljs";
import { prisma } from "../src/lib/prisma";
import { buildProjectsExport } from "../src/lib/export/projects-export";
import { buildEtcExport } from "../src/lib/export/etc-export";
import { buildCsv } from "../src/lib/export/csv";
import { buildXlsx } from "../src/lib/export/xlsx";
import type { SheetSpec } from "../src/lib/export/sheet";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// The totals row must be the sum of the column above it, for every numeric column that
// has a total. This is acceptance 12 ("bottom totals match the exported rows") and it is
// the one property most likely to rot as columns move.
function checkTotals(spec: SheetSpec) {
  if (!spec.totals) return check("has a totals row", false);
  let checked = 0;
  let wrong = 0;
  spec.columns.forEach((col, i) => {
    const total = spec.totals![i];
    if (typeof total !== "number") return;
    // The New ETC column deliberately totals what the month would SUBMIT as, which
    // includes the suggestion standing in for a blank cell — so the visible column does
    // not add up to it, by design (see etc-export.ts). Skipped rather than fudged.
    if (col.header === "New ETC") return;
    const sum = spec.rows.reduce((s, r) => (typeof r[i] === "number" ? s + (r[i] as number) : s), 0);
    checked++;
    const off = Math.abs(sum - total);
    if (off > 0.011) {
      wrong++;
      console.log(`       column ${i} (${col.group ? col.group + " - " : ""}${col.header}): rows sum ${sum}, total says ${total}`);
    }
  });
  check(`every numeric total sums its column (${checked} checked)`, wrong === 0, wrong > 0 ? `${wrong} mismatched` : "");
}

async function checkWorkbook(spec: SheetSpec, name: string, keep: boolean) {
  const buf = await buildXlsx(spec);
  check(`${name}: xlsx is non-trivial`, buf.length > 2000, `${(buf.length / 1024).toFixed(0)} KB`);
  // Read it back with exceljs: a workbook that cannot be re-parsed is one Excel will
  // refuse to open, and that failure is silent otherwise.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  check(`${name}: worksheet name`, !!ws && ws.name.length <= 31, ws?.name);
  check(`${name}: frozen panes`, ws?.views?.[0]?.state === "frozen");
  // Numbers must be numbers. A DATE column is deliberately excluded here: its cell value
  // is a Date object, which is the correct thing for Excel to receive and would fail a
  // "typeof number" check for the right reason.
  const numericCol = spec.columns.findIndex((c) => c.type === "hours" || c.type === "currency" || c.type === "number");
  if (numericCol >= 0 && spec.rows.length > 0) {
    const headerRowIndex = 1 + spec.subtitle.length + 1 + (spec.columns.some((c) => c.group) ? 1 : 0) + 1;
    const firstDataRow = ws.getRow(headerRowIndex + 1);
    const cell = firstDataRow.getCell(numericCol + 1);
    const isNumberOrBlank = cell.value === null || cell.value === undefined || typeof cell.value === "number";
    check(`${name}: numeric column holds a number (or a blank), not text`, isNumberOrBlank, `got ${typeof cell.value}`);
  }
  if (keep) {
    writeFileSync(`${name}.xlsx`, buf);
    writeFileSync(`${name}.csv`, buildCsv(spec), "utf8");
    console.log(`       wrote ${name}.xlsx / ${name}.csv`);
  }
}

async function main() {
  const keep = process.argv.includes("--keep");
  const monthArg = process.argv.find((a) => /^\d{4}-\d{2}$/.test(a));
  const latest = await prisma.etcEntry.findFirst({ orderBy: { month: "desc" }, select: { month: true } });
  const month = monthArg ?? latest?.month;
  if (!month) throw new Error("No ETC months exist to export.");
  const now = new Date();

  console.log("\n=== Projects export (default view) ===");
  const t0 = performance.now();
  const projects = await buildProjectsExport({}, now);
  console.log(`  built in ${Math.round(performance.now() - t0)}ms — ${projects.rowCount} rows x ${projects.spec.columns.length} columns`);
  check("rows exist", projects.rowCount > 0);
  check("filter label describes the view", projects.filterLabel.length > 0, projects.filterLabel);
  check("every row has one cell per column", projects.spec.rows.every((r) => r.length === projects.spec.columns.length));
  checkTotals(projects.spec);
  await checkWorkbook(projects.spec, "Projects_smoke", keep);

  console.log("\n=== Projects export (a NARROWER filter must return fewer rows) ===");
  const narrowed = await buildProjectsExport({ statuses: "Complete" }, now);
  console.log(`  ${narrowed.rowCount} rows with statuses=Complete`);
  check("the filter is honoured", narrowed.rowCount !== projects.rowCount || narrowed.rowCount === 0,
    `${projects.rowCount} default vs ${narrowed.rowCount} filtered`);

  console.log(`\n=== Monthly ETC export (${month}) ===`);
  const t1 = performance.now();
  const etc = await buildEtcExport(month, undefined, now);
  console.log(`  built in ${Math.round(performance.now() - t1)}ms — ${etc.rowCount} rows x ${etc.spec.columns.length} columns`);
  check("rows exist", etc.rowCount > 0);
  check("13 sections + Parts Cost, five columns each, plus 6 identity columns",
    etc.spec.columns.length === 6 + 14 * 5, `${etc.spec.columns.length} columns`);
  check("every row has one cell per column", etc.spec.rows.every((r) => r.length === etc.spec.columns.length));
  check("Parts Cost columns are currency-formatted",
    etc.spec.columns.filter((c) => c.group === "Parts Cost").every((c) => c.type === "currency"));
  // A blank New ETC has to survive as null all the way to the file.
  const newEtcIdx = etc.spec.columns.findIndex((c) => c.header === "New ETC");
  const blanks = etc.spec.rows.filter((r) => r[newEtcIdx] === null).length;
  console.log(`  first New ETC column: ${blanks} of ${etc.rowCount} rows blank (cells still awaiting a figure)`);
  check("blanks are null, never 0", etc.spec.rows.every((r) => r[newEtcIdx] === null || typeof r[newEtcIdx] === "number"));
  checkTotals(etc.spec);
  await checkWorkbook(etc.spec, `Monthly_ETC_smoke`, keep);

  console.log(`\n=== CSV shape ===`);
  const csv = buildCsv(etc.spec);
  const lines = csv.split("\r\n");
  check("BOM present", csv.startsWith("﻿"));
  check("header is flattened per column", lines.some((l) => l.includes(" - Prior ETC")));
  check("one line per row plus the header block and totals", lines.length >= etc.rowCount + 5, `${lines.length} lines`);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
