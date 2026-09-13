import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { latestPriorEtcByKey, calcHoursLeft, round2, isMonthLocked } from "@/lib/etc";

// Repairs Prior ETC on the OPEN month for job/sections whose carry-forward fell
// back to quoted hours because the immediately-preceding month had no row.
// See latestPriorEtcByKey — seedMonth's old prevMonth-only lookup reset a
// worked-down balance to the job's full original quote.
//
// Only touches needsReview (unsubmitted) rows in the latest month. Locked
// history is never rewritten: those figures are what somebody signed off.
//
//   npx tsx scripts/repair-prior-etc-carryforward.ts           (dry run)
//   npx tsx scripts/repair-prior-etc-carryforward.ts --apply

const APPLY = process.argv.includes("--apply");

async function main() {
  const latest = await prisma.etcEntry.findFirst({ orderBy: { month: "desc" }, select: { month: true } });
  if (!latest) return console.log("No ETC months exist.");
  const month = latest.month;

  const entries = await prisma.etcEntry.findMany({
    where: { month },
    include: { job: { select: { jobId: true, jobName: true } } },
  });
  if (isMonthLocked(entries)) {
    console.log(`${month} is submitted and locked — nothing to repair (its figures are signed off).`);
    return;
  }

  const prior = await prisma.etcEntry.findMany({
    where: { month: { lt: month } },
    select: { jobId: true, section: true, month: true, newEtc: true },
  });
  const carry = latestPriorEtcByKey(prior);

  const fixes: { id: number; jobId: string; section: string; was: number; now: number; hoursLeftCalc: number }[] = [];
  for (const e of entries) {
    if (!e.needsReview) continue; // already submitted — leave it alone
    const correct = carry.get(`${e.jobId}-${e.section}`);
    if (correct === undefined) continue; // genuinely new: quoted hours are right
    const was = round2(Number(e.priorEtc));
    const now = round2(correct);
    if (was === now) continue;
    fixes.push({ id: e.id, jobId: e.job.jobId, section: e.section, was, now, hoursLeftCalc: round2(calcHoursLeft(now, Number(e.hoursWorked))) });
  }

  console.log(`${month}: ${fixes.length} entr${fixes.length === 1 ? "y" : "ies"} to correct${APPLY ? "" : "  (DRY RUN — pass --apply to write)"}\n`);
  const byJob = new Map<string, number>();
  let delta = 0;
  for (const f of fixes) {
    byJob.set(f.jobId, (byJob.get(f.jobId) ?? 0) + (f.was - f.now));
    delta += f.was - f.now;
    console.log(`  job ${f.jobId.padEnd(6)} ${f.section.padEnd(11)} ${String(f.was).padStart(9)} -> ${String(f.now).padStart(9)}`);
  }
  console.log(`\n  ${byJob.size} job(s); total Prior ETC removed: ${round2(delta)} h`);
  for (const [j, d] of [...byJob.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${j.padEnd(6)} -${round2(d)} h`);

  if (!APPLY || fixes.length === 0) return void (await prisma.$disconnect());

  await prisma.$transaction(
    fixes.map((f) => prisma.etcEntry.update({ where: { id: f.id }, data: { priorEtc: f.now, hoursLeftCalc: f.hoursLeftCalc } })),
  );
  console.log(`\nAPPLIED to ${fixes.length} entries.`);
  await prisma.$disconnect();
}
main();
