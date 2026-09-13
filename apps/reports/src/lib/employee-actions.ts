"use server";

import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { logAudit } from "@/lib/audit";
import { recordChanges, classifyChange } from "@/lib/change-log";
import { reconcileSchedulerRoster, type RosterReconciliation } from "@/lib/sync-scheduler-team";
import { parseSupervisorExport, applySupervisorImport, type SupervisorImportResult } from "@/lib/import-employee-supervisors";
import { assertActionPermission } from "@/lib/require-permission";
import { DISCIPLINE_LABEL } from "@/lib/disciplines";
import { pushTeamMemberToScheduler } from "@/lib/scheduler-push";

// Employees are NEVER hard-deleted — departed people keep their historical
// hours (Dan's requirement). Deactivate/reactivate only.

function readEmployeeForm(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Employee name is required.");

  const department = String(formData.get("department") ?? "").trim() || null;
  const billingGroup = String(formData.get("billingGroup") ?? "").trim() || null;
  const discipline = String(formData.get("discipline") ?? "").trim() || null;
  const paylocityId = String(formData.get("paylocityId") ?? "").trim() || null;
  const supRaw = String(formData.get("supervisorId") ?? "").trim();
  // Guard like every other numeric field: a non-numeric/blank-ish value must
  // not slip through as NaN (or "0" as 0) into a Prisma write.
  let supervisorId: number | null = null;
  if (supRaw) {
    const n = Number(supRaw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid supervisor id "${supRaw}".`);
    supervisorId = n;
  }
  return { name, department, billingGroup, discipline, paylocityId, supervisorId };
}

export async function createEmployee(formData: FormData) {
  await assertActionPermission("employees:edit");
  const data = readEmployeeForm(formData);

  if (data.paylocityId) {
    const existing = await prisma.employee.findUnique({ where: { paylocityId: data.paylocityId } });
    if (existing) {
      throw new Error(`Paylocity ID ${data.paylocityId} already belongs to ${existing.name}${existing.active ? "" : " (inactive — reactivate them instead)"}.`);
    }
  }

  const employee = await prisma.employee.create({ data });
  await logAudit({
    action: "employee.create",
    entityType: "Employee",
    entityId: employee.id,
    summary: `Created employee ${employee.name}`,
    metadata: data,
  });
  revalidatePath("/employees");
}

export async function updateEmployee(id: number, formData: FormData) {
  await assertActionPermission("employees:edit");
  const data = readEmployeeForm(formData);

  if (data.paylocityId) {
    const existing = await prisma.employee.findUnique({ where: { paylocityId: data.paylocityId } });
    if (existing && existing.id !== id) {
      throw new Error(`Paylocity ID ${data.paylocityId} already belongs to ${existing.name}.`);
    }
  }

  // A person can't be their own supervisor.
  if (data.supervisorId === id) data.supervisorId = null;

  const before = await prisma.employee.findUnique({ where: { id } });
  await prisma.employee.update({ where: { id }, data });
  await logAudit({
    action: "employee.update",
    entityType: "Employee",
    entityId: id,
    summary: `Updated employee ${data.name}`,
    metadata: { before, after: data },
  });
  // §33.1 — one event per field that moved, so the Employees tab is live for other
  // users like every other tab. No cellKey: these are dialog fields, not grid cells,
  // so a receiving browser refetches rather than patching one input.
  await recordChanges(
    (Object.keys(EMPLOYEE_FIELD_LABELS) as (keyof typeof data)[])
      .map((field) => {
        const previousValue = employeeFieldText(before ? (before as Record<string, unknown>)[field] : null);
        const newValue = employeeFieldText(data[field]);
        return { field, previousValue, newValue };
      })
      .filter((f) => f.previousValue !== f.newValue)
      .map((f) => ({
        tab: "Employees",
        // The person is the row. Their name before the edit, so a rename reads
        // "Bob Smith → Robert Smith" against the row you were looking at.
        rowRef: before?.name ?? data.name,
        columnName: EMPLOYEE_FIELD_LABELS[f.field],
        previousValue: f.previousValue,
        newValue: f.newValue,
        changeType: classifyChange(f.previousValue, f.newValue),
        entityType: "Employee",
        entityId: id,
      })),
    { action: "employee.update" },
  );
  revalidatePath("/employees");
}

// The editable employee fields, as a human reads them. Also the allow-list for what
// gets announced — a field absent here is not reported.
const EMPLOYEE_FIELD_LABELS = {
  name: "Name",
  department: "Department",
  billingGroup: "Billing Group",
  discipline: "Discipline",
  paylocityId: "Paylocity ID",
  supervisorId: "Supervisor",
} as const;

function employeeFieldText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === "" ? null : s;
}

// Read-only: reports how ETC's full roster (active + inactive) reconciles with
// the Scheduler's team list. No writes. Name-matched, unlike the ID-matched
// scripts/reconcile-employee-groups.ts — see sync-scheduler-team.ts's header
// comment for why this stays as a second, non-authoritative comparison.
export async function reconcileSchedulerRosterAction(): Promise<RosterReconciliation> {
  return reconcileSchedulerRoster();
}

// Imports reporting lines from an uploaded Paylocity employee export (the
// "Supervisor [Id]" column), matched by Emp Id == paylocityId. Returns a report
// for the UI. Same apply logic a future SharePoint auto-pull would reuse.
export async function importSupervisorsAction(formData: FormData): Promise<SupervisorImportResult> {
  await assertActionPermission("employees:edit");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, reason: "No file uploaded.", updated: [], clearedCount: 0, unchanged: 0, notInEtc: 0, supervisorNotInEtc: [] };
  }
  let parsed;
  try {
    parsed = parseSupervisorExport(Buffer.from(await file.arrayBuffer()));
  } catch {
    return { ok: false, reason: "Could not read that file — expected a Paylocity employee export (.xlsx).", updated: [], clearedCount: 0, unchanged: 0, notInEtc: 0, supervisorNotInEtc: [] };
  }
  const result = await applySupervisorImport(parsed);
  if (result.ok) revalidatePath("/employees");
  return result;
}

// Soft-delete / restore. Historical ActualHours rows stay linked either way.
export async function setEmployeeActive(id: number, active: boolean, _formData: FormData) {
  await assertActionPermission("employees:edit");
  const employee = await prisma.employee.update({ where: { id }, data: { active } });
  await logAudit({
    action: active ? "employee.reactivate" : "employee.deactivate",
    entityType: "Employee",
    entityId: id,
    summary: `${active ? "Reactivated" : "Deactivated"} employee ${employee.name}`,
  });
  // Announced like any other change: this one moves a person between the roster's
  // Active and Inactive lists, so a colleague looking at either needs to know.
  // "edited" rather than added/removed — the soft-delete flips a value, it does not
  // clear a cell (historical ActualHours rows stay linked either way).
  await recordChanges(
    [
      {
        tab: "Employees",
        rowRef: employee.name,
        columnName: "Active",
        previousValue: active ? "Inactive" : "Active",
        newValue: active ? "Active" : "Inactive",
        changeType: "edited",
        entityType: "Employee",
        entityId: id,
      },
    ],
    { action: active ? "employee.reactivate" : "employee.deactivate" },
  );
  revalidatePath("/employees");
}

export type AddTeamMemberResult = { ok: true; schedulerSynced: boolean; schedulerReason?: string } | { ok: false; error: string };

// "Add member" from a department card — the write half of matching the
// Scheduler board exactly. Two phases, deliberately in this order: the LOCAL
// Reports Employee row first (this is the record that matters if the second
// phase fails), then a best-effort push to Scheduler's own team_members table
// so the person shows up there too (see scheduler-push.ts's own header for
// why this can't just be a direct DB write). A push failure does not roll
// back the local row — a half-added person who exists in Reports but not yet
// on the Scheduler board is recoverable with "Reconcile with Scheduler"
// later; losing the row entirely because a network call to another app
// timed out would not be.
export async function addTeamMember(disciplineCode: string, name: string): Promise<AddTeamMemberResult> {
  await assertActionPermission("employees:edit");

  const trimmedName = name.trim();
  if (!trimmedName) return { ok: false, error: "Name is required." };

  const label = DISCIPLINE_LABEL[disciplineCode];
  if (!label) return { ok: false, error: `"${disciplineCode}" is not a department this can add to.` };

  const employee = await prisma.employee.create({ data: { name: trimmedName, discipline: label } });
  await logAudit({
    action: "employee.create",
    entityType: "Employee",
    entityId: employee.id,
    summary: `Added ${employee.name} to ${label} (from the Employees card)`,
    metadata: { name: trimmedName, discipline: label },
  });

  const push = await pushTeamMemberToScheduler(employee.id, trimmedName, disciplineCode);
  revalidatePath("/employees");
  return { ok: true, schedulerSynced: push.ok, schedulerReason: push.ok ? undefined : push.reason };
}
