// Three-way reconciliation for §42: Lisa's OneDrive workbook vs the Power BI feed
// the app currently reads vs what is actually stored in MySQL.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/_recon_workbook_vs_pbi_vs_db.ts
//
// Writes NOTHING. Read-only on all three sources.
//
// The question it answers: when Lisa drops a new Current_Job_Hours.xlsx, how far
// behind is each downstream stage? If the workbook carries work dates the Power BI
// feed does not, the app cannot possibly show them however often Refresh Data is
// clicked — which is the reported §42 failure.
import "dotenv/config";
import ExcelJS from "exceljs";
import { statSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { mapPunchToColumns } from "@/lib/sections";
import { buildColumnResolver, fetchJobHoursRowsWithIssues, normalizePbiJobId } from "@/lib/job-hours-source";

const WORKBOOK =
  "C:\\Users\\akamuju\\OneDrive - Steven Douglas Corp\\SDC- Power BI Integration - Job Hours Report\\Job Hours From Paylocity\\Current_Job_Hours.xlsx";

const MONTHS = ["2026-06", "2026-07", "2026-08"];

type Agg = Map<string, number>; // "job::section" -> hours

function add(m: Agg, k: string, h: number) {
  m.set(k, (m.get(k) ?? 0) + h);
}

function sum(m: Agg): number {
  let t = 0;
  for (const v of m.values()) t += v;
  return t;
}

function monthOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function readWorkbook(resolve: (s: string) => string | null) {
  const st = statSync(WORKBOOK);
  const buf = readFileSync(WORKBOOK);
  const sha = createHash("sha256").update(buf).digest("hex");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.getWorksheet("Report");
  if (!ws) throw new Error("no 'Report' sheet");

  const byMonth = new Map<string, Agg>();
  let maxDate: Date | null = null;
  let rowsRead = 0;
  let noJob = 0;
  let noJobHours = 0;
  let unmapped = 0;
  let unmappedHours = 0;

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const empId = String(row.getCell(1).value ?? "").trim();
    const dv = row.getCell(2).value;
    const rawJob = String(row.getCell(3).value ?? "").trim();
    const machineSec = String(row.getCell(5).value ?? "").trim();
    const fn = String(row.getCell(6).value ?? "").trim();
    const hours = Number(row.getCell(7).value ?? 0);
    void empId;

    const d = dv instanceof Date ? dv : typeof dv === "string" ? new Date(dv) : null;
    if (!d || Number.isNaN(d.getTime())) continue;
    if (!hours) continue;
    rowsRead++;
    if (!maxDate || d > maxDate) maxDate = d;

    const month = monthOf(d);
    if (!byMonth.has(month)) byMonth.set(month, new Map());
    const agg = byMonth.get(month)!;

    const rawSection = `${machineSec}-${fn}`;
    const jobNum = Number(rawJob);
    if (rawJob === "" || !Number.isFinite(jobNum)) {
      noJob++;
      noJobHours += hours;
      continue;
    }
    const jobId = normalizePbiJobId(rawJob);
    const cols = mapPunchToColumns(rawSection, hours, resolve);
    if (cols.length === 0) {
      unmapped++;
      unmappedHours += hours;
      continue;
    }
    for (const c of cols) add(agg, `${jobId}::${c.section}`, c.hours);
  }

  return {
    size: st.size,
    mtime: st.mtime,
    sha,
    byMonth,
    maxDate,
    rowsRead,
    noJob,
    noJobHours,
    unmapped,
    unmappedHours,
  };
}

async function main() {
  console.log("Resolving the model's code->column map…");
  let resolve: (s: string) => string | null = () => null;
  try {
    resolve = (await buildColumnResolver()).resolve;
    console.log("  ok (Function Hierarchy)");
  } catch (e) {
    console.log("  FAILED, falling back to SECTION_ALIASES:", (e as Error).message);
  }

  console.log("\nReading the workbook…");
  const file = await readWorkbook(resolve);
  console.log(`  ${WORKBOOK.split("\\").pop()}  ${file.size} bytes  mtime ${file.mtime.toISOString()}`);
  console.log(`  sha256 ${file.sha}`);
  console.log(`  ${file.rowsRead} rows with hours, latest work date ${file.maxDate?.toISOString().slice(0, 10)}`);
  console.log(`  ${file.noJob} rows (${file.noJobHours.toFixed(2)}h) have no valid job number`);
  console.log(`  ${file.unmapped} rows (${file.unmappedHours.toFixed(2)}h) map to no app column`);

  console.log("\nReading the Power BI feed (per month)…");
  const pbiByMonth = new Map<string, Agg>();
  let pbiMax: Date | null = null;
  for (const m of MONTHS) {
    const { rows } = await fetchJobHoursRowsWithIssues({ onlyMonth: m });
    const agg: Agg = new Map();
    for (const r of rows) {
      add(agg, `${r.jobId}::${r.section}`, r.hours);
      if (!pbiMax || r.date > pbiMax) pbiMax = r.date;
    }
    pbiByMonth.set(m, agg);
    console.log(`  ${m}: ${rows.length} rows, ${sum(agg).toFixed(2)}h`);
  }
  console.log(`  latest work date in Power BI: ${pbiMax?.toISOString().slice(0, 10) ?? "none"}`);

  console.log("\nReading the database…");
  const dbByMonth = new Map<string, Agg>();
  for (const m of MONTHS) {
    const rows = await prisma.jobHoursDetail.findMany({
      where: { month: m },
      select: { jobId: true, section: true, hours: true, workDate: true },
    });
    // jobHoursDetail.jobId is the app's Job PK, not the job NUMBER — resolve it.
    // Job.jobId IS the job number ("1101"); Job.id is the surrogate key.
    const jobs = await prisma.job.findMany({ select: { id: true, jobId: true } });
    const numById = new Map(jobs.map((j) => [j.id, j.jobId]));
    const agg: Agg = new Map();
    let maxD: Date | null = null;
    for (const r of rows) {
      add(agg, `${numById.get(r.jobId) ?? r.jobId}::${r.section}`, Number(r.hours));
      if (!maxD || r.workDate > maxD) maxD = r.workDate;
    }
    dbByMonth.set(m, agg);
    console.log(`  ${m}: ${rows.length} punch rows, ${sum(agg).toFixed(2)}h, latest work date ${maxD?.toISOString().slice(0, 10) ?? "none"}`);
  }

  console.log("\n" + "=".repeat(78));
  console.log("TOTALS BY MONTH   (workbook / Power BI / database)");
  console.log("=".repeat(78));
  for (const m of MONTHS) {
    const f = sum(file.byMonth.get(m) ?? new Map());
    const p = sum(pbiByMonth.get(m) ?? new Map());
    const d = sum(dbByMonth.get(m) ?? new Map());
    const flag = Math.abs(f - p) > 0.5 || Math.abs(p - d) > 0.5 ? "  <-- MISMATCH" : "";
    console.log(
      `${m}   file ${f.toFixed(2).padStart(10)}h   pbi ${p.toFixed(2).padStart(10)}h   db ${d.toFixed(2).padStart(10)}h   ` +
        `file-pbi ${(f - p).toFixed(2).padStart(9)}   pbi-db ${(p - d).toFixed(2).padStart(9)}${flag}`,
    );
  }

  console.log("\n" + "=".repeat(78));
  console.log("LARGEST job x section GAPS  (file - powerbi)");
  console.log("=".repeat(78));
  for (const m of MONTHS) {
    const f = file.byMonth.get(m) ?? new Map();
    const p = pbiByMonth.get(m) ?? new Map();
    const keys = new Set([...f.keys(), ...p.keys()]);
    const diffs: { k: string; f: number; p: number; d: number }[] = [];
    for (const k of keys) {
      const fv = f.get(k) ?? 0;
      const pv = p.get(k) ?? 0;
      if (Math.abs(fv - pv) > 0.005) diffs.push({ k, f: fv, p: pv, d: fv - pv });
    }
    diffs.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    console.log(`\n${m}: ${diffs.length} differing job x section cells`);
    for (const x of diffs.slice(0, 12)) {
      console.log(`   ${x.k.padEnd(22)} file ${x.f.toFixed(2).padStart(9)}  pbi ${x.p.toFixed(2).padStart(9)}  diff ${x.d.toFixed(2).padStart(9)}`);
    }
  }

  console.log("\n" + "=".repeat(78));
  console.log("UNDEFINED HOURS: stored HoursImportIssue vs live recompute");
  console.log("=".repeat(78));
  for (const m of MONTHS) {
    const stored = await prisma.hoursImportIssue.findMany({ where: { month: m } });
    const storedTotal = stored.reduce((s, i) => s + Number(i.hours), 0);
    const { issues } = await fetchJobHoursRowsWithIssues({ onlyMonth: m });
    const liveTotal = issues.reduce((s, i) => s + i.hours, 0);
    const flag = Math.abs(storedTotal - liveTotal) > 0.005 ? "  <-- KPI/DRILL MISMATCH" : "";
    console.log(
      `${m}   stored(KPI) ${storedTotal.toFixed(2).padStart(9)}h (${stored.length} labels)   ` +
        `live(drill) ${liveTotal.toFixed(2).padStart(9)}h (${issues.length} labels)${flag}`,
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
