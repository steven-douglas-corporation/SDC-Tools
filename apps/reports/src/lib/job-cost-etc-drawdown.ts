import { suggestNewEtc } from "@/lib/etc";

// ── Profitability's ETC, drawn down by what has happened since it was submitted ──
//
// The ETC columns read the latest SUBMITTED month's frozen New ETC ("Submitted ETC for
// 2026-09"). That figure is the estimate to complete AS OF that submission. Every hour
// worked and every dollar of parts invoiced since then is already in Act Hrs / Parts
// Invoiced, so leaving the submitted figure untouched counted that work twice: once as
// actual, once more as still-to-do.
//
// Job 1130 on 2026-10-23: Sep submitted ETC Eng 120 / Shop 879 / Parts $23,941; October
// so far had 38h booked to Electrical Build (ETC 584) and $7,564 of parts invoiced, all of
// it already inside the actuals.
//
// The drawdown is the Monthly ETC grid's OWN rule, applied per section and month on top of
// the submitted figure — not a second definition of "remaining":
//
//   next = suggestNewEtc(prior, worked)   // worked === 0 -> prior; else max(prior - worked, 0)
//
// Per SECTION, never netted across a job's sections: hours booked to a section with no
// estimate left (System Design after the design is done) are an overrun on that section
// and do not shrink the Machine Testing hours still ahead. That is also what keeps this
// from UNDER-counting: netting at the job level would remove forecast work that has not
// been done. A month with no activity leaves the figure exactly as submitted.

/** month ("YYYY-MM") -> hours worked, or dollars of parts invoiced, in that month. */
export type MonthlyAmounts = ReadonlyMap<string, number>;

export type EtcActivity = {
  /** section code -> month -> hours worked after the submitted month. */
  hours: ReadonlyMap<string, MonthlyAmounts>;
  /** month -> GL-posted parts spend after the submitted month. */
  parts: MonthlyAmounts;
};

export const NO_ETC_ACTIVITY: EtcActivity = { hours: new Map(), parts: new Map() };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * `start` carried forward through each month's activity, oldest first — the grid's
 * month-to-month carry (this month's New ETC is next month's Prior ETC).
 */
export function drawDownEtc(start: number, byMonth: MonthlyAmounts | undefined): number {
  if (!byMonth || byMonth.size === 0) return start;
  let value = start;
  for (const month of [...byMonth.keys()].sort()) value = suggestNewEtc(value, byMonth.get(month) ?? 0);
  return round2(value);
}
