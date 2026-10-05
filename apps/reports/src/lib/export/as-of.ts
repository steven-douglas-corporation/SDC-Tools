// No imports on purpose: the Export menu (a client component) shares AS_OF_MIN from here,
// and anything this file pulled in would be pulled into the browser bundle with it.

// ── "Values as of" for the Projects export (2026-10-05, by request) ────────────
//
// An export-only date. The Projects grid, every stored figure and every sync stay live;
// this only changes what ONE downloaded file contains. Blank is the default and means
// "live, as of now" — byte for byte what the export did before this existed.
//
// Pure and free of `server-only`, so the rules are unit-tested without a database.
//
// ── What the date cuts, and what it cannot ────────────────────────────────────
//
//   CUT      Actual hours, by punch date (JobHoursDetail.workDate).
//            Parts Cost actuals, by AP document date (APBD.APDocDate) — the same date
//            "Money Spent Month" windows on.
//   NOT CUT  Quoted hours, Parts Cost Quoted, Status, Start/Complete Date: those are the
//            CURRENT values, because no history of them is kept. The export says so.
//
// ── Why there is a floor ──────────────────────────────────────────────────────
//
// The oldest hours exist only as one lifetime total per job and section, "through
// 2025-01-31" (the Excel migration snapshot), and as one frozen figure per closed ETC
// month. Neither can be split at a day, so a date before the snapshot's own end would
// quietly keep hours worked after it. Rather than return a wrong number, the date must
// be on or after that day.
export const AS_OF_MIN = "2025-01-31";

export type AsOfParse = { ok: true; asOf: string | null } | { ok: false; error: string };

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Validates the `asOf` query parameter. `today` is YYYY-MM-DD, passed in so this stays
 * pure. Blank/absent is valid and means "live".
 */
export function parseAsOf(raw: string | null | undefined, today: string): AsOfParse {
  const v = (raw ?? "").trim();
  if (v === "") return { ok: true, asOf: null };
  if (!isRealDate(v)) return { ok: false, error: `"Values as of" must be a real date written YYYY-MM-DD (got "${v}").` };
  if (v < AS_OF_MIN) {
    return {
      ok: false,
      error: `"Values as of" cannot be earlier than ${AS_OF_MIN}: older hours are stored only as one lifetime total, which cannot be cut at a day.`,
    };
  }
  if (v > today) return { ok: false, error: `"Values as of" cannot be in the future (${v}). Leave it blank for today's live figures.` };
  return { ok: true, asOf: v };
}

/** `2026-09-30` -> `2026-09-30` is a month end; `2026-09-15` is not. Calendar-correct, leap years included. */
export function isMonthEnd(asOf: string): boolean {
  const [y, m, d] = asOf.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate() === d;
}

/**
 * How a cutoff maps onto the hours sources.
 *
 *   punchThrough    a punch counts when workDate <= this day (UTC midnight, matching how
 *                   the DATE column is compared elsewhere).
 *   frozenMonthCap  the last ETC month whose frozen figure may count. A frozen month is
 *                   ONE number for the whole month, so it counts only once the month has
 *                   fully ended on or before the cutoff: a cutoff mid-month keeps the
 *                   months before it, not the one it falls in.
 */
export function asOfWindow(asOf: string): { punchThrough: Date; frozenMonthCap: string } {
  const month = asOf.slice(0, 7);
  return {
    punchThrough: new Date(`${asOf}T00:00:00.000Z`),
    frozenMonthCap: isMonthEnd(asOf) ? month : previousMonth(month),
  };
}

// `2026-01` -> `2025-12`. UTC arithmetic, so the result cannot depend on the server's zone.
function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
