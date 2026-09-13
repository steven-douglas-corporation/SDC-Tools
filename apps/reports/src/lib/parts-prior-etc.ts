import "server-only";
import { prisma } from "@/lib/prisma";
import { PARTS_COST_SECTION } from "@/lib/sections";

// ── Prior-month ETC and this month's parts spend, for one ETC month ──────────
//
// The two inputs to `adjustedEtc = max(0, priorEtc - partsSpentThisMonth)`.
//
// ── Why both come off the SELECTED month's own row ──────────────────────────
//
// EtcEntry already stores, per job per month per section, exactly the two figures
// Dan's model wants:
//
//   priorEtc      the previous month's confirmed New ETC, carried forward by the
//                 Monthly ETC chain. So spec §2's "Prior ETC = previous month's
//                 submitted New ETC" is a field read, not a second query into last
//                 month — and it is the same value the Monthly ETC grid renders in
//                 its own "Prior ETC" column, which is what §17 asks for.
//   hoursWorked   despite the name (the column is shared with the hours sections),
//                 on a Parts Cost row this is the month's booked parts cost — the
//                 grid's "Money Spent Month", synced by syncPartsCost from that
//                 month's AP window. Spec §18's "only the correct selected-month
//                 spend", by construction: it is a per-month column.
//
// Reading last month's `newEtc` directly instead would be a second, parallel
// definition of the carry-forward that could disagree with the grid's — the exact
// drift §17 exists to prevent.
//
// ── §20, stated plainly ─────────────────────────────────────────────────────
//
// This is deliberately NOT the selected month's own `newEtc`. That is the manager's
// entry for NEXT month's baseline; using it here would make the yellow segment jump
// the moment somebody typed, and it is the confusion §20 calls out by name.

export type PriorEtcResolution = {
  /** The forecast this month starts from. Null when it cannot be resolved at all. */
  priorEtc: number | null;
  /** The month's canonical booked parts cost. */
  partsSpentThisMonth: number;
  /** Where `priorEtc` came from, so the drill-through can say. */
  source: "carry-forward" | "quoted-parts" | "none";
  month: string | null;
};

const NONE: PriorEtcResolution = { priorEtc: null, partsSpentThisMonth: 0, source: "none", month: null };

/**
 * Resolve the two figures for each job, for `month`.
 *
 * `month` is the ETC month the card has already resolved, so every figure on the
 * card describes the same month.
 */
export async function readPriorEtcByJob(
  jobPks: number[],
  month: string | null,
): Promise<Map<number, PriorEtcResolution>> {
  const out = new Map<number, PriorEtcResolution>();
  if (jobPks.length === 0 || !month) return out;

  const rows = await prisma.etcEntry.findMany({
    where: { jobId: { in: jobPks }, section: PARTS_COST_SECTION, month },
    select: { jobId: true, month: true, priorEtc: true, hoursWorked: true },
  });

  // ── §19: a job's FIRST parts ETC month opens at the quoted parts value ────
  //
  // On a first month there is no previous month to carry forward from, so the stored
  // `priorEtc` is 0 — and 0 is also a legitimate carried-forward value on a job
  // whose manager forecast nothing more. The two are indistinguishable from the row
  // alone, so "is this the first month" is asked directly: does any EARLIER parts
  // row exist for this job?
  //
  // Spec §19: "Do not default to zero." A first month defaulting to zero would show
  // a job's entire opening exposure as uncovered on the very first month it is
  // planned, which is the false alarm this rule exists to prevent.
  const firstMonthCandidates = rows.filter((r) => Number(r.priorEtc) === 0).map((r) => r.jobId);
  const hasEarlier = new Set<number>();
  if (firstMonthCandidates.length > 0) {
    const earlier = await prisma.etcEntry.findMany({
      where: {
        jobId: { in: firstMonthCandidates },
        section: PARTS_COST_SECTION,
        month: { lt: month },
      },
      select: { jobId: true },
      distinct: ["jobId"],
    });
    for (const e of earlier) hasEarlier.add(e.jobId);
  }

  const needQuote = firstMonthCandidates.filter((pk) => !hasEarlier.has(pk));
  const quotedByJob = new Map<number, number>();
  if (needQuote.length > 0) {
    const quoted = await prisma.job.findMany({
      where: { id: { in: needQuote } },
      select: { id: true, costQuoted: true },
    });
    for (const q of quoted) {
      if (q.costQuoted != null) quotedByJob.set(q.id, Number(q.costQuoted));
    }
  }

  for (const r of rows) {
    const stored = Number(r.priorEtc);
    const spent = Number(r.hoursWorked);
    const isFirstMonth = stored === 0 && !hasEarlier.has(r.jobId);
    const quoted = quotedByJob.get(r.jobId);

    out.set(r.jobId, {
      // A first month with no quote on file keeps 0 rather than inventing a figure:
      // an absent quote is not a forecast, and `source` says which it was.
      priorEtc: isFirstMonth && quoted != null ? quoted : stored,
      partsSpentThisMonth: Number.isFinite(spent) ? spent : 0,
      source: isFirstMonth && quoted != null ? "quoted-parts" : "carry-forward",
      month: r.month,
    });
  }

  for (const pk of jobPks) if (!out.has(pk)) out.set(pk, NONE);
  return out;
}

/**
 * One pair of figures for a SELECTION of jobs, summed — the card's other totals are
 * summed the same way, so the forecast it draws has to be the total of the selection's
 * forecasts.
 *
 * A job with no parts row for the month contributes nothing rather than a zero prior
 * ETC, so one unplanned job cannot drag a selection's forecast down to meet it.
 * `priorEtc` is null only when NO job in the selection resolved one, which is
 * distinct from a total of 0.
 */
export function sumPriorEtc(
  jobPks: number[],
  byJob: Map<number, PriorEtcResolution>,
): PriorEtcResolution {
  let priorEtc = 0;
  let spent = 0;
  let any = false;
  let anyQuoted = false;
  const months = new Set<string>();

  for (const pk of jobPks) {
    const hit = byJob.get(pk);
    if (!hit || hit.source === "none" || hit.priorEtc == null) continue;
    any = true;
    if (hit.source === "quoted-parts") anyQuoted = true;
    priorEtc += hit.priorEtc;
    spent += hit.partsSpentThisMonth;
    if (hit.month) months.add(hit.month);
  }

  if (!any) return NONE;
  return {
    priorEtc,
    partsSpentThisMonth: spent,
    // A selection mixing a first month with carried-forward ones is reported as the
    // weaker of the two, since the total is then not purely a carry-forward.
    source: anyQuoted ? "quoted-parts" : "carry-forward",
    month: months.size === 1 ? [...months][0] : null,
  };
}
