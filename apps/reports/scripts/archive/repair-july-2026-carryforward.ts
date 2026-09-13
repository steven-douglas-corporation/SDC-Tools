// One-off repair for the July 2026 carry-forward damage reported 2026-08-04:
// "why is the New ETC filled out for parts for July?" and "June isn't saved
// correctly, the Prior ETC for July still isn't right".
//
// Both symptoms, one cause: July's Prior ETC was frozen at figures that later
// moved, and the New ETC drafts derived from those figures were frozen with it.
//
// The audit log tells the whole story:
//   16:32  July submitted            -> July locks
//   16:37  June corrected + submitted -> "carry-forward stopped at locked month
//                                         2026-07" (correctly — cascade must not
//                                         rewrite confirmed rows)
//   16:38  July reopened              -> nothing re-derived it, so July kept the
//                                         Prior ETC it had before June moved
//
// And separately, syncPartsCost looked only at the IMMEDIATELY preceding month
// for a job's parts balance, so a job with no June parts row fell through to its
// original quote: job 1105 reopened at $636,234 having confirmed 0 in May, job
// 979 at $8,600 having confirmed 0 in April.
//
// The code fixes are in place (lib/etc-prior-etc.ts, syncPartsCost,
// reopenMonth). This applies the same result to the data that is already wrong,
// because the code only corrects a value at the moment it changes and these
// changed yesterday.
//
// Writes ONLY unsubmitted (needsReview) rows — confirmed history is never
// touched, by construction: derivePriorEtcForMonth filters on it and step 2
// below re-checks it.
//
//   dry run:  npx tsx scripts/repair-july-2026-carryforward.ts 2026-07
//   for real: npx tsx scripts/repair-july-2026-carryforward.ts 2026-07 --write
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { derivePriorEtcForMonth, cascadePriorEtcForward } from "@/lib/etc-prior-etc";
import { latestPriorEtcByKey, priorEtcForMonth, round2, suggestNewEtc } from "@/lib/etc";
import { PARTS_COST_SECTION } from "@/lib/sections";

const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });

async function main() {
  const month = process.argv[2];
  const write = process.argv.includes("--write");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) throw new Error("Pass a month, e.g. 2026-07");
  console.log(`${write ? "WRITING" : "DRY RUN"} — ${month}\n`);

  const jobLabel = new Map(
    (await prisma.job.findMany({ select: { id: true, jobId: true } })).map((j) => [j.id, j.jobId]),
  );

  // ── Step 1: what the systematic re-derivation would change ────────────────
  //
  // Predicted with the SAME rule the writer uses (priorEtcForMonth), so the
  // preview and the write cannot disagree.
  const entries = await prisma.etcEntry.findMany({ where: { month, needsReview: true } });
  const jobIds = [...new Set(entries.map((e) => e.jobId))];
  const [priorEntries, jobs] = await Promise.all([
    prisma.etcEntry.findMany({
      where: { month: { lt: month }, jobId: { in: jobIds } },
      select: { jobId: true, section: true, month: true, newEtc: true },
    }),
    prisma.job.findMany({
      where: { id: { in: jobIds } },
      select: { id: true, startDate: true, costQuoted: true, estimatedHours: { select: { section: true, quotedHours: true } } },
    }),
  ]);
  const priorByKey = latestPriorEtcByKey(priorEntries);
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const monthOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

  console.log("── Step 1: Prior ETC re-derived from the months before it ──");
  let predicted = 0;
  for (const e of entries) {
    const job = jobById.get(e.jobId);
    if (!job) continue;
    const carried = priorByKey.get(`${e.jobId}-${e.section}`);
    const quoted =
      e.section === PARTS_COST_SECTION
        ? Number(job.costQuoted ?? 0)
        : Number(job.estimatedHours.find((q) => q.section === e.section)?.quotedHours ?? 0);
    if (carried === undefined && quoted === 0) continue;
    const startsThisMonth = job.startDate != null && monthOf(job.startDate) === month;
    const want = priorEtcForMonth({ startsThisMonth, carried, quoted });
    const have = round2(Number(e.priorEtc));
    if (have === want) continue;
    predicted++;
    const fmt = e.section === PARTS_COST_SECTION ? money : String;
    console.log(
      `  ${String(jobLabel.get(e.jobId)).padEnd(6)} ${e.section.padEnd(11)} ${fmt(have).padStart(11)} -> ${fmt(want).padStart(11)}` +
        (startsThisMonth ? "  [starts this month -> quoted]" : `  [carried from the latest earlier month]`),
    );
  }
  console.log(`  ${predicted} row(s) to re-derive\n`);

  // ── Step 2: drafts left stranded by a Prior ETC that moved earlier ────────
  //
  // A New ETC draft of 0 on a cell where NOTHING was spent contradicts the one
  // rule this column has: no spend means the balance carries forward. Every one
  // of these was saved while the cell's Prior ETC was still 0 — correct at the
  // time — and outlived it. redrivenDraft now moves such a draft with the figure
  // it came from, but only from the moment the figure moves, so these need
  // saying explicitly.
  //
  // Deliberately narrow: 0 draft, 0 worked, positive Prior. A draft that
  // disagrees with the carry-forward by any other amount is somebody's decision.
  console.log("── Step 2: stale zero drafts over a live balance ──");
  const stale = entries.filter(
    (e) =>
      e.newEtcDraft != null &&
      round2(Number(e.newEtcDraft)) === 0 &&
      Number(e.hoursWorked) === 0 &&
      round2(Number(e.priorEtc)) > 0,
  );
  // Predicted AFTER step 1, so a row whose Prior is about to become 0 (job 979,
  // job 1105 — both finished buying) is correctly left alone rather than being
  // handed back a balance it no longer has.
  const staleAfterStep1 = stale.filter((e) => {
    const job = jobById.get(e.jobId);
    if (!job) return false;
    const carried = priorByKey.get(`${e.jobId}-${e.section}`);
    const quoted =
      e.section === PARTS_COST_SECTION
        ? Number(job.costQuoted ?? 0)
        : Number(job.estimatedHours.find((q) => q.section === e.section)?.quotedHours ?? 0);
    const startsThisMonth = job.startDate != null && monthOf(job.startDate) === month;
    const want = carried === undefined && quoted === 0 ? round2(Number(e.priorEtc)) : priorEtcForMonth({ startsThisMonth, carried, quoted });
    return want > 0;
  });
  for (const e of staleAfterStep1) {
    const fmt = e.section === PARTS_COST_SECTION ? money : String;
    console.log(
      `  ${String(jobLabel.get(e.jobId)).padEnd(6)} ${e.section.padEnd(11)} draft 0 -> ${fmt(round2(suggestNewEtc(Number(e.priorEtc), 0)))} (carry-forward; nothing spent)`,
    );
  }
  console.log(`  ${staleAfterStep1.length} draft(s) to restore\n`);
  const skipped = stale.length - staleAfterStep1.length;
  if (skipped > 0) console.log(`  (${skipped} zero draft(s) left as-is — their Prior ETC becomes 0 in step 1, so 0 is right)\n`);

  if (!write) {
    console.log("Nothing written. Re-run with --write to apply.");
    await prisma.$disconnect();
    return;
  }

  // Step 1 for real, through the shared writer — so this script cannot drift
  // from what a reopen or a submit would do.
  const rederived = await derivePriorEtcForMonth(month);
  console.log(`Step 1: re-derived ${rederived.entriesUpdated} Prior ETC in ${month}`);

  // Step 2 for real, re-reading each row so a value that changed under us in
  // step 1 is respected.
  let restored = 0;
  for (const e of staleAfterStep1) {
    const fresh = await prisma.etcEntry.findUnique({ where: { id: e.id } });
    if (!fresh || !fresh.needsReview) continue; // submitted since — leave it
    if (fresh.newEtcDraft == null || round2(Number(fresh.newEtcDraft)) !== 0) continue; // moved since
    if (Number(fresh.hoursWorked) !== 0 || round2(Number(fresh.priorEtc)) <= 0) continue;
    await prisma.etcEntry.update({
      where: { id: fresh.id },
      data: { newEtcDraft: round2(suggestNewEtc(Number(fresh.priorEtc), 0)), newEtcClearedAt: null },
    });
    restored++;
  }
  console.log(`Step 2: restored ${restored} carry-forward draft(s)`);

  const cascade = await cascadePriorEtcForward(month);
  console.log(
    `Step 3: cascaded forward — months ${cascade.monthsUpdated.join(", ") || "(none)"}, ${cascade.entriesUpdated} row(s)` +
      (cascade.stoppedAtLockedMonth ? `, stopped at locked ${cascade.stoppedAtLockedMonth}` : ""),
  );

  await prisma.$disconnect();
}

main();
