// Deactivates the non-project departments on the employee roster: Business
// Development, Executive Leadership, Finance, Growth / Business Development,
// Operations, Sales, and everyone with no department at all.
//
// Deactivate, not delete. Employees are never hard-deleted here (Dan's
// requirement, restated at the top of employee-actions.ts): departed people
// keep their historical hours, and five of the people in this set are still
// somebody's supervisor, so removing the rows would silently blank eight
// reporting lines for staff who are staying.
//
// The practical effect is the same — the roster hides inactive people by
// default — and it is reversible from the Status dropdown on the Employees tab.
//
// Writes an audit row per person, the same action name the UI's own
// deactivate uses, so this bulk pass is not invisible in the log.
//
// Dry run (default):  npx tsx scripts/deactivate-non-project-departments.ts
// Apply:              npx tsx scripts/deactivate-non-project-departments.ts --apply
import "dotenv/config";
import { prisma } from "@/lib/prisma";

// Matched case-insensitively and whitespace-insensitively around the slash:
// the roster carries "Growth / Business Development" with spaces, which an
// exact-string match silently misses.
const TARGET_DEPARTMENTS = [
  "business development",
  "executive leadership",
  "finance",
  "growth / business development",
  "operations",
  "sales",
];

const normalise = (s: string) => s.trim().toLowerCase().replace(/\s*\/\s*/g, " / ").replace(/\s+/g, " ");

async function main() {
  const apply = process.argv.includes("--apply");

  const all = await prisma.employee.findMany({
    select: { id: true, name: true, department: true, active: true },
    orderBy: [{ department: "asc" }, { name: "asc" }],
  });

  const targeted = all.filter((e) => {
    const d = (e.department ?? "").trim();
    return d === "" || TARGET_DEPARTMENTS.includes(normalise(d));
  });
  const toChange = targeted.filter((e) => e.active);

  console.log(`Roster: ${all.length} employees`);
  console.log(`Targeted departments (incl. no department): ${targeted.length}`);
  console.log(`Already inactive, nothing to do: ${targeted.length - toChange.length}`);
  console.log(`Will be deactivated: ${toChange.length}\n`);
  for (const e of toChange) {
    console.log(`  ${String(e.id).padStart(4)}  ${e.name.padEnd(28)} ${e.department?.trim() || "(no department)"}`);
  }

  if (!apply) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to make these changes.");
    return;
  }

  const ids = toChange.map((e) => e.id);
  await prisma.$transaction([
    prisma.employee.updateMany({ where: { id: { in: ids } }, data: { active: false } }),
    prisma.auditLog.createMany({
      data: toChange.map((e) => ({
        action: "employee.deactivate",
        entityType: "Employee",
        entityId: String(e.id),
        summary: `Deactivated employee ${e.name} (bulk: non-project departments)`.slice(0, 191),
        metadata: { department: e.department, reason: "bulk deactivation of non-project departments" },
      })),
    }),
  ]);

  console.log(`\nDeactivated ${ids.length} employee(s), with an audit row each.`);
  console.log("Reversible from the Status dropdown on the Employees tab.");
}

main()
  .catch((e) => { console.error("FAILED:", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
