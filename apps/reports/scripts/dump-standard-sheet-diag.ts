// READ-ONLY diagnostic dump for the "Standard Sheet totals swing at submission"
// report. Writes ONE JSON file and touches nothing in the database — every
// call below is a findMany/count. Safe to run on production.
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/dump-standard-sheet-diag.ts
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/dump-standard-sheet-diag.ts 2026-07
//
// No --tsconfig flag: this tsx build forwards it to node, which rejects it
// ("bad option: --tsconfig"). It was never needed here anyway — tsconfig.json
// already maps @/* to ./src/*, and the -r shim is what resolves "server-only",
// which is the only other thing tsconfig.scripts.json adds. Same invocation
// shape as `npm test`.
//
// Defaults to 2026-08. Output: standard-sheet-diag.<month>.json in the repo root.
//
// What it is for: the live (pre-submit) Standard Sheet and the frozen
// (post-submit) one resolve their job universe through getEtcMonthJobWhere,
// which switches branch the moment the month locks — etcActiveJobFilter before,
// { has entries } + etcEligibleJobFilter after. The two halves differ by
// LIFECYCLE (status === "Active", completeDate === null). This dump captures
// both universes side by side, plus everything needed to reconcile the two
// grand totals cell by cell.
import "dotenv/config";
import { writeFileSync } from "fs";
import { prisma } from "@/lib/prisma";
import { etcActiveJobFilter, etcEligibleJobFilter } from "@/lib/job-filters";
import { getEtcMonthJobWhere } from "@/lib/etc-month-jobs";

const arg = process.argv[2];
const MONTH = arg && /^\d{4}-\d{2}$/.test(arg) ? arg : "2026-08";
const PREV = prevMonth(MONTH);
const NEXT = nextMonth(MONTH);
const OUT = `standard-sheet-diag.${MONTH}.json`;

function prevMonth(m: string) {
  const [y, mm] = m.split("-").map(Number);
  return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, "0")}`;
}
function nextMonth(m: string) {
  const [y, mm] = m.split("-").map(Number);
  return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
}

const JOB_FIELDS = {
  id: true,
  jobId: true,
  jobName: true,
  status: true,
  type: true,
  startDate: true,
  completeDate: true,
  billable: true,
  excludedFromStandardFees: true,
} as const;

async function main() {
  const monthWhere = await getEtcMonthJobWhere(MONTH);

  const [
    submissions,
    snapshots,
    snapshotsPrev,
    entries,
    jobsWithEntries,
    jobsLiveUniverse,
    jobsLockedUniverse,
    jobsResolvedNow,
    pools,
    poolsPrev,
    setting,
    executionRates,
    auditEtc,
    auditJob,
    nextEntries,
  ] = await Promise.all([
    // Every submission attempt for the month, in order. `validation` holds the
    // counts/issues from the run that produced it.
    prisma.monthlyReportSubmission.findMany({ where: { month: MONTH }, orderBy: { id: "asc" } }),
    prisma.standardSheetSnapshot.findMany({ where: { month: MONTH }, include: { job: { select: JOB_FIELDS } } }),
    prisma.standardSheetSnapshot.findMany({ where: { month: PREV }, include: { job: { select: JOB_FIELDS } } }),
    prisma.etcEntry.findMany({ where: { month: MONTH }, include: { job: { select: JOB_FIELDS } } }),

    // Job universes, all three, evaluated right now.
    prisma.job.findMany({ where: { etcEntries: { some: { month: MONTH } } }, select: JOB_FIELDS }),
    prisma.job.findMany({ where: etcActiveJobFilter, select: JOB_FIELDS }),
    prisma.job.findMany({ where: { etcEntries: { some: { month: MONTH } }, ...etcEligibleJobFilter }, select: JOB_FIELDS }),
    prisma.job.findMany({ where: monthWhere.where, select: JOB_FIELDS }),

    prisma.categoryPool.findMany({ where: { month: MONTH } }),
    prisma.categoryPool.findMany({ where: { month: PREV } }),
    prisma.standardSheetSetting.findUnique({ where: { id: 1 } }),
    prisma.executionRate.findMany(),

    // Everything that touched an ETC cell or month in the submission window.
    prisma.auditLog.findMany({
      where: { entityType: { in: ["EtcEntry", "EtcMonth"] }, createdAt: { gte: new Date(`${MONTH}-01T00:00:00Z`) } },
      orderBy: { id: "asc" },
      take: 20000,
    }),
    // Job-level changes (billable / excludedFromStandardFees / status flips).
    prisma.auditLog.findMany({
      where: { entityType: "Job", createdAt: { gte: new Date(`${MONTH}-01T00:00:00Z`) } },
      orderBy: { id: "asc" },
      take: 5000,
    }),
    // Next month's seeds — startMonth copied this month's newEtc into them.
    prisma.etcEntry.findMany({
      where: { month: NEXT },
      select: { jobId: true, section: true, priorEtc: true, newEtc: true, newEtcDraft: true, createdAt: true },
    }),
  ]);

  const payload = {
    generatedAt: new Date().toISOString(),
    month: MONTH,
    prevMonth: PREV,
    nextMonth: NEXT,
    monthIsLocked: monthWhere.monthIsLocked,
    counts: {
      submissions: submissions.length,
      snapshots: snapshots.length,
      snapshotsPrev: snapshotsPrev.length,
      entries: entries.length,
      entriesNeedsReview: entries.filter((e) => e.needsReview).length,
      jobsWithEntries: jobsWithEntries.length,
      jobsLiveUniverse: jobsLiveUniverse.length,
      jobsLockedUniverse: jobsLockedUniverse.length,
      jobsResolvedNow: jobsResolvedNow.length,
      auditEtc: auditEtc.length,
      auditJob: auditJob.length,
    },
    setting,
    pools,
    poolsPrev,
    submissions,
    snapshots,
    snapshotsPrev,
    entries,
    jobsWithEntries,
    jobsLiveUniverse,
    jobsLockedUniverse,
    jobsResolvedNow,
    executionRates,
    auditEtc,
    auditJob,
    nextEntries,
  };

  writeFileSync(OUT, JSON.stringify(payload, null, 1));
  console.log(`Wrote ${OUT}`);
  console.table(payload.counts);
  console.log(`monthIsLocked=${monthWhere.monthIsLocked}`);
  const live = new Set(jobsLiveUniverse.map((j) => j.jobId));
  const locked = new Set(jobsLockedUniverse.map((j) => j.jobId));
  const onlyLocked = [...locked].filter((j) => !live.has(j));
  const onlyLive = [...live].filter((j) => !locked.has(j));
  console.log(`In the FROZEN universe but not the LIVE one (${onlyLocked.length}): ${onlyLocked.join(", ") || "—"}`);
  console.log(`In the LIVE universe but not the FROZEN one (${onlyLive.length}): ${onlyLive.join(", ") || "—"}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
