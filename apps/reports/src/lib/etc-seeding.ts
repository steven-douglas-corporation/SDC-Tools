import "server-only";
import { prisma } from "@/lib/prisma";
import { calcHoursLeft, round2, isValidMonth, isMonthLocked, latestPriorEtcByKey, priorEtcForMonth, redrivenDraft, startsInMonth } from "@/lib/etc";
import { etcActiveJobFilter } from "@/lib/job-filters";
import { ETC_TRACKED_CODES } from "@/lib/sections";
import { isDerivedPartsDraft } from "@/lib/parts-breakout-scope";

// ── Seeding an ETC month's rows ─────────────────────────────────────────────
//
// Split out of etc-actions.ts (2026-09-01) for one reason: etc-actions.ts is a
// `"use server"` module, so EVERY export in it is a callable Server Action
// endpoint. reseedOpenMonth is called by the hourly refresh pass
// (lib/auto-sync.ts), which has no session at all, so it cannot be gated with
// assertActionPermission — and leaving it exported from a "use server" file
// would have published an unauthenticated write endpoint purely to satisfy a
// caller that was never a browser in the first place.
//
// A plain `server-only` module has no such surface: nothing here is reachable
// from a client, and both callers import it as an ordinary function —
// startMonth (which IS permission-gated, in etc-actions.ts) and the refresh
// pass.

// Writes the rows for `month` per the shared opening-balance rule
// (priorEtcForMonth). Idempotent: already-submitted entries are left untouched,
// and a row whose figures have not moved is not rewritten.
export async function seedMonthRows(month: string): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  // Must be the exact filter the grid renders with — a job seeded here but
  // hidden there leaves entries no form input can ever confirm.
  const jobs = await prisma.job.findMany({
    where: etcActiveJobFilter,
    include: { estimatedHours: true },
  });
  const jobIds = jobs.map((j) => j.id);

  await prisma.$transaction(
    async (tx) => {
      // Read INSIDE the transaction, not before it — this snapshot is what
      // decides which rows are safe to touch (existing.needsReview), so it
      // must be as fresh as possible relative to the writes below. Reading
      // it before the transaction started left a window where a concurrent
      // Submit and Lock (committing between the pre-read and this write)
      // wouldn't be reflected here, and this loop can run long enough
      // (every active job × tracked section, up to the 20s timeout) for
      // that window to matter.
      const [priorEntries, existingEntries] = await Promise.all([
        // EVERY earlier month, not just prevMonth — a job that skipped a period
        // must resume from where its ETC actually left off, never from quoted.
        // See latestPriorEtcByKey for the balance-reset this fixed (job 1104,
        // 2026-08-02). Four narrow columns, so the extra rows are cheap.
        tx.etcEntry.findMany({
          where: { month: { lt: month }, jobId: { in: jobIds } },
          select: { jobId: true, section: true, month: true, newEtc: true },
        }),
        tx.etcEntry.findMany({ where: { month, jobId: { in: jobIds } } }),
      ]);
      const priorByKey = latestPriorEtcByKey(priorEntries);
      const existingByKey = new Map(existingEntries.map((e) => [`${e.jobId}-${e.section}`, e]));

      // Collected, then written in two shapes: one createMany for the rows that
      // don't exist yet, and an update per row that genuinely CHANGED.
      //
      // This used to issue an upsert per TRACKED job/section — 380 of them on
      // the current data, awaited one at a time inside this transaction, on
      // every Refresh Data click. Almost all of them wrote values identical to what was
      // already stored, because Prior ETC only moves when last month's New ETC
      // does. Now a repeat refresh writes nothing at all, and the transaction
      // holds open for a fraction of the time — which matters more than the
      // milliseconds, since submitMonth contends for these same rows.
      const toCreate: {
        jobId: number;
        section: string;
        month: string;
        priorEtc: number;
        hoursWorked: number;
        hoursLeftCalc: number;
        newEtc: number;
        needsReview: boolean;
      }[] = [];
      const toUpdate: { id: number; priorEtc: number; hoursLeftCalc: number; newEtcDraft: number | null }[] = [];

      // Sections that carry a balance forward but have no QUOTE behind them.
      //
      // Seeding used to iterate job.estimatedHours alone, so a section the job was
      // never quoted for could never be seeded — even when the previous month left
      // a New ETC sitting on it. That is now reachable: the grid lets a manager
      // plan any section (see parseNewEtcCreateFields), so a June cell at
      // Prior 0 / Worked 0 / New ETC 1 must arrive in July as Prior 1, exactly
      // like every quoted section. Without this it would be stranded — the
      // balance would simply vanish at the month boundary.
      //
      // Built from priorEntries rather than by parsing priorByKey's composite
      // keys: section codes contain a hyphen and so does the key separator.
      const priorSectionsByJob = new Map<number, Set<string>>();
      for (const p of priorEntries) {
        if (!ETC_TRACKED_CODES.has(p.section)) continue;
        let set = priorSectionsByJob.get(p.jobId);
        if (!set) priorSectionsByJob.set(p.jobId, (set = new Set()));
        set.add(p.section);
      }

      // A job whose Start Date falls IN this month opens at its quote, whatever
      // the carry-forward chain says (2026-08-03, by request).
      //
      // The rule used to be "no ETC history -> quoted", which is only a proxy for
      // this one and diverges exactly where it matters. Jobs 1159 and 1160 both
      // started in July but already had rows from earlier months — seeded before
      // anyone had entered their quote, so those rows carried 0. July then
      // inherited 0 against quotes of 100, 260 and 150, and 1160 read Hours Left
      // -175 on a job that had simply never been given its estimate.
      //
      // This is also Power BI's own rule: [ETC Historical Hours Prior Month] uses
      // [Hours Quoted] for a job whose Start Date falls in the period.
      //
      // Confirmed history is still untouched — the needsReview check below is what
      // guarantees that, so this can only ever correct an open month.
      for (const job of jobs) {
        const startsThisMonth = startsInMonth(job.startDate, month);
        const quotedBySection = new Map<string, number>();
        for (const eh of job.estimatedHours) {
          if (!ETC_TRACKED_CODES.has(eh.section)) continue;
          quotedBySection.set(eh.section, Number(eh.quotedHours));
        }
        // The union: everything quoted, plus everything with ETC history. A
        // section in both is visited once.
        const sectionsToSeed = new Set<string>([...quotedBySection.keys(), ...(priorSectionsByJob.get(job.id) ?? [])]);

        for (const section of sectionsToSeed) {
          const key = `${job.id}-${section}`;
          const existing = existingByKey.get(key);
          if (existing && !existing.needsReview) continue; // already submitted — don't touch confirmed history

          const carried = priorByKey.get(key);
          // NO ETC history at all -> QUOTED hours, not estimate-to-complete:
          // the report's own [ETC Historical Hours Prior Month] measure
          // (SemanticModel TMDL, verified 2026-07-17) uses [Hours Quoted] for
          // a job whose Start Date falls in the prior period. The two are
          // usually equal for a brand-new job, but ETC can drift from quoted
          // before the job's first ETC month — quoted is the report's rule.
          //
          // "No history at all" is the operative phrase, and it used to read
          // "no row in the immediately preceding month" — which reset a
          // worked-down balance back to full quote every time a job skipped a
          // period. See latestPriorEtcByKey.
          // A history-only section has no quote to fall back to — but `carried`
          // is always defined for it by construction, so the fallback is never
          // reached there. The ?? 0 is belt-and-braces, not a real branch.
          // startsThisMonth WINS over the carried balance — see the note above.
          //
          // Now the shared rule (lib/etc.ts) rather than this expression, so
          // cascadePriorEtcForward and reopenMonth cannot answer it differently.
          const priorEtc = priorEtcForMonth({ startsThisMonth, carried, quoted: quotedBySection.get(section) ?? 0 });
          const hoursWorked = existing ? Number(existing.hoursWorked) : 0;

          // newEtc is deliberately NOT written for an existing row — it's a
          // manager-entered value (submitMonth falls back to the suggestion only
          // at submission time). Rows display the live suggestion as a
          // placeholder until then; nothing needs to overwrite the column on
          // every startMonth/Refresh Data click before that.
          if (!existing) {
            toCreate.push({
              jobId: job.id,
              section,
              month,
              priorEtc,
              hoursWorked: 0,
              hoursLeftCalc: priorEtc,
              newEtc: priorEtc,
              needsReview: true,
            });
            continue;
          }

          const hoursLeftCalc = round2(calcHoursLeft(priorEtc, hoursWorked));
          // Compare on the ROUNDED figures actually stored, not raw Decimals:
          // Number(Decimal) round-trips can differ in the last bit, and treating
          // that as a change would write all 380 rows every time and defeat the
          // point of comparing at all.
          const unchanged =
            round2(Number(existing.priorEtc)) === round2(priorEtc) &&
            round2(Number(existing.hoursLeftCalc)) === hoursLeftCalc;
          if (unchanged) continue;
          // A draft that merely echoed the suggestion from the OLD Prior ETC moves
          // with it — see redrivenDraft. Without this, a Save taken before the
          // Prior settled froze that moment's figure into the cell for good.
          //
          // Unless the draft is DERIVED rather than typed: on a breakout month the
          // Parts Cost draft is leftToInvoice + leftToPurchase, and this function knows
          // nothing about those two columns, so redriving it would leave the stored New
          // ETC unequal to the halves stored beside it. See isDerivedPartsDraft.
          const newEtcDraft = isDerivedPartsDraft(month, section)
            ? existing.newEtcDraft != null
              ? round2(Number(existing.newEtcDraft))
              : null
            : redrivenDraft({
                draft: existing.newEtcDraft != null ? Number(existing.newEtcDraft) : null,
                oldPriorEtc: Number(existing.priorEtc),
                newPriorEtc: priorEtc,
                hoursWorked,
              });
          toUpdate.push({ id: existing.id, priorEtc, hoursLeftCalc, newEtcDraft });
        }
      }

      // One round-trip for every new row. skipDuplicates covers the narrow race
      // where a concurrent writer created the same (job, section, month) between
      // this transaction's read and this write: the other row wins, which is the
      // same outcome the per-row upsert gave.
      if (toCreate.length > 0) {
        await tx.etcEntry.createMany({ data: toCreate, skipDuplicates: true });
      }
      // Still one statement per changed row — each carries different values — but
      // now only for rows that moved, which on a repeat refresh is none.
      for (const u of toUpdate) {
        await tx.etcEntry.update({
          where: { id: u.id },
          data: { priorEtc: u.priorEtc, hoursLeftCalc: u.hoursLeftCalc, newEtcDraft: u.newEtcDraft },
        });
      }
      created = toCreate.length;
      updated = toUpdate.length;
      console.log(
        `[seedMonth] ${month}: ${toCreate.length} created, ${toUpdate.length} updated (of ${jobs.length} active jobs)`,
      );
    },
    { timeout: 20000 },
  );
  return { created, updated };
}

// Re-applies the seeding rule to a month that is ALREADY OPEN. Same writer as
// starting one — seedMonthRows above — minus the two things that only make
// sense when a month comes into existence: assertMonthSeedable (the month
// demonstrably exists) and pruneStaleEntries (deleting rows is a decision for a
// person, not for the hourly pass).
//
// This exists because the hours half of a month was frozen at the instant it
// was started, while the parts half re-derived on every refresh
// (syncPartsCost). That asymmetry is the August 2026 zero-Prior-ETC bug: August
// was seeded 2026-08-09, and jobs 1163 (quoted 2026-08-14), 1169 (created
// 2026-08-12) and 1151 (quoted 2026-08-28) all got their quotes AFTER that
// instant. Nothing ever re-ran the rule, so their quoted sections had no row at
// all — or a row created later by a punch landing on them, opening at 0 against
// quotes of 1,770 / 630 / 490 hours. Their PARTS_COST rows were correct the
// whole time, which is exactly the tell: $2,342,659 sat beside 17 departments
// reading zero.
//
// Safe on the schedule for the same reasons syncPartsCost is: submitted rows
// are never touched (seedMonthRows skips them), a locked month is refused
// outright, and a pass that changes nothing writes nothing.
//
// NO revalidatePath. This runs from the hourly pass in instrumentation.ts,
// outside any request, where revalidatePath throws "static generation store
// missing" — and it would throw AFTER the writes, so the step would be logged
// as failed having actually succeeded. syncPartsCost, the money-side twin of
// this function, has never called it either; the grid picks the new figures up
// on its next load like every other refreshed value.
export async function reseedOpenMonth(month: string): Promise<{ created: number; updated: number } | null> {
  if (!isValidMonth(month)) {
    throw new Error(`"${month}" is not a valid ETC month (expected YYYY-MM).`);
  }
  const entries = await prisma.etcEntry.findMany({ where: { month }, select: { needsReview: true } });
  // Not started. STARTING a month is a person's decision (see the note in
  // refresh-service.ts), and this function must never make it by accident.
  if (entries.length === 0) return null;
  if (isMonthLocked(entries)) return null;
  return await seedMonthRows(month);
}
