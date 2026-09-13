import "dotenv/config";
import { prisma } from "@/lib/prisma";

async function main() {
  const all = await prisma.employee.findMany({ select: { department: true, active: true } });
  const byDept = new Map<string, { active: number; inactive: number }>();
  for (const e of all) {
    const d = e.department?.trim() ? e.department.trim() : "(no department)";
    const c = byDept.get(d) ?? { active: 0, inactive: 0 };
    if (e.active) c.active++; else c.inactive++;
    byDept.set(d, c);
  }
  console.log("department                              active  inactive");
  for (const [d, c] of [...byDept.entries()].sort((a, b) => b[1].active - a[1].active || a[0].localeCompare(b[0]))) {
    console.log(`  ${d.padEnd(38)} ${String(c.active).padStart(5)} ${String(c.inactive).padStart(9)}`);
  }
  const active = all.filter((e) => e.active).length;
  console.log(`\nTotal: ${active} active, ${all.length - active} inactive, ${all.length} on the roster`);
}

main().catch((e) => { console.error("FAILED:", e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
