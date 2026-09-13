import { prisma } from "@/lib/prisma";
import { effectiveNewEtc, round2 } from "@/lib/etc";
import { ETC_SECTIONS, ETC_TRACKED_CODES, PARTS_COST_SECTION } from "@/lib/sections";

const SECTION_BILLING_GROUP = new Map(ETC_SECTIONS.map((s) => [s.code, s.billingGroup]));

export type ExecutionEtc = { engineering: number; shop: number; parts: number };

// Which jobs participate in the Standard Fees allocation (Total ETC pool
// share). Mirrors the sheet's manually-curated fee job list: internal
// non-billable jobs (4000/6000/7000, SDC Showroom, …) never appear in it,
// and the per-job flag covers deliberate one-off exclusions of otherwise
// billable jobs (verified against the June 2026 sheet, which dropped 1115).
// Excluded jobs still render on the ETC grid — they just get no fee row and
// don't dilute anyone's % of total.
export function isInStandardFeesAllocation(job: { billable: boolean; excludedFromStandardFees: boolean }): boolean {
  return job.billable && !job.excludedFromStandardFees;
}

// Mirrors Standard Fees.xlsx's per-job VLOOKUP into Managers Fill Out's
// "Total (New ETC) > Engineering/Shop > All > Total New ETC" and
// "Parts Cost > Total > New ETC" columns — rolled up here from EtcEntry
// instead of a cross-workbook formula.
//
// `month` scopes the rollup to one ETC month, mirroring how the workbook's
// Managers Fill Out always holds exactly one month's working state.
export async function getExecutionEtcByJob(jobIds: number[], month: string): Promise<Map<number, ExecutionEtc>> {
  const result = new Map<number, ExecutionEtc>();
  if (jobIds.length === 0) return result;

  const entries = await prisma.etcEntry.findMany({
    where: { jobId: { in: jobIds }, month },
    select: { jobId: true, section: true, newEtc: true, newEtcDraft: true, needsReview: true, priorEtc: true, hoursWorked: true },
  });

  for (const e of entries) {
    if (e.section !== PARTS_COST_SECTION && !ETC_TRACKED_CODES.has(e.section)) continue;

    const totals = result.get(e.jobId) ?? { engineering: 0, shop: 0, parts: 0 };
    // Same "effective New ETC" rule the Monthly ETC grid renders with:
    // confirmed value once submitted; before that, the manager's autosaved
    // draft if any, else the live suggestion. Stored newEtc on an
    // unsubmitted entry is just the seed-time value, so using it made the
    // Standard Sheet disagree with the grid until the month was submitted.
    // Calls the shared `effectiveNewEtc` (2026-08-15, audit finding) — this
    // used to hand-copy that exact branching inline, a second copy of the
    // same rule that could silently drift from the original the moment one
    // was edited and not the other (found while auditing the Parts Cost
    // projection formula; identical behavior before and after this change).
    const value = effectiveNewEtc(e);
    if (e.section === PARTS_COST_SECTION) {
      totals.parts += value;
    } else if (SECTION_BILLING_GROUP.get(e.section) === "Engineering") {
      totals.engineering += value;
    } else {
      totals.shop += value;
    }
    result.set(e.jobId, totals);
  }

  // Round each rollup at the boundary: these sums feed calcTotalEtcDollars in
  // the month-freeze (stored as money), so float residue from summing per-
  // section values (e.g. 12.340000000001) must not drift into persisted fees.
  for (const [jobId, t] of result) {
    result.set(jobId, { engineering: round2(t.engineering), shop: round2(t.shop), parts: round2(t.parts) });
  }

  return result;
}
