// ── Profitability: the exact calculation behind a cell, as hover text ─────────
//
// Every figure here is read back out of the same functions the grid is computed
// with (laborForType, rateForYear, partsCostForProfit) or off the already-computed
// row, never re-derived with a second copy of the rules — so the hover can't drift
// from the number it explains. Keep it that way if job-cost.ts changes.
//
// Pure and string-in/string-out so it can be unit-tested without React.

import {
  laborForType,
  partsCostForProfit,
  rateForYear,
  RATE_MATRIX_FIRST_YEAR,
  RATE_MATRIX_LAST_YEAR,
  type CostRates,
  type JobCostComputed,
  type JobHourAllocation,
  type YearRateOverrides,
} from "@/lib/job-cost";

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hrs = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}%`;

type HourType = "eng" | "shop";

/** Hours below this are rounding noise, not a real "no year" remainder (same cut-off as laborForType). */
const UNTIMED_EPSILON = 0.005;

/**
 * Where each of a job's Eng (or Shop) hours falls, by year — the same split the
 * Labor cost uses:
 *   - a manual hour allocation, if one is set for the job, replaces the automatic split;
 *   - otherwise the per-year hours, plus whatever is in the total but in no year
 *     (the migration snapshot, work through 2025-01-31, which carries no month).
 */
export function hoursByYearEntries(
  row: Pick<JobCostComputed, "engineeringHours" | "shopHours" | "hoursByYear">,
  allocation: JobHourAllocation | undefined,
  type: HourType,
): { entries: { label: string; year: string | null; hours: number }[]; manual: boolean } {
  const total = (type === "eng" ? row.engineeringHours : row.shopHours) ?? 0;
  const alloc = allocation?.[type];
  if (alloc && alloc.length) {
    const byYear = new Map<string, number>();
    for (const a of alloc) byYear.set(a.year, (byYear.get(a.year) ?? 0) + (Number(a.hours) || 0));
    const entries = [...byYear.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([year, hours]) => ({ label: year, year, hours }));
    return { entries, manual: true };
  }
  const hby = row.hoursByYear ?? {};
  const years = Object.keys(hby).filter((y) => (hby[y][type] || 0) !== 0).sort();
  const entries: { label: string; year: string | null; hours: number }[] = years.map((y) => ({ label: y, year: y, hours: hby[y][type] || 0 }));
  const inYears = Object.keys(hby).reduce((s, y) => s + (hby[y][type] || 0), 0);
  const untimed = Math.max(total - inYears, 0);
  if (untimed > UNTIMED_EPSILON) entries.push({ label: "No year (migration snapshot, through 2025-01-31)", year: null, hours: untimed });
  return { entries, manual: false };
}

export function explainHours(
  row: Pick<JobCostComputed, "engineeringHours" | "shopHours" | "hoursByYear">,
  allocation: JobHourAllocation | undefined,
  type: HourType,
): string {
  const name = type === "eng" ? "Eng Hrs" : "Shop Hrs";
  const { entries, manual } = hoursByYearEntries(row, allocation, type);
  if (!entries.length) return `${name} by year\nNo ${type === "eng" ? "engineering" : "shop"} hours on this job.`;
  const sum = entries.reduce((s, e) => s + e.hours, 0);
  const head = manual ? `${name} by year (manual allocation set for this job)` : `${name} by year`;
  return [head, ...entries.map((e) => `${e.label}: ${hrs(e.hours)} hrs`), `Total: ${hrs(sum)} hrs`].join("\n");
}

/**
 * One hour type's labor, split the way laborForType costs it: each year's hours at that
 * year's Rate Matrix rate, hours with no year at the default rate. Sums to laborForType.
 */
function laborLines(
  row: JobCostComputed,
  def: CostRates,
  overrides: YearRateOverrides,
  allocation: JobHourAllocation | undefined,
  type: HourType,
): string[] {
  const rateKey = type === "eng" ? "engRate" : "shopRate";
  const { entries } = hoursByYearEntries(row, allocation, type);
  return entries.map((e) => {
    const rate = e.year == null ? def[rateKey] : rateForYear(e.year, def, overrides)[rateKey];
    const note = e.year == null ? " (default rate)" : "";
    return `  ${e.label}: ${hrs(e.hours)} hrs × ${money(rate)}/hr${note} = ${money(e.hours * rate)}`;
  });
}

// Where a job's PM% / Mfg% came from — the Rate Matrix row for its completion year, or the default.
function pctSource(year: string | null, key: "pmPct" | "mfgPct", overrides: YearRateOverrides): string {
  if (!year) return "default rate (job has no Complete Date)";
  const n = Number(year);
  if (Number.isFinite(n) && n > RATE_MATRIX_LAST_YEAR) return `default rate (${year} is after the Rate Matrix's last year, ${RATE_MATRIX_LAST_YEAR})`;
  const rowYear = Number.isFinite(n) && n < RATE_MATRIX_FIRST_YEAR ? String(RATE_MATRIX_FIRST_YEAR) : year;
  const label = rowYear === year ? `${year} Rate Matrix row` : `${rowYear} Rate Matrix row (${year} is before the matrix starts)`;
  return overrides[rowYear]?.[key] != null ? label : `default rate (${label} leaves it blank)`;
}

function explainShareOfSales(
  row: JobCostComputed,
  def: CostRates,
  overrides: YearRateOverrides,
  key: "pmPct" | "mfgPct",
): string {
  const name = key === "pmPct" ? "PM $" : "Mfg $";
  const sales = row.salesPrice || 0;
  const year = row.completeDate ? row.completeDate.slice(0, 4) : null;
  const rc = year ? rateForYear(year, def, overrides) : def;
  const p = rc[key];
  const value = key === "pmPct" ? row.pmCost : row.mfgCost;
  return [
    `${name} = Sales Price × ${key === "pmPct" ? "PM" : "Mfg"} %`,
    `Sales Price: ${row.salesPrice == null ? "none on file (counted as $0.00)" : money(sales)}`,
    `${key === "pmPct" ? "PM" : "Mfg"} %: ${pct(p)} — ${pctSource(year, key, overrides)}`,
    `${money(sales)} × ${pct(p)} = ${money(value)}`,
  ].join("\n");
}

export function explainPm(row: JobCostComputed, def: CostRates, overrides: YearRateOverrides): string {
  return explainShareOfSales(row, def, overrides, "pmPct");
}

export function explainMfg(row: JobCostComputed, def: CostRates, overrides: YearRateOverrides): string {
  return explainShareOfSales(row, def, overrides, "mfgPct");
}

export function explainTotalCost(
  row: JobCostComputed,
  def: CostRates,
  overrides: YearRateOverrides,
  allocation: JobHourAllocation | undefined,
): string {
  const engLabor = laborForType(row, def, overrides, allocation, "eng");
  const shopLabor = laborForType(row, def, overrides, allocation, "shop");
  const engLines = laborLines(row, def, overrides, allocation, "eng");
  const shopLines = laborLines(row, def, overrides, allocation, "shop");
  const etcEng = row.etcEngHours || 0;
  const etcShop = row.etcShopHours || 0;
  const parts = partsCostForProfit(row, row.etcPartsCost);
  const open = parts.committedNotPosted;
  const etcParts = row.etcPartsCost ?? 0;
  const partsLine =
    row.status === "Complete"
      ? `Parts: ${money(parts.actual)} (Complete job: Parts Invoiced only, no ETC)`
      : `Parts: ${money(parts.actual)} invoiced + ${money(Math.max(open, etcParts))} (larger of open PO balance ${money(open)} and ETC Parts ${money(etcParts)}) = ${money(row.partsProjected)}`;
  return [
    "Total Cost = Labor + PM $ + Mfg $ + Parts",
    `Eng labor (hours by year × that year's Eng rate): ${money(engLabor)}`,
    ...(engLines.length ? engLines : ["  no Eng hours"]),
    `Shop labor (hours by year × that year's Shop rate): ${money(shopLabor)}`,
    ...(shopLines.length ? shopLines : ["  no Shop hours"]),
    `ETC Eng: ${hrs(etcEng)} hrs × ${money(def.engRate)}/hr (default rate) = ${money(etcEng * def.engRate)}`,
    `ETC Shop: ${hrs(etcShop)} hrs × ${money(def.shopRate)}/hr (default rate) = ${money(etcShop * def.shopRate)}`,
    `Labor subtotal: ${money(row.laborCost)}`,
    `PM $: ${money(row.pmCost)}`,
    `Mfg $: ${money(row.mfgCost)}`,
    partsLine,
    `${money(row.laborCost)} + ${money(row.pmCost)} + ${money(row.mfgCost)} + ${money(row.partsProjected)} = ${money(row.totalCost)}`,
  ].join("\n");
}

export function explainSalesPrice(row: JobCostComputed): string | undefined {
  const d = row.salesPriceDetail;
  if (!d) return undefined;
  const cq = d.changeQuote ?? 0;
  const cqNote = cq !== 0 ? `\nThe Projects tab's Change Quote (${money(cq)}) is not added to this figure.` : "";
  if (d.source === "projects") {
    const base = d.projectsSalesPrice ?? 0;
    return [
      "Sales Price = Projects Sales Price + Change Quote",
      `Projects Sales Price: ${money(base)}`,
      `Change Quote: ${money(cq)}${d.changeQuote == null ? " (none)" : ""}`,
      `${money(base)} + ${money(cq)} = ${money(row.salesPrice ?? 0)}`,
    ].join("\n");
  }
  if (d.source === "inventory") {
    const why = d.asOf
      ? `As-of view (${d.asOf}): that month's inventory-workbook figure is used, not today's Projects price.`
      : "The Projects tab has no Sales Price for this job, so the inventory-workbook figure is used.";
    return `Sales Price from the inventory workbook: ${money(row.salesPrice ?? 0)}\n${why}${cqNote}\n(The workbook figure may already include change orders.)`;
  }
  if (d.source === "powerbi") {
    return `Sales Price from Power BI: ${money(row.salesPrice ?? 0)}\nThe Projects tab has no Sales Price for this job and the inventory workbook has none either.${cqNote}`;
  }
  return "No Sales Price on file: not on the Projects tab, the inventory workbook or Power BI.";
}

export function explainProfit(row: JobCostComputed): string {
  if (row.salesPrice == null) return "Profit = Sales Price − Total Cost\nBlank: this job has no Sales Price on file.";
  return [
    "Profit = Sales Price − Total Cost",
    `Sales Price: ${money(row.salesPrice)}`,
    `Total Cost: ${money(row.totalCost)} (Labor ${money(row.laborCost)} + PM ${money(row.pmCost)} + Mfg ${money(row.mfgCost)} + Parts ${money(row.partsProjected)})`,
    `${money(row.salesPrice)} − ${money(row.totalCost)} = ${money(row.profit ?? 0)}`,
  ].join("\n");
}

export function explainMargin(row: JobCostComputed): string {
  if (row.salesPrice == null) return "Margin = Profit ÷ Sales Price × 100\nBlank: this job has no Sales Price on file.";
  if (!row.salesPrice) return "Margin = Profit ÷ Sales Price × 100\nBlank: Sales Price is $0.00.";
  return [
    "Margin = Profit ÷ Sales Price × 100",
    `Profit: ${money(row.profit ?? 0)}`,
    `Sales Price: ${money(row.salesPrice)}`,
    `${money(row.profit ?? 0)} ÷ ${money(row.salesPrice)} × 100 = ${(row.margin ?? 0).toFixed(2)}%`,
  ].join("\n");
}

/** The per-job hover for a Profitability cell, or undefined for columns that have none. */
export function explainJobCell(
  key: string,
  row: JobCostComputed,
  def: CostRates,
  overrides: YearRateOverrides,
  allocation: JobHourAllocation | undefined,
): string | undefined {
  switch (key) {
    case "engineeringHours": return explainHours(row, allocation, "eng");
    case "shopHours": return explainHours(row, allocation, "shop");
    case "pmCost": return explainPm(row, def, overrides);
    case "mfgCost": return explainMfg(row, def, overrides);
    case "totalCost": return explainTotalCost(row, def, overrides, allocation);
    case "salesPrice": return explainSalesPrice(row);
    case "profit": return explainProfit(row);
    case "margin": return explainMargin(row);
    default: return undefined;
  }
}
