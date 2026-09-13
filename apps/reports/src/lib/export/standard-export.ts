import { prisma } from "@/lib/prisma";
import { getEtcMonthJobWhere } from "@/lib/etc-month-jobs";
import { getExecutionEtcByJob, isInStandardFeesAllocation } from "@/lib/execution-etc";
import { loadEffectivePools } from "@/lib/standard-sheet-actions";
import { POOL_PANEL_META } from "@/lib/pool-panel-meta";
import { compareJobIds } from "@/lib/job-filters";
import {
  calcTotalEtcDollars,
  calcPercentOfTotal,
  calcStandardFeeEngineering,
  calcStandardFeeShop,
  calcTotalStandardFees,
  type JobRate,
  type CategoryPoolTotals,
} from "@/lib/standard-fees";
import { round2 } from "@/lib/etc";
import { etcMonthLabel } from "@/lib/export/etc-export";
import type { CellValue, SheetColumn, SheetSpec } from "@/lib/export/sheet";

// ── Standard Sheet + Standard Fees, as two more sheets on the Monthly ETC export ──
//
// This module has no idea whether the caller is authorized to see any of this — and
// never should. Gating is the export ROUTE's job (isStandardSheetUnlocked, checked
// before this is ever called); folding a second check in here would just be a second
// place the rule could drift from the first. This file only answers "what would the
// unlocked view show", on the assumption that question is safe to ask.
//
// Every figure mirrors two things exactly, on purpose, rather than being a third
// implementation that could quietly disagree with either:
//   * the pure math in lib/standard-fees.ts (calcTotalEtcDollars and friends — the same
//     functions EtcStandardColumns.tsx calls to render the grid), and
//   * the ETC page's own live-vs-frozen branch (src/app/(app)/etc/page.tsx, the
//     `if (standardSheetSubmitted) { … } else { … }` block): a submitted month reads
//     StandardSheetSnapshot verbatim, because that snapshot IS the signed-off record and
//     re-deriving it risks disagreeing with what was actually frozen if a rate changed
//     afterward; an open month recomputes live from the same inputs the grid reads at
//     render time.
//
// Deliberately NOT reusing lib/monthly-report.ts's loadStandardSheetRows for the live
// branch: that function throws when this month's pools are a carry-forward estimate,
// which is the right call for blocking a SUBMISSION but wrong here — the on-screen
// Standard view still renders carried-forward pool figures just fine (with its own
// banner saying so), and an export must not go blank in a state the screen handles.

export type StandardJobRow = {
  // The BUSINESS Job Id ("1079"), not Job.id — the same value the main Monthly ETC
  // sheet's first column carries, so the two sheets can be joined on it. Job.id is an
  // autoincrement primary key that means nothing to a reader and matches nothing on
  // screen.
  jobId: string;
  jobName: string;
  totalEtcDollars: number;
  percentOfTotal: number;
  standardFees: number;
  contingencyAmount: number;
  totalStandardFees: number;
  notes: string;
};

export type StandardPoolRow = {
  category: string;
  label: string; // "Engineering — PM", matching POOL_PANEL_META's group/dept
  previousMonthPulledHours: number;
  newHoursAddedThisMonth: number;
  hoursAvailable: number;
  hoursWorkedThisMonth: number;
  hoursPulledThisMonth: number;
  rate: number;
  newEtcHours: number;
  standardFee: number;
};

// A month is frozen the instant it has any snapshot rows — same existence check
// page.tsx, standard-fees-card.ts and standard-pool-eligibility.ts all use, so "is this
// month locked" can never disagree between the screen and the export.
export async function isStandardSheetSubmitted(month: string): Promise<boolean> {
  const row = await prisma.standardSheetSnapshot.findFirst({ where: { month }, select: { id: true } });
  return row != null;
}

// The ETC grid sorts its rows with compareJobIds (etc/page.tsx) — numerically, because a
// plain string sort puts "10000" before "979". The Standard columns are extra columns on
// those same grid rows, so these sheets have to use the same comparator to list jobs in
// the order the unlocked view shows them.
function byJobId(rows: StandardJobRow[]): StandardJobRow[] {
  return rows.sort((a, b) => compareJobIds(a.jobId, b.jobId));
}

async function frozenJobRows(month: string): Promise<StandardJobRow[]> {
  const snapshots = await prisma.standardSheetSnapshot.findMany({ where: { month } });
  const jobs = await prisma.job.findMany({
    where: { id: { in: snapshots.map((s) => s.jobId) } },
    select: { id: true, jobId: true, jobName: true },
  });
  const byId = new Map(jobs.map((j) => [j.id, j]));
  return byJobId(
    snapshots.map((s) => {
      const job = byId.get(s.jobId);
      return {
        // A snapshot outlives the job row only if a job was hard-deleted, which this app
        // does not do — but falling back to the numeric id beats emitting a blank cell.
        jobId: job?.jobId ?? String(s.jobId),
        jobName: job?.jobName ?? "",
        totalEtcDollars: Number(s.totalEtcDollars),
        percentOfTotal: Number(s.percentOfTotal),
        // One column on screen ("Standard Fees"), not two — EtcStandardCells sums these
        // the same way for the live branch below.
        standardFees: Number(s.standardFeeEngineering) + Number(s.standardFeeShop),
        contingencyAmount: Number(s.contingencyAmount),
        totalStandardFees: Number(s.totalStandardFees),
        notes: s.notes ?? "",
      };
    }),
  );
}

// Same per-category fee math PoolTotals (StandardPoolPanel.tsx) and StandardRatesProvider
// both use: (Hours Available − Pulled) × Rate.
function poolFeeTotals(
  pools: { category: string; hoursAvailable: unknown; hoursPulledThisMonth: unknown; rate: unknown }[],
): CategoryPoolTotals {
  const fee = (category: string) => {
    const p = pools.find((x) => x.category === category);
    if (!p) return 0;
    return (Number(p.hoursAvailable) - Number(p.hoursPulledThisMonth)) * Number(p.rate);
  };
  return {
    engineeringPM: fee("ENGINEERING_PM"),
    engineeringWarranty: fee("ENGINEERING_WARRANTY"),
    shopManufacturing: fee("SHOP_MANUFACTURING"),
    shopWarranty: fee("SHOP_WARRANTY"),
  };
}

async function liveJobRows(month: string): Promise<StandardJobRow[]> {
  const { where } = await getEtcMonthJobWhere(month);
  const jobs = await prisma.job.findMany({ where, include: { executionRate: true } });
  // Same membership rule the sheet's fee job list uses: non-billable / flag-excluded jobs
  // stay off this sheet and don't dilute anyone's % Total, even though they still appear
  // on the main Monthly ETC sheet.
  const eligible = jobs.filter((j) => isInStandardFeesAllocation(j));

  const [execEtcByJob, setting, pools] = await Promise.all([
    getExecutionEtcByJob(eligible.map((j) => j.id), month),
    prisma.standardSheetSetting.findUnique({ where: { id: 1 } }),
    loadEffectivePools(month),
  ]);
  const rates: JobRate = {
    engrRate: setting ? Number(setting.engrRate) : 170,
    shopRate: setting ? Number(setting.shopRate) : 140,
    partsMarkup: setting ? Number(setting.partsMarkup) : 1.2,
  };
  const contingencyRate = setting ? Number(setting.contingencyRate) : 1.2;
  const poolTotals = poolFeeTotals(pools.pools);

  const withEtc = eligible.map((job) => {
    const etc = execEtcByJob.get(job.id) ?? { engineering: 0, shop: 0, parts: 0 };
    return { job, totalEtcDollars: calcTotalEtcDollars(etc, rates) };
  });
  const grandTotalEtcDollars = withEtc.reduce((sum, r) => sum + r.totalEtcDollars, 0);

  return byJobId(
    withEtc.map(({ job, totalEtcDollars }) => {
      const percentOfTotal = calcPercentOfTotal(totalEtcDollars, grandTotalEtcDollars);
      const standardFeeEngineering = calcStandardFeeEngineering(percentOfTotal, poolTotals);
      const standardFeeShop = calcStandardFeeShop(percentOfTotal, poolTotals);
      const contingencyAmount = job.executionRate ? Number(job.executionRate.contingencyAmount) : 0;
      const totalStandardFees = calcTotalStandardFees(
        totalEtcDollars,
        standardFeeEngineering,
        standardFeeShop,
        contingencyAmount,
        contingencyRate,
      );
      return {
        jobId: job.jobId,
        jobName: job.jobName,
        totalEtcDollars,
        percentOfTotal,
        standardFees: standardFeeEngineering + standardFeeShop,
        contingencyAmount,
        totalStandardFees,
        notes: job.executionRate?.notes ?? "",
      };
    }),
  );
}

async function poolRows(month: string): Promise<{ rows: StandardPoolRow[]; carriedFrom: string | null }> {
  // Deliberately unconditional on frozen/live: CategoryPool rows for an already-submitted
  // month cannot change (savePools/refresh both refuse to touch a submitted month — see
  // standard-pool-eligibility.ts), so reading them live is already reading the frozen
  // figures, with no separate snapshot needed the way the per-job rows above need one.
  const { pools, carriedFrom } = await loadEffectivePools(month);
  const rows = POOL_PANEL_META.map(({ category, group, dept }) => {
    const p = pools.find((x) => x.category === category);
    return {
      category,
      label: `${group} — ${dept}`,
      previousMonthPulledHours: p ? Number(p.previousMonthPulledHours) : 0,
      newHoursAddedThisMonth: p ? Number(p.newHoursAddedThisMonth) : 0,
      hoursAvailable: p ? Number(p.hoursAvailable) : 0,
      hoursWorkedThisMonth: p ? Number(p.hoursWorkedThisMonth) : 0,
      hoursPulledThisMonth: p ? Number(p.hoursPulledThisMonth) : 0,
      rate: p ? Number(p.rate) : 0,
      newEtcHours: p ? Number(p.newEtcHours) : 0,
      standardFee: p ? Number(p.standardFee) : 0,
    };
  });
  return { rows, carriedFrom };
}

function standardSheetSpec(monthLabel: string, rows: StandardJobRow[], now: Date): SheetSpec {
  const columns: SheetColumn[] = [
    { header: "Job Id", type: "text", width: 12 },
    { header: "Job Name", type: "text", width: 38 },
    { header: "Total ETC $", type: "currency" },
    // A plain number, not a %-formatted one (SheetColumn has no percentage type) — the
    // value is already ×100, matching the on-screen `percent()` helper's own digits
    // (15.3, not 0.153), so the header alone disambiguates.
    { header: "% Total", type: "number" },
    { header: "Standard Fees", type: "currency" },
    { header: "Contingency $", type: "currency" },
    { header: "Total Standard Fees", type: "currency" },
    { header: "Notes", type: "text", width: 30 },
  ];
  const dataRows: CellValue[][] = rows.map((r) => [
    r.jobId,
    r.jobName,
    round2(r.totalEtcDollars),
    round2(r.percentOfTotal * 100),
    round2(r.standardFees),
    round2(r.contingencyAmount),
    round2(r.totalStandardFees),
    r.notes || null,
  ]);
  const totals: CellValue[] = [
    `TOTAL (${rows.length} job${rows.length === 1 ? "" : "s"})`,
    null,
    round2(rows.reduce((s, r) => s + r.totalEtcDollars, 0)),
    round2(rows.reduce((s, r) => s + r.percentOfTotal, 0) * 100),
    round2(rows.reduce((s, r) => s + r.standardFees, 0)),
    round2(rows.reduce((s, r) => s + r.contingencyAmount, 0)),
    round2(rows.reduce((s, r) => s + r.totalStandardFees, 0)),
    null,
  ];
  return {
    sheetName: `Standard Sheet - ${monthLabel}`,
    title: `Standard Sheet — ${monthLabel}`,
    subtitle: [
      "Password-protected — matches the Monthly ETC page's own unlocked Standard Sheet view exactly.",
      `Exported ${now.toISOString().slice(0, 16).replace("T", " ")} — ${rows.length} job${rows.length === 1 ? "" : "s"}`,
    ],
    columns,
    rows: dataRows,
    totals,
    freezeColumns: 2,
  };
}

function standardFeesSpec(
  monthLabel: string,
  rows: StandardPoolRow[],
  carriedFrom: string | null,
  now: Date,
): SheetSpec {
  const columns: SheetColumn[] = [
    { header: "Department", type: "text", width: 24 },
    { header: "Previous Month Pulled", type: "hours" },
    { header: "New Hours Added", type: "hours" },
    { header: "Hours Available", type: "hours" },
    { header: "Hours Worked This Month", type: "hours" },
    { header: "Hours Pulled This Month", type: "hours" },
    { header: "Rate", type: "currency" },
    { header: "New ETC Hours", type: "hours" },
    { header: "Standard Fee", type: "currency" },
  ];
  const dataRows: CellValue[][] = rows.map((r) => [
    r.label,
    round2(r.previousMonthPulledHours),
    round2(r.newHoursAddedThisMonth),
    round2(r.hoursAvailable),
    round2(r.hoursWorkedThisMonth),
    round2(r.hoursPulledThisMonth),
    round2(r.rate),
    round2(r.newEtcHours),
    round2(r.standardFee),
  ]);
  // Engineering Total / Shop Total / Grand Total — the same three summary rows
  // StandardPoolPanel's own PoolTotals() renders beneath the four department rows, not a
  // generic per-column sum (a "Rate" column summed across categories would be
  // meaningless, which is why this isn't the SheetSpec `totals` field).
  const feeOf = (category: string) => rows.find((r) => r.category === category)?.standardFee ?? 0;
  const engineeringTotal = feeOf("ENGINEERING_PM") + feeOf("ENGINEERING_WARRANTY");
  const shopTotal = feeOf("SHOP_MANUFACTURING") + feeOf("SHOP_WARRANTY");
  dataRows.push(
    ["Engineering Total", null, null, null, null, null, null, null, round2(engineeringTotal)],
    ["Shop Total", null, null, null, null, null, null, null, round2(shopTotal)],
    ["Grand Total", null, null, null, null, null, null, null, round2(engineeringTotal + shopTotal)],
  );
  return {
    sheetName: `Standard Fees - ${monthLabel}`,
    title: `Standard Fees by Department — ${monthLabel}`,
    subtitle: [
      "Password-protected — matches the Monthly ETC page's own Standard Fees by Department panel exactly.",
      ...(carriedFrom
        ? [`Pools carried forward from ${carriedFrom} — this month's own pools have not been refreshed yet.`]
        : []),
      `Exported ${now.toISOString().slice(0, 16).replace("T", " ")}`,
    ],
    columns,
    rows: dataRows,
  };
}

// The one entry point the export route calls, ALREADY having verified the caller is
// authorized (see api/export/[report]/route.ts) — this function does not check, and must
// not be reachable in a way that lets it.
export async function buildStandardExportSheets(month: string, now: Date): Promise<SheetSpec[]> {
  const label = etcMonthLabel(month);
  const submitted = await isStandardSheetSubmitted(month);
  const jobRows = submitted ? await frozenJobRows(month) : await liveJobRows(month);
  const { rows: pools, carriedFrom } = await poolRows(month);
  return [standardSheetSpec(label, jobRows, now), standardFeesSpec(label, pools, submitted ? null : carriedFrom, now)];
}
