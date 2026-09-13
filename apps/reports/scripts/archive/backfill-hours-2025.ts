// One-off backfill for the Hours tab's 2025 coverage — see the "New Hours Tab" plan
// (2026-08-08). `Job_Hours_2025.xlsx` sits in the same OneDrive folder as
// Current_Job_Hours.xlsx, has the IDENTICAL "Report" sheet/headers, and is read with the
// exact same reader (readPaylocityWorkbook) — no new parsing code exists anywhere in
// this script.
//
// Default run is a REPORT ONLY — no writes. It prints, per month, the file's total
// against what JobHoursDetail already holds (Power-BI-sourced today for 2025), plus the
// entirely new 2025-01 coverage the app has never had. This app's own precedent
// (docs/PAYLOCITY-INGESTION.md) is to prove reconciliation before flipping a source, not
// to silently rewrite settled history, so replacing already-shown months is a second,
// separate, explicit choice:
//
//   npx tsx scripts/backfill-hours-2025.ts                     # report only
//   npx tsx scripts/backfill-hours-2025.ts --write              # writes 2025-01 only (pure addition)
//   npx tsx scripts/backfill-hours-2025.ts --write --overwrite-existing   # also replaces 2025-02..boundary
//
// The dedup boundary is Current_Job_Hours.xlsx's own earliest work date, computed fresh
// each run (not hardcoded) — Job_Hours_2025.xlsx rows on/after that date are DROPPED, so
// the current file always wins for any date it covers, per the ticket's own instruction.
import "dotenv/config";
import path from "path";
import { readPaylocityWorkbook, workbookPath, type WorkbookHoursRow } from "@/lib/paylocity-workbook";
import { buildColumnResolver } from "@/lib/job-hours-source";
import { syncJobHoursDetail } from "@/lib/sync-actuals";
import { prisma } from "@/lib/prisma";
import { logAuditFor } from "@/lib/audit";

const HIST_FILE_NAME = "Job_Hours_2025.xlsx";
const SOURCE_TAG = "paylocity_2025_export";

function monthOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function sumByMonth(rows: WorkbookHoursRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.year}-${String(r.month).padStart(2, "0")}`;
    out.set(key, (out.get(key) ?? 0) + r.hours);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write") || args.includes("--overwrite-existing");
  const overwriteExisting = args.includes("--overwrite-existing");

  const [resolveBuilt, currentFile] = await Promise.all([
    buildColumnResolver().catch((err) => {
      console.warn("[backfill-hours-2025] Function Hierarchy unavailable, falling back to SECTION_ALIASES:", err);
      return null;
    }),
    readPaylocityWorkbook({ path: workbookPath() }),
  ]);
  const resolve = resolveBuilt?.resolve;

  const knownJobs = await prisma.job.findMany({ select: { jobId: true } });
  const knownJobNumbers = new Set(knownJobs.map((j) => j.jobId));

  const histPath = path.join(path.dirname(workbookPath()), HIST_FILE_NAME);
  const hist = await readPaylocityWorkbook({ path: histPath, resolve, knownJobNumbers });

  const boundary = currentFile.firstWorkDate;
  if (!boundary) throw new Error("Current_Job_Hours.xlsx carried no valid work date — cannot compute the dedup boundary.");

  const keptRows = hist.rows.filter((r) => r.date < boundary);
  const droppedRows = hist.rows.length - keptRows.length;

  console.log(`Current_Job_Hours.xlsx earliest date (dedup boundary): ${boundary.toISOString().slice(0, 10)}`);
  console.log(`${HIST_FILE_NAME}: ${hist.rows.length.toLocaleString()} resolved rows, ${hist.rejected.length.toLocaleString()} rejected`);
  console.log(`  ${keptRows.length.toLocaleString()} rows before the boundary kept, ${droppedRows.toLocaleString()} on/after it dropped (superseded by the current file)\n`);

  const fileTotalsByMonth = sumByMonth(keptRows);
  const monthsInFile = [...fileTotalsByMonth.keys()].sort();

  const dbTotals = await prisma.jobHoursDetail.groupBy({ by: ["month"], where: { month: { in: monthsInFile } }, _sum: { hours: true } });
  const dbTotalsByMonth = new Map(dbTotals.map((r) => [r.month, Number(r._sum.hours ?? 0)]));

  console.log("month     | file hours | db hours (today) | delta    | status");
  console.log("----------|-----------:|------------------:|---------:|-------");
  const newMonths: string[] = [];
  const existingMonths: string[] = [];
  for (const month of monthsInFile) {
    const fileHours = fileTotalsByMonth.get(month) ?? 0;
    const dbHasMonth = dbTotalsByMonth.has(month);
    const dbHours = dbTotalsByMonth.get(month) ?? 0;
    const delta = fileHours - dbHours;
    const status = !dbHasMonth ? "NEW coverage" : Math.abs(delta) < 0.05 ? "matches" : "DIFFERS";
    if (!dbHasMonth) newMonths.push(month);
    else existingMonths.push(month);
    console.log(
      `${month}  | ${fileHours.toFixed(2).padStart(10)} | ${(dbHasMonth ? dbHours.toFixed(2) : "—").padStart(18)} | ${(dbHasMonth ? delta.toFixed(2) : "—").padStart(8)} | ${status}`,
    );
  }

  console.log(`\nNew coverage (not in the DB at all today): ${newMonths.join(", ") || "(none)"}`);
  console.log(`Already covered (currently Power-BI-sourced): ${existingMonths.join(", ") || "(none)"}`);

  if (!write) {
    console.log("\nReport only — no writes. Re-run with --write to add the NEW months, or --write --overwrite-existing to also replace the already-covered ones.");
    await prisma.$disconnect();
    return;
  }

  const monthsToWrite = overwriteExisting ? monthsInFile : newMonths;
  if (monthsToWrite.length === 0) {
    console.log("\nNothing to write — no new months, and --overwrite-existing was not passed.");
    await prisma.$disconnect();
    return;
  }

  const writeRows = keptRows.filter((r) => monthsToWrite.includes(monthOf(r.date)));
  const jobPkRows = await prisma.job.findMany({ where: { jobId: { in: [...new Set(writeRows.map((r) => r.jobId))] } }, select: { id: true, jobId: true } });
  const jobByJobId = new Map(jobPkRows.map((j) => [j.jobId, j]));

  const written = await syncJobHoursDetail(writeRows, jobByJobId, SOURCE_TAG);
  console.log(`\nWrote ${written.toLocaleString()} JobHoursDetail rows across ${monthsToWrite.join(", ")} (source="${SOURCE_TAG}").`);

  await logAuditFor(null, "backfill-hours-2025-script", {
    action: "hours.backfill2025",
    entityType: "JobHoursDetail",
    summary: `Backfilled ${monthsToWrite.join(", ")} from ${HIST_FILE_NAME} (${written} rows, overwriteExisting=${overwriteExisting})`,
    metadata: { monthsToWrite, written, overwriteExisting, boundary: boundary.toISOString().slice(0, 10) },
  });

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
