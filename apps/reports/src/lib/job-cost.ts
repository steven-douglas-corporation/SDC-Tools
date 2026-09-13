// ── Job Cost Explorer: the calc engine ──────────────────────────────────────
//
// Ported byte-for-byte in logic (not merely "inspired by") from the standalone
// "Job Cost Explorer" app's compute()/laborForType() (D:\AI Projects\new app
// \public\app.js:330-378). Every rule below is preserved on purpose — this
// file is what tests/job-cost.test.ts pins down as behavior-preserving, not a
// reinterpretation of the original.
//
// What changed in the port: rates and hour allocations now come from shared,
// server-side storage (lib/job-cost-actions.ts) instead of localStorage — see
// job-cost-source.ts for where the row data itself comes from.

export type CostRates = { engRate: number; shopRate: number; pmPct: number; mfgPct: number };

export const DEFAULT_RATES: CostRates = { engRate: 200, shopRate: 150, pmPct: 10, mfgPct: 10 };

/** { [year]: { eng: hours, shop: hours } } — the automatic per-year breakdown. */
export type HoursByYear = Record<string, { eng: number; shop: number }>;

/** One row of a manual hour allocation: this many hours costed at this year's rate. */
export type HourAllocationEntry = { hours: number; year: string };

/** A job's manual override, per hour type — present only for jobs someone has set one for. */
export type JobHourAllocation = { eng: HourAllocationEntry[]; shop: HourAllocationEntry[] };

/** Per-year rate overrides. A missing field on a year falls back to the default, not to zero. */
export type YearRateOverrides = Record<string, Partial<CostRates>>;

export type JobCostRow = {
  jobId: string;
  jobName: string;
  status: string;
  customerName: string | null;
  machineType: string | null;
  actualHours: number | null;
  engineeringHours: number | null;
  shopHours: number | null;
  otherHours: number | null;
  partCost: number | null;
  partInvoiced: number | null;
  salesPrice: number | null;
  startDate: string | null;
  completeDate: string | null;
  percentComplete: number | null;
  hoursByYear: HoursByYear;
  etcEngHours: number | null;
  etcShopHours: number | null;
  etcPartsCost: number | null;
};

export type JobCostComputed = JobCostRow & {
  pmCost: number;
  mfgCost: number;
  laborCost: number;
  profit: number | null;
  margin: number | null;
};

/**
 * Real jobs only — matches the original's UTILITY_IDS. These are Total ETO
 * clearing/placeholder rows, not actual jobs; kept as a literal set rather
 * than derived, exactly as before.
 */
export const UTILITY_JOB_IDS = new Set(["4000", "1083", "6000", "7000", "10000", "NOT DEFINED"]);

export function isUtilityJob(jobId: string): boolean {
  return UTILITY_JOB_IDS.has(jobId) || !jobId.trim();
}

/** The global year-matrix override for one year, else the default — never zero-filled. */
export function rateForYear(year: string, def: CostRates, overrides: YearRateOverrides): CostRates {
  const o = overrides[year] ?? {};
  return {
    engRate: o.engRate ?? def.engRate,
    shopRate: o.shopRate ?? def.shopRate,
    pmPct: o.pmPct ?? def.pmPct,
    mfgPct: o.mfgPct ?? def.mfgPct,
  };
}

/**
 * Labor cost for one hour type on a job: the job's manual year allocation if
 * one was set, else the automatic per-year breakdown, else the aggregate
 * hours at the default rate. Unchanged from the original's laborForType().
 */
export function laborForType(
  row: JobCostRow,
  def: CostRates,
  overrides: YearRateOverrides,
  allocation: JobHourAllocation | undefined,
  type: "eng" | "shop",
): number {
  const rateKey = type === "eng" ? "engRate" : "shopRate";
  const alloc = allocation?.[type];
  if (alloc && alloc.length) {
    return alloc.reduce((sum, r) => sum + (Number(r.hours) || 0) * rateForYear(r.year, def, overrides)[rateKey], 0);
  }
  const hby = row.hoursByYear ?? {};
  const years = Object.keys(hby);
  if (years.length) {
    return years.reduce((sum, y) => sum + (hby[y][type] || 0) * rateForYear(y, def, overrides)[rateKey], 0);
  }
  const total = type === "eng" ? row.engineeringHours : row.shopHours;
  return (total || 0) * def[rateKey];
}

/**
 * The full per-job rollup — unchanged from the original's compute():
 *   Labor Cost = Σ_year(EngHours[year] × EngRate[year]) + Σ_year(ShopHours[year] × ShopRate[year])
 *              + Sales × PM%[completionYear] + Sales × Mfg%[completionYear]
 *   x (cost)   = Labor Cost + ETC_EngHours × EngRate_default + ETC_ShopHours × ShopRate_default
 *   y (parts)  = PartCost + ETC_PartsCost
 *   Profit     = Sales Price − (x + y)              [null if no Sales Price]
 *   Margin     = Profit ÷ Sales Price × 100
 *
 * PM%/Mfg% are a share of sales, applied once at the job's completion-year
 * rate — sales isn't time-phased like hours are. For a Complete job, ETC
 * figures are forced to zero before costing (the work is done; adding ETC on
 * top would double-count) while displayed percentComplete is forced to 100.
 * ETC (future) hours always cost at the default rate, never a per-year one —
 * they have no year yet.
 */
export function computeJobCost(
  row: JobCostRow,
  def: CostRates,
  overrides: YearRateOverrides,
  allocation: JobHourAllocation | undefined,
): JobCostComputed {
  const sales = row.salesPrice || 0;

  const blendedLabor = laborForType(row, def, overrides, allocation, "eng") + laborForType(row, def, overrides, allocation, "shop");

  const compYear = row.completeDate ? row.completeDate.slice(0, 4) : null;
  const rc = compYear ? rateForYear(compYear, def, overrides) : def;
  const pmCost = sales * (rc.pmPct / 100);
  const mfgCost = sales * (rc.mfgPct / 100);
  const laborCost = blendedLabor + pmCost + mfgCost;

  const isComplete = row.status === "Complete";
  const etcEngHours = isComplete ? 0 : row.etcEngHours;
  const etcShopHours = isComplete ? 0 : row.etcShopHours;
  const etcPartsCost = isComplete ? 0 : row.etcPartsCost;

  const x = laborCost + (etcEngHours || 0) * def.engRate + (etcShopHours || 0) * def.shopRate;
  const y = (row.partCost || 0) + (etcPartsCost || 0);
  const profit = row.salesPrice != null ? sales - x - y : null;
  const margin = profit != null && sales ? (profit / sales) * 100 : null;
  const percentComplete = isComplete ? 100 : row.percentComplete;

  return { ...row, pmCost, mfgCost, laborCost, profit, margin, percentComplete, etcEngHours, etcShopHours, etcPartsCost };
}
