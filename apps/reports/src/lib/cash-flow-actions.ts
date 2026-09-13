"use server";

import { assertEltOnlyAction } from "@/lib/cash-flow-access";
import {
  setEtcAllocation,
  setForecastOverride,
  getEtcAllocationsForProject,
  getForecastOverride,
  getForecastOverrides,
  type EtcAllocationRow,
  type ForecastOverrideRow,
} from "@/lib/cash-flow-snapshot-store";
import { logAudit } from "@/lib/audit";

export async function loadProjectPlanning(projectId: string): Promise<{ etcAllocations: EtcAllocationRow[]; arOverrides: ForecastOverrideRow[] }> {
  await assertEltOnlyAction();
  const [etcAllocations, allOverrides] = await Promise.all([getEtcAllocationsForProject(projectId), getForecastOverrides()]);
  return { etcAllocations, arOverrides: allOverrides.filter((o) => o.projectId === projectId) };
}

// Every manual forecast write goes through here, and every one is audited
// via the EXISTING AuditLog (logAudit) — no second, cash-flow-specific audit
// table, matching the same choice the Hiring Positions feature made. Both
// actions are gated on `assertEltOnlyAction()`, not a togglable Permission —
// see cash-flow-access.ts's own header.

const MONTH_RE = /^\d{4}-\d{2}$/;

export type CashFlowActionResult = { ok: true } | { ok: false; error: string };

/**
 * PM's monthly distribution of a project's remaining TotalETO estimate. The
 * sum of every month a PM enters for one project is NOT enforced to equal
 * the project's remaining cost by this function (a PM may be mid-planning,
 * with only some months entered) — the UI surfaces the running total against
 * the target so a PM can see when they've reconciled it, per the task's own
 * "the sum of monthly ETC allocations must reconcile to the project's
 * current remaining ETC" as a north star, not a hard save-time constraint
 * that would block an honestly incomplete plan from being saved at all.
 */
export async function setCashFlowEtcAllocation(
  projectId: string,
  forecastMonth: string,
  amount: number,
  note: string | null,
): Promise<CashFlowActionResult> {
  const session = await assertEltOnlyAction();
  if (!projectId) return { ok: false, error: "Missing project." };
  if (!MONTH_RE.test(forecastMonth)) return { ok: false, error: "Forecast month must be yyyy-mm." };
  if (!Number.isFinite(amount)) return { ok: false, error: "Amount must be a number." };

  const existing = (await getEtcAllocationsForProject(projectId)).find((a) => a.forecastMonth === forecastMonth);
  await setEtcAllocation(projectId, forecastMonth, amount, note?.trim() || null, session.user.email ?? null);

  await logAudit({
    action: "cashflow.etcAllocationSet",
    entityType: "CashFlowEtcAllocation",
    entityId: `${projectId}:${forecastMonth}`,
    summary: `Project ${projectId} ${forecastMonth} ETC: ${existing?.amount ?? 0} → ${amount} (by ${session.user.email ?? "unknown"})`,
    metadata: { projectId, forecastMonth, previousAmount: existing?.amount ?? null, newAmount: amount, note },
  });

  return { ok: true };
}

/**
 * A PM's manual correction to the AR forecast for one project/month —
 * "System Actual / Committed" (the live Total ETO query) is never touched;
 * this only ever affects what getCurrentCashFlowLines() layers on top for
 * "Current". A past snapshot can never be changed by this, by construction —
 * see cash-flow.ts's own getCashFlowLines().
 */
export async function setCashFlowForecastOverride(
  projectId: string,
  forecastMonth: string,
  amount: number,
  note: string | null,
): Promise<CashFlowActionResult> {
  const session = await assertEltOnlyAction();
  if (!projectId) return { ok: false, error: "Missing project." };
  if (!MONTH_RE.test(forecastMonth)) return { ok: false, error: "Forecast month must be yyyy-mm." };
  if (!Number.isFinite(amount)) return { ok: false, error: "Amount must be a number." };

  const category = "AR"; // the one category a PM can move without touching ERP data — see the model's own schema comment
  const existing = await getForecastOverride(projectId, category, forecastMonth);
  await setForecastOverride(projectId, category, forecastMonth, amount, note?.trim() || null, session.user.email ?? null);

  await logAudit({
    action: "cashflow.forecastOverrideSet",
    entityType: "CashFlowForecastOverride",
    entityId: `${projectId}:${category}:${forecastMonth}`,
    summary: `Project ${projectId} ${forecastMonth} AR forecast: ${existing?.amount ?? "(TotalETO figure)"} → ${amount} (by ${session.user.email ?? "unknown"})`,
    metadata: { projectId, category, forecastMonth, previousAmount: existing?.amount ?? null, newAmount: amount, note },
  });

  return { ok: true };
}
