import "server-only";
import { prisma } from "@/lib/prisma";
import { validJobTypeFilter } from "@/lib/job-filters";
import { SECTIONS, PARTS_COST_SECTION, mapPunchToColumns, billingGroupForSection } from "@/lib/sections";
import { coveredMonths } from "@/lib/actual-hours";
import { getPartsCostSpentByJob, getPartsActualByJob } from "@/lib/sync-totaleto";
import { effectiveNewEtc } from "@/lib/etc";
import { runDax } from "@/lib/powerbi-client";
import { withTimeoutOrNull } from "@/lib/with-timeout";
import { getInventorySnapshotForDate, listInventorySnapshotDates } from "@/lib/job-cost-inventory-snapshot";
import type { HoursByYear, JobCostRow } from "@/lib/job-cost";

// ── Job Cost Explorer data assembly ─────────────────────────────────────────
//
// The standalone app this replaces (D:\AI Projects\new app) sourced every
// column from Power BI, live, on every load. Per the integration audit, only
// TWO things here still have no equivalent anywhere in this app and still go
// to Power BI: Sales Price (as a fallback — the primary source is the same
// manually-maintained inventory file the original app used) and nothing else.
// Everything else — job identity, actual hours by billing group, and parts
// cost — is read from this app's own, already-more-current pipelines.

// Billing-group bucket per section code, from the FULL section list (every
// phase), not the narrower ETC-grid-scoped subset — Job Cost Explorer's
// Actual/Eng/Shop/Other columns are whole-job totals across every phase.
//
// "ME"/"CE" -> "Mechanical Engineering"/"Controls Engineering" (2026-08-20):
// sections.ts's `group` now carries the centralized canonical wording, not
// its own abbreviation — this check has to match the CURRENT values or every
// ME/CE-coded section silently falls through to "other" (found live while
// migrating; nothing here would have errored, it would just have quietly
// moved hours off the Eng column).
// Collapsed onto sections.ts's billingGroupForSection (2026-09-02) — the shared
// helper added 2026-09-01 for exactly this question. It was a private copy of the
// same rule, and the comment above records what a private copy costs: the ME/CE
// rename silently moved hours to "other" and nothing errored. One definition now,
// so a future rename cannot make two callers disagree.
const SECTION_BUCKET: Record<string, "eng" | "shop" | "other"> = {};
for (const s of SECTIONS) {
  const group = billingGroupForSection(s.code);
  SECTION_BUCKET[s.code] = group === "Engineering" ? "eng" : group === "Shop" ? "shop" : "other";
}

// The 1990–2100 "lifetime" window these constants supplied is gone: the Parts
// Actual column now calls getPartsActualByJob(), which is unwindowed by
// construction (2026-08-10). Nothing here needs a synthetic date range any more.

// A live TotalETO connection failure surfaced during integration testing
// (summing 35 years of AP-document history across every job is a heavier
// query than the single-job budget §69 measured for /job-hours). Bounded
// with the same withTimeoutOrNull pattern rather than left to hang or crash
// the whole page — a slow/unreachable Total ETO now degrades Parts
// Purchased/Invoiced to "—" instead of an error boundary. 25s is a
// considered starting point (batch, not per-job, so more generous than
// UPSTREAM_BUDGET_MS), not a measured number yet — revisit once this page
// has real usage to profile against.
const PARTS_BATCH_BUDGET_MS = 25_000;

type JobHoursTotals = {
  actualHours: number;
  engineeringHours: number;
  shopHours: number;
  otherHours: number;
  hoursByYear: HoursByYear;
};

/**
 * Per-job Actual/Engineering/Shop/Other hours and the per-year Eng/Shop
 * breakdown — the same three-era read `lib/actual-hours.ts` uses (migration
 * snapshot + frozen ETC for uncovered months + live punches for covered
 * months), bucketed by billing group and, for the frozen/punch eras, by the
 * year the work fell in. The migration-snapshot era carries no month, so it
 * contributes to the flat totals only, never to hoursByYear — matching how
 * the original app's Power BI year breakdown could never have covered
 * pre-tracking history either.
 *
 * `throughMonth` (2026-08-11): null reproduces the unbounded query above byte
 * for byte — Current mode's hours stay exactly as live/unwindowed as they
 * always were. Set for a historical "As of" snapshot, it bounds BOTH
 * month-scoped sources (and therefore hoursByYear, which `laborForType` in
 * job-cost.ts costs per year) at the selected month — a job's July snapshot
 * must not silently absorb August's hours just because August has since
 * happened. `historical` (the pre-tracking migration snapshot) is never
 * filtered: it carries no month and predates every trackable one by
 * construction, so it belongs in every snapshot including the earliest.
 */
async function loadJobHoursAndYears(jobPks: number[], throughMonth: string | null): Promise<Map<number, JobHoursTotals>> {
  const out = new Map<number, JobHoursTotals>();
  if (jobPks.length === 0) return out;

  const covered = await coveredMonths();
  const [historical, frozen, punches] = await Promise.all([
    prisma.estimatedHours.findMany({
      where: { jobId: { in: jobPks } },
      select: { jobId: true, section: true, actualHistoricalHours: true },
    }),
    prisma.etcEntry.groupBy({
      by: ["jobId", "section", "month"],
      where: {
        jobId: { in: jobPks },
        section: { not: PARTS_COST_SECTION },
        month: { notIn: covered, ...(throughMonth ? { lte: throughMonth } : {}) },
      },
      _sum: { hoursWorked: true },
    }),
    prisma.jobHoursDetail.groupBy({
      by: ["jobId", "section", "month"],
      where: { jobId: { in: jobPks }, month: { in: covered, ...(throughMonth ? { lte: throughMonth } : {}) } },
      _sum: { hours: true },
    }),
  ]);

  function entry(jobPk: number): JobHoursTotals {
    let e = out.get(jobPk);
    if (!e) out.set(jobPk, (e = { actualHours: 0, engineeringHours: 0, shopHours: 0, otherHours: 0, hoursByYear: {} }));
    return e;
  }
  function addTotal(jobPk: number, section: string, hrs: number) {
    if (!hrs) return;
    const e = entry(jobPk);
    e.actualHours += hrs;
    const bucket = SECTION_BUCKET[section] ?? "other";
    if (bucket === "eng") e.engineeringHours += hrs;
    else if (bucket === "shop") e.shopHours += hrs;
    else e.otherHours += hrs;
  }
  // hoursByYear only ever tracks Eng/Shop, matching the original's
  // HOURS_BY_YEAR_DAX — "other" hours have no per-year rate to apply anyway.
  function addYear(jobPk: number, section: string, month: string, hrs: number) {
    if (!hrs) return;
    const bucket = SECTION_BUCKET[section];
    if (bucket !== "eng" && bucket !== "shop") return;
    const e = entry(jobPk);
    const year = month.slice(0, 4);
    const y = (e.hoursByYear[year] ??= { eng: 0, shop: 0 });
    y[bucket] += hrs;
  }

  // ── Punches are folded first; the other two eras are already column-keyed ──
  //
  // JobHoursDetail.section stores the RAW Paylocity pair, and SECTION_BUCKET
  // above is keyed on the app's fixed column codes — so an unfolded raw pair
  // matched nothing and fell through to "other". That is not a cosmetic
  // mis-label here: computeJobCost's Labor Cost sums Eng and Shop hours ONLY
  // (see job-cost.ts), so every hour in "other" is costed at zero.
  //
  // Measured app-wide on 2026-09-02, before this fold: 45,068 hours of real
  // engineering and shop labour sat in "other" — Eng 39,798h instead of
  // 69,845h, Shop 52,439h instead of 67,461h — which is roughly $8.3M of
  // labour cost missing at the default rates, and profit and margin overstated
  // by that much on the jobs carrying those codes.
  //
  // Same fold, same function, same reason as actual-hours.ts, sync-actuals.ts,
  // job-hours-detail.ts and tm-hours.ts. `historical` and `frozen` are
  // app-owned grid data already keyed by column code and must NOT be folded.
  for (const h of historical) addTotal(h.jobId, h.section, Number(h.actualHistoricalHours ?? 0));
  for (const f of frozen) {
    const hrs = Number(f._sum.hoursWorked ?? 0);
    addTotal(f.jobId, f.section, hrs);
    addYear(f.jobId, f.section, f.month, hrs);
  }
  for (const p of punches) {
    for (const col of mapPunchToColumns(p.section, Number(p._sum.hours ?? 0))) {
      addTotal(p.jobId, col.section, col.hours);
      addYear(p.jobId, col.section, p.month, col.hours);
    }
  }
  return out;
}

// ── Submitted ETC snapshot resolution (2026-08-11) ──────────────────────────
//
// Replaces the hand-maintained etc-data.json this app shipped with (a single
// always-latest snapshot someone had to manually regenerate and drop in) with
// a direct read of this app's OWN submitted/locked ETC months. "Submitted" is
// not a separate flag to invent — a month is locked exactly when every
// EtcEntry row in it has needsReview=false (isMonthLocked, lib/etc.ts:622),
// which is set, together with a frozen `newEtc`, by submitEtcEntriesInTx
// (lib/monthly-report.ts) at the moment a manager submits the month. Reading
// `newEtc` on a needsReview=false row is reading exactly that frozen value.

/**
 * Locked (submitted) months, newest first. Cheaper than fetching every
 * EtcEntry row just to run isMonthLocked() per month: a month with zero
 * pending rows among the months that have ANY rows is locked, full stop.
 */
export async function listLockedEtcMonthsDesc(): Promise<string[]> {
  const [all, pending] = await Promise.all([
    prisma.etcEntry.groupBy({ by: ["month"] }),
    prisma.etcEntry.groupBy({ by: ["month"], where: { needsReview: true } }),
  ]);
  const pendingMonths = new Set(pending.map((p) => p.month));
  return all
    .map((a) => a.month)
    .filter((m) => !pendingMonths.has(m))
    .sort((a, b) => b.localeCompare(a));
}

export type SubmittedEtc = { etcEngHours: number; etcShopHours: number; etcPartsCost: number };

/**
 * The frozen ETC Eng/Shop/Parts for one SUBMITTED month, bucketed with this
 * file's own SECTION_BUCKET (the full-job-wide rule Actual/Eng/Shop/Other
 * Hours already use above) — not the narrower ETC_TRACKED_CODES subset
 * getExecutionEtcByJob/Standard Fees uses, so a section that shows real
 * actual hours can never show a mysterious 0 ETC just because a differently-
 * scoped code list doesn't track it. Callers are expected to have already
 * resolved `month` via listLockedEtcMonthsDesc — this does not re-check
 * lock status itself, it just reads whatever's frozen for that exact month.
 */
export async function getSubmittedEtcSnapshot(jobPks: number[], month: string): Promise<Map<number, SubmittedEtc>> {
  const out = new Map<number, SubmittedEtc>();
  if (jobPks.length === 0) return out;

  const entries = await prisma.etcEntry.findMany({
    where: { jobId: { in: jobPks }, month, needsReview: false },
    select: { jobId: true, section: true, newEtc: true, newEtcDraft: true, needsReview: true, priorEtc: true, hoursWorked: true },
  });
  for (const e of entries) {
    let ref = out.get(e.jobId);
    if (!ref) out.set(e.jobId, (ref = { etcEngHours: 0, etcShopHours: 0, etcPartsCost: 0 }));
    const value = effectiveNewEtc(e); // needsReview=false here always reduces this to Number(e.newEtc)
    if (e.section === PARTS_COST_SECTION) ref.etcPartsCost += value;
    else if (SECTION_BUCKET[e.section] === "eng") ref.etcEngHours += value;
    else if (SECTION_BUCKET[e.section] === "shop") ref.etcShopHours += value;
  }
  return out;
}

// The one Power BI query this integration still needs — Sales Price, as a
// fallback for any job the inventory file doesn't cover. Ported from the
// original app's JOBS_DAX, narrowed to just this one measure since every
// other column now comes from this app's own data.
const SALES_PRICE_DAX = ["EVALUATE", "SUMMARIZECOLUMNS(", "  'Job'[Job Id],", '  "SalesPrice", [Sales Total Amount]', ")"].join("\n");

async function loadSalesPriceFallback(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const rows = (await runDax(SALES_PRICE_DAX)) as Record<string, unknown>[];
    for (const r of rows) {
      const jobId = String(r["Job[Job Id]"] ?? r["Job Id"] ?? "");
      const sales = Number(r["SalesPrice"]);
      if (jobId && Number.isFinite(sales)) map.set(jobId, sales);
    }
  } catch {
    // Power BI unreachable — fall through with an empty fallback, same
    // resilience the original app had ("serve what you have, don't blank
    // the page"). The inventory file's own coverage is unaffected.
  }
  return map;
}

// Last calendar day of a "YYYY-MM" month — same technique workingDaysInMonth
// (lib/etc.ts) already uses (day 0 of next month = last day of this one) — for
// turning a locked ETC month into a month-END date, so the As-of picker's
// option list is one consistent kind of value (a date), not a mix of "YYYY-MM"
// ETC months and "YYYY-MM-DD" inventory dates.
function monthEndDate(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

// A job that finishes in August must not have that retroactively zero out a
// July snapshot's still-live ETC forecast (computeJobCost forces ETC to 0 and
// %Complete to 100 once status is literally "Complete") — job-cost.ts itself
// is untouched; this corrects its INPUT instead. completeDate is the one real
// historical marker this app has for "was it done yet" — a job currently
// showing Complete that hadn't reached its completeDate as of `asOf` reports
// as "Active" for that snapshot instead (there is no historical record of
// Active-vs-HeadStart to reconstruct, and neither affects computeJobCost).
function historicalStatus(job: { status: string; completeDate: Date | null }, asOf: string): string {
  const completedByThen = job.completeDate != null && job.completeDate.toISOString().slice(0, 10) <= asOf;
  if (completedByThen) return "Complete";
  return job.status === "Complete" ? "Active" : job.status;
}

export type JobCostData = {
  rows: JobCostRow[];
  inventoryAsOf: string | null;
  /** The submitted ETC month actually used ("YYYY-MM"), or null if none qualified. */
  etcRefreshedThru: string | null;
  partsCostAvailable: boolean;
  /** Echoes what was applied — a "YYYY-MM-DD" month-end, or null for Current. */
  asOf: string | null;
  inventoryMissing: boolean;
  etcMissing: boolean;
  /** Available month-end dates for the As-of picker, descending. */
  asOfOptions: string[];
};

export async function loadJobCostRows(asOf: string | null = null): Promise<JobCostData> {
  const jobs = await prisma.job.findMany({
    where: validJobTypeFilter,
    select: { id: true, jobId: true, jobName: true, status: true, customer: true, startDate: true, completeDate: true },
  });
  const jobPks = jobs.map((j) => j.id);

  let partsFailed = false;
  const onPartsFail = (error: unknown) => {
    partsFailed = true;
    console.error("[job-cost-source] Total ETO parts query failed or timed out", error);
  };

  // Inventory and ETC each resolve "latest available <= asOf" INDEPENDENTLY —
  // they depend on two unrelated periodic snapshots (Lisa's workbook vs. this
  // app's own monthly submission) that can lag each other, so tying one to the
  // other's availability would make a merely-late file block an otherwise-fine
  // snapshot. Current (asOf=null) means no ceiling on either search.
  const [lockedMonths, inventoryDates] = await Promise.all([listLockedEtcMonthsDesc(), listInventorySnapshotDates()]);
  const etcMonth = lockedMonths.find((m) => m <= (asOf ? asOf.slice(0, 7) : "9999-12")) ?? null;
  const throughMonth = asOf ? asOf.slice(0, 7) : null;
  const asOfOptions = [...new Set([...lockedMonths.map(monthEndDate), ...inventoryDates])].sort((a, b) => b.localeCompare(a));

  const [hoursByJobPk, partsPurchased, partsInvoiced, inventory, etcSnapshotByJobPk, salesFallback] = await Promise.all([
    loadJobHoursAndYears(jobPks, throughMonth),
    withTimeoutOrNull("Total ETO parts purchased (Job Cost Explorer)", PARTS_BATCH_BUDGET_MS, () => getPartsCostSpentByJob(), onPartsFail),
    // Parts Actual, from the app's one definition of it (2026-08-10). Was
    // getPartsInvoicedByJob over a 1990–2100 "lifetime" window, which is the same
    // AP-document sum WITHOUT the GL-posted rule — so this column disagreed with
    // the Projects grid's Parts Actual by every never-exported invoice a job had.
    // Same function, same number, everywhere. Not asOf-scoped: the requirement
    // for this feature names Sales$/%Complete (inventory) and Hours/ETC
    // (submitted ETC) specifically — Parts Purchased/Invoiced stays this app's
    // own always-current TotalETO figure either way, exactly as it already does.
    withTimeoutOrNull("Total ETO parts actual (Job Cost Explorer)", PARTS_BATCH_BUDGET_MS, () => getPartsActualByJob(), onPartsFail),
    getInventorySnapshotForDate(asOf),
    etcMonth ? getSubmittedEtcSnapshot(jobPks, etcMonth) : Promise.resolve(new Map<number, SubmittedEtc>()),
    loadSalesPriceFallback(),
  ]);
  const partsPurchasedMap = partsPurchased ?? new Map<string, number>();
  const partsInvoicedMap = partsInvoiced ?? new Map<string, number>();

  const rows: JobCostRow[] = jobs.map((j) => {
    const h = hoursByJobPk.get(j.id);
    const inv = inventory.map.get(j.jobId);
    const etc = etcSnapshotByJobPk.get(j.id);
    const salesPrice = inv?.salesPrice ?? salesFallback.get(j.jobId) ?? null;

    return {
      jobId: j.jobId,
      jobName: j.jobName,
      // Current (asOf null) keeps the job's real live status, unchanged.
      status: asOf ? historicalStatus(j, asOf) : j.status,
      customerName: j.customer ?? null,
      // No source has ever populated this — the original app's own comment
      // notes the Power BI model has no machine-type column on 'Job' either.
      machineType: null,
      actualHours: h?.actualHours || null,
      engineeringHours: h?.engineeringHours || null,
      shopHours: h?.shopHours || null,
      otherHours: h?.otherHours || null,
      partCost: partsPurchasedMap.get(j.jobId) ?? null,
      partInvoiced: partsInvoicedMap.get(j.jobId) ?? null,
      salesPrice,
      startDate: j.startDate ? j.startDate.toISOString().slice(0, 10) : null,
      completeDate: j.completeDate ? j.completeDate.toISOString().slice(0, 10) : null,
      percentComplete: inv?.percentComplete ?? null,
      hoursByYear: h?.hoursByYear ?? {},
      etcEngHours: etc?.etcEngHours ?? null,
      etcShopHours: etc?.etcShopHours ?? null,
      etcPartsCost: etc?.etcPartsCost ?? null,
    };
  });

  return {
    rows,
    inventoryAsOf: inventory.asOfDate,
    etcRefreshedThru: etcMonth,
    partsCostAvailable: !partsFailed,
    asOf,
    inventoryMissing: inventory.asOfDate == null,
    etcMissing: etcMonth == null,
    asOfOptions,
  };
}
