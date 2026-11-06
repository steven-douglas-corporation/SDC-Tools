import "server-only";
import { readPartsEtcBreakout } from "@/lib/parts-etc-breakout";
import { bookedNetFor, getPartsCostBookedByJob } from "@/lib/sync-totaleto";
import { monthWindowUtc } from "@/lib/etc";
import { withTimeoutOrNull, UPSTREAM_BUDGET_MS } from "@/lib/with-timeout";

// ── The one source for a month's Parts figures ───────────────────────────────
//
// Left to Invoice and Money Spent Month for a set of jobs and ONE month. Everything
// that shows these two numbers outside the Parts List reads them from here or from the
// same two functions underneath:
//
//   Left to Invoice   readPartsEtcBreakout — what Monthly ETC's grid cell reads. Returned
//                     UNFLOORED (`rawLeftToInvoice`), because Monthly ETC's cell is
//                     deliberately signed too.
//   Money Spent       getPartsCostBookedByJob + bookedNetFor — what syncPartsCost stores
//                     on the Monthly ETC Parts Cost row.
//
// The Job Details Parts List is built a different way on purpose (BOM-first), which is
// what makes it a real cross-check: lib/parts-parity.ts compares it against this.

export type PartsMonthFigure = {
  /** Null = Total ETO could not be read ("—"), never a silent $0. */
  leftToInvoice: number | null;
  moneySpent: number | null;
};

export type PartsMonthFigures = {
  month: string;
  byJobPk: Map<number, PartsMonthFigure>;
  leftToInvoiceFailed: boolean;
  moneySpentFailed: boolean;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function getPartsMonthFigures(
  jobs: readonly { pk: number; jobNumber: string }[],
  month: string,
): Promise<PartsMonthFigures> {
  const { start, endExclusive } = monthWindowUtc(month);
  const [breakout, booked] = await Promise.all([
    readPartsEtcBreakout(jobs.map((j) => ({ pk: j.pk, jobNumber: j.jobNumber })), month),
    withTimeoutOrNull(
      `TotalETO money spent ${month} (parts month figures)`,
      UPSTREAM_BUDGET_MS,
      () => getPartsCostBookedByJob(start, endExclusive),
      (e) => console.error("[parts-month-figures] getPartsCostBookedByJob failed:", e),
    ),
  ]);

  const byJobPk = new Map<number, PartsMonthFigure>();
  for (const j of jobs) {
    const lti = breakout.byJobPk.get(j.pk)?.rawLeftToInvoice ?? null;
    byJobPk.set(j.pk, {
      leftToInvoice: breakout.linesFailed || lti === null ? null : round2(lti),
      moneySpent: booked ? round2(bookedNetFor(booked.net, j.jobNumber)) : null,
    });
  }
  return { month, byJobPk, leftToInvoiceFailed: breakout.linesFailed, moneySpentFailed: booked === null };
}
