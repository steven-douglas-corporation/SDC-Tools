import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { loadActualHoursBySection } from "@/lib/actual-hours";
import { validJobTypeFilter } from "@/lib/job-filters";
import { checkSchedulerToken } from "@/lib/scheduler-api-auth";
import { SECTIONS } from "@/lib/sections";

// Per-section quoted / actual / ETC hours for one job, for SDC_Scheduler's Job
// Hours page. Read-only, server-to-server, same SCHEDULER_SHARED_TOKEN guard as
// the sibling job-detail endpoint.
//
// ── Why this exists (2026-08-26) ────────────────────────────────────────────
// The Scheduler used to get these three numbers by running DAX against Power BI
// itself (SDC_Scheduler/lib/hoursApi.js). Two things were wrong with that.
//
// First, it was a second, independent hours pipeline, and it broke: the PBI path
// needs an MCP exe plus an interactive MSAL token that no service can renew. The
// token cache emptied on 2026-07-11 and the Scheduler's Job Hours was dead for
// 46 days while the exe respawned every ~4 seconds.
//
// Second — and worse — when it DID work it was serving numbers this app had
// already rejected. Hours moved off Power BI here on 2026-08-05 because the PBI
// model ran days behind the Paylocity workbook: July short 150.53h, August
// missing entirely. So the Scheduler was showing stale hours, not just fragile
// ones.
//
// The rule now is that Paylocity punches and this database are the source of
// truth for hours in every SDC Tools app, and consumers read them from here
// rather than reaching past this app to Power BI.
//
// ── Where each number comes from ────────────────────────────────────────────
//   quoted — EstimatedHours.quotedHours (manager-editable; the PBI quoted sync
//            deliberately skips rows flagged quotedHoursManuallyEdited).
//   actual — loadActualHoursBySection(), which is THE definition of "actual
//            hours worked to date" for every report in this app. Do NOT
//            substitute a plain JobHoursDetail sum: that function deliberately
//            stitches three non-overlapping eras (migration snapshot, frozen
//            pre-punch-feed ETC history, then live punches for months the import
//            covers). Summing punches alone silently drops pre-feed history;
//            using EtcEntry.hoursWorked alone lost 6,954 hours across Jan-Jul
//            2026 because closed months freeze. Reusing it is what stops this
//            endpoint from drifting away from the Projects grid.
//   etc    — EstimatedHours.estimateToCompleteHours.
//
// ── Grouping ───────────────────────────────────────────────────────────────
// `group` is Engineering / Shop, from SECTIONS. The Scheduler's page previously
// subtotalled by Power BI's "Billing Group", which has no equivalent here; the
// Engineering/Shop split was chosen instead (2026-08-26) because it matches both
// this app's model and the Scheduler's own SHOP/ENGINEERING task hierarchy.
function toNum(d: unknown): number {
  if (d === null || d === undefined) return 0;
  const n = Number(d);
  return Number.isFinite(n) ? n : 0;
}

// Display order = the order sections are declared in SECTIONS, which is the
// order every grid in this app renders them. Sections that show up in the data
// but not in SECTIONS sort last rather than vanishing.
const SECTION_INDEX = new Map(SECTIONS.map((s, i) => [s.code, i]));
const SECTION_META = new Map(SECTIONS.map((s) => [s.code, s]));

export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/integration/jobs/[jobId]/hours">,
) {
  const denied = checkSchedulerToken(req);
  if (denied) return denied;

  const { jobId } = await ctx.params;

  // Same type-gate as the sibling endpoint: a noise job that appears in no list
  // must not be served in detail just because its id was guessed.
  const job = await prisma.job.findFirst({ where: { jobId, ...validJobTypeFilter } });
  if (!job) return Response.json({ error: "job_not_found" }, { status: 404 });

  const [estimates, actualMap] = await Promise.all([
    prisma.estimatedHours.findMany({
      where: { jobId: job.id },
      select: { section: true, quotedHours: true, estimateToCompleteHours: true },
    }),
    loadActualHoursBySection([job.id]),
  ]);

  // ── The fold now happens in loadActualHoursBySection (2026-09-02) ──────────
  //
  // This endpoint used to fold here itself, and the reason is worth keeping:
  // JobHoursDetail.section STORES THE RAW Paylocity pair, not a canonical
  // section code, so the raw pairs have to be folded onto the fixed columns
  // before anything is aggregated. Measured on 2026-08-26 before this endpoint
  // did that, 35-59% of a job's actual hours fell into an "Other" bucket (3,598h
  // of 9,902h on one job) because raw codes like 10-311, 12-211, 13-211, 14-211,
  // 40-311 and 90-211 are not themselves SECTIONS entries.
  //
  // What was never true is that this endpoint was alone in needing it. The same
  // omission was costing the Job Hour Details chart 1,410h on job 1131 and the
  // Projects grid, Quoted page and projects export 45,069h in total — so the
  // fold moved INTO the loader, where it applies to every consumer at once
  // instead of being re-implemented by whoever notices next. Folding again here
  // is verified idempotent (2026-09-02: 228 jobs, 2,127 section values, zero
  // differences) but it is a second copy of a rule that now has one home, so it
  // is gone.
  //
  // The loader omits `resolve` for the reason this endpoint did: the only
  // resolver available reads Power BI for punch-code metadata, and hours must not
  // depend on Power BI. It falls back to the hand-written SECTION_ALIASES table,
  // so this endpoint still has no Power BI dependency at all — and 10-311 still
  // SPLITS 30/70 across 10-312/10-313 in there, a fan-out rather than a rename.
  const actuals = actualMap.get(job.id) ?? new Map<string, number>();

  // Union of sections that have an estimate and sections that have hours — a
  // section worked but never quoted has to appear, or the page under-reports
  // actuals and the totals stop matching this app's own grid.
  const codes = new Set<string>([...estimates.map((e) => e.section), ...actuals.keys()]);

  const byCode = new Map(estimates.map((e) => [e.section, e]));
  const rows = [...codes].map((code) => {
    const meta = SECTION_META.get(code);
    const est = byCode.get(code);
    return {
      section: code,
      // `fn` is the human name the Scheduler shows per row; fall back to the raw
      // code so an unmapped section is visible and obviously unmapped, rather
      // than rendering as a blank row that looks like a bug.
      fn: meta?.name ?? code,
      group: meta?.group ?? "Other",
      phase: meta?.phase ?? null,
      order: SECTION_INDEX.get(code) ?? Number.MAX_SAFE_INTEGER,
      quoted: toNum(est?.quotedHours),
      actual: toNum(actuals.get(code)),
      etc: toNum(est?.estimateToCompleteHours),
    };
  });

  rows.sort((a, b) => a.order - b.order || a.section.localeCompare(b.section));

  const groupTotals: Record<string, { quoted: number; actual: number; etc: number }> = {};
  for (const r of rows) {
    const g = (groupTotals[r.group] ??= { quoted: 0, actual: 0, etc: 0 });
    g.quoted += r.quoted;
    g.actual += r.actual;
    g.etc += r.etc;
  }
  const totals = rows.reduce(
    (a, r) => ({ quoted: a.quoted + r.quoted, actual: a.actual + r.actual, etc: a.etc + r.etc }),
    { quoted: 0, actual: 0, etc: 0 },
  );

  return Response.json({
    jobId: job.jobId,
    jobName: job.jobName,
    // Provenance, so the Scheduler can state where the numbers came from rather
    // than leaving a reader to assume Power BI is still involved.
    source: "paylocity+reports-db",
    rows,
    groupTotals,
    totals,
  });
}
