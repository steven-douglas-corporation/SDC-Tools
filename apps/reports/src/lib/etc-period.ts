// Deliberately not "server-only": this is a thin query over the same dataset
// powerbi-client already exposes, and the reconciliation scripts must be able
// to import it. A mapping this load-bearing needs to stay checkable from a
// script, which is how the drift below was caught in the first place.
import { runDax } from "@/lib/powerbi-client";

// Which Power BI ETC period corresponds to one of the app's months.
//
// ── Why this is not just a string format ───────────────────────────────────
//
// It used to be. Both PBI-facing syncs mapped by NAME — "May 2026" is app month
// "2026-05" — on the documented grounds that the period's Begin Date runs a
// month later (May's ETC is filled out in early June), so Begin Date would pull
// the wrong month.
//
// That mapping no longer holds. Measured against the punch export on
// 2026-07-31, which is dated by real work date and owes Power BI nothing:
//
//   • Every period upstream now carries a Begin Date one month AFTER its name
//     ("May 2026" -> 2026-06-01), and its Standard Fees figures are the app's
//     JUNE figures. Scored across 24 department-months, name-as-month matched
//     0 and name-minus-one matched 10 — and name-as-month was not merely worse,
//     it was wrong in every single cell.
//   • The app's own stored history is NOT affected: stored Hours Worked matches
//     punches in the same calendar month 11 times and the next month 0 times.
//     The archive is correctly labelled; the upstream NAME moved under it.
//
// So the name is not a reliable key any more, while the Begin Date describes
// the period unambiguously. This resolves by Begin Date and treats the name as
// a lookup token only — which is also stable if upstream relabels again.
//
// The pool ledger no longer depends on any of this (standard-pool-local.ts
// computes it from app data). What still does: the manual ETC history backfill,
// and syncCategoryPoolsFromPowerBi if anyone calls it directly.

export type EtcPeriod = {
  // The token to filter on: 'Estimated to Complete Period'[ETC Name].
  name: string;
  // The app month this period actually holds data for, from its Begin Date.
  month: string;
  // What the name alone would have implied. Differs from `month` whenever the
  // upstream labelling is offset — kept so callers can report the drift.
  monthFromName: string | null;
};

const MONTH_NAME_TO_NUM: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

// "Aug 2025" -> "2025-08". Null rather than throwing: an unparseable name is
// only fatal if there is also no Begin Date to fall back on.
function monthFromEtcName(name: string): string | null {
  const [mon, year] = String(name).split(" ");
  const mm = MONTH_NAME_TO_NUM[mon];
  if (!mm || !/^\d{4}$/.test(year ?? "")) return null;
  return `${year}-${mm}`;
}

function monthFromBeginDate(raw: unknown): string | null {
  if (raw == null) return null;
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Every ETC period upstream, each resolved to the app month it holds.
export async function fetchEtcPeriods(): Promise<EtcPeriod[]> {
  const rows = (await runDax(
    `EVALUATE SUMMARIZECOLUMNS('Estimated to Complete Period'[ETC Name], 'Estimated to Complete Period'[ETC Begin Date])`,
  )) as Record<string, unknown>[];

  const periods: EtcPeriod[] = [];
  let drifted = 0;
  for (const r of rows) {
    const name = String(r["Estimated to Complete Period[ETC Name]"] ?? "");
    if (!name) continue;
    const fromName = monthFromEtcName(name);
    const fromBegin = monthFromBeginDate(r["Estimated to Complete Period[ETC Begin Date]"]);
    // Begin Date wins. Only when it is missing entirely does the name stand in
    // — better a period keyed off a suspect name than a period silently
    // dropped from a backfill.
    const month = fromBegin ?? fromName;
    if (!month) continue;
    if (fromName && fromBegin && fromName !== fromBegin) drifted++;
    periods.push({ name, month, monthFromName: fromName });
  }

  if (drifted > 0) {
    // Stated out loud every time rather than assumed: if upstream ever moves
    // the labelling back, this line disappearing is the signal.
    console.warn(
      `[etc-period] ${drifted}/${periods.length} periods have a Begin Date month that disagrees with their ETC Name. ` +
        `Resolving by Begin Date (see etc-period.ts). Names alone would map these to the wrong month.`,
    );
  }

  return periods.sort((a, b) => a.month.localeCompare(b.month));
}

// The [ETC Name] token to filter on for a given app month, or null when
// upstream has no period for it yet (the normal case for the in-progress
// month — periods are published roughly two months behind).
export async function resolveEtcPeriodName(month: string): Promise<string | null> {
  const periods = await fetchEtcPeriods();
  return periods.find((p) => p.month === month)?.name ?? null;
}
