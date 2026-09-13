// One-time import of June 2026 from the team's working Excel copies
// ("june numbers/" — saved 2026-07-14), replacing the machine-frozen 7/14
// auto-suggestion snapshot with the managers' actual entries. Cross-verified
// before import: Fill Out per-section sums match the Standard Fees file's
// per-job H/I/J on all 41 shared jobs with 0 mismatches.
// Writes keep needsReview=false and set NO ownership markers, so June
// remains PBI-owned and still rebuilds automatically once the "Jun 2026"
// archive publishes.
import * as fs from "fs";
import { prisma } from "@/lib/prisma";
import { round2, calcHoursLeft } from "@/lib/etc";

type Row = { jobId: string; name: string; sections: Record<string, [number, number, number | null]> };

async function main() {
  const data: Row[] = JSON.parse(fs.readFileSync("june numbers/_extracted.json", "utf-8"));
  const month = "2026-06";

  let updated = 0, created = 0;
  const missingJobs: string[] = [];
  for (const row of data) {
    const job = await prisma.job.findUnique({ where: { jobId: row.jobId }, select: { id: true } });
    if (!job) { missingJobs.push(row.jobId); continue; }
    for (const [section, [prior, worked, newEtcRaw]] of Object.entries(row.sections)) {
      const newEtc = newEtcRaw ?? 0; // blank cell sums as 0 in the sheet's own job totals (verified)
      const existing = await prisma.etcEntry.findUnique({
        where: { jobId_section_month: { jobId: job.id, section, month } },
      });
      if (existing) {
        if (
          Math.abs(Number(existing.priorEtc) - prior) < 0.005 &&
          Math.abs(Number(existing.hoursWorked) - worked) < 0.005 &&
          Math.abs(Number(existing.newEtc) - newEtc) < 0.005
        ) continue;
        await prisma.etcEntry.update({
          where: { id: existing.id },
          data: { priorEtc: prior, hoursWorked: worked, hoursLeftCalc: round2(calcHoursLeft(prior, worked)), newEtc, newEtcDraft: null },
        });
        updated++;
      } else {
        if (prior === 0 && worked === 0 && newEtc === 0) continue; // nothing to show
        await prisma.etcEntry.create({
          data: { jobId: job.id, section, month, priorEtc: prior, hoursWorked: worked, hoursLeftCalc: round2(calcHoursLeft(prior, worked)), newEtc, needsReview: false },
        });
        created++;
      }
    }
  }

  // Pools: the June file's manual cells (pulled 450/255/803/243).
  const POOL: Record<string, number> = { ENGINEERING_PM: 450, ENGINEERING_WARRANTY: 255, SHOP_MANUFACTURING: 803, SHOP_WARRANTY: 243 };
  for (const [category, pulled] of Object.entries(POOL)) {
    const pool = await prisma.categoryPool.findUnique({ where: { category_month: { category: category as never, month } } });
    if (!pool) continue;
    const newEtcHours = round2(Number(pool.hoursAvailable) - pulled);
    const standardFee = round2(newEtcHours * Number(pool.rate));
    await prisma.categoryPool.update({
      where: { id: pool.id },
      data: { hoursPulledThisMonth: pulled, newEtcHours, standardFee },
    });
  }

  await prisma.auditLog.create({
    data: {
      action: "etc.importJuneFromExcel",
      entityType: "EtcMonth",
      entityId: month,
      summary: `Imported June 2026 from the team's working Excel (june numbers/, saved 7/14): ${updated} entries updated, ${created} created; pool pulled set to 450/255/803/243`,
    },
  });
  console.log(`Updated: ${updated}, created: ${created}, jobs not in app: ${missingJobs.join(", ") || "none"}`);
}
main().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
