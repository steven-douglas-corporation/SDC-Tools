/**
 * One-off data correction (2026-08-24): deactivate three back-office employees.
 *
 * Context
 * -------
 * scripts/reactivate-back-office.ts reactivated all 16 people in the
 * Growth / Business Development, Business Development, Sales, Finance and
 * Executive Leadership departments, because every one of them carried
 * `active = 0` and their cards therefore rendered nothing on the Employees tab.
 *
 * That was applied on 2026-08-24 at 13:29 UTC. Three of the sixteen turned out
 * not to be current employees, so this reverses those three specifically. The
 * other thirteen stay active.
 *
 * `Employee.active` is a soft-delete flag — historical ActualHours rows stay
 * linked either way (schema.prisma), so deactivating loses no data.
 *
 * Matched on primary key, not name: `Employee.name` is free text with real
 * duplicate spellings in this table ("Steve Toneff" / "Steven Toneoff"), so an
 * id is the only unambiguous way to name a row. The expected name is carried
 * alongside and asserted against the database, so a wrong or stale id fails
 * loudly instead of silently deactivating the wrong person.
 *
 * Audit trail mirrors employee-actions.ts's setEmployeeActive() — an AuditLog
 * row plus a change record each — rather than a bare UPDATE, both so the roster
 * history shows who did this and because lib/change-version.ts derives
 * "has anything changed" from MAX(AuditLog.id), which is what makes open tabs
 * refresh instead of sitting on a stale roster.
 *
 * Run with:
 *   npx tsx -r ./scripts/shim-server-only.cjs scripts/deactivate-employees.ts
 *
 * Add --apply to actually write. Without it this is a dry run.
 * Safe to re-run: it only selects rows that are still active.
 */

import { prisma } from "@/lib/prisma";
import { logAuditFor } from "@/lib/audit";
import { recordChanges } from "@/lib/change-log";

const TO_DEACTIVATE: { id: number; name: string }[] = [
  { id: 121, name: "Aubrie Russell" },
  { id: 63, name: "Richard Wagner" },
  { id: 18, name: "Evan Johnson" },
];

const ACTOR_EMAIL = "akamuju@sdcautomation.com";

async function main() {
  const apply = process.argv.includes("--apply");

  const rows = await prisma.$queryRaw<{ id: number; name: string; department: string | null; active: number | boolean }[]>`
    SELECT id, name, department, active FROM Employee WHERE id IN (${TO_DEACTIVATE[0].id}, ${TO_DEACTIVATE[1].id}, ${TO_DEACTIVATE[2].id})`;

  const targets: { id: number; name: string; department: string | null }[] = [];
  for (const want of TO_DEACTIVATE) {
    const row = rows.find((r) => r.id === want.id);
    if (!row) throw new Error(`No employee with id=${want.id} (expected "${want.name}").`);
    if (row.name.trim().toLowerCase() !== want.name.trim().toLowerCase()) {
      throw new Error(`id=${want.id} expected "${want.name}" but the database has "${row.name}". Refusing to touch it.`);
    }
    if (!Boolean(row.active)) {
      console.log(`  already inactive — skipping  id=${row.id}  ${row.name}`);
      continue;
    }
    targets.push({ id: row.id, name: row.name, department: row.department });
  }

  if (targets.length === 0) {
    console.log("\nNothing to do — all three are already inactive.");
    await prisma.$disconnect();
    return;
  }

  console.log(`\n${apply ? "Deactivating" : "[DRY RUN] Would deactivate"} ${targets.length} employees:\n`);
  for (const t of targets) console.log(`  id=${String(t.id).padStart(4)}  ${t.name.padEnd(22)} ${t.department}`);

  if (!apply) {
    console.log("\nDry run — nothing was written. Re-run with --apply to commit these changes.");
    await prisma.$disconnect();
    return;
  }

  const actor = await prisma.user.findUnique({ where: { email: ACTOR_EMAIL }, select: { id: true } });
  if (!actor) console.warn(`\nNote: no User row for ${ACTOR_EMAIL}; audit rows will carry the email only.`);

  console.log("");
  for (const t of targets) {
    await prisma.employee.update({ where: { id: t.id }, data: { active: false } });
    await logAuditFor(actor?.id ?? null, ACTOR_EMAIL, {
      action: "employee.deactivate",
      entityType: "Employee",
      entityId: t.id,
      summary: `Deactivated employee ${t.name} — not a current employee`,
    });
    await recordChanges(
      [
        {
          tab: "Employees",
          rowRef: t.name,
          columnName: "Active",
          previousValue: "Active",
          newValue: "Inactive",
          changeType: "edited",
          entityType: "Employee",
          entityId: t.id,
        },
      ],
      { action: "employee.deactivate" },
    );
    console.log(`  deactivated  ${t.name}`);
  }

  console.log(`\nDone — ${targets.length} employees deactivated.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
