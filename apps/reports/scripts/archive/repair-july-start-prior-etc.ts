// One-off repair: Prior ETC for jobs whose Start Date falls in the month.
//
// seedMonth now opens such a job at its QUOTED figures rather than at whatever
// the carry-forward chain holds (see the `startsThisMonth` note in
// etc-actions.ts). Jobs 1159 and 1160 started in July but already had rows from
// earlier months — seeded before anyone entered their quotes, so those rows
// carried 0. July inherited the 0 against quotes of 100 / 260 / 150, and 1160
// showed Hours Left -175 on a job that had simply never been given its estimate.
//
// The code fix corrects this on the next Refresh Data. This script applies the
// same result directly, for when clicking the button isn't convenient. It exists
// as a script rather than a one-liner because it must reproduce seedMonth's rule
// exactly, and be readable enough to check that it does.
//
// Writes ONLY:
//   • unsubmitted rows (needsReview) — confirmed history is never touched
//   • rows whose Prior ETC actually differs from the quote
//   • the month named on the command line, for jobs starting IN that month
//
//   dry run:  npx tsx scripts/repair-july-start-prior-etc.ts 2026-07
//   for real: npx tsx scripts/repair-july-start-prior-etc.ts 2026-07 --write
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { ETC_TRACKED_CODES, PARTS_COST_SECTION } from "@/lib/sections";
import { calcHoursLeft, round2 } from "@/lib/etc";

async function main() {
  const month = process.argv[2];
  const write = process.argv.includes("--write");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) throw new Error("Pass a month, e.g. 2026-07");

  const [y, m] = month.split("-").map(Number);
  const monthStart = new Date(Date.UTC(y, m - 1, 1));
  const monthEnd = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1));

  const jobs = await prisma.job.findMany({
    where: { startDate: { gte: monthStart, lt: monthEnd } },
    select: {
      id: true,
      jobId: true,
      jobName: true,
      costQuoted: true,
      estimatedHours: { select: { section: true, quotedHours: true } },
      etcEntries: {
        where: { month },
        select: { id: true, section: true, priorEtc: true, hoursWorked: true, needsReview: true },
      },
    },
  });

  console.log(`${month}: ${jobs.length} jobs with a Start Date in this month`);
  console.log(write ? "MODE: WRITING\n" : "MODE: dry run (pass --write to commit)\n");

  const writes: { id: number; priorEtc: number; hoursLeftCalc: number }[] = [];
  let skippedSubmitted = 0;

  for (const job of jobs) {
    const quoted = new Map(
      job.estimatedHours.filter((e) => ETC_TRACKED_CODES.has(e.section)).map((e) => [e.section, Number(e.quotedHours)]),
    );
    const lines: string[] = [];

    for (const entry of job.etcEntries) {
      if (!entry.needsReview) {
        skippedSubmitted++;
        continue; // confirmed history — never touched
      }
      // Parts uses the job's Parts Cost Quoted; hours use the section's quote.
      const target =
        entry.section === PARTS_COST_SECTION ? Number(job.costQuoted ?? 0) : (quoted.get(entry.section) ?? 0);
      const current = Number(entry.priorEtc);
      if (Math.abs(current - target) < 0.005) continue;

      const hoursLeftCalc = round2(calcHoursLeft(target, Number(entry.hoursWorked)));
      writes.push({ id: entry.id, priorEtc: round2(target), hoursLeftCalc });
      lines.push(
        `    ${entry.section.padEnd(11)} prior ${current} -> ${round2(target)}   (worked ${Number(entry.hoursWorked)}, hours left -> ${hoursLeftCalc})`,
      );
    }

    if (lines.length) {
      console.log(`  ${job.jobId} ${job.jobName}`);
      lines.forEach((l) => console.log(l));
    }
  }

  console.log(`\nrows to correct: ${writes.length}   (submitted rows left alone: ${skippedSubmitted})`);
  if (!write || writes.length === 0) {
    await prisma.$disconnect();
    return;
  }

  await prisma.$transaction(
    writes.map((w) =>
      prisma.etcEntry.update({ where: { id: w.id }, data: { priorEtc: w.priorEtc, hoursLeftCalc: w.hoursLeftCalc } }),
    ),
  );
  console.log(`written.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
