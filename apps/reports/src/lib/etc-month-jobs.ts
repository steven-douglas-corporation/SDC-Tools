import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { etcActiveJobFilter, etcEligibleJobFilter } from "@/lib/job-filters";

// The single source of truth for "which jobs belong to an ETC month" — used by
// the Monthly ETC grid AND the Standard Sheet so both always list the exact
// same projects for a given month/year.
//
// Mirrors the grid's own rule:
// - A LOCKED month (has entries, none still need review) is a frozen snapshot:
//   show exactly the jobs that have entries in it, whatever their status is
//   today. Filtering by current status would hide every job completed since,
//   making history show fewer jobs than were actually submitted.
// - A REOPENED HISTORICAL month (has entries, some pending, but a newer month
//   exists) keeps that same entries-based universe. Found 2026-07-14: using
//   etcActiveJobFilter here rendered a reopened April against TODAY's job
//   roster — 7 since-completed jobs vanished from the grid, and the follow-up
//   Submit pruned their real entries (366 → 323 rows) because they had no
//   form inputs. Reopening history must never change which jobs are in it.
// - Only the SINGLE current in-progress (or not-yet-started) month uses
//   etcActiveJobFilter — the live universe seeding/pruning/submission operate on.
export async function getEtcMonthJobWhere(month: string): Promise<{ where: Prisma.JobWhereInput; monthIsLocked: boolean }> {
  const [entryCount, pendingCount, latest] = await Promise.all([
    prisma.etcEntry.count({ where: { month } }),
    prisma.etcEntry.count({ where: { month, needsReview: true } }),
    prisma.etcEntry.findFirst({ orderBy: { month: "desc" }, select: { month: true } }),
  ]);
  const monthIsLocked = entryCount > 0 && pendingCount === 0;
  const isHistorical = entryCount > 0 && latest != null && month < latest.month;
  return {
    // ── The entries-based branch applies ELIGIBILITY, not lifecycle (2026-08-10) ──
    //
    // It used to apply only the type gate, which let a submitted or historical month
    // render every job that merely HAD entries in it — including the non-billable
    // ones the live month excludes. Measured before this change: June (locked) showed
    // 48 jobs of which 4 were non-billable, and JULY showed 55 of which 7 were —
    // July because `isHistorical` fires the moment August is started, so an
    // in-progress month silently switched job universes underneath the team and its
    // Engineering/Shop/Parts Spent KPIs jumped with it.
    //
    // etcEligibleJobFilter is the half of etcActiveJobFilter that is NOT about
    // lifecycle (see job-filters.ts): billable, not HeadStart, valid type. Completed
    // jobs still render, which is the whole point of this branch — 1115 Wet Hi-Pot is
    // Complete and billable, and its June rows are real submitted history. What no
    // longer renders is a job that was never an ETC project at all.
    //
    // This is what makes the scope IDENTICAL before and after submission: both
    // branches now answer to the same eligibility rule, and only the lifecycle half
    // differs — deliberately, and only for months that are already closed.
    where: monthIsLocked || isHistorical ? { etcEntries: { some: { month } }, ...etcEligibleJobFilter } : etcActiveJobFilter,
    monthIsLocked,
  };
}
