/**
 * One-time backfill for the new shared `Employee.team` field (2026-08-13) —
 * the authoritative grouping for the 7 delivery teams, now written directly
 * by SDC Scheduler instead of mirrored in by an hourly name-matched pull.
 *
 *   npx tsx scripts/backfill-employee-team.ts             # dry run, prints the plan
 *   npx tsx scripts/backfill-employee-team.ts --apply     # writes it
 *
 * What this does, in order:
 *   1. For every existing Employee, computes today's teamFor(department,
 *      discipline) result and writes the matching schedulerCode into `team`.
 *      Nothing about department/discipline changes — this only adds the new
 *      column's value.
 *   2. Creates two new Employee rows for real people found on the Scheduler
 *      board with no ETC/Paylocity record at all: Jishnu Madhusoodanan (mech)
 *      and Janki Patel (controls). paylocityId stays null until the next
 *      Paylocity import matches them by name.
 *   3. Reactivates Michael Steimle and Justin Wood (active "mech" on the
 *      Scheduler board today, but inactive with no department in ETC) with
 *      team=mech — Scheduler's board is the fresher signal for who's
 *      actually on a team.
 *
 * Deliberately NOT created here (see the plan's "outsourced overlap"
 * decision): Kedar Tarlekar and Vipin Vijayan are the real-name versions of
 * ETC's generic "CE Outsourced" / "ME Outsourced" rows — those get LINKED by
 * scripts/backfill-employee-id.js on the Scheduler side, not duplicated here.
 * "New member" is a stale placeholder row on the board, not a person — left
 * alone entirely; the reconciliation report flags it for manual cleanup.
 *
 * Uses `Employee.team` via raw SQL ($queryRaw/$executeRaw), not the typed
 * Prisma Client API — `prisma generate` is blocked on this box by a locked
 * query-engine DLL (see src/lib/employee-team-field.ts's own comment).
 */
import { PrismaClient } from "@prisma/client";
import { teamFor } from "@/lib/employee-teams";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

async function main() {
  const employees = await prisma.employee.findMany({
    select: { id: true, name: true, department: true, discipline: true, active: true },
  });

  const teamChanges: { id: number; name: string; schedulerCode: string }[] = [];
  const noTeam: string[] = [];
  for (const e of employees) {
    const team = teamFor({ department: e.department, discipline: e.discipline });
    if (team) teamChanges.push({ id: e.id, name: e.name, schedulerCode: team.schedulerCode });
    else noTeam.push(e.name);
  }

  console.log(`\n${teamChanges.length} employees get a team assigned (from their current department/discipline):`);
  for (const c of teamChanges) console.log(`  ${c.name} -> ${c.schedulerCode}`);
  console.log(`\n${noTeam.length} employees stay team=null (not one of the 7 delivery teams): ${noTeam.join(", ")}`);

  // ── New Employee rows for real Scheduler-only people ──────────────────────
  const newPeople: { name: string; schedulerCode: string }[] = [
    { name: "Jishnu Madhusoodanan", schedulerCode: "mech" },
    { name: "Janki Patel", schedulerCode: "controls" },
    // Found unmatched by scripts/backfill-employee-id.js on the Scheduler
    // side — a real name on the mech bucket, same "auto-create" treatment.
    { name: "Brian Mack", schedulerCode: "mech" },
  ];
  console.log(`\n${newPeople.length} new Employee rows to create (real people on Scheduler's board, no ETC record):`);
  for (const p of newPeople) console.log(`  ${p.name} -> ${p.schedulerCode} (active, paylocityId=null)`);

  // ── Reactivations ──────────────────────────────────────────────────────────
  const reactivations = employees.filter((e) => ["Michael Steimle", "Justin Wood"].includes(e.name));
  console.log(`\n${reactivations.length} employees to reactivate with team=mech (active on Scheduler's board today):`);
  for (const e of reactivations) console.log(`  ${e.name} (was active=${e.active}, department=${e.department ?? "(none)"})`);

  if (!APPLY) {
    console.log("\nDry run only — pass --apply to write these changes.");
    return;
  }

  for (const c of teamChanges) {
    await prisma.$executeRaw`UPDATE Employee SET team = ${c.schedulerCode} WHERE id = ${c.id}`;
  }
  for (const p of newPeople) {
    const [existing] = await prisma.employee.findMany({ where: { name: p.name } });
    if (existing) {
      console.log(`  skip ${p.name}: an Employee row already exists (id ${existing.id})`);
      continue;
    }
    const created = await prisma.employee.create({ data: { name: p.name, active: true } });
    await prisma.$executeRaw`UPDATE Employee SET team = ${p.schedulerCode} WHERE id = ${created.id}`;
    console.log(`  created ${p.name} (id ${created.id})`);
  }
  for (const e of reactivations) {
    await prisma.employee.update({ where: { id: e.id }, data: { active: true } });
    await prisma.$executeRaw`UPDATE Employee SET team = 'mech' WHERE id = ${e.id}`;
    console.log(`  reactivated ${e.name}`);
  }

  console.log("\nDone.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
