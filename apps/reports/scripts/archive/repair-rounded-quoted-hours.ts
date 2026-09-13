// One-time repair for damage caused by the quotedHours-rounding bug fixed in
// quoted-actions.ts (2026-07-16 audit): saving ANY cell on /quoted resubmitted
// every hours cell's ROUNDED display value, and the old diff-check compared
// that against the true (possibly fractional) DB value — so any untouched
// cell holding a fractional Power-BI-synced value got silently rounded and
// permanently flagged quotedHoursManuallyEdited, blocking future syncs.
//
// This repairs only entries where the damage is provable: DB value exactly
// equals Math.round(Excel value) AND the entry is flagged manually-edited.
// A genuine manager override would essentially never coincidentally equal
// round(the exact Power-BI/Excel figure) — this is what distinguishes real
// edits (left alone) from bug victims (repaired).
//
// Run with: npx tsx scripts/repair-rounded-quoted-hours.ts          (report only)
//           npx tsx scripts/repair-rounded-quoted-hours.ts --fix     (report + repair)
import * as XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";
import { SECTIONS } from "@/lib/sections";

const prisma = new PrismaClient();
const FIX = process.argv.includes("--fix");
const XLSX_PATH = "D:/AI Projects/sdc-etc-planner/Project Planner Data Control.xlsx";

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const wb = XLSX.readFile(XLSX_PATH, { cellDates: true });
  const ws = wb.Sheets["Estimated Hours"];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][];
  const QUOTED_START = XLSX.utils.decode_col("J");

  const excelByJobId = new Map<string, unknown[]>();
  for (let i = 8; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row[0] == null) continue;
    excelByJobId.set(String(row[0]).trim(), row);
  }

  const jobs = await prisma.job.findMany({ include: { estimatedHours: true } });

  let candidates = 0;
  let repaired = 0;

  for (const job of jobs) {
    const row = excelByJobId.get(job.jobId);
    if (!row) continue;

    for (const eh of job.estimatedHours) {
      if (!eh.quotedHoursManuallyEdited) continue;
      const si = SECTIONS.findIndex((s) => s.code === eh.section);
      if (si === -1) continue;

      const excelValue = numOrNull(row[QUOTED_START + si]);
      if (excelValue == null) continue;
      const dbValue = Number(eh.quotedHours);

      if (Math.round(excelValue) !== dbValue) continue; // doesn't fit the damage signature — leave it as a real manual edit
      if (Math.abs(excelValue - dbValue) < 0.005) continue; // already exact, no fractional precision was actually lost

      candidates++;
      console.log(`✗ Job ${job.jobId} ${eh.section}: DB=${dbValue} (rounded) -> restoring Excel=${excelValue}, clearing manually-edited flag`);
      if (FIX) {
        await prisma.estimatedHours.update({
          where: { id: eh.id },
          data: { quotedHours: excelValue, quotedHoursManuallyEdited: false },
        });
        repaired++;
      }
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Candidates found: ${candidates}${FIX ? `, repaired: ${repaired}` : ""}`);
  if (!FIX && candidates > 0) console.log("Re-run with --fix to apply the repair above.");
}

main()
  .catch((e) => {
    console.error("FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
