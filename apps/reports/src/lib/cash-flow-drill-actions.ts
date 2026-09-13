"use server";

import { assertEltOnlyAction } from "@/lib/cash-flow-access";
import { fetchArDrillRows, fetchApDrillRows, fetchPoDrillRows, type ArDrillRow, type ApDrillRow, type PoDrillRow } from "@/lib/cash-flow-drill";
import { monthKeyFromIso } from "@/lib/cash-flow-normalize";

// The right-side drill-through behind one Cash Flow cell — fetched on click,
// same reasoning as every other on-demand drill in this app (T&M's
// tm-drill-actions.ts, Monthly ETC's hours-detail-actions.ts): real Total ETO
// network I/O for a panel most sessions never open. CURRENT only — see
// cash-flow-drill.ts's own header for why a historical snapshot has no
// line-item detail to drill into.

const MONTH_RE = /^\d{4}-\d{2}$|^UNKNOWN$/;

function requireMonth(forecastMonth: string): void {
  if (!MONTH_RE.test(forecastMonth)) throw new Error("Invalid forecast month.");
}

export async function loadArDrill(projectId: string, forecastMonth: string): Promise<ArDrillRow[]> {
  await assertEltOnlyAction();
  requireMonth(forecastMonth);
  const rows = await fetchArDrillRows(projectId);
  return rows.filter((r) => monthKeyFromIso(r.dueDate) === forecastMonth);
}

export async function loadApDrill(projectId: string, forecastMonth: string): Promise<ApDrillRow[]> {
  await assertEltOnlyAction();
  requireMonth(forecastMonth);
  const rows = await fetchApDrillRows(projectId);
  return rows.filter((r) => monthKeyFromIso(r.dueDate) === forecastMonth);
}

export async function loadPoDrill(projectId: string, forecastMonth: string): Promise<PoDrillRow[]> {
  await assertEltOnlyAction();
  requireMonth(forecastMonth);
  const rows = await fetchPoDrillRows(projectId);
  return rows.filter((r) => monthKeyFromIso(r.expectedDate) === forecastMonth);
}
