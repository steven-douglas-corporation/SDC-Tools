// Recon: can the Standard Fees pool DRIVERS be reproduced locally, without
// Power BI? Compares candidate local definitions against the archived
// CategoryPool rows, whose newHoursAddedThisMonth / hoursWorkedThisMonth came
// from PBI's [Hours Quoted by ETC Period] / [Hours Actual by ETC Period].
//
// Run: npx tsx scripts/_recon_pool_drivers.ts
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { VALID_JOB_TYPES } from "@/lib/job-filters";

// The four pools ARE the four sections the ETC grid excludes.
const POOL_SECTION: Record<string, string> = {
  ENGINEERING_PM: "10-111",
  ENGINEERING_WARRANTY: "70-211",
  SHOP_MANUFACTURING: "10-413",
  SHOP_WARRANTY: "70-411",
};

function monthOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function main() {
  const pools = await prisma.categoryPool.findMany({ orderBy: [{ month: "asc" }, { category: "asc" }] });
  console.log(`\n=== CategoryPool archive: ${pools.length} rows ===`);
  const months = [...new Set(pools.map((p) => p.month))].sort();
  console.log(`months: ${months.join(", ")}`);
  console.log(`sources: ${[...new Set(pools.map((p) => p.source))].join(", ")}`);

  console.log("\nmonth    category               prevPulled  newAdded  worked   pulled   newEtc   src");
  for (const p of pools) {
    console.log(
      `${p.month}  ${p.category.padEnd(22)} ${String(Number(p.previousMonthPulledHours)).padStart(9)} ` +
        `${String(Number(p.newHoursAddedThisMonth)).padStart(9)} ${String(Number(p.hoursWorkedThisMonth)).padStart(8)} ` +
        `${String(Number(p.hoursPulledThisMonth)).padStart(8)} ${String(Number(p.newEtcHours)).padStart(8)}  ${p.source}`,
    );
  }

  // ── What local data exists to rebuild the drivers from ────────────────────
  const jobs = await prisma.job.findMany({
    where: { type: { in: [...VALID_JOB_TYPES] } },
    select: { id: true, jobId: true, status: true, startDate: true, poStartDate: true, createdAt: true },
  });
  console.log(`\n=== Local inputs ===`);
  console.log(`type-gated jobs: ${jobs.length}`);

  const est = await prisma.estimatedHours.findMany({
    where: { section: { in: Object.values(POOL_SECTION) } },
    select: { jobId: true, section: true, quotedHours: true },
  });
  console.log(`EstimatedHours rows in the 4 pool sections: ${est.length}`);
  for (const [cat, sec] of Object.entries(POOL_SECTION)) {
    const rows = est.filter((e) => e.section === sec);
    const total = rows.reduce((s, e) => s + Number(e.quotedHours), 0);
    console.log(`  ${cat.padEnd(22)} ${sec}  rows=${String(rows.length).padStart(4)}  totalQuoted=${total.toFixed(2)}`);
  }

  // Punch coverage for the pool sections — is Hours Worked rebuildable?
  const punch = await prisma.jobHoursDetail.groupBy({
    by: ["section", "month"],
    where: { section: { in: Object.values(POOL_SECTION) } },
    _sum: { hours: true },
  });
  console.log(`\n=== JobHoursDetail punches in pool sections (import currently drops 10-111/70-211/70-411) ===`);
  if (punch.length === 0) console.log("  (none)");
  for (const r of punch.sort((a, b) => a.month.localeCompare(b.month) || a.section.localeCompare(b.section))) {
    console.log(`  ${r.month}  ${r.section}  ${Number(r._sum.hours ?? 0).toFixed(2)}`);
  }

  // First-ETC-month per job — the anchor for "entered this ETC period".
  const firstEtc = await prisma.etcEntry.groupBy({ by: ["jobId"], _min: { month: true } });
  const firstByJob = new Map(firstEtc.map((r) => [r.jobId, r._min.month as string]));
  const byFirstMonth = new Map<string, number[]>();
  for (const [jid, m] of firstByJob) {
    if (!byFirstMonth.has(m)) byFirstMonth.set(m, []);
    byFirstMonth.get(m)!.push(jid);
  }
  console.log(`\n=== Jobs by FIRST EtcEntry month ===`);
  for (const m of [...byFirstMonth.keys()].sort()) console.log(`  ${m}: ${byFirstMonth.get(m)!.length} jobs`);

  // Candidate A: quoted hours in the pool's section, for jobs whose first ETC
  // month is this month.
  console.log(`\n=== Candidate A — quoted(section) over jobs first appearing in that ETC month ===`);
  console.log("month    category               pbiNewAdded   candA     delta");
  const quotedBy = new Map<string, number>();
  for (const e of est) quotedBy.set(`${e.jobId}::${e.section}`, Number(e.quotedHours));
  for (const p of pools) {
    const sec = POOL_SECTION[p.category];
    const jobIds = byFirstMonth.get(p.month) ?? [];
    const candA = jobIds.reduce((s, jid) => s + (quotedBy.get(`${jid}::${sec}`) ?? 0), 0);
    const pbi = Number(p.newHoursAddedThisMonth);
    console.log(
      `${p.month}  ${p.category.padEnd(22)} ${pbi.toFixed(2).padStart(11)} ${candA.toFixed(2).padStart(9)} ${(candA - pbi).toFixed(2).padStart(9)}`,
    );
  }

  // Candidate C: jobs whose startDate falls in the month.
  console.log(`\n=== Candidate C — quoted(section) over jobs whose startDate is in that month ===`);
  console.log("month    category               pbiNewAdded   candC     delta");
  const byStartMonth = new Map<string, number[]>();
  for (const j of jobs) {
    if (!j.startDate) continue;
    const m = monthOf(j.startDate);
    if (!byStartMonth.has(m)) byStartMonth.set(m, []);
    byStartMonth.get(m)!.push(j.id);
  }
  for (const p of pools) {
    const sec = POOL_SECTION[p.category];
    const jobIds = byStartMonth.get(p.month) ?? [];
    const candC = jobIds.reduce((s, jid) => s + (quotedBy.get(`${jid}::${sec}`) ?? 0), 0);
    const pbi = Number(p.newHoursAddedThisMonth);
    console.log(
      `${p.month}  ${p.category.padEnd(22)} ${pbi.toFixed(2).padStart(11)} ${candC.toFixed(2).padStart(9)} ${(candC - pbi).toFixed(2).padStart(9)}`,
    );
  }
}

main()
  .catch((e) => {
    console.error("FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
