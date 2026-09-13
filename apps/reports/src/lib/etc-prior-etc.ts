import { prisma } from "@/lib/prisma";
import { calcHoursLeft, isMonthLocked, round2, nextMonth, latestPriorEtcByKey, priorEtcForMonth, redrivenDraft, startsInMonth } from "@/lib/etc";
import { PARTS_COST_SECTION } from "@/lib/sections";
import { isDerivedPartsDraft } from "@/lib/parts-breakout-scope";

// Re-derives the Prior ETC (and the Hours Left it implies) of every UNSUBMITTED
// row in one month from the months before it. The single writer behind both
// cascadePriorEtcForward and reopenMonth, so "what does this month open at" has
// exactly one answer wherever it is asked — priorEtcForMonth in lib/etc.ts, the
// same rule seedMonth applies.
//
// Three things it will not do:
//   • Touch a submitted (`needsReview` false) row. That is somebody's locked
//     decision, and rewriting it is the July-2026 history-corruption bug.
//   • Reset a job that STARTS in this month. Such a job opens at its quote
//     whatever the chain holds — the rule seedMonth and syncPartsCost both
//     apply. The cascade used to ignore this and would have walked jobs 1159
//     and 1160 (both starting July 2026, quoted 100/260/150 hours) back down to
//     the 0 their pre-quote June rows carried.
//   • Strand a draft. A draft that merely echoed the old suggestion moves with
//     the Prior it was derived from — see redrivenDraft.
//
// Rows whose job/section has no upstream history AND no quote keep whatever they
// hold: there is nothing to derive from, and this is not the function that
// invents an opening balance.
export async function derivePriorEtcForMonth(month: string): Promise<{ entriesUpdated: number }> {
  const entries = await prisma.etcEntry.findMany({ where: { month, needsReview: true } });
  if (entries.length === 0) return { entriesUpdated: 0 };

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

  const writes: { id: number; priorEtc: number; hoursLeftCalc: number; newEtcDraft: number | null }[] = [];
  for (const entry of entries) {
    const job = jobById.get(entry.jobId);
    if (!job) continue;
    const carried = priorByKey.get(`${entry.jobId}-${entry.section}`);
    const startsThisMonth = startsInMonth(job.startDate, month);
    // Parts Cost is MONEY, so its quote is the job's Parts Cost Quoted rather
    // than a per-section hours figure — the same split syncPartsCost makes.
    const quoted =
      entry.section === PARTS_COST_SECTION
        ? Number(job.costQuoted ?? 0)
        : Number(job.estimatedHours.find((q) => q.section === entry.section)?.quotedHours ?? 0);
    // Nothing upstream and nothing quoted: no basis to derive from, so leave it.
    if (carried === undefined && quoted === 0) continue;

    const priorEtc = priorEtcForMonth({ startsThisMonth, carried, quoted });
    const oldPriorEtc = round2(Number(entry.priorEtc));
    const hoursWorked = Number(entry.hoursWorked);
    const hoursLeftCalc = round2(calcHoursLeft(priorEtc, hoursWorked));
    const currentDraft = entry.newEtcDraft != null ? round2(Number(entry.newEtcDraft)) : null;
    // A breakout month's Parts Cost draft is DERIVED — leftToInvoice + leftToPurchase
    // — and this function knows nothing about those two columns, so redriving it would
    // leave the stored New ETC no longer equal to the halves stored beside it. See
    // isDerivedPartsDraft.
    const newEtcDraft = isDerivedPartsDraft(month, entry.section)
      ? currentDraft
      : redrivenDraft({
          draft: entry.newEtcDraft != null ? Number(entry.newEtcDraft) : null,
          oldPriorEtc,
          newPriorEtc: priorEtc,
          hoursWorked,
        });
    if (oldPriorEtc === priorEtc && round2(Number(entry.hoursLeftCalc)) === hoursLeftCalc && currentDraft === newEtcDraft) {
      continue;
    }
    writes.push({ id: entry.id, priorEtc, hoursLeftCalc, newEtcDraft });
  }

  if (writes.length === 0) return { entriesUpdated: 0 };
  await prisma.$transaction(
    writes.map((w) =>
      prisma.etcEntry.update({
        where: { id: w.id },
        data: { priorEtc: w.priorEtc, hoursLeftCalc: w.hoursLeftCalc, newEtcDraft: w.newEtcDraft },
      }),
    ),
  );
  return { entriesUpdated: writes.length };
}

// Pushes a corrected month's New ETC forward into the months that derive from
// it. Prior ETC of month N+1 IS the New ETC of month N (seedMonth, above), so
// re-submitting a corrected historical month leaves every later month holding
// a Prior ETC computed from the value that just changed — and Hours Left,
// the suggested New ETC, and every dollar figure downstream with it.
//
// Nothing else does this. seedMonth refreshes Prior ETC the same way, but it
// only runs from startMonth and Refresh Data, and Refresh Data is refused on
// anything but the current month (isSafeForLiveEtcSync) — so before this, a
// June correction sat in June until somebody happened to refresh July.
//
// Two rules, both about not repeating the July 2026 history-corruption bug:
//
//   • Only `needsReview` rows are rewritten. A submitted row is a decision
//     somebody made and locked; it is not this function's to revise. That is
//     derivePriorEtcForMonth's guarantee, which is what this walk delegates to.
//   • The walk STOPS at the first locked month rather than skipping past it.
//     If July is frozen, July's New ETC hasn't moved, so August's Prior ETC
//     is still correct — there is nothing downstream to fix, and continuing
//     would only risk touching months this correction never reached. The
//     stopped-at month is returned so the caller can say so out loud.
//
// Stopping is safe but not sufficient on its own: the month it stopped at is
// left holding a Prior ETC derived from the value that just changed under it.
// reopenMonth is what closes that gap — it re-derives on the way back in, which
// is the only moment those rows are unsubmitted and therefore this code's to
// touch. See the note there (July 2026, reported 2026-08-04).
export async function cascadePriorEtcForward(fromMonth: string): Promise<{
  monthsUpdated: string[];
  entriesUpdated: number;
  stoppedAtLockedMonth: string | null;
}> {
  const monthsUpdated: string[] = [];
  let entriesUpdated = 0;
  let stoppedAtLockedMonth: string | null = null;

  let current = nextMonth(fromMonth);

  // Bounded by the number of months that actually exist — a runaway here
  // would walk the calendar forever.
  for (;;) {
    const entries = await prisma.etcEntry.findMany({ where: { month: current }, select: { needsReview: true } });
    if (entries.length === 0) break; // no such month — end of the chain

    if (isMonthLocked(entries)) {
      stoppedAtLockedMonth = current;
      break;
    }

    // One writer for the whole rule — including the quoted opening for a job
    // that STARTS in `current`, which this walk used to ignore and would have
    // reset to the carried balance.
    const { entriesUpdated: updated } = await derivePriorEtcForMonth(current);
    if (updated > 0) {
      monthsUpdated.push(current);
      entriesUpdated += updated;
    }

    current = nextMonth(current);
  }

  return { monthsUpdated, entriesUpdated, stoppedAtLockedMonth };
}
