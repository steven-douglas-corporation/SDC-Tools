/**
 * One-time retroactive backfill for the password hash-sync feature (2026-08-13).
 *
 *   npx tsx scripts/backfill-password-hashes.ts             # dry run, prints the plan
 *   npx tsx scripts/backfill-password-hashes.ts --apply     # writes it
 *
 * The hash-sync built alongside this (see src/app/api/integration/sync-password/route.ts
 * and its Scheduler mirror) only fires when a password is SET — register, change-password,
 * admin reset. That leaves the people who already had an account on both sides before the
 * feature existed still holding TWO different passwords: linking the accounts didn't make
 * one credential work in both places, which is what "shared login" was supposed to mean.
 * Found live when the user's own Scheduler password kept failing on Reports.
 *
 * This applies the sync that WOULD have happened, for every linked account whose two
 * hashes currently differ — copying the hash from whichever side holds the password the
 * person actually KNOWS, which is not the same side for everybody:
 *
 *   Scheduler -> Reports (the default, 28 of 31 accounts). Either they had both accounts
 *     before today and Scheduler is the older/actively-used one, or their Reports account
 *     was created by scripts/link-scheduler-users.ts this afternoon with a generated temp
 *     password that was printed for hand-out and most likely never used. Either way the
 *     Scheduler password is the real one.
 *
 *   Reports -> Scheduler (REPORTS_AUTHORITATIVE below, 3 accounts). The mirror case, and
 *     the reason this script isn't a one-directional loop: these people already had a
 *     working Reports password, and it was their SCHEDULER row that got created this
 *     afternoon (by SDC_Scheduler/scripts/link-etc-users.js) with an un-handed-out temp
 *     password. Copying Scheduler->Reports for them would replace the password they know
 *     with one they don't — locking them out of the app they were already using.
 *
 * Only ever copies a bcrypt HASH — never a plaintext password, which neither app stores or
 * can recover. Idempotent: a re-run finds nothing to do, since the hashes then match.
 *
 * Writes to Reports go straight to its own table; writes to Scheduler go through its live
 * POST /api/auth/sync-password endpoint (bearer-authenticated, same as the ongoing sync
 * uses) rather than a direct cross-schema UPDATE, since SCHEDULER_DATABASE_URL is a
 * read-only credential over there.
 */
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import mysql from "mysql2/promise";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

// scheduler-db.ts is `server-only` and can't be imported from a plain script — same note
// as reconcile-employee-groups.ts and link-scheduler-users.ts.
function loadEnvFile() {
  if (!fs.existsSync(".env")) return;
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\r\n]*)"?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}

// The three people whose REPORTS account is the pre-existing one — taken from
// SDC_Scheduler/scripts/link-etc-users.js's own printed output ("3 new Scheduler
// account(s) to create"), i.e. these are exactly the rows that script created today.
// Hardcoded rather than re-derived from timestamps on purpose: Reports stores createdAt in
// UTC and Scheduler stores created_at in local time (EDT), so a naive timestamp comparison
// silently inverts the decision for spfaff@ (Reports 16:53 UTC = 12:53 EDT vs Scheduler
// 14:34 EDT) — and inverting it is precisely the lock-someone-out mistake this list exists
// to prevent. A short auditable list beats clever arithmetic here.
const REPORTS_AUTHORITATIVE = new Set([
  "acohen@sdcautomation.com",
  "dculbertson@sdcautomation.com",
  "spfaff@sdcautomation.com",
]);

type SchedulerUser = { email: string; password_hash: string; reports_user_id: number | null };

async function fetchLinkedSchedulerUsers(): Promise<SchedulerUser[]> {
  loadEnvFile();
  const url = process.env.SCHEDULER_DATABASE_URL;
  if (!url) throw new Error("SCHEDULER_DATABASE_URL is not set — cannot read the Scheduler's user table.");
  const conn = await mysql.createConnection(url);
  try {
    const [rows] = await conn.query(
      "SELECT email, password_hash, reports_user_id FROM users WHERE reports_user_id IS NOT NULL",
    );
    return rows as SchedulerUser[];
  } finally {
    await conn.end();
  }
}

/** Pushes a hash to Scheduler the same way the ongoing sync does. Returns true on success. */
async function pushHashToScheduler(email: string, passwordHash: string): Promise<boolean> {
  const token = process.env.SCHEDULER_SHARED_TOKEN;
  if (!token) throw new Error("SCHEDULER_SHARED_TOKEN is not set — cannot write to the Scheduler.");
  const base = (process.env.SCHEDULER_BASE_URL || "http://server-app1:4003").replace(/\/+$/, "");
  const res = await fetch(`${base}/api/auth/sync-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ email, passwordHash }),
  });
  if (!res.ok) console.error(`    ! Scheduler returned ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.ok;
}

async function main() {
  const linked = await fetchLinkedSchedulerUsers();
  const reportsUsers = await prisma.user.findMany({ select: { id: true, email: true, passwordHash: true } });
  const reportsById = new Map(reportsUsers.map((u) => [u.id, u]));

  const schedulerWins: { reportsId: number; email: string; newHash: string }[] = [];
  const reportsWins: { email: string; newHash: string }[] = [];
  const alreadyMatching: string[] = [];
  const noReportsRow: string[] = [];

  for (const s of linked) {
    const target = reportsById.get(s.reports_user_id as number);
    if (!target) { noReportsRow.push(s.email); continue; }
    if (target.passwordHash === s.password_hash) { alreadyMatching.push(s.email); continue; }
    if (REPORTS_AUTHORITATIVE.has(target.email)) {
      reportsWins.push({ email: target.email, newHash: target.passwordHash });
    } else {
      schedulerWins.push({ reportsId: target.id, email: target.email, newHash: s.password_hash });
    }
  }

  console.log(`${linked.length} linked account(s) examined.\n`);
  console.log(`${schedulerWins.length} Scheduler -> Reports (their Scheduler password becomes the shared one):`);
  for (const u of schedulerWins) console.log(`  ${u.email} (Reports User#${u.reportsId})`);
  console.log(`\n${reportsWins.length} Reports -> Scheduler (their existing Reports password is preserved and becomes the shared one):`);
  for (const u of reportsWins) console.log(`  ${u.email}`);
  console.log(`\n${alreadyMatching.length} already in sync: ${alreadyMatching.join(", ") || "(none)"}`);
  if (noReportsRow.length) {
    console.log(`${noReportsRow.length} linked to a Reports id that no longer exists (stale link, skipped): ${noReportsRow.join(", ")}`);
  }

  if (!APPLY) {
    console.log("\nDry run only — pass --apply to write these changes.");
    return;
  }

  console.log("");
  for (const u of schedulerWins) {
    await prisma.user.update({ where: { id: u.reportsId }, data: { passwordHash: u.newHash } });
    console.log(`  Scheduler -> Reports: ${u.email}`);
  }
  let pushed = 0;
  for (const u of reportsWins) {
    if (await pushHashToScheduler(u.email, u.newHash)) { pushed++; console.log(`  Reports -> Scheduler: ${u.email}`); }
  }

  console.log(`\nDone — ${schedulerWins.length + pushed} account(s) now share one password across both apps.`);
  if (pushed !== reportsWins.length) {
    console.log(`WARNING: ${reportsWins.length - pushed} Reports -> Scheduler push(es) failed — re-run to retry those.`);
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
