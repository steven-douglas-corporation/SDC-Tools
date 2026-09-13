/**
 * Plan the SDC Scheduler team board (team_members) from the ETC departments
 * that Employee_Department_Map.xlsx just set.
 *
 *   npx tsx scripts/plan-scheduler-team-from-departments.ts
 *
 * Emits a diff plus ready-to-run SQL. It does NOT write: the ETC host reaches
 * the Scheduler through a READ-ONLY MySQL user (sdc_etc_ro, see scheduler-db.ts),
 * which is deliberate — this app should never mutate the Scheduler's tables
 * behind its back.
 *
 * Note the direction of travel. Normally the Scheduler is the source of truth
 * for discipline and ETC mirrors it (sync-scheduler-team.ts). This script is the
 * one-off reverse: the workbook is now authoritative for who sits in which
 * department, so the board is being brought in line with it.
 *
 * The board has 5 buckets; the workbook has ~15 departments. Only the five
 * below map. Everything else (Finance, Sales, Executive Leadership, …) has no
 * board equivalent — those people belong in the board's "Unassigned" column,
 * which is fed live from the ETC roster and needs no row here.
 */
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import mysql from "mysql2/promise";

// scheduler-db.ts is `server-only` (it's imported by server components), so a
// plain script can't reuse it — this opens its own read-only connection from the
// same SCHEDULER_DATABASE_URL. .env is read by hand because tsx doesn't load it.
type BoardMember = { name: string; discipline: string; active: boolean };

function loadEnvFile() {
  if (!fs.existsSync(".env")) return;
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\r\n]*)"?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

async function fetchBoard(): Promise<BoardMember[]> {
  const conn = await mysql.createConnection(process.env.SCHEDULER_DATABASE_URL!);
  try {
    const [rows] = await conn.query("SELECT name, discipline, active FROM team_members");
    return (rows as { name: string; discipline: string; active: number }[]).map((r) => ({
      name: r.name,
      discipline: r.discipline,
      active: Boolean(r.active),
    }));
  } finally {
    await conn.end();
  }
}

// Every workbook department now has a board bucket (Scheduler DISCIPLINES was
// extended from 5 to 12 for this). Two pairs deliberately share one bucket:
//   "Project Management" + "Project Execution / Project Management" → pm
//   "Business Development" + "Growth / Business Development"        → growth
// Those are the same team written two ways in the source sheet — creating
// separate buckets would split one department across two columns.
const DEPT_TO_DISCIPLINE: Record<string, string> = {
  "Project Execution / Project Management": "pm",
  "Project Management": "pm",
  "Mechanical Engineering": "mech",
  "Controls Engineering": "controls",
  "Mechanical Build / Manufacturing": "build",
  "Electrical Build": "wire",
  "Service Engineering": "service",
  "Manufacturing Operations": "mfgops",
  Operations: "ops",
  Finance: "finance",
  "Growth / Business Development": "growth",
  "Business Development": "growth",
  Sales: "sales",
  "Executive Leadership": "exec",
};

// Nothing is intentionally off-board any more; a department landing here means
// the sheet grew a new one and both apps need a matching bucket.
const NON_BOARD_DEPTS = new Set<string>();

const NICKNAMES: Record<string, string> = {
  mike: "michael", josh: "joshua", rich: "richard", tim: "timothy",
  matt: "matthew", rob: "robert", dave: "david", mitch: "mitchell",
  nick: "nicholas", greg: "gregory", dan: "daniel", tom: "thomas",
  jon: "jonathan", chris: "christopher", andy: "andrew", bill: "william",
  billy: "william", sam: "samuel", joe: "joseph", jim: "james", ben: "benjamin",
  rick: "richard",
};

function normalizeName(name: string): string {
  const parts = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]/g, " ")
    .trim()
    .split(/\s+/);
  if (parts.length > 0) parts[0] = NICKNAMES[parts[0]] ?? parts[0];
  return parts.join("");
}

const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;

const prisma = new PrismaClient();

async function main() {
  loadEnvFile();
  if (!process.env.SCHEDULER_DATABASE_URL) {
    console.error("SCHEDULER_DATABASE_URL is not set — cannot read the Scheduler team board.");
    process.exit(1);
  }

  const [employees, board] = await Promise.all([
    prisma.employee.findMany({ where: { active: true }, select: { name: true, department: true } }),
    fetchBoard(),
  ]);

  const empByKey = new Map(employees.map((e) => [normalizeName(e.name), e]));

  const moves: { name: string; from: string; to: string; dept: string }[] = [];
  const correct: string[] = [];
  const shouldLeaveBoard: { name: string; from: string; dept: string }[] = [];
  const notInEtc: string[] = [];
  const placeholders: string[] = [];
  const unknownDept = new Set<string>();

  for (const m of board) {
    // Placeholder rows (ME/CE/Build/Wire Placeholder) are the board's own
    // capacity stand-ins, not people. Never touch them.
    if (/placeholder/i.test(m.name)) { placeholders.push(m.name); continue; }

    const emp = empByKey.get(normalizeName(m.name));
    if (!emp) { notInEtc.push(`${m.name} (${m.discipline})`); continue; }

    const dept = (emp.department ?? "").trim();
    const target = DEPT_TO_DISCIPLINE[dept];
    if (!target) {
      if (dept && !NON_BOARD_DEPTS.has(dept)) unknownDept.add(dept);
      shouldLeaveBoard.push({ name: m.name, from: m.discipline, dept: dept || "(none)" });
      continue;
    }
    if (target !== m.discipline) moves.push({ name: m.name, from: m.discipline, to: target, dept });
    else correct.push(m.name);
  }

  // People whose department maps to a bucket but who have no board row at all.
  // ETC's generic outsourced rows ("CE Outsourced", "ME Outsourced") are excluded:
  // the board already models spare capacity with its own ME/CE/Build/Wire
  // Placeholder rows, and it knows the outsourced staff by their real names
  // (Kedar Tarlekar, Vipin Vijayan, …) — adding a generic row would double-count.
  const boardKeys = new Set(board.map((m) => normalizeName(m.name)));
  const isEtcPlaceholder = (name: string) => /outsourced|placeholder/i.test(name);
  const missing = employees
    .filter(
      (e) =>
        DEPT_TO_DISCIPLINE[(e.department ?? "").trim()] &&
        !boardKeys.has(normalizeName(e.name)) &&
        !isEtcPlaceholder(e.name)
    )
    .map((e) => ({ name: e.name, to: DEPT_TO_DISCIPLINE[(e.department ?? "").trim()], dept: (e.department ?? "").trim() }));

  console.log(`Board rows: ${board.length} (${placeholders.length} placeholders)   Active ETC employees: ${employees.length}`);

  console.log(`\nMOVE — wrong bucket for their department (${moves.length}):`);
  for (const m of moves) console.log(`  ${m.name.padEnd(24)} ${m.from} → ${m.to}   [${m.dept}]`);

  console.log(`\nADD — department maps to a bucket, but not on the board (${missing.length}):`);
  for (const m of missing) console.log(`  ${m.name.padEnd(24)} → ${m.to}   [${m.dept}]`);

  console.log(`\nREVIEW — on the board, but their department has no bucket (${shouldLeaveBoard.length}):`);
  for (const m of shouldLeaveBoard) console.log(`  ${m.name.padEnd(24)} currently ${m.from.padEnd(9)} [${m.dept}]`);

  if (notInEtc.length) {
    console.log(`\nON BOARD, NOT AN ACTIVE ETC EMPLOYEE (${notInEtc.length}) — left alone:`);
    for (const n of notInEtc) console.log(`  ${n}`);
  }
  if (unknownDept.size) {
    console.log(`\nUNRECOGNISED DEPARTMENTS (${unknownDept.size}) — add to the map or NON_BOARD_DEPTS:`);
    for (const d of unknownDept) console.log(`  ${d}`);
  }
  console.log(`\nAlready in the right bucket: ${correct.length}`);

  if (moves.length || missing.length) {
    console.log("\n--- SQL (review before running; the ETC host has read-only access) ---");
    for (const m of moves) {
      console.log(`UPDATE team_members SET discipline = ${sqlStr(m.to)} WHERE name = ${sqlStr(m.name)} AND discipline = ${sqlStr(m.from)};`);
    }
    for (const m of missing) {
      console.log(
        `INSERT INTO team_members (name, discipline, active, is_lead) SELECT ${sqlStr(m.name)}, ${sqlStr(m.to)}, 1, 0 ` +
          `FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM team_members WHERE name = ${sqlStr(m.name)});`
      );
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
