import { prisma } from "@/lib/prisma";
import { SECTIONS, ETC_SECTIONS, PHASE_GROUPS, PARTS_COST_SECTION, SERVICE_AND_SPARE_PARTS_CODES, OFF_GRID_PHASE, UNMAPPED_PHASE } from "@/lib/sections";
import { suggestNewEtc } from "@/lib/etc";
import { validJobTypeFilter, compareJobIds } from "@/lib/job-filters";
import { loadActualHoursBySection, loadMonthlyWorkedBySection } from "@/lib/actual-hours";
import { classifyPunchCode } from "@/lib/paylocity-standard-rules";

// Data layer for the "Job Hour Details" dashboard — a web recreation of the
// Power BI "Job Hours Report — Management Level" drillthrough page. Sources every
// hours metric from the ETC app's own data (EstimatedHours = Quoted, EtcEntry =
// Actual + ETC), so it needs no Power BI connection.

export type HoursType = "Quoted" | "ETC";

export type SectionHours = {
  code: string;
  name: string;
  phase: string;
  group: string;
  // "Unclassified" (2026-08-24) is for punch codes with no ETC/Quoted column —
  // Service (80-*) and Spare Parts (90-*) whose Section+Function pair the
  // approved rule book does not list. They are REAL hours and must be visible,
  // but attributing them to Engineering or Shop would be inventing a business
  // rule, so they carry their own value and the billing-group rollup below
  // (which maps only Engineering and Shop) leaves them out of both totals.
  billingGroup: "Engineering" | "Shop" | "Unclassified";
  quoted: number;
  etc: number;
  actual: number;
};

// Engineering vs Shop split — READ from sections.ts's own ETC_SECTIONS.billingGroup
// rather than a second, hand-copied code list (found live, 2026-08-20: this used to
// re-type sections.ts's private ENGINEERING_CODES set, which could silently drift
// from the real one with no compiler warning — exactly the "signed-off number
// disagrees across screens" failure class this app has hit before).
// OFF_GRID_PHASE / UNMAPPED_PHASE moved to @/lib/sections (client-safe);
// re-exported here so existing importers keep working.
export { OFF_GRID_PHASE, UNMAPPED_PHASE } from "@/lib/sections";

const BILLING_GROUP_BY_CODE = new Map(ETC_SECTIONS.map((s) => [s.code, s.billingGroup]));
// NOTE the fallback: "Shop" is correct only for the 17 SECTIONS codes, every one
// of which HAS an ETC_SECTIONS entry, so the ?? never actually fires for them. It
// must not be reused for anything else — an off-grid code would be silently
// attributed to Shop. Those go through billingGroupForOffGridCode below.
const billingGroupOf = (code: string): "Engineering" | "Shop" => BILLING_GROUP_BY_CODE.get(code) ?? "Shop";

// ── Off-grid punch codes: Service (80-*), Spare Parts (90-*) (2026-08-24) ───
//
// Reported as "2026 Service punches are missing from Job Hours". They were never
// missing from the DATA: 1,441.5h of 2026 section-80/90 punches sit in
// JobHoursDetail and actual-hours.ts already returns them in actualBySection.
// They were dropped one step later — the section list was built by iterating the
// fixed 17-code SECTIONS array, and Service/Spare Parts deliberately have no
// SECTIONS row (no ETC/Quoted column exists for them; see sections.ts). The keys
// were sitting in the map and nothing ever read them.
//
// Rather than add rows to SECTIONS — which ETC_SECTIONS and ETC_TRACKED_CODES
// derive from, so it would add columns to the signed-off ETC grid and change the
// quoted/ETC formulas, the exports and the permissions matrix (20 importers) —
// the extra rows are appended HERE, in the one place that needs them.
//
// SCOPED to Service/Spare Parts, via sections.ts's own
// SERVICE_AND_SPARE_PARTS_CODES — deliberately NOT "everything SECTIONS omits".
//
// That distinction is the whole care in this change. Measured all-time, codes with
// no SECTIONS row carry 3,557h of Service/Spare Parts and 54,112h of OTHER
// off-grid codes (10-414 alone is 11,006h; 40-311 is 12,620h). Taking every
// off-grid code would have added ~57.7k hours here, more than doubling this
// chart's Engineering/Shop actuals, while the Projects grid and
// JobMonthlyActualHours went on reporting the old figures from their own narrow
// allowlist (JOB_DASHBOARD_HOURS_CODES) — the "signed-off number disagrees across
// screens" failure this file already carries a warning about.
//
// So this fixes what was reported and nothing more. The 54,112h is real and worth
// its own decision, but that is a reporting-scope change across several pages,
// not a bug fix.
function billingGroupForOffGridCode(code: string): "Engineering" | "Shop" | "Unclassified" {
  const dept = classifyPunchCode(code).department;
  // Only the rule book may decide this. "PM" has no billing group on this chart,
  // and "Undefined" means the pair is not in the rule book at all — both stay out
  // of the Engineering/Shop totals rather than being guessed into one.
  return dept === "Engineering" || dept === "Shop" ? dept : "Unclassified";
}

export type JobHoursDashboard = {
  job: { id: number; jobId: string; jobName: string; customer: string | null; status: string };
  // The individual jobs this view aggregates (1+). Used to pull parts cost.
  jobRefs: { id: number; jobId: string }[];
  kpis: {
    hoursRefreshedThru: string | null;
    latestEtcMonth: string | null;
    // There was a `designToDebugRatio` here — the PBI DAX measure (Section 10
    // Engineering actual / Section 40 Engineering actual, blank under 200 debug
    // hours). Its card was removed from the header row in §57 and nothing read the
    // field afterwards, so it was removed in §66 rather than left computing a
    // figure with no consumer. The section-level `actual` hours it derived from are
    // untouched and still drive the charts.
  };
  sections: SectionHours[];
  phaseGroups: { phase: string; count: number }[];
  billingGroups: { group: string; quoted: number; etc: number; actual: number }[];
  // Per-section month-by-month worked hours, oldest first — the detail behind a
  // section's Actual bar. Keyed by section code; a section with no ETC history
  // is absent rather than present-and-empty. Feeds the drill-through panel: the
  // charts could say a section was 680 hours over, but not when that happened,
  // which is the first thing anyone asks next.
  monthlyBySection: Record<string, { month: string; worked: number }[]>;
};

// Effective New ETC — the same rule the ETC grid renders with (execution-etc.ts).
function effectiveNewEtc(e: {
  needsReview: boolean; newEtc: unknown; newEtcDraft: unknown; priorEtc: unknown; hoursWorked: unknown;
}): number {
  if (!e.needsReview) return Number(e.newEtc);
  if (e.newEtcDraft != null) return Number(e.newEtcDraft);
  return suggestNewEtc(Number(e.priorEtc), Number(e.hoursWorked));
}

export async function listDashboardJobs(): Promise<{ id: number; jobId: string; jobName: string; status: string }[]> {
  const jobs = await prisma.job.findMany({
    where: { ...validJobTypeFilter },
    select: { id: true, jobId: true, jobName: true, status: true },
  });
  return jobs.sort((a, b) => compareJobIds(a.jobId, b.jobId));
}

// Pick a sensible default job for first load: the one with the most worked
// hours in the latest ETC month (so the dashboard opens on real data instead of
// an empty service/spare-parts job).
export async function defaultDashboardJobId(): Promise<number | null> {
  const latest = await prisma.etcEntry.findFirst({ orderBy: { month: "desc" }, select: { month: true } });
  if (!latest) return null;
  const grouped = await prisma.etcEntry.groupBy({
    by: ["jobId"],
    where: { month: latest.month },
    _sum: { hoursWorked: true },
  });
  grouped.sort((a, b) => Number(b._sum.hoursWorked ?? 0) - Number(a._sum.hoursWorked ?? 0));
  const validIds = new Set((await listDashboardJobs()).map((j) => j.id));
  for (const g of grouped) if (validIds.has(g.jobId)) return g.jobId;
  return null;
}

// Accepts one or more internal Job ids and aggregates the hours dashboard
// across them (sections, billing groups, KPIs are summed) — the same way the
// Power BI job slicer combines multiple jobs.
export async function getJobHoursDashboard(jobIdOrIds: number | number[]): Promise<JobHoursDashboard | null> {
  const ids = Array.isArray(jobIdOrIds) ? jobIdOrIds : [jobIdOrIds];
  const jobs = await prisma.job.findMany({
    where: { id: { in: ids } },
    select: { id: true, jobId: true, jobName: true, customer: true, status: true },
  });
  if (jobs.length === 0) return null;
  jobs.sort((a, b) => compareJobIds(a.jobId, b.jobId));
  const jobIds = jobs.map((j) => j.id);

  const [estimated, entries, actualBySection, monthlyBySection, freshness, latestEntry] = await Promise.all([
    // Quoted only — actuals come from actual-hours.ts below.
    prisma.estimatedHours.findMany({ where: { jobId: { in: jobIds } }, select: { section: true, quotedHours: true } }),
    prisma.etcEntry.findMany({
      where: { jobId: { in: jobIds } },
      select: { section: true, month: true, hoursWorked: true, newEtc: true, newEtcDraft: true, priorEtc: true, needsReview: true },
    }),
    // Actuals and their monthly timeline come from actual-hours.ts, not from
    // `entries` above: EtcEntry.hoursWorked is frozen once a month closes, so
    // reading it here understated every closed month by the late punches booked
    // since (6,954h across Jan–Jul 2026). `entries` is still what drives ETC,
    // which must keep using the frozen figure.
    loadActualHoursBySection(jobIds),
    loadMonthlyWorkedBySection(jobIds),
    prisma.powerBiFreshness.findUnique({ where: { source: "hours_actual" }, select: { refreshedThrough: true } }).catch(() => null),
    prisma.etcEntry.findFirst({ where: { jobId: { in: jobIds } }, orderBy: { month: "desc" }, select: { month: true } }),
  ]);

  // Combined display when more than one job is selected.
  const job =
    jobs.length === 1
      ? jobs[0]
      : {
          id: jobs[0].id,
          jobId: jobs.map((j) => j.jobId).join(", "),
          jobName: `${jobs.length} jobs selected`,
          customer: null as string | null,
          status: "—",
        };
  const jobRefs = jobs.map((j) => ({ id: j.id, jobId: j.jobId }));

  const latestMonth = latestEntry?.month ?? null;

  // Quoted per section.
  const quotedBy = new Map<string, number>();
  for (const e of estimated) quotedBy.set(e.section, (quotedBy.get(e.section) ?? 0) + Number(e.quotedHours));

  // Cumulative actual per section, summed across the selected jobs. The rule
  // (migration snapshot + frozen ETC history + live punches) lives in
  // actual-hours.ts so this page and the Projects grid can't disagree.
  const actualBy = new Map<string, number>();
  for (const sections of actualBySection.values()) {
    for (const [section, hours] of sections) actualBy.set(section, (actualBy.get(section) ?? 0) + hours);
  }

  // ETC per section — effective New ETC for the latest month only.
  const etcBy = new Map<string, number>();
  if (latestMonth) {
    for (const e of entries) {
      if (e.month !== latestMonth || e.section === PARTS_COST_SECTION) continue;
      etcBy.set(e.section, (etcBy.get(e.section) ?? 0) + effectiveNewEtc(e));
    }
  }

  const gridSections: SectionHours[] = SECTIONS.map((s) => ({
    code: s.code,
    name: s.name,
    phase: s.phase,
    group: s.group,
    billingGroup: billingGroupOf(s.code),
    quoted: quotedBy.get(s.code) ?? 0,
    etc: etcBy.get(s.code) ?? 0,
    actual: actualBy.get(s.code) ?? 0,
  }));

  // Off-grid codes carrying real hours — see billingGroupForOffGridCode above.
  // quoted/etc are 0 by construction, not by omission: no ETC or Quoted column
  // exists for these phases, so a diff badge showing the whole actual as "over"
  // is the truth about unbudgeted work rather than a gap in this query.
  const gridCodes = new Set(SECTIONS.map((s) => s.code));
  // ── Every off-grid code with hours, not just Service/Spare Parts (2026-09-02) ─
  //
  // This filter used to require SERVICE_AND_SPARE_PARTS_CODES, and the note above
  // explains why: taking every code SECTIONS omits would have added ~57.7k hours
  // to this chart, dominated by 10-414 (11,006h) and 40-311 (12,620h), while the
  // other pages went on reporting the narrower figure.
  //
  // That reasoning was right about the risk and wrong about those two codes.
  // Neither is off-grid: SECTION_ALIASES maps 10-414 -> 10-413 and 40-311 ->
  // 40-211, signed off, and every other consumer folds them there. They only
  // looked unhoused because actual-hours.ts was handing this function RAW pairs
  // without applying that fold — fixed there now, so those 57.7k hours land in
  // the columns they belong to rather than needing a bar of their own.
  //
  // What is genuinely left over is 6.75% of all punch hours (10,289h measured
  // app-wide), and it is not a scope question: it is malformed phase prefixes in
  // the Paylocity export — "1-411", "1-412", "-111", "5-414" — that the rule book
  // has no entry for and cannot be guessed into one. classifyPunchCode returns
  // department "Undefined" for all of them, so billingGroupForOffGridCode keeps
  // every one out of the Engineering and Shop totals; widening this filter
  // therefore cannot move either total, only make hours visible that were being
  // dropped without a trace. A number nobody can categorise still has to be
  // shown, or the chart quietly disagrees with the punch table it is drawn from.
  const offGridSections: SectionHours[] = [...actualBy.entries()]
    .filter(([code, hours]) => !gridCodes.has(code) && hours > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, hours]) => {
      const c = classifyPunchCode(code);
      return {
        code,
        name: c.taskDescription === "Undefined" ? `Unmapped ${code}` : c.taskDescription,
        // Service/Spare Parts keep their own band; an unmappable code must not be
        // labelled as Service work it may have nothing to do with.
        phase: SERVICE_AND_SPARE_PARTS_CODES.has(code) ? OFF_GRID_PHASE : UNMAPPED_PHASE,
        group: c.department,
        billingGroup: billingGroupForOffGridCode(code),
        quoted: 0,
        etc: 0,
        actual: hours,
      };
    });

  const sections: SectionHours[] = [...gridSections, ...offGridSections];

  // Billing-group rollups (Engineering / Shop).
  const bgMap = new Map<string, { quoted: number; etc: number; actual: number }>();
  for (const s of sections) {
    const cur = bgMap.get(s.billingGroup) ?? { quoted: 0, etc: 0, actual: 0 };
    cur.quoted += s.quoted; cur.etc += s.etc; cur.actual += s.actual;
    bgMap.set(s.billingGroup, cur);
  }
  const billingGroups = ["Engineering", "Shop"].map((g) => ({ group: g, ...(bgMap.get(g) ?? { quoted: 0, etc: 0, actual: 0 }) }));

  return {
    job,
    jobRefs,
    kpis: {
      hoursRefreshedThru: freshness?.refreshedThrough ? freshness.refreshedThrough.toISOString().slice(0, 10) : null,
      latestEtcMonth: latestMonth,
    },
    sections,
    phaseGroups: PHASE_GROUPS,
    billingGroups,
    monthlyBySection,
  };
}
