import "server-only";
import { prisma } from "@/lib/prisma";
import { PARTS_COST_SECTION } from "@/lib/sections";
import { calcHoursLeft, effectiveNewEtc, isNewEtcDecided, newEtcDiff, round2 } from "@/lib/etc";

// ── The drill behind the "Parts spent" card, one row per JOB ─────────────────
//
// The other four cards on the strip could be opened and read; this one was a single
// dollar figure with nothing behind it. "$1,417,072 spent" is not a number anybody can
// act on — the question is always WHICH jobs, and that had no answer on this page.
//
// One row per job rather than per invoice, because Parts Cost is stored that way: the
// ETC month holds exactly one PARTS_COST entry per job, so a job IS the grain here.
// (Contrast the hours drill beside it, which groups punch-level rows by employee.)
//
// ── Reconciling with the card (§28.15) ──────────────────────────────────────
//
// Every figure comes from the SAME EtcEntry rows and the SAME functions
// getEtcMonthKpis uses — effectiveNewEtc, newEtcDiff, calcHoursLeft — so the drill's
// totals are the card's figures by construction rather than by coincidence. The one
// thing this must never become is a second definition of "parts spent": that is how a
// card and its own detail come to disagree, which is the defect §28 exists against.
//
// Scoped to the jobs the caller passes, which is the set the GRID is rendering. A
// drill that summed jobs the grid filters out would answer a different question from
// the card that opened it.

export type PartsSpentRow = {
  // The app's internal id, for the Scheduler deep-link and as a React key.
  id: number;
  // The job NUMBER people say out loud ("1105"), not the database id.
  jobId: string;
  jobName: string;
  // The parts budget this month opened with.
  prior: number;
  // Money invoiced against the job this month. Genuinely negative on a credit note or
  // a returned part — the same asymmetry the Hours Worked column carries for parts.
  spent: number;
  // prior − spent. Not clamped: a job can be overspent, and hiding that would be the
  // point of the drill lost.
  left: number;
  // What the manager has planned for the rest of the job.
  newEtc: number;
  diff: number;
  // Has anybody actually entered a New ETC here? An undecided cell contributes 0 to
  // the variance (newEtcDiff), and the panel says so rather than printing a confident
  // figure nobody chose.
  decided: boolean;
};

export type PartsSpentDetail = {
  rows: PartsSpentRow[];
  // Column totals, summed from `rows` so the footer cannot drift from the list above
  // it — and so they can be checked against the card.
  totals: { prior: number; spent: number; left: number; newEtc: number; diff: number };
  // Jobs with a parts row but nothing spent and nothing planned. Counted rather than
  // listed: they are the majority on most months and they are not what anybody opened
  // this to see.
  quietJobs: number;
};

export async function getPartsSpentDetail(month: string, jobIds: number[]): Promise<PartsSpentDetail> {
  const empty: PartsSpentDetail = {
    rows: [],
    totals: { prior: 0, spent: 0, left: 0, newEtc: 0, diff: 0 },
    quietJobs: 0,
  };
  if (jobIds.length === 0) return empty;

  const entries = await prisma.etcEntry.findMany({
    where: { month, section: PARTS_COST_SECTION, jobId: { in: jobIds } },
    select: {
      priorEtc: true,
      hoursWorked: true,
      newEtc: true,
      newEtcDraft: true,
      needsReview: true,
      job: { select: { id: true, jobId: true, jobName: true } },
    },
  });

  const rows: PartsSpentRow[] = [];
  let quietJobs = 0;
  for (const e of entries) {
    const prior = Number(e.priorEtc);
    const spent = Number(e.hoursWorked);
    const newEtc = effectiveNewEtc(e);
    const decided = isNewEtcDecided(e);
    // Nothing spent, nothing planned, no budget — a row that exists because the month
    // was seeded, not because anything happened. Counted, not listed.
    if (spent === 0 && prior === 0 && newEtc === 0) {
      quietJobs++;
      continue;
    }
    rows.push({
      id: e.job.id,
      jobId: e.job.jobId,
      jobName: e.job.jobName,
      prior: round2(prior),
      spent: round2(spent),
      left: round2(calcHoursLeft(prior, spent)),
      newEtc: round2(newEtc),
      diff: round2(newEtcDiff(e)),
      decided,
    });
  }

  // Biggest spend first — the drill is opened to find out where the money went, and
  // that ordering answers it in the first row rather than the fortieth. Jobs with no
  // spend this month sort to the bottom by their remaining budget, which is the next
  // most useful thing about them.
  rows.sort((a, b) => b.spent - a.spent || b.left - a.left);

  const totals = rows.reduce(
    (t, r) => ({
      prior: t.prior + r.prior,
      spent: t.spent + r.spent,
      left: t.left + r.left,
      newEtc: t.newEtc + r.newEtc,
      diff: t.diff + r.diff,
    }),
    { prior: 0, spent: 0, left: 0, newEtc: 0, diff: 0 },
  );

  return {
    rows,
    totals: {
      prior: round2(totals.prior),
      spent: round2(totals.spent),
      left: round2(totals.left),
      newEtc: round2(totals.newEtc),
      diff: round2(totals.diff),
    },
    quietJobs,
  };
}
