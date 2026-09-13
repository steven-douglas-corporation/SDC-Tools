"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { effectiveNewEtc } from "@/lib/etc";
import { PARTS_COST_SECTION } from "@/lib/sections";
import { withDrillErrors } from "@/lib/drill-error";

// The rows behind the Parts Cost card's ETC figure.
//
// ── What "ETC detail" can and cannot mean ───────────────────────────────────
//
// There is no per-PART ETC anywhere in this system, and there never was: parts ETC
// is one figure per job per month, maintained on the Monthly ETC grid. Apportioning
// it across part rows by value would produce a table that sums correctly and means
// nothing, so the drill does not do that.
//
// What the figure IS made of is its own history — the monthly drawdown. Each
// `EtcEntry` for section PARTS_COST carries where the month started (`priorEtc`),
// what was booked against it (`hoursWorked`, dollars for this section rather than
// hours), and where the manager left it (`newEtc`/`newEtcDraft`). Read down the
// months, that chain is the honest answer to "where did this number come from",
// and it is the same chain the Monthly ETC grid itself renders.
//
// ── Fetched on open, like every other drill on this page ────────────────────
//
// This is the one Parts Cost drill mode that needs the server: the invoiced and
// left-to-invoice modes re-sum `financials.lines`, already on the client. Loading
// it with the page would put a query behind a panel nobody has opened, on a route
// that re-renders far more often than it is navigated to — the same reasoning
// hours-detail-actions.ts records for the punch drill.

export type PartsEtcMonth = {
  month: string;
  /** Where the month opened — last month's confirmed New ETC. */
  priorEtc: number;
  /** Parts dollars booked against the job that month (this section stores dollars, not hours). */
  spent: number;
  /** The effective New ETC — confirmed if submitted, else the draft, else the suggestion. */
  newEtc: number;
  /** False once the month is submitted; true while the figure is still a draft or a suggestion. */
  needsReview: boolean;
  submittedAt: string | null;
  enteredBy: string | null;
};

export async function loadPartsEtcHistory(jobIds: number[]): Promise<PartsEtcMonth[]> {
  // A server action is a public endpoint of its own, whatever guards the page has.
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in.");
  if (jobIds.length === 0) return [];

  return withDrillErrors({
    metric: "Parts ETC history",
    context: { jobIds },
    upstream: "local",
    run: async () => {
    const entries = await prisma.etcEntry.findMany({
      where: { jobId: { in: jobIds }, section: PARTS_COST_SECTION },
      select: {
        month: true,
        priorEtc: true,
        hoursWorked: true,
        newEtc: true,
        newEtcDraft: true,
        needsReview: true,
        submittedAt: true,
        enteredBy: { select: { name: true } },
      },
      orderBy: { month: "asc" },
    });

    // Summed by month, because a multi-job selection has one entry per job per
    // month and the card's own figure is the same sum. `effectiveNewEtc` is called
    // per ENTRY and then added — not on some merged pseudo-entry — since the
    // confirmed/draft/suggested rule is decided per job, and a submitted job and an
    // untouched one in the same month resolve differently.
    const byMonth = new Map<string, PartsEtcMonth>();
    for (const e of entries) {
      const row = byMonth.get(e.month) ?? {
        month: e.month,
        priorEtc: 0,
        spent: 0,
        newEtc: 0,
        needsReview: false,
        submittedAt: null as string | null,
        enteredBy: null as string | null,
      };
      row.priorEtc += Number(e.priorEtc);
      row.spent += Number(e.hoursWorked);
      row.newEtc += effectiveNewEtc(e);
      // A month is only "settled" when every job in it is. One unsubmitted job
      // makes the month's figure provisional, and saying otherwise would present a
      // draft as a decision.
      row.needsReview = row.needsReview || e.needsReview;
      row.submittedAt = row.submittedAt ?? e.submittedAt?.toISOString() ?? null;
      row.enteredBy = row.enteredBy ?? e.enteredBy?.name ?? null;
      byMonth.set(e.month, row);
    }
      return [...byMonth.values()];
    },
  });
}
