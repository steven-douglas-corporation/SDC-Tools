// One-off: deactivate 4 more employees at the user's direct request
// (2026-08-19, second batch). Same pattern as
// scripts/archive/_deactivate_employees_20260819.ts -- replicates
// setEmployeeActive's exact behavior (audit log + change log), since that
// function has no UI caller yet.
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { logAuditFor } from "@/lib/audit";
import { recordChanges } from "@/lib/change-log";

const ACTOR_USER_ID = 6; // akamuju@sdcautomation.com
const ACTOR_EMAIL = "akamuju@sdcautomation.com";

const NAMES = ["Timothy Spehar", "Janki Patel", "Mitchell Heinz", "Timothy Shaffer"];

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
