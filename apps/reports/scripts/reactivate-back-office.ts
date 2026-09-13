/**
 * One-off data correction (2026-08-24): reactivate the back-office employees.
 *
 * Why this exists
 * ---------------
 * The Employees tab gained a card per company department on 2026-08-24, but
 * Growth / Business Development, Finance and Executive Leadership rendered no
 * card at all. That was not a display bug: every person in those departments
 * carried `active = 0`, the tab hides inactive people by default, and a
 * workforce group with no cards renders nothing. The requester confirmed these
 * are current employees, so the flag is simply wrong.
 *
 * `Employee.active` is this app's own manually maintained soft-delete flag
 * (schema.prisma: "Synced from Paylocity (Phase 2). Manually maintained for
 * now."). Nothing in the codebase sets it to false automatically — verified by
 * grep — so this correction will not be reverted by a later sync.
 *
 * Scope, deliberately narrow
 * --------------------------
 * ONLY the five department spellings below, and only rows already inactive.
 * There are other inactive employees (departed staff, duplicate name spellings
 * like "Steve Toneff"/"Steven Toneoff", legacy department spellings) and this
 * must not touch them.
 *
 * It deliberately does NOT reactivate the inactive people in Engineering/Shop
 * departments (Jake Wiegand, Robert Galosi, Timothy Spehar, Mitchell Heinz,
 * Timothy Shaffer). Those departments ALREADY show the headcount the supplied
 * roster expects, so flipping them would push the counts above it — that
 * discrepancy needs a human decision, not a blanket flip.
 *
 * Audit trail
 * -----------
 * Mirrors employee-actions.ts's setEmployeeActive() exactly — an AuditLog row
 * plus a change record per person — rather than issuing a bare UPDATE. Two
 * reasons: the Employees roster's change history should show who moved these
 * people and when, and lib/change-version.ts derives "has anything changed"
 * from MAX(AuditLog.id), so writing these rows is also what makes already-open
 * tabs refresh instead of sitting on a stale roster.
 *
 * Run with:
 *   npx tsx -r ./scripts/shim-server-only.cjs scripts/reactivate-back-office.ts
 *
 * Add --apply to actually write. Without it this is a dry run and changes
 * nothing, so the row list can be checked first.
 *
 * Safe to re-run: it only ever selects rows that are still inactive, so a
 * second run finds nothing to do.
 */

import { prisma } from "@/lib/prisma";
import { logAuditFor } from "@/lib/audit";
import { recordChanges } from "@/lib/change-log";

const BACK_OFFICE_DEPARTMENTS = [
  "growth / business development",
  "business development",
  "sales",
  "finance",
  "executive leadership",
];

// Attribution for the audit rows. This was a requested correction, not
// automated maintenance, so it is attributed to the person who asked for it
// rather than to "system@auto-sync".
const ACTOR_EMAIL = "akamuju@sdcautomation.com";

// APPLIED 2026-08-24 13:29 UTC — 16 employees reactivated.
//
// Three of those sixteen (Aubrie Russell, Richard Wagner, Evan Johnson) turned
// out not to be current employees and were reversed afterwards by
// scripts/deactivate-employees.ts. They are deliberately NOT excluded here:
// this script is the record of what actually ran, and the reversal is its own
// auditable step rather than an edit that would make this file disagree with
// the audit log.

async function main() {
  const apply = process.argv.includes("--apply");

  const inactive = await prisma.$queryRaw<{ id: number; name: string; department: string | null }[]>`
    SELECT id, name, department FROM Employee WHERE active = 0 ORDER BY department, name`;

  const targets = inactive.filter((r) => BACK_OFFICE_DEPARTMENTS.includes((r.department ?? "").trim().toLowerCase()));

  if (targets.length === 0) {
    console.log("Nothing to do — no inactive employees remain in the back-office departments.");
    await prisma.$disconnect();
    return;
  }

  console.log(`${apply ? "Reactivating" : "[DRY RUN] Would reactivate"} ${targets.length} employees:\n`);
  for (const t of targets) {
    console.log(`  id=${String(t.id).padStart(4)}  ${t.name.padEnd(24)} ${t.department}`);
  }

  if (!apply) {
    console.log("\nDry run — nothing was written. Re-run with --apply to commit these changes.");
    await prisma.$disconnect();
    return;
  }

  const actor = await prisma.user.findUnique({ where: { email: ACTOR_EMAIL }, select: { id: true } });
  if (!actor) {
    // Not fatal — logAuditFor accepts a null userId and still records the
    // email — but worth saying out loud rather than silently attributing the
    // change to an id that does not exist.
    console.warn(`\nNote: no User row for ${ACTOR_EMAIL}; audit rows will carry the email only.`);
  }

  console.log("");
  for (const t of targets) {
    await prisma.employee.update({ where: { id: t.id }, data: { active: true } });
    await logAuditFor(actor?.id ?? null, ACTOR_EMAIL, {
      action: "employee.reactivate",
      entityType: "Employee",
      entityId: t.id,
      summary: `Reactivated employee ${t.name} — back-office department flagged inactive in error`,
    });
    await recordChanges(
      [
        {
          tab: "Employees",
          rowRef: t.name,
          columnName: "Active",
          previousValue: "Inactive",
          newValue: "Active",
          changeType: "edited",
          entityType: "Employee",
          entityId: t.id,
        },
      ],
      { action: "employee.reactivate" },
    );
    console.log(`  reactivated  ${t.name}`);
  }

  console.log(`\nDone — ${targets.length} employees reactivated.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
