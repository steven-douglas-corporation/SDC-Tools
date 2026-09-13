"use server";

import { auth } from "@/lib/auth";
import type { TmPartsDrillKey, TmPartsDrillRow } from "@/lib/tm-report";
import { loadTmPartsLines, tmDrillRowsFrom } from "@/lib/tm-parts-source";
import { getTmHoursDrillRows, resolveTmJobPks, type TmHoursDrillKey, type TmHoursDrillRow } from "@/lib/tm-hours";
import { TM_HOURS_KEYS } from "@/lib/tm-hours-classify";
import { sanitizeJobIds, isValidDateRange } from "@/lib/tm-drill-validate";
import { withDrillErrors } from "@/lib/drill-error";

// The T&M KPI cards' drill-through, fetched WHEN A CARD IS CLICKED — same
// reasoning as loadEtcMonthHoursDetail/loadPartsSpentDetail in
// hours-detail-actions.ts: this is real I/O, not a page-load concern, for a
// panel most sessions never open.
//
// Two different backends behind these two actions, by design (2026-08-19):
// the four Hours cards read the app's own local Paylocity ingest (same
// pipeline Monthly ETC's hours already use — see tm-hours.ts's header), the
// three dollar cards still read live Power BI. Nothing here should ever
// route an hours key through fetchTmPartsDrill or vice versa — the two
// HOURS_KEYS/PARTS_KEYS lists exist specifically to keep that boundary a
// runtime-checked fact, not just a convention. Neither path falls back to
// the other on failure — an hours query that fails stays failed rather than
// silently re-querying Power BI, which would make the runtime source
// selection unpredictable and defeat the whole point of moving off it.
//
// ── Failures are logged here, not shown here (2026-08-19) ───────────────────
//
// A raw Prisma error can name a table/column; a raw Power BI DAX error can be
// startlingly detailed about the model's own internals (see
// docs/SEMANTIC-MODEL-MAP.md's `Hours Actual` example). Neither belongs in
// front of a user. `withDrillErrors` (lib/drill-error.ts) is the one seam both actions go
// through: it logs the full exception server-side with enough context to
// actually debug an intermittent failure (metric, job selection, date range,
// which source, how long it ran, a request id), and hands the CLIENT back
// only a generic message plus that request id for correlating a support
// report to this exact log line.

// DERIVED from TM_HOURS_KEYS, not written out again (2026-09-08). This was a
// hand-maintained list of four, and it silently outlived the fifth card:
// `otherHours` was added 2026-09-01 and the type, TM_HOURS_KEYS and
// TmReportClient.tsx's HOURS_DRILL_KEYS were all updated with it — this
// fourth copy was not. So the Other Hours card rendered and was clickable,
// and every click threw `Invalid drill key "otherHours"` from the guard
// below, even though getTmHoursDrillRows handles that key correctly.
//
// The hours/parts boundary this list enforces is unchanged and still a
// runtime-checked fact; it just can no longer disagree with the classifier
// about which keys exist. Same reason HOURS_CODES_BY_KEY was deleted on
// 2026-09-01 — a second definition of one mapping is a thing that drifts.
const HOURS_KEYS: readonly TmHoursDrillKey[] = TM_HOURS_KEYS;
const PARTS_KEYS: TmPartsDrillKey[] = ["partInvoicedAmount", "sdcManufacturedPartsSalesPrice", "expenseReports"];

function requireDateRange(startDate: string, endDate: string): void {
  if (!isValidDateRange(startDate, endDate)) throw new Error("Invalid date range.");
}

// The shared helper (lib/drill-error.ts). This file's own `withDrillLogging` WAS
// that implementation; it moved so the Monthly ETC parts drill could use the same
// one rather than a second copy. Same behaviour, plus one addition: an upstream
// that is unreachable now says so by name instead of "Couldn't load this detail",
// which is what a Total ETO outage on 2026-09-01 showed was worth distinguishing.
type DrillSource = "paylocity" | "powerbi";

const UPSTREAM_FOR: Record<DrillSource, "totaleto" | "powerbi" | "local"> = {
  // The hours drills read the app's own database (the Paylocity ingest), so a
  // failure there is a local one — never an integration being down.
  paylocity: "local",
  powerbi: "powerbi",
};

export async function loadTmHoursDrill(
  key: TmHoursDrillKey,
  jobIds: string[],
  startDate: string,
  endDate: string,
): Promise<TmHoursDrillRow[]> {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in.");
  if (!HOURS_KEYS.includes(key)) throw new Error(`Invalid drill key "${key}".`);
  requireDateRange(startDate, endDate);
  const cleanJobIds = sanitizeJobIds(jobIds);
  return withDrillErrors({
    metric: key,
    context: { jobIds: cleanJobIds, startDate, endDate, source: "paylocity" },
    upstream: UPSTREAM_FOR.paylocity,
    run: async () => {
      const jobPks = await resolveTmJobPks(cleanJobIds);
      // `truncated` isn't surfaced to the panel today — MAX_ROWS (4000) is far
      // above any real job/date-range selection; if it's ever hit in practice,
      // the dev-only reconciliation check (TmReportClient.tsx) will show a
      // nonzero difference, which is the signal to add a "truncated" note here.
      const { rows } = await getTmHoursDrillRows(jobPks, startDate, endDate, key);
      return rows;
    },
  });
}

export async function loadTmPartsDrill(
  key: TmPartsDrillKey,
  jobIds: string[],
  startDate: string,
  endDate: string,
): Promise<TmPartsDrillRow[]> {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in.");
  if (!PARTS_KEYS.includes(key)) throw new Error(`Invalid drill key "${key}".`);
  requireDateRange(startDate, endDate);
  const cleanJobIds = sanitizeJobIds(jobIds);
  return withDrillErrors({
    metric: key,
    context: { jobIds: cleanJobIds, startDate, endDate, source: "powerbi" },
    upstream: UPSTREAM_FOR.powerbi,
    run: async () => {
      const filters = { jobIds: cleanJobIds, startDate, endDate };
      return tmDrillRowsFrom(await loadTmPartsLines(filters), key, filters);
    },
  });
}
