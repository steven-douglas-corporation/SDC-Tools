import { createHash } from "crypto";
import type { ArForecastRow, ApForecastRow, PoForecastRow } from "@/lib/cash-flow-totaleto";

// ── Pure normalization: raw Total ETO rows -> one dimensional line shape ────
//
// No `fs`, no Prisma, no "server-only" — directly unit-testable, and the ONE
// place a raw extraction row becomes the (project, month, flowType, category,
// amount) shape every snapshot line, the current-forecast view, and the
// comparison view all share. `forecastMonth` is text ("2026-08" or the
// literal "UNKNOWN"), never a real DATE column and never one column per
// month — the task's own explicit requirement, so history and future months
// are unlimited without a schema change.

export type FlowType = "incoming" | "outgoing";
export type CashFlowCategory = "AR" | "AP" | "PO" | "ETC";

export type CashFlowLine = {
  projectId: string;
  customer: string | null;
  forecastMonth: string;
  flowType: FlowType;
  category: CashFlowCategory;
  amount: number;
};

export const UNKNOWN_MONTH = "UNKNOWN";

export function monthKeyFromIso(isoDate: string | null): string {
  return isoDate && /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? isoDate.slice(0, 7) : UNKNOWN_MONTH;
}

function customerFor(projectId: string, customerByProject: ReadonlyMap<string, string>): string | null {
  return customerByProject.get(projectId) ?? null;
}

export function buildArLines(rows: readonly ArForecastRow[], customerByProject: ReadonlyMap<string, string>): CashFlowLine[] {
  return rows
    .filter((r) => r.amount !== 0)
    .map((r) => ({
      projectId: r.projectId,
      customer: customerFor(r.projectId, customerByProject),
      forecastMonth: monthKeyFromIso(r.dueDate),
      flowType: "incoming" as const,
      category: "AR" as const,
      amount: r.amount,
    }));
}

export function buildApLines(rows: readonly ApForecastRow[], customerByProject: ReadonlyMap<string, string>): CashFlowLine[] {
  return rows
    .filter((r) => r.amount !== 0)
    .map((r) => ({
      projectId: r.projectId,
      customer: customerFor(r.projectId, customerByProject),
      forecastMonth: monthKeyFromIso(r.dueDate),
      flowType: "outgoing" as const,
      category: "AP" as const,
      amount: r.amount,
    }));
}

export function buildPoLines(rows: readonly PoForecastRow[], customerByProject: ReadonlyMap<string, string>): CashFlowLine[] {
  return rows
    .filter((r) => r.remainingAmount !== 0)
    .map((r) => ({
      projectId: r.projectId,
      customer: customerFor(r.projectId, customerByProject),
      forecastMonth: monthKeyFromIso(r.dueDate),
      flowType: "outgoing" as const,
      category: "PO" as const,
      amount: r.remainingAmount,
    }));
}

export type EtcAllocationInput = { projectId: string; forecastMonth: string; amount: number };

// ETC allocations are PM-entered against a real month by construction (see
// CashFlowEtcAllocation's own schema comment) — never UNKNOWN, so this is a
// straight passthrough rather than a date-derived bucketing step.
export function buildEtcLines(allocations: readonly EtcAllocationInput[], customerByProject: ReadonlyMap<string, string>): CashFlowLine[] {
  return allocations
    .filter((a) => a.amount !== 0)
    .map((a) => ({
      projectId: a.projectId,
      customer: customerFor(a.projectId, customerByProject),
      forecastMonth: a.forecastMonth,
      flowType: "outgoing" as const,
      category: "ETC" as const,
      amount: a.amount,
    }));
}

/**
 * Collapses multiple raw rows for the same (project, month, flowType,
 * category) into one line — dozens of AR sales-term rows for one project's
 * "2026-09" bucket become a single number, the same total either way — and
 * returns them in a FIXED, deterministic order so hashLines() below never
 * depends on the order the extraction queries happened to return rows in.
 */
export function aggregateLines(lines: readonly CashFlowLine[]): CashFlowLine[] {
  const byKey = new Map<string, CashFlowLine>();
  for (const l of lines) {
    const key = `${l.projectId}|${l.forecastMonth}|${l.flowType}|${l.category}`;
    const existing = byKey.get(key);
    if (existing) existing.amount = Math.round((existing.amount + l.amount) * 100) / 100;
    else byKey.set(key, { ...l, amount: Math.round(l.amount * 100) / 100 });
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.projectId.localeCompare(b.projectId) ||
      a.forecastMonth.localeCompare(b.forecastMonth) ||
      a.flowType.localeCompare(b.flowType) ||
      a.category.localeCompare(b.category),
  );
}

/**
 * The snapshot dedup key (CashFlowSnapshot.contentHash) — deterministic
 * because `lines` is expected to already be aggregateLines()'s own sorted
 * output. Amounts are fixed to 2 decimals before hashing so a float-summation
 * artifact (the kind aggregateLines() itself already rounds away, but a
 * defensive second guard here costs nothing) can never manufacture a
 * spurious "the forecast changed" snapshot.
 */
export function hashLines(lines: readonly CashFlowLine[]): string {
  const payload = lines
    .map((l) => `${l.projectId}|${l.customer ?? ""}|${l.forecastMonth}|${l.flowType}|${l.category}|${l.amount.toFixed(2)}`)
    .join("\n");
  return createHash("sha256").update(payload).digest("hex");
}
