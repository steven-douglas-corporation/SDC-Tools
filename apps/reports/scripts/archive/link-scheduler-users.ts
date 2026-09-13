/**
 * One-time migration for the shared-account project (2026-08-13) — creates a Reports
 * account for every real Scheduler user who doesn't have one yet, so they can sign into
 * Reports directly (not only via the Scheduler SSO hand-off, which would otherwise be
 * their only way in until they happen to click a cross-app link — see auth.ts's
 * "scheduler-sso" provider for that ongoing path; this script is what gets the CURRENT
 * 14 people a working account today instead of waiting on that).
 *
 *   npx tsx scripts/link-scheduler-users.ts             # dry run, prints the plan
 *   npx tsx scripts/link-scheduler-users.ts --apply     # writes it, prints temp passwords
 *
 * Matched by normalized (trimmed, lowercased) email against Scheduler's `users` table —
 * no fuzzy name matching needed, this is a small, fully-reviewed dataset. Two emails are
 * deliberately skipped rather than linked (see SKIP below); everything else creates a
 * new Reports User with role MANAGER, active mirroring the Scheduler row, and a
 * generated temp password (same word-list style as Scheduler's own _genTempPassword) —
 * print it now, hand it out directly (Slack/in person), since neither app sends email.
 *
 * Companion to SDC_Scheduler/scripts/link-etc-users.js, which does the reverse: link the
 * accounts that already exist on both sides (writes Scheduler's own `reports_user_id`,
 * nothing on this side), and create Scheduler accounts for the handful of Reports-only
 * people. The two scripts can run in either order — this one only reads Reports' User
 * table for emails that already exist today, and never depends on the other script
 * having run first.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import fs from "fs";
import mysql from "mysql2/promise";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

// scheduler-db.ts is `server-only` and can't be imported from a plain script — same
// note as reconcile-employee-groups.ts.
function loadEnvFile() {
  if (!fs.existsSync(".env")) return;
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\r\n]*)"?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

type SchedulerUser = { id: number; email: string; name: string; active: number | boolean };

async function fetchSchedulerUsers(): Promise<SchedulerUser[]> {
  loadEnvFile();
  const url = process.env.SCHEDULER_DATABASE_URL;
  if (!url) throw new Error("SCHEDULER_DATABASE_URL is not set — cannot read the Scheduler's user table.");
  const conn = await mysql.createConnection(url);
  try {
    const [rows] = await conn.query("SELECT id, email, name, active FROM users");
    return rows as SchedulerUser[];
  } finally {
    await conn.end();
  }
}

// Same shape as Scheduler's own routes/users.js _genTempPassword — one recognizable
// convention for "a temp password someone was handed", not two.
const WORDS = ["blue", "lime", "gear", "bolt", "fast", "spark", "steel", "motor", "shaft", "cam", "weld", "panel"];
function genTempPassword(): string {
  const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${pick()}-${pick()}-${pick()}-${Math.floor(10 + Math.random() * 89)}`;
}

async function main() {
  const scheduler = await fetchSchedulerUsers();
  const reportsUsers = await prisma.user.findMany({ select: { email: true } });
  const reportsEmails = new Set(reportsUsers.map((u) => u.email.trim().toLowerCase()));

  const toCreate = scheduler.filter((s) => !reportsEmails.has(s.email.trim().toLowerCase()));

  console.log(`${scheduler.length} Scheduler users, ${reportsEmails.size} Reports users, ${toCreate.length} need a new Reports account.\n`);

  // Observation, not a skip — jackiehlavaty@ and jhlavaty@ look like they could be the
  // same person under two Scheduler logins, but that's a pre-existing Scheduler data
  // question, not something this migration introduces or is positioned to judge. Both
  // get linked normally; flagging it here just means it isn't a silent surprise later.
  const near = toCreate.filter((s) => /hlavaty/i.test(s.email));
  if (near.length > 1) {
    console.log(`Note: ${near.map((s) => s.email).join(", ")} look like they might be the same person — creating both as distinct linked accounts. Review in Scheduler's own Setup > Users if that's wrong.\n`);
  }

  for (const s of toCreate) console.log(`  create: ${s.email} (${s.name}), active=${Boolean(s.active)}`);

  if (!APPLY) {
    console.log("\nDry run only — pass --apply to write these changes.");
    return;
  }

  console.log("\nCreating Reports accounts — temp passwords below, hand these out directly:\n");
  for (const s of toCreate) {
    const email = s.email.trim().toLowerCase();
    const tempPassword = genTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    // `active` isn't on the generated Client yet (see src/lib/token-revocation.ts's own
    // note on why) — create with the schema default (true), then a raw UPDATE for the
    // rare case a Scheduler account is itself inactive, so that status carries over
    // rather than silently reactivating someone on the Reports side.
    const created = await prisma.user.create({ data: { email, name: s.name, passwordHash, role: "MANAGER" } });
    if (!s.active) await prisma.$executeRaw`UPDATE User SET active = false WHERE id = ${created.id}`;
    console.log(`  ${email}  ->  ${tempPassword}   (Reports User id ${created.id}${s.active ? "" : ", inactive"})`);
  }

  console.log("\nDone. Each person should change their password on first Reports login.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
