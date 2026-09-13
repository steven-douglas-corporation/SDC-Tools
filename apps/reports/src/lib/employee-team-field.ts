import "server-only";
import { prisma } from "@/lib/prisma";

// `Employee.team` exists in the database (see prisma/migrations/
// 20260813000000_add_employee_team) but isn't in the generated Prisma Client's
// types yet — `prisma generate` is blocked on this box by a locked
// query-engine DLL held open by a running PM2 process, the same constraint
// already documented for the Job Cost Explorer tables. Raw SQL is the
// established fallback here, same as there. Once `generate` succeeds again,
// this file can be deleted and every call site below switched to reading
// `.team` straight off `prisma.employee`.
export async function fetchEmployeeTeams(): Promise<Map<number, string | null>> {
  const rows = await prisma.$queryRaw<{ id: number; team: string | null }[]>`SELECT id, team FROM Employee`;
  return new Map(rows.map((r) => [r.id, r.team]));
}

export async function fetchEmployeeTeam(id: number): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ team: string | null }[]>`SELECT team FROM Employee WHERE id = ${id}`;
  return rows[0]?.team ?? null;
}

export async function setEmployeeTeam(id: number, team: string | null): Promise<void> {
  await prisma.$executeRaw`UPDATE Employee SET team = ${team} WHERE id = ${id}`;
}
