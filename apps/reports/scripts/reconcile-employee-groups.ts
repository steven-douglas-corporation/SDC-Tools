/**
 * Reconciliation check for the shared employee/department source of truth
 * (2026-08-13) — run any time to confirm ETC and Scheduler still agree.
 *
 *   npx tsx scripts/reconcile-employee-groups.ts
 *
 * Supersedes reconcileSchedulerRoster() (formerly sync-scheduler-team.ts):
 * that compared by fuzzy name match, which is exactly the kind of drift this
 * migration removed. This compares by team_members.employee_id — ETC's
 * Employee.id — so a linked row's Reports Group and Scheduler Group are the
 * same value by construction (both are written by the one code path in
 * SDC_Scheduler/routes/team.js). This script's real job is catching what
 * ISN'T linked yet, not catching drift between two numbers that can no
 * longer disagree.
 *
 * Uses Employee.team via raw SQL — see src/lib/employee-team-field.ts for
 * why (prisma generate is blocked on this box).
 */
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import mysql from "mysql2/promise";

const prisma = new PrismaClient();

// scheduler-db.ts is `server-only` and can't be imported from a plain script
// (see plan-scheduler-team-from-departments.ts's own note).
function loadEnvFile() {
  if (!fs.existsSync(".env")) return;
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\r\n]*)"?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

type EtcRow = { id: number; name: string; team: string | null; active: number | boolean };
type SchedulerMember = { id: number; name: string; discipline: string; active: number; employee_id: number | null };

const SHARED_CODES = new Set(["pm", "mech", "controls", "build", "wire", "service", "mfgops"]);

async function fetchSchedulerTeam(): Promise<SchedulerMember[]> {
  loadEnvFile();
  const url = process.env.SCHEDULER_DATABASE_URL;
  if (!url) throw new Error("SCHEDULER_DATABASE_URL is not set — cannot read the Scheduler team board.");
  const conn = await mysql.createConnection(url);
  try {
    const [rows] = await conn.query(
      "SELECT id, name, discipline, active, employee_id FROM team_members WHERE name NOT LIKE '%Placeholder%'",
    );
    return rows as SchedulerMember[];
  } finally {
    await conn.end();
  }
}

async function main() {
  const employees = await prisma.$queryRaw<EtcRow[]>`SELECT id, name, team, active FROM Employee`;
  const scheduler = await fetchSchedulerTeam();

  const schedulerByEmployeeId = new Map<number, SchedulerMember>();
  for (const m of scheduler) if (m.employee_id != null) schedulerByEmployeeId.set(m.employee_id, m);

  const rows: { id: number; name: string; reportsGroup: string; schedulerGroup: string; match: string }[] = [];
  let mismatches = 0;

  for (const e of employees) {
    const linked = schedulerByEmployeeId.get(e.id);
    if (!linked) continue; // not on the Scheduler board at all — not this report's concern
    if (!SHARED_CODES.has(linked.discipline)) continue; // back-office bucket, out of shared scope

    const reportsGroup = e.team ?? "(none)";
    const schedulerGroup = linked.discipline;
    const groupMatch = reportsGroup === schedulerGroup;
    const statusMatch = Boolean(e.active) === Boolean(linked.active);
    const match = groupMatch && statusMatch ? "yes" : !groupMatch ? "GROUP MISMATCH" : "STATUS MISMATCH";
    if (match !== "yes") mismatches++;
    rows.push({ id: e.id, name: e.name, reportsGroup, schedulerGroup, match });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));

  console.log("Employee ID | Employee Name | Reports Group | Scheduler Group | Match");
  console.log("----------- | -------------- | -------------- | ---------------- | -----");
  for (const r of rows) {
    console.log(`${r.id} | ${r.name} | ${r.reportsGroup} | ${r.schedulerGroup} | ${r.match}`);
  }

  // What isn't linked yet — a brand-new hire added to one app but not the
  // other, or (on the Scheduler side) something the one-time backfill
  // couldn't match (see backfill-employee-id.js's own printed list).
  const unlinkedScheduler = scheduler.filter((m) => m.employee_id == null && SHARED_CODES.has(m.discipline));
  const linkedIds = new Set(rows.map((r) => r.id));
  const unlinkedEtcInTeam = employees.filter((e) => e.team && SHARED_CODES.has(e.team) && !linkedIds.has(e.id));

  console.log(`\n${rows.length} linked and compared, ${mismatches} mismatch(es).`);
  if (unlinkedScheduler.length) {
    console.log(`${unlinkedScheduler.length} Scheduler board member(s) not linked to any Employee row: ${unlinkedScheduler.map((m) => m.name).join(", ")}`);
  }
  if (unlinkedEtcInTeam.length) {
    console.log(`${unlinkedEtcInTeam.length} Employee row(s) with a team but no linked Scheduler row: ${unlinkedEtcInTeam.map((e) => e.name).join(", ")}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
