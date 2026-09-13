/**
 * Rename ETC's generic outsourced placeholder rows to the real people they are.
 *
 *   npx tsx scripts/rename-outsourced-employees.ts            # dry run
 *   npx tsx scripts/rename-outsourced-employees.ts --apply    # renames
 *
 *   "CE Outsourced" [100700] -> Kedar Tarlekar
 *   "ME Outsourced" [100600] -> Vipin Vijayan
 *
 * Why this is safe, and why it is the right fix rather than a translation layer:
 *
 *   - `name` is NOT an identity key. Hours are keyed by Paylocity Employee Id
 *     (JobHoursDetail.employeeId), and every consumer resolves it through
 *     Employee.paylocityId — hours-explorer, job-hours-detail, data-quality.
 *     paylocityId is untouched here, so no hours, job cost or ETC history moves.
 *
 *   - `name` IS the join key to the SDC Scheduler. src/lib/sync-scheduler-team.ts
 *     matches the two apps on a normalized name because they share no stable key
 *     for that comparison, and the Scheduler board already knows these two by
 *     their REAL names. Today "CE Outsourced" can never match "Kedar Tarlekar",
 *     so both people sit permanently in the reconcile "unmatched" lists. The
 *     rename is what makes the two apps agree.
 *
 *   - No live code branches on the string. The only /outsourced/i special-casing
 *     left is in scripts/archive/, already retired.
 *
 * "Outsourced" is an attribute, not a name — it belongs in department /
 * positionTitle / billingGroup, which are filterable, not baked into a display
 * string that doubles as a cross-app join key.
 *
 * Matched by paylocityId, never by the placeholder text, so a second row that
 * happens to be called "ME Outsourced" (100800, an inactive duplicate) is left
 * alone. Refuses to rename onto a name another employee already holds.
 */
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

// paylocityId -> the real person. Keyed by id because that is the identity;
// the current name is only asserted so a surprise row is reported, not renamed.
const RENAMES = [
  { paylocityId: "100700", expect: "CE Outsourced", to: "Kedar Tarlekar" },
  { paylocityId: "100600", expect: "ME Outsourced", to: "Vipin Vijayan" },
];

// The app version stamped on audit rows, matching src/lib/change-log.ts.
const APP_VERSION = process.env.npm_package_version ?? "script";

async function main() {
  const planned: { id: number; from: string; to: string }[] = [];

  for (const r of RENAMES) {
    const emp = await prisma.employee.findUnique({
      where: { paylocityId: r.paylocityId },
      select: { id: true, name: true, active: true, department: true },
    });
    if (!emp) {
      console.log(`SKIP ${r.to}: no employee with paylocityId ${r.paylocityId}`);
      continue;
    }
    if (emp.name === r.to) {
      console.log(`OK   ${r.to} [${r.paylocityId}] — already renamed`);
      continue;
    }
    if (emp.name !== r.expect) {
      console.log(`SKIP ${r.paylocityId}: expected "${r.expect}", found "${emp.name}" — not touching it`);
      continue;
    }
    // A rename must not collide with somebody who already exists.
    const clash = await prisma.employee.findFirst({
      where: { name: r.to, id: { not: emp.id } },
      select: { id: true, paylocityId: true },
    });
    if (clash) {
      console.log(`SKIP ${r.to}: employee #${clash.id} [${clash.paylocityId ?? "no id"}] already has that name`);
      continue;
    }
    console.log(`RENAME #${emp.id} "${emp.name}" → "${r.to}"   (${emp.department || "no dept"}, ${emp.active ? "active" : "inactive"})`);
    planned.push({ id: emp.id, from: emp.name, to: r.to });
  }

  if (!APPLY) {
    console.log(`\nDry run — nothing written. Re-run with --apply to rename ${planned.length} employee(s).`);
    return;
  }

  for (const p of planned) {
    await prisma.employee.update({ where: { id: p.id }, data: { name: p.to } });
    // Same audit shape the Employees dialog writes (see employee-actions.ts):
    // tab "Employees", the row is the person, rowRef is the name BEFORE the edit
    // so the log reads "CE Outsourced → Kedar Tarlekar" against the row you were
    // looking at. Written with raw SQL rather than recordChanges() so the script
    // does not have to pull next-auth in outside a request scope.
    await prisma.$executeRaw`
      INSERT INTO AuditLog
        (userId, userEmail, userName, action, entityType, entityId, summary, metadata, createdAt,
         tab, rowRef, columnName, previousValue, newValue, changeType, appVersion, changeId)
      VALUES
        (NULL, NULL, 'rename-outsourced-employees script', 'employee.update',
         'Employee', ${String(p.id)},
         ${`Renamed employee ${p.from} to ${p.to}`}, NULL, ${new Date()},
         'Employees', ${p.from}, 'Name', ${p.from}, ${p.to},
         'edited', ${APP_VERSION}, ${randomUUID()})`;
  }
  console.log(`\nRenamed ${planned.length} employee(s), each with an Employees-tab audit row.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
