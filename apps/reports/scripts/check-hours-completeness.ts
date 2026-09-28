/**
 * Checks that the Projects grid's footer Total, with nothing hidden, is every hour
 * the app holds — built independently from the tables, era by era.
 *
 * Run:  npx tsx -r ./scripts/shim-server-only.cjs scripts/check-hours-completeness.ts
 *
 * ── The equation ───────────────────────────────────────────────────────────
 *
 *   grid Total (all jobs, all sections)
 *     ==  Σ EstimatedHours.actualHistoricalHours                      era 1
 *       + Σ EtcEntry.hoursWorked, months the punches do not cover     era 2
 *       + Σ JobHoursDetail.hours, months they do                      era 3
 *       + Σ UndefinedHoursRow.hours, job-number reasons, same months  No Job ID
 *       - whatever of eras 2 and 3 already sits inside a snapshot     (see
 *         SNAPSHOT_THROUGH_MONTH in actual-hours.ts)
 *
 * The left side comes from the loaders the page calls; the right side from plain
 * aggregates written here. A difference means a loader is dropping or doubling hours.
 *
 * It also prints what is NOT in the Total and why — the other rejection reasons —
 * so "every hour the app holds" is not mistaken for "every hour in the file".
 *
 * Read-only. It never writes, so it is safe to run against production.
 */
import { prisma } from "../src/lib/prisma";
import {
  JOBLESS_REASONS,
  SNAPSHOT_THROUGH_MONTH,
  coveredMonths,
  loadActualHoursBySection,
  loadJoblessActualsBySection,
} from "../src/lib/actual-hours";
import { PARTS_COST_SECTION } from "../src/lib/sections";

function h(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const num = (v: unknown) => Number(v ?? 0);

async function main() {
  const covered = await coveredMonths();
  const jobs = await prisma.job.findMany({ select: { id: true } });
  const jobPks = jobs.map((j) => j.id);

  // ── Right side: plain aggregates ─────────────────────────────────────────
  const snapshotRows = await prisma.estimatedHours.groupBy({
    by: ["jobId"],
    where: { section: { not: PARTS_COST_SECTION } },
    _sum: { actualHistoricalHours: true },
  });
  const era1 = snapshotRows.reduce((s, r) => s + num(r._sum.actualHistoricalHours), 0);
  // Same test as OUTSIDE_SNAPSHOT: any non-zero snapshot row, in any section.
  const snapshotJobs = (
    await prisma.estimatedHours.findMany({ where: { actualHistoricalHours: { not: 0 } }, distinct: ["jobId"], select: { jobId: true } })
  ).map((r) => r.jobId);

  const [era2All, era3All, era2InSnapshot, era3InSnapshot, jobless, otherRejections] = await Promise.all([
    prisma.etcEntry.aggregate({ where: { section: { not: PARTS_COST_SECTION }, month: { notIn: covered } }, _sum: { hoursWorked: true } }),
    prisma.jobHoursDetail.aggregate({ where: { month: { in: covered } }, _sum: { hours: true } }),
    prisma.etcEntry.aggregate({
      where: { section: { not: PARTS_COST_SECTION }, month: { notIn: covered, lte: SNAPSHOT_THROUGH_MONTH }, jobId: { in: snapshotJobs } },
      _sum: { hoursWorked: true },
    }),
    prisma.jobHoursDetail.aggregate({
      where: { month: { in: covered, lte: SNAPSHOT_THROUGH_MONTH }, jobId: { in: snapshotJobs } },
      _sum: { hours: true },
    }),
    prisma.undefinedHoursRow.aggregate({ where: { reason: { in: [...JOBLESS_REASONS] }, month: { in: covered } }, _sum: { hours: true } }),
    prisma.undefinedHoursRow.groupBy({
      by: ["reason"],
      where: { reason: { notIn: [...JOBLESS_REASONS] } },
      _sum: { hours: true },
      _count: true,
    }),
  ]);
  const era2 = num(era2All._sum.hoursWorked) - num(era2InSnapshot._sum.hoursWorked);
  const era3 = num(era3All._sum.hours) - num(era3InSnapshot._sum.hours);
  const joblessTotal = num(jobless._sum.hours);
  const expected = era1 + era2 + era3 + joblessTotal;

  // ── Left side: what the page's loaders produce ───────────────────────────
  const [actuals, joblessLoaded] = await Promise.all([loadActualHoursBySection(jobPks), loadJoblessActualsBySection()]);
  let gridJobs = 0;
  for (const bySection of actuals.values()) {
    for (const [code, hours] of bySection) if (code !== PARTS_COST_SECTION) gridJobs += hours;
  }
  const gridJobless = [...joblessLoaded.bySection.values()].reduce((s, v) => s + v, 0);
  const grid = gridJobs + gridJobless;

  console.log("Projects grid Total vs the database (all jobs, all sections)\n");
  console.log(`punch-covered months           : ${covered.length} (${[...covered].sort()[0] ?? "—"} … ${[...covered].sort().at(-1) ?? "—"})`);
  console.log(`jobs with a snapshot           : ${snapshotJobs.length} of ${jobPks.length}\n`);
  console.log(`era 1  migration snapshot      : ${h(era1)}`);
  console.log(`era 2  frozen ETC months       : ${h(era2)}   (${h(num(era2InSnapshot._sum.hoursWorked))} already in a snapshot, left out)`);
  console.log(`era 3  punches                 : ${h(era3)}   (${h(num(era3InSnapshot._sum.hours))} already in a snapshot, left out)`);
  console.log(`No Job ID                      : ${h(joblessTotal)}`);
  console.log(`EXPECTED                       : ${h(expected)}\n`);
  console.log(`grid, job rows                 : ${h(gridJobs)}`);
  console.log(`grid, No Job ID row            : ${h(gridJobless)}`);
  console.log(`GRID TOTAL                     : ${h(grid)}`);
  const diff = grid - expected;
  console.log(`DIFFERENCE                     : ${h(diff)}   ${Math.abs(diff) < 0.01 ? "OK" : "MISMATCH"}\n`);

  console.log("Not in the Total, by design (other import rejections, all months):");
  if (otherRejections.length === 0) console.log("   (none)");
  for (const r of otherRejections.sort((a, b) => num(b._sum.hours) - num(a._sum.hours))) {
    console.log(`   ${r.reason.padEnd(22)} ${String(r._count).padStart(6)} rows  ${h(num(r._sum.hours)).padStart(12)} h`);
  }

  await prisma.$disconnect();
  if (Math.abs(diff) >= 0.01) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
