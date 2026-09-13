// Drift check (and optional fix) for the /quoted "Projects" grid against the
// "Estimated Hours" tab of Project Planner Data Control.xlsx — the same
// source the app's Job/EstimatedHours models were originally migrated from.
//
// Compares, per job: Cost Quoted, Cost Actual Historical, and each of the 17
// section codes' Quoted / Actual Historical hours. `Estimate to Complete`
// hours are reported only, never fixed — that field live-syncs continuously
// from Power BI (see sync-actuals.ts), so a static Excel export is just a
// point-in-time snapshot of it, not a source of truth to force onto the DB.
//
// Respects the app's own manual-edit protections: quotedHoursManuallyEdited
// and costQuotedManuallyEdited mark a deliberate business correction a
// manager made on this page — those are reported but never overwritten,
// same as the live Power BI sync itself already refuses to touch them.
//
// Run with: npx tsx scripts/verify-quoted-hours.ts          (report only)
//           npx tsx scripts/verify-quoted-hours.ts --fix     (report + apply safe fixes)
import * as XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";
import { SECTIONS } from "../src/lib/sections";

const prisma = new PrismaClient();
const FIX = process.argv.includes("--fix");
const XLSX_PATH = "D:/AI Projects/sdc-etc-planner/Project Planner Data Control.xlsx";
const EPSILON = 0.01;

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON;
}

async function main() {
  const wb = XLSX.readFile(XLSX_PATH, { cellDates: true });
  const ws = wb.Sheets["Estimated Hours"];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][];

  const QUOTED_START = XLSX.utils.decode_col("J");
  const ACTUAL_HIST_START = XLSX.utils.decode_col("AB");
  const ESTIMATE_START = XLSX.utils.decode_col("AT");
  const COST_QUOTED_COL = XLSX.utils.decode_col("CJ");
  const COST_ACTUAL_COL = XLSX.utils.decode_col("CK");

  // Row 8 (index 7) is the header ("Job#", "Description", ...); data starts row 9 (index 8).
  const excelByJobId = new Map<string, unknown[]>();
  const excelDupeCounts = new Map<string, number>();
  for (let i = 8; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row[0] == null) continue;
    const id = String(row[0]).trim();
    excelDupeCounts.set(id, (excelDupeCounts.get(id) ?? 0) + 1);
    excelByJobId.set(id, row);
  }
  console.log(`Loaded ${excelByJobId.size} unique job rows from Excel.\n`);

  const dupes = [...excelDupeCounts.entries()].filter(([, c]) => c > 1);
  if (dupes.length > 0) {
    console.log(`!! Duplicate Job# in Excel (only the last row was checked for each): ${dupes.map(([id, c]) => `${id} (x${c})`).join(", ")}\n`);
  }

  const jobs = await prisma.job.findMany({ include: { estimatedHours: true } });

  // Reverse direction: an Excel row with no matching DB job means that job's
  // entire cost/hours data is simply missing from the app, not just drifted —
  // the per-job loop below only ever walks DB jobs, so it can never surface this.
  const dbJobIds = new Set(jobs.map((j) => j.jobId));
  const excelOnly = [...excelByJobId.keys()].filter((id) => !dbJobIds.has(id));
  if (excelOnly.length > 0) {
    console.log(`!! Excel job(s) with NO matching DB job — entirely missing from the app:`);
    for (const id of excelOnly) {
      const row = excelByJobId.get(id)!;
      console.log(`   Job# ${id} — "${row[1]}" (status: ${row[2]})`);
    }
    console.log();
  } else {
    console.log("Every Excel job row has a matching DB job.\n");
  }

  // Stray EstimatedHours rows using a section code outside the known 17 —
  // the per-section loop below only ever walks SECTIONS, so orphaned/legacy
  // codes would otherwise never be reported.
  const knownCodes = new Set(SECTIONS.map((s) => s.code));
  const strayCodes = new Set<string>();
  for (const job of jobs) {
    for (const eh of job.estimatedHours) {
      if (!knownCodes.has(eh.section)) strayCodes.add(eh.section);
    }
  }
  if (strayCodes.size > 0) {
    console.log(`!! EstimatedHours rows exist for section code(s) outside the known 17: ${[...strayCodes].join(", ")}\n`);
  }

  let costMismatches = 0;
  let costFixed = 0;
  let costSkippedManual = 0;
  let hoursMismatches = 0;
  let hoursFixed = 0;
  let hoursSkippedManual = 0;
  let estimateDrift = 0;
  let notInExcel = 0;

  for (const job of jobs) {
    const row = excelByJobId.get(job.jobId);
    if (!row) {
      notInExcel++;
      console.log(`? Job ${job.jobId} ("${job.jobName}") — not present in Excel (app-only entry, skipped)`);
      continue;
    }

    // --- Cost Quoted ---
    const excelCostQuoted = numOrNull(row[COST_QUOTED_COL]) ?? 0;
    const dbCostQuoted = job.costQuoted != null ? Number(job.costQuoted) : 0;
    if (!closeEnough(excelCostQuoted, dbCostQuoted)) {
      if (job.costQuotedManuallyEdited) {
        costSkippedManual++;
        console.log(`~ Job ${job.jobId} costQuoted: DB=${dbCostQuoted} Excel=${excelCostQuoted} — manually edited, left alone`);
      } else {
        costMismatches++;
        console.log(`✗ Job ${job.jobId} costQuoted: DB=${dbCostQuoted} -> Excel=${excelCostQuoted}`);
        if (FIX) {
          await prisma.job.update({ where: { id: job.id }, data: { costQuoted: excelCostQuoted } });
          costFixed++;
        }
      }
    }

    // --- Cost Actual Historical (frozen migration field — no manual-edit flag, always safe to correct) ---
    const excelCostActual = numOrNull(row[COST_ACTUAL_COL]) ?? 0;
    const dbCostActual = job.costActualHistorical != null ? Number(job.costActualHistorical) : 0;
    if (!closeEnough(excelCostActual, dbCostActual)) {
      costMismatches++;
      console.log(`✗ Job ${job.jobId} costActualHistorical: DB=${dbCostActual} -> Excel=${excelCostActual}`);
      if (FIX) {
        await prisma.job.update({ where: { id: job.id }, data: { costActualHistorical: excelCostActual } });
        costFixed++;
      }
    }

    // --- Per-section hours ---
    const hoursBySection = new Map(job.estimatedHours.map((eh) => [eh.section, eh]));
    for (let si = 0; si < SECTIONS.length; si++) {
      const code = SECTIONS[si].code;
      const eh = hoursBySection.get(code);
      const excelQuoted = numOrNull(row[QUOTED_START + si]) ?? 0;
      const excelActualHist = numOrNull(row[ACTUAL_HIST_START + si]) ?? 0;
      const excelEstimate = numOrNull(row[ESTIMATE_START + si]) ?? 0;
      const dbQuoted = eh ? Number(eh.quotedHours) : 0;
      const dbActualHist = eh ? Number(eh.actualHistoricalHours) : 0;
      const dbEstimate = eh ? Number(eh.estimateToCompleteHours) : 0;

      const quotedOff = !closeEnough(excelQuoted, dbQuoted);
      const actualOff = !closeEnough(excelActualHist, dbActualHist);
      if (quotedOff || actualOff) {
        if (quotedOff && eh?.quotedHoursManuallyEdited) {
          hoursSkippedManual++;
          console.log(`~ Job ${job.jobId} ${code} quotedHours: DB=${dbQuoted} Excel=${excelQuoted} — manually edited, left alone`);
        } else if (quotedOff) {
          hoursMismatches++;
          console.log(`✗ Job ${job.jobId} ${code} quotedHours: DB=${dbQuoted} -> Excel=${excelQuoted}`);
        }
        if (actualOff) {
          hoursMismatches++;
          console.log(`✗ Job ${job.jobId} ${code} actualHistoricalHours: DB=${dbActualHist} -> Excel=${excelActualHist}`);
        }

        if (FIX) {
          const data: Record<string, number> = {};
          if (quotedOff && !eh?.quotedHoursManuallyEdited) data.quotedHours = excelQuoted;
          if (actualOff) data.actualHistoricalHours = excelActualHist;
          if (Object.keys(data).length > 0) {
            await prisma.estimatedHours.upsert({
              where: { jobId_section: { jobId: job.id, section: code } },
              update: data,
              create: {
                jobId: job.id,
                section: code,
                quotedHours: quotedOff && !eh?.quotedHoursManuallyEdited ? excelQuoted : (eh ? Number(eh.quotedHours) : 0),
                actualHistoricalHours: actualOff ? excelActualHist : (eh ? Number(eh.actualHistoricalHours) : 0),
                estimateToCompleteHours: eh ? Number(eh.estimateToCompleteHours) : 0,
              },
            });
            hoursFixed += Object.keys(data).length;
          }
        }
      }

      if (!closeEnough(excelEstimate, dbEstimate)) {
        estimateDrift++;
        console.log(`i Job ${job.jobId} ${code} estimateToComplete: DB(live)=${dbEstimate} Excel(snapshot)=${excelEstimate} — informational only, not fixed (live-synced field)`);
      }
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Jobs checked: ${jobs.length} (${notInExcel} not in Excel, skipped)`);
  console.log(`Cost mismatches: ${costMismatches}${FIX ? ` (${costFixed} fixed)` : ""}, ${costSkippedManual} left alone (manually edited)`);
  console.log(`Hours mismatches: ${hoursMismatches}${FIX ? ` (${hoursFixed} field-writes applied)` : ""}, ${hoursSkippedManual} left alone (manually edited)`);
  console.log(`Estimate-to-complete drift (informational, not fixed): ${estimateDrift}`);
  if (!FIX && (costMismatches > 0 || hoursMismatches > 0)) {
    console.log("\nRe-run with --fix to apply the corrections above.");
  }
}

main()
  .catch((e) => {
    console.error("FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
