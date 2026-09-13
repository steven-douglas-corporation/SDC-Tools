// Why don't the app's July hours match the Power BI report? (§43)
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/_recon_pbi_definitions.ts
//
// Reported: Power BI shows Engineering 3,020 / Shop 2,680 / Manufacturing 676 for
// 2026-07; the app's grid footer shows Engineering 3,154 / Shop 2,698.
//
// Three candidate causes, two of which are correct behaviour and one of which would be
// a bug. They must be separated before anything is changed:
//
//   1. FRESHNESS  — the workbook holds ~153h of July the model has not ingested.
//   2. DEFINITION — Power BI's [Engineering Hours] counts functions 211/311/312/313/
//                   515-518 in ANY phase, Warranty and Service included. The app's ENG
//                   total is a fixed 9-code formula that excludes Warranty entirely,
//                   signed off 2026-07-31 (see the note above SECTION_ALIASES).
//   3. JOB SCOPE  — the ETC grid lists Active + billable jobs only; the report is
//                   filtered to "Multiple selections".
//
// The workbook is parsed RAW here rather than through readPaylocityWorkbook, because
// that reader has already applied the app's own column mapping — and the app's mapping
// is the thing under test. Comparing a mapping against itself proves nothing.
import "dotenv/config";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { workbookPath, normalizeJobNumber } from "@/lib/paylocity-workbook";
import { mapPunchToColumns, ETC_TRACKED_CODES, ETC_SECTIONS } from "@/lib/sections";

const MONTH = "2026-07";
const REPORT = { engineering: 3020, shop: 2680, manufacturing: 676 };
const BILLING = new Map(ETC_SECTIONS.map((s) => [s.code, s.billingGroup]));
const r2 = (n: number) => Math.round(n * 100) / 100;

// Power BI's measure definitions, by FUNCTION and regardless of phase — probed measure
// by measure on 2026-07-31 and recorded above SECTION_ALIASES in sections.ts.
const PBI_ENG = new Set(["211", "311", "312", "313", "515", "516", "517", "518"]);
const PBI_SHOP = new Set(["411", "412"]);

type Row = { jobId: string; phase: string; fn: string; hours: number; date: Date; employeeId: string };

async function readRaw(): Promise<Row[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(workbookPath());
  const ws = wb.worksheets[0];
  const header = new Map<string, number>();
  ws.getRow(1).eachCell((c, i) => header.set(String(c.value ?? "").trim(), i));
  const col = (n: string) => {
    const i = header.get(n);
    if (!i) throw new Error(`missing column ${n} (have: ${[...header.keys()].join(", ")})`);
    return i;
  };
  const [cJob, cSec, cFn, cHrs, cDate, cEmp] = [
    col("Jobs"), col("MachineSec"), col("Function"), col("Total Hours Worked"), col("Work Date"), col("Employee Id"),
  ];
  const out: Row[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const hours = Number(row.getCell(cHrs).value ?? 0);
    if (!hours) return;
    const raw = row.getCell(cDate).value;
    const date = raw instanceof Date ? raw : new Date(String(raw));
    if (Number.isNaN(date.getTime())) return;
    out.push({
      jobId: normalizeJobNumber(String(row.getCell(cJob).value ?? "")),
      phase: String(row.getCell(cSec).value ?? "").trim(),
      fn: String(row.getCell(cFn).value ?? "").trim(),
      hours,
      date,
      employeeId: String(row.getCell(cEmp).value ?? "").trim(),
    });
  });
  return out;
}

function ym(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function main() {
  const raw = (await readRaw()).filter((r) => ym(r.date) === MONTH);
  console.log(`\n  ${raw.length} workbook punch rows with hours in ${MONTH}\n`);

  // TWO keyings, because the two sides of this comparison are keyed differently and
  // getting it wrong reports a clean 0.00 rather than an error:
  //   * the workbook carries the job NUMBER ("1079")            -> Job.jobId
  //   * JobHoursDetail.jobId references the SURROGATE PK        -> Job.id
  const jobs = await prisma.job.findMany({ select: { id: true, jobId: true, status: true, billable: true } });
  const active = jobs.filter((j) => j.status === "Active" && j.billable);
  const gridJobs = new Set(active.map((j) => j.jobId));      // by job number
  const gridJobPks = new Set(active.map((j) => j.id));       // by surrogate id
  const knownJobs = new Set(jobs.map((j) => j.jobId));

  // ── Power BI's definition, three scopes ───────────────────────────────────
  const pbi = { all: { e: 0, s: 0, m: 0 }, known: { e: 0, s: 0, m: 0 }, grid: { e: 0, s: 0, m: 0 } };
  const engByPhase: Record<string, number> = {};
  const shopByPhase: Record<string, number> = {};

  for (const r of raw) {
    const bucket = PBI_ENG.has(r.fn) ? "e" : PBI_SHOP.has(r.fn) ? "s" : r.fn === "414" ? "m" : null;
    if (!bucket) continue;
    pbi.all[bucket] += r.hours;
    if (knownJobs.has(r.jobId)) pbi.known[bucket] += r.hours;
    if (gridJobs.has(r.jobId)) {
      pbi.grid[bucket] += r.hours;
      if (bucket === "e") engByPhase[r.phase] = (engByPhase[r.phase] ?? 0) + r.hours;
      if (bucket === "s") shopByPhase[r.phase] = (shopByPhase[r.phase] ?? 0) + r.hours;
    }
  }

  // ── The app's definition, from the same rows ──────────────────────────────
  const app = { e: 0, s: 0, mfg: 0 };
  for (const r of raw) {
    if (!gridJobs.has(r.jobId)) continue;
    for (const c of mapPunchToColumns(`${r.phase}-${r.fn}`, r.hours)) {
      if (c.section === "10-413") { app.mfg += c.hours; continue; }
      if (!ETC_TRACKED_CODES.has(c.section)) continue;
      if (BILLING.get(c.section) === "Engineering") app.e += c.hours;
      else app.s += c.hours;
    }
  }

  // ── What the database holds right now (what the grid footer sums) ─────────
  const stored = await prisma.jobHoursDetail.findMany({ where: { month: MONTH }, select: { jobId: true, section: true, hours: true } });
  const db = { e: 0, s: 0 };
  for (const s of stored) {
    if (!ETC_TRACKED_CODES.has(s.section) || !gridJobPks.has(Number(s.jobId))) continue;
    if (BILLING.get(s.section) === "Engineering") db.e += Number(s.hours);
    else db.s += Number(s.hours);
  }

  const show = (label: string, e: number, s: number, m?: number) =>
    console.log(`  ${label.padEnd(44)}${r2(e).toFixed(2).padStart(10)}${r2(s).toFixed(2).padStart(10)}${m === undefined ? "" : r2(m).toFixed(2).padStart(10)}`);

  console.log(`  ${"".padEnd(44)}${"ENG".padStart(10)}${"SHOP".padStart(10)}${"MFG".padStart(10)}`);
  show("POWER BI REPORT (as shown to me)", REPORT.engineering, REPORT.shop, REPORT.manufacturing);
  console.log();
  console.log("  ── PBI's definition applied to the workbook ──");
  show("all jobs", pbi.all.e, pbi.all.s, pbi.all.m);
  show("jobs the app knows", pbi.known.e, pbi.known.s, pbi.known.m);
  show("Active + billable (the grid's jobs)", pbi.grid.e, pbi.grid.s, pbi.grid.m);
  console.log();
  console.log("  ── The app's definition, same rows, grid jobs ──");
  show("workbook via mapPunchToColumns", app.e, app.s, app.mfg);
  show("stored in DB  <-- the grid footer", db.e, db.s);
  console.log();

  console.log("  ── Where PBI's Engineering sits, by phase (grid jobs) ──");
  for (const [p, h] of Object.entries(engByPhase).sort((a, b) => b[1] - a[1]))
    console.log(`     phase ${p.padEnd(4)} ${r2(h).toFixed(2).padStart(10)}h${ETC_TRACKED_CODES.has(`${p}-211`) ? "" : "   <-- app has no ENG column for this phase"}`);
  console.log("  ── ... and Shop ──");
  for (const [p, h] of Object.entries(shopByPhase).sort((a, b) => b[1] - a[1]))
    console.log(`     phase ${p.padEnd(4)} ${r2(h).toFixed(2).padStart(10)}h${ETC_TRACKED_CODES.has(`${p}-411`) ? "" : "   <-- app has no SHOP column for this phase"}`);

  console.log("\n  ── Reconciliation ──");
  console.log(`     app ENG  ${r2(db.e).toFixed(2)}  −  report ${REPORT.engineering}  =  ${r2(db.e - REPORT.engineering) > 0 ? "+" : ""}${r2(db.e - REPORT.engineering)}`);
  console.log(`     app SHOP ${r2(db.s).toFixed(2)}  −  report ${REPORT.shop}  =  ${r2(db.s - REPORT.shop) > 0 ? "+" : ""}${r2(db.s - REPORT.shop)}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
