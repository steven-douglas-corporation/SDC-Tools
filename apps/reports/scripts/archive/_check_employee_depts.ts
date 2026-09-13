// What a delete of the named departments would actually remove, and whether any
// of those people have data hanging off them. Read-only.
//
// Run: npx tsx scripts/_check_employee_depts.ts
import "dotenv/config";
import { prisma } from "@/lib/prisma";

const TARGET = [
  "Business Development",
  "Executive Leadership",
  "Finance",
  "Growth/Business Development",
  "Operations",
  "Sales",
];

async function main() {
  const all = await prisma.employee.findMany({
    select: { id: true, name: true, department: true, active: true, paylocityId: true, supervisorId: true },
    orderBy: [{ department: "asc" }, { name: "asc" }],
  });

  console.log("=== Every department currently on the roster ===");
  const byDept = new Map<string, number>();
  for (const e of all) {
    const d = e.department?.trim() ? e.department.trim() : "(no department)";
    byDept.set(d, (byDept.get(d) ?? 0) + 1);
  }
  for (const [d, n] of [...byDept.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${d}${TARGET.includes(d) || d === "(no department)" ? "   <- TARGETED" : ""}`);
  }

  const targeted = all.filter((e) => {
    const d = e.department?.trim() ?? "";
    return d === "" || TARGET.includes(d);
  });

  console.log(`\n=== Targeted for deletion: ${targeted.length} of ${all.length} ===`);
  for (const e of targeted) {
    console.log(`  ${String(e.id).padStart(4)}  ${e.name.padEnd(28)} ${(e.department ?? "(none)").padEnd(30)} ${e.active ? "active" : "inactive"}  paylocityId=${e.paylocityId ?? "-"}`);
  }

  // Anything referencing them? Punches key off paylocityId as a STRING (not an
  // FK), so a delete would orphan hours silently rather than being blocked.
  const ids = new Set(targeted.map((e) => e.paylocityId).filter(Boolean) as string[]);
  const punches = ids.size
    ? await prisma.jobHoursDetail.groupBy({
        by: ["employeeId"],
        where: { employeeId: { in: [...ids] } },
        _sum: { hours: true },
        _count: { _all: true },
      })
    : [];

  console.log(`\n=== Punch hours booked by targeted employees (JobHoursDetail, matched on paylocityId) ===`);
  if (punches.length === 0) console.log("  none");
  for (const p of punches.sort((a, b) => Number(b._sum.hours ?? 0) - Number(a._sum.hours ?? 0))) {
    const who = targeted.find((e) => e.paylocityId === p.employeeId);
    console.log(`  ${(who?.name ?? p.employeeId).padEnd(28)} ${Number(p._sum.hours ?? 0).toFixed(2).padStart(10)}h across ${p._count._all} punches`);
  }

  // Are any of them somebody's supervisor? Employee.supervisorId is a real FK
  // with onDelete: SetNull, so this would quietly blank reporting lines.
  const targetedIds = targeted.map((e) => e.id);
  const reports = await prisma.employee.findMany({
    where: { supervisorId: { in: targetedIds } },
    select: { id: true, name: true, department: true, supervisorId: true },
  });
  console.log(`\n=== People who report to a targeted employee (their supervisor would be blanked) ===`);
  if (reports.length === 0) console.log("  none");
  for (const r of reports) {
    const sup = targeted.find((e) => e.id === r.supervisorId);
    console.log(`  ${r.name.padEnd(28)} (${r.department ?? "-"}) reports to ${sup?.name ?? r.supervisorId}`);
  }
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
