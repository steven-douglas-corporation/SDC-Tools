import { DISCIPLINE_LABEL_SET } from "@/lib/disciplines";
import { prisma } from "@/lib/prisma";
import type { NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { checkSchedulerToken } from "@/lib/scheduler-api-auth";
import { logAudit } from "@/lib/audit";

// Employee roster for the SDC_Scheduler team board. Server-to-server, guarded by
// SCHEDULER_SHARED_TOKEN (same token as /api/integration/jobs; see proxy.ts,
// which exempts /api/integration from the browser session). ETC is the master
// roster — the Scheduler shows ETC's active-but-ungrouped people as
// "Unassigned" and ETC's inactive people as "Inactive".
//
// GET   → the full roster (active + inactive), keyed by paylocityId.
// PATCH → push a grouping decision back to ETC (set/clear an employee's
//         discipline), so a drag on the Scheduler board reflects in ETC too.

// Shared with the Employees page and the sync map — see lib/disciplines.ts.
const ETC_DISCIPLINES = DISCIPLINE_LABEL_SET;

export async function GET(req: NextRequest) {
  const denied = checkSchedulerToken(req);
  if (denied) return denied;

  const employees = await prisma.employee.findMany({
    select: { paylocityId: true, name: true, active: true, discipline: true },
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  return Response.json({ employees });
}

export async function PATCH(req: NextRequest) {
  const denied = checkSchedulerToken(req);
  if (denied) return denied;

  let body: { paylocityId?: string; discipline?: string | null };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const paylocityId = String(body.paylocityId ?? "").trim();
  if (!paylocityId) return Response.json({ error: "paylocityId_required" }, { status: 400 });

  // null / "" clears the grouping (back to Unassigned); otherwise must be one of
  // the five canonical labels.
  const rawDiscipline = body.discipline == null ? null : String(body.discipline).trim();
  const discipline = rawDiscipline ? rawDiscipline : null;
  if (discipline && !ETC_DISCIPLINES.has(discipline)) {
    return Response.json({ error: "invalid_discipline", allowed: [...ETC_DISCIPLINES] }, { status: 400 });
  }

  const employee = await prisma.employee.findUnique({ where: { paylocityId } });
  if (!employee) return Response.json({ error: "employee_not_found" }, { status: 404 });

  if (employee.discipline === discipline) {
    return Response.json({ ok: true, unchanged: true });
  }

  await prisma.employee.update({ where: { id: employee.id }, data: { discipline } });
  await logAudit({
    action: "employee.disciplineFromScheduler",
    entityType: "Employee",
    entityId: employee.id,
    summary: `Discipline set to ${discipline ?? "(unassigned)"} for ${employee.name} via Scheduler board`,
    metadata: { before: employee.discipline, after: discipline },
  });
  revalidatePath("/employees");

  return Response.json({ ok: true, name: employee.name, discipline });
}
