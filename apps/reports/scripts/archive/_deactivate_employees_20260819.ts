// One-off: deactivate 6 employees at the user's direct request (2026-08-19).
// Not reachable via the UI today (setEmployeeActive in employee-actions.ts
// has no caller yet), so this replicates that function's exact behavior --
// same audit-log entry, same change-log entry -- run directly instead.
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { logAuditFor } from "@/lib/audit";
import { recordChanges } from "@/lib/change-log";

const ACTOR_USER_ID = 6; // akamuju@sdcautomation.com
const ACTOR_EMAIL = "akamuju@sdcautomation.com";

const NAMES = ["Jon Culp", "Michael Steimle", "Justin Wood", "Jake Wiegand", "Brian Mack", "Robert Galosi"];

async function main() {
  for (const name of NAMES) {
    const employee = await prisma.employee.findFirst({ where: { name } });
    if (!employee) {
      console.error(`NOT FOUND: ${name}`);
      continue;
    }
    if (!employee.active) {
      console.log(`Already inactive: ${employee.name}`);
      continue;
    }

    await prisma.employee.update({ where: { id: employee.id }, data: { active: false } });

    await logAuditFor(ACTOR_USER_ID, ACTOR_EMAIL, {
      action: "employee.deactivate",
      entityType: "Employee",
      entityId: employee.id,
      summary: `Deactivated employee ${employee.name}`,
    });

    await recordChanges(
      [
        {
          tab: "Employees",
          rowRef: employee.name,
          columnName: "Active",
          previousValue: "Active",
          newValue: "Inactive",
          changeType: "edited",
          entityType: "Employee",
          entityId: employee.id,
        },
      ],
      { action: "employee.deactivate" },
    );

    console.log(`Deactivated: ${employee.name} (id ${employee.id})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
