import "server-only";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

// Sets each ETC employee's supervisor (reporting line) from a Paylocity
// employee export — the authoritative org chart. Matched on Emp Id ==
// Employee.paylocityId (a stable key), so no name matching is needed. The
// supervisor is another Employee (self-relation), resolved via the supervisor's
// own Emp Id embedded in the "Supervisor [Id]" cell, e.g. "Cantrell, Dewayne
// [100125]".
//
// parseSupervisorExport is deliberately split from applySupervisorImport so the
// same apply step can later be fed automatically from SharePoint (Microsoft
// Graph), exactly like the hours sync (see job-hours-source.ts), instead of a
// manual upload — without changing the matching/DB logic.

export type SupervisorExportRow = {
  empId: string;
  supervisorEmpId: string | null;
  status: string;
};

// Pull "[100125]" out of "Cantrell, Dewayne [100125]".
function extractBracketId(cell: unknown): string | null {
  const m = String(cell ?? "").match(/\[(\d+)\]/);
  return m ? m[1] : null;
}

export function parseSupervisorExport(buf: Buffer): SupervisorExportRow[] {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
  const out: SupervisorExportRow[] = [];
  for (const r of rows) {
    // Tolerate minor header variations by looking the columns up loosely.
    const empId = String(r["Emp Id"] ?? r["Emp ID"] ?? r["EmpId"] ?? "").trim();
    if (!empId) continue;
    out.push({
      empId,
      supervisorEmpId: extractBracketId(r["Supervisor [Id]"] ?? r["Supervisor"]),
      status: String(r["Status"] ?? "").trim(),
    });
  }
  return out;
}

export type SupervisorImportResult = {
  ok: boolean;
  reason?: string;
  // Employees whose supervisor changed: name → new supervisor name.
  updated: { name: string; supervisor: string }[];
  clearedCount: number; // had a supervisor in ETC, export shows none → cleared
  unchanged: number;
  // Export rows whose Emp Id isn't an active ETC employee (terminated, etc.).
  notInEtc: number;
  // Rows where the named supervisor's Emp Id isn't an ETC employee (can't link).
  supervisorNotInEtc: { name: string; supervisorEmpId: string }[];
};

export async function applySupervisorImport(
  parsed: SupervisorExportRow[],
): Promise<SupervisorImportResult> {
  if (parsed.length === 0) {
    return {
      ok: false,
      reason: "No employee rows found in the file. Is it a Paylocity employee export (with an 'Emp Id' column)?",
      updated: [], clearedCount: 0, unchanged: 0, notInEtc: 0, supervisorNotInEtc: [],
    };
  }

  // ETC employees keyed by paylocityId, so both the person and their supervisor
  // resolve via the same map.
  const employees = await prisma.employee.findMany({
    where: { paylocityId: { not: null } },
    select: { id: true, name: true, paylocityId: true, supervisorId: true },
  });
  const byPid = new Map(employees.map((e) => [e.paylocityId!, e]));

  const updated: SupervisorImportResult["updated"] = [];
  const supervisorNotInEtc: SupervisorImportResult["supervisorNotInEtc"] = [];
  let clearedCount = 0;
  let unchanged = 0;
  let notInEtc = 0;

  for (const row of parsed) {
    const emp = byPid.get(row.empId);
    if (!emp) {
      notInEtc++;
      continue;
    }
    // Resolve the supervisor's ETC row from the bracketed Emp Id.
    let nextSupervisorId: number | null = null;
    if (row.supervisorEmpId) {
      const sup = byPid.get(row.supervisorEmpId);
      if (sup && sup.id !== emp.id) {
        nextSupervisorId = sup.id;
      } else if (!sup) {
        supervisorNotInEtc.push({ name: emp.name, supervisorEmpId: row.supervisorEmpId });
      }
      // sup.id === emp.id (self-reference in the export) → leave null.
    }

    if (emp.supervisorId === nextSupervisorId) {
      unchanged++;
      continue;
    }
    await prisma.employee.update({ where: { id: emp.id }, data: { supervisorId: nextSupervisorId } });
    if (nextSupervisorId == null) {
      clearedCount++;
    } else {
      const supName = employees.find((e) => e.id === nextSupervisorId)?.name ?? String(nextSupervisorId);
      updated.push({ name: emp.name, supervisor: supName });
    }
  }

  await logAudit({
    action: "employee.importSupervisors",
    entityType: "Employee",
    entityId: 0,
    summary: `Imported supervisors: ${updated.length} set/changed, ${clearedCount} cleared, ${unchanged} unchanged, ${notInEtc} export rows not in ETC, ${supervisorNotInEtc.length} supervisors unresolved`,
    metadata: { updatedCount: updated.length, clearedCount, unchanged, notInEtc, supervisorNotInEtc },
  });

  return { ok: true, updated, clearedCount, unchanged, notInEtc, supervisorNotInEtc };
}
