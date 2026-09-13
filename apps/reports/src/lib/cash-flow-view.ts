import { UNKNOWN_MONTH, type CashFlowLine, type CashFlowCategory } from "@/lib/cash-flow-normalize";
import type { ProjectEstimate } from "@/lib/cash-flow";
import { currentMonth } from "@/lib/etc";

// ── Pure view-model shaping for the Cash Flow tab (2026-08-19) ──────────────
//
// No I/O, no React — everything here turns a flat `CashFlowLine[]` (already
// current-or-historical, already override-applied — see cash-flow.ts) into
// what the KPI strip / main table / comparison panel actually render. Kept
// separate from cash-flow.ts (which touches Prisma/TotalETO) so this is
// directly unit-testable, and separate from any component so the same shapes
// feed the page, a future export, and tests alike.
//
// `forecastMonth` is a plain "yyyy-mm" string (or the literal "UNKNOWN") —
// there is no per-line date, only a month, because that's the dimension the
// snapshot schema itself stores (the task's own explicit requirement: month
// as data, not a date). "Next 30 Days" below is therefore a MONTH-level
// approximation (current month + next calendar month), not a true rolling
// 30-day window — documented here so nobody mistakes it for day-precision
// the underlying model doesn't carry.

export type MonthTotals = { incoming: number; outgoing: number; ar: number; ap: number; po: number; etc: number };

function emptyTotals(): MonthTotals {
  return { incoming: 0, outgoing: 0, ar: 0, ap: 0, po: 0, etc: 0 };
}

function addLine(totals: MonthTotals, line: CashFlowLine): void {
  if (line.flowType === "incoming") totals.incoming += line.amount;
  else totals.outgoing += line.amount;
  if (line.category === "AR") totals.ar += line.amount;
  else if (line.category === "AP") totals.ap += line.amount;
  else if (line.category === "PO") totals.po += line.amount;
  else if (line.category === "ETC") totals.etc += line.amount;
}

/** Every real month present across the given lines, sorted — UNKNOWN is never included (it has no place on a timeline). */
export function distinctMonths(lines: readonly CashFlowLine[]): string[] {
  return [...new Set(lines.map((l) => l.forecastMonth).filter((m) => m !== UNKNOWN_MONTH))].sort();
}

// Was UTC (toISOString().slice(0,7)) -- the one function in this app's
// "current month" family that disagreed with the other three, which all use
// local server time. See lib/etc.ts's currentMonth() for why that's now the
// one definition.
export function currentMonthKey(today: Date): string {
  return currentMonth(today);
}

/** "2026-08" -> "Aug 2026" — the one place a month key becomes display text, so a column header and a KPI label never word it differently. */
export function formatMonthLabel(monthKey: string): string {
  if (monthKey === UNKNOWN_MONTH) return "Unknown";
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
}

/** "2026-08" shifted by `delta` calendar months — exported for the UI's own month-window paging (← Prev / Next →). */
export function shiftMonth(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const addMonths = shiftMonth;

export type KpiSet = {
  incomingCurrentMonth: number;
  outgoingCurrentMonth: number;
  netCurrentMonth: number;
  next30Incoming: number;
  next30Outgoing: number;
  arUnknown: number;
  apUnknown: number;
  poUnknown: number;
};

export function computeKpis(lines: readonly CashFlowLine[], today: Date): KpiSet {
  const thisMonth = currentMonthKey(today);
  const nextMonth = addMonths(thisMonth, 1);
  let incomingCurrentMonth = 0;
  let outgoingCurrentMonth = 0;
  let next30Incoming = 0;
  let next30Outgoing = 0;
  let arUnknown = 0;
  let apUnknown = 0;
  let poUnknown = 0;

  for (const l of lines) {
    if (l.forecastMonth === thisMonth) {
      if (l.flowType === "incoming") incomingCurrentMonth += l.amount;
      else outgoingCurrentMonth += l.amount;
    }
    if (l.forecastMonth === thisMonth || l.forecastMonth === nextMonth) {
      if (l.flowType === "incoming") next30Incoming += l.amount;
      else next30Outgoing += l.amount;
    }
    if (l.forecastMonth === UNKNOWN_MONTH) {
      if (l.category === "AR") arUnknown += l.amount;
      else if (l.category === "AP") apUnknown += l.amount;
      else if (l.category === "PO") poUnknown += l.amount;
    }
  }

  return {
    incomingCurrentMonth,
    outgoingCurrentMonth,
    netCurrentMonth: incomingCurrentMonth - outgoingCurrentMonth,
    next30Incoming,
    next30Outgoing,
    arUnknown,
    apUnknown,
    poUnknown,
  };
}

export type ProjectFlowRow = ProjectEstimate & {
  byMonth: Map<string, MonthTotals>;
  unknown: MonthTotals;
  totalIncoming: number;
  totalOutgoing: number;
};

/**
 * One row per project with a real estimate row OR at least one forecast
 * line — a project with neither never appears (nothing to show), and a
 * project with an estimate but zero current AR/AP/PO/ETC still appears with
 * all-zero months, since "no forecast activity" is itself a fact worth
 * seeing rather than a row silently missing.
 */
export function buildProjectRows(estimates: readonly ProjectEstimate[], lines: readonly CashFlowLine[]): ProjectFlowRow[] {
  const byProject = new Map<string, ProjectFlowRow>();
  for (const e of estimates) {
    byProject.set(e.projectId, { ...e, byMonth: new Map(), unknown: emptyTotals(), totalIncoming: 0, totalOutgoing: 0 });
  }
  for (const l of lines) {
    let row = byProject.get(l.projectId);
    if (!row) {
      row = {
        projectId: l.projectId,
        customer: l.customer,
        jobName: null,
        salesPrice: 0,
        materialEstimate: 0,
        laborEstimate: 0,
        totalEstimate: 0,
        projectProfit: 0,
        remainingCost: null,
        byMonth: new Map(),
        unknown: emptyTotals(),
        totalIncoming: 0,
        totalOutgoing: 0,
      };
      byProject.set(l.projectId, row);
    }
    const bucket = l.forecastMonth === UNKNOWN_MONTH ? row.unknown : row.byMonth.get(l.forecastMonth) ?? emptyTotals();
    addLine(bucket, l);
    if (l.forecastMonth !== UNKNOWN_MONTH) row.byMonth.set(l.forecastMonth, bucket);
    if (l.flowType === "incoming") row.totalIncoming += l.amount;
    else row.totalOutgoing += l.amount;
  }
  return [...byProject.values()].sort((a, b) => a.projectId.localeCompare(b.projectId));
}

export type ComparisonRow = {
  forecastMonth: string;
  flowType: CashFlowLine["flowType"];
  current: number;
  previous: number;
  changeAmount: number;
  /** null when `previous` is exactly 0 — a percentage against zero is undefined, not infinite or 0. */
  changePercent: number | null;
};

/** Aggregates each side to (month, flowType) totals first, so the comparison is stable regardless of how many individual project/category lines make it up. */
export function compareLines(current: readonly CashFlowLine[], previous: readonly CashFlowLine[]): ComparisonRow[] {
  const sum = (lines: readonly CashFlowLine[]) => {
    const m = new Map<string, number>();
    for (const l of lines) {
      const key = `${l.forecastMonth}|${l.flowType}`;
      m.set(key, (m.get(key) ?? 0) + l.amount);
    }
    return m;
  };
  const currentTotals = sum(current);
  const previousTotals = sum(previous);
  const keys = new Set([...currentTotals.keys(), ...previousTotals.keys()]);
  const rows: ComparisonRow[] = [];
  for (const key of keys) {
    const [forecastMonth, flowType] = key.split("|") as [string, CashFlowLine["flowType"]];
    const currentAmount = currentTotals.get(key) ?? 0;
    const previousAmount = previousTotals.get(key) ?? 0;
    const changeAmount = Math.round((currentAmount - previousAmount) * 100) / 100;
    rows.push({
      forecastMonth,
      flowType,
      current: currentAmount,
      previous: previousAmount,
      changeAmount,
      changePercent: previousAmount === 0 ? null : Math.round((changeAmount / Math.abs(previousAmount)) * 1000) / 10,
    });
  }
  return rows.sort((a, b) => a.forecastMonth.localeCompare(b.forecastMonth) || a.flowType.localeCompare(b.flowType));
}

/** Which project moved the most between two forecasts for one month/category — the task's own "which project caused the change" question. */
export function biggestMoversForMonth(
  current: readonly CashFlowLine[],
  previous: readonly CashFlowLine[],
  forecastMonth: string,
  category: CashFlowCategory,
): { projectId: string; customer: string | null; changeAmount: number }[] {
  const byProject = new Map<string, { customer: string | null; current: number; previous: number }>();
  for (const l of current) {
    if (l.forecastMonth !== forecastMonth || l.category !== category) continue;
    const row = byProject.get(l.projectId) ?? { customer: l.customer, current: 0, previous: 0 };
    row.current += l.amount;
    byProject.set(l.projectId, row);
  }
  for (const l of previous) {
    if (l.forecastMonth !== forecastMonth || l.category !== category) continue;
    const row = byProject.get(l.projectId) ?? { customer: l.customer, current: 0, previous: 0 };
    row.previous += l.amount;
    byProject.set(l.projectId, row);
  }
  return [...byProject.entries()]
    .map(([projectId, r]) => ({ projectId, customer: r.customer, changeAmount: Math.round((r.current - r.previous) * 100) / 100 }))
    .filter((r) => r.changeAmount !== 0)
    .sort((a, b) => Math.abs(b.changeAmount) - Math.abs(a.changeAmount));
}
