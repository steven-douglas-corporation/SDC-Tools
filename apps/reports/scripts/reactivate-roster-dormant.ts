/**
 * One-off data correction (2026-08-28): reactivate the seven employees the
 * Paylocity roster still lists as active.
 *
 * Why this exists
 * ---------------
 * The 2026-08-28 roster audit reconciled the Employees tab against Paylocity's
 * "Employee Status History Records" export by unique Employee Id:
 *
 *     83 status-history rows
 *   -  4 duplicate/history rows
 *   = 79 unique employees, every row status "Active"
 *      -  7 deactivated in this app
 *      -  2 never ingested        (fixed separately — reconcile-roster-against-app.ts)
 *   = 70 on the Employees tab
 *
 * Those seven were each deactivated by a documented one-off request during
 * August 2026 (scripts/archive/_deactivate_employees_20260819*.ts,
 * scripts/deactivate-employees.ts, the non-project-departments pass). The audit
 * reported them rather than flipping them, because a reconciliation script must
 * not silently overturn a human decision.
 *
 * The requester has now confirmed they are current employees, which agrees with
 * the authoritative HR source: Paylocity's own export, taken 2026-08-27 —
 * AFTER every one of those deactivations — still lists all seven as Active,
 * with no termination date on any of them.
 *
 * Scope, deliberately narrow
 * --------------------------
 * Exactly these seven Paylocity ids, and only rows that are still inactive.
 * There are other inactive employees — genuinely departed staff, duplicate name
 * spellings ("Steve Toneff" / "Steven Toneoff"), the "ME Outsourced"
 * placeholder — and this must not touch any of them.
 *
 * Matched on paylocityId, not name: Employee.name is free text with real
 * duplicate spellings in this table, so the Paylocity id is the only
 * unambiguous way to name a row. The expected name is carried alongside and
 * asserted against the database, so a wrong or stale id fails loudly instead of
 * silently reactivating the wrong person.
 *
 * Audit trail
 * -----------
 * Mirrors employee-actions.ts's setEmployeeActive() — an AuditLog row plus a
 * change record each — rather than a bare UPDATE, exactly as
 * scripts/reactivate-back-office.ts does. The roster's change history should
 * show who moved these people and when, and lib/change-version.ts derives
 * "has anything changed" from MAX(AuditLog.id), so writing these rows is also
 * what makes already-open tabs refresh instead of sitting on a stale roster.
 *
 * Run with:
 *   npx tsx -r ./scripts/shim-server-only.cjs scripts/reactivate-roster-dormant.ts
 *
 * Add --apply to actually write. Without it this is a dry run.
 * Safe to re-run: it only selects rows that are still inactive.
 */

import { prisma } from "@/lib/prisma";
import { logAuditFor } from "@/lib/audit";
import { recordChanges } from "@/lib/change-log";

// paylocityId -> the name the roster carries, asserted against the row we find.
const TARGETS: { pid: string; expected: string }[] = [
  { pid: "100001", expected: "Deborah Belliveau" },
  { pid: "100009", expected: "Timothy Spehar" },
  { pid: "100033", expected: "Jonathan Belliveau" },
  { pid: "100089", expected: "Mitchell Heinz" },
  { pid: "100102", expected: "Tim Shaffer" },
  { pid: "100103", expected: "Robert Galosi" },
  { pid: "100703", expected: "Rick Wagner" },
];

const ACTOR_EMAIL = "akamuju@sdcautomation.com";

/** Free-text names differ between the roster and this table ("Rick"/"Richard", "Tim"/"Timothy"). */
function looksLikeSamePerson(a: string, b: string): boolean {
  const last = (s: string) => s.trim().split(/\s+/).pop()!.toLowerCase();
  return last(a) === last(b);
}

async function main() {
  const apply = process.argv.includes("--apply");

  const rows = await prisma.employee.findMany({
    where: { paylocityId: { in: TARGETS.map((t) => t.pid) } },
    select: { id: true, paylocityId: true, name: true, department: true, active: true },
  });
  const byPid = new Map(rows.map((r) => [r.paylocityId!, r]));

  const targets: typeof rows = [];
  for (const t of TARGETS) {
    const row = byPid.get(t.pid);
    if (!row) {
      console.error(`  NOT FOUND  [${t.pid}] ${t.expected} — no Employee row with that paylocityId`);
      continue;
    }
    // Fail loudly on a wrong id rather than reactivating a stranger.
    if (!looksLikeSamePerson(row.name, t.expected)) {
      throw new Error(`[${t.pid}] expected "${t.expected}" but the row is "${row.name}" — refusing to touch it`);
    }
    if (row.active) {
      console.log(`  already active  [${t.pid}] ${row.name}`);
      continue;
    }
    targets.push(row);
  }

  if (targets.length === 0) {
    console.log("\nNothing to do — all seven are already active.");
    await prisma.$disconnect();
    return;
  }

  console.log(`\n${apply ? "Reactivating" : "[DRY RUN] Would reactivate"} ${targets.length} employee(s):\n`);
  for (const t of targets) {
    console.log(`  id=${String(t.id).padStart(4)}  [${t.paylocityId}]  ${t.name.padEnd(22)} ${t.department ?? "(no dept)"}`);
  }

  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply to commit.");
    await prisma.$disconnect();
    return;
  }

  const actor = await prisma.user.findUnique({ where: { email: ACTOR_EMAIL }, select: { id: true } });
  if (!actor) {
    console.warn(`\nNote: no User row for ${ACTOR_EMAIL}; audit rows will carry the email only.`);
  }

  console.log("");
  for (const t of targets) {
    await prisma.employee.update({ where: { id: t.id }, data: { active: true } });
    await logAuditFor(actor?.id ?? null, ACTOR_EMAIL, {
      action: "employee.reactivate",
      entityType: "Employee",
      entityId: t.id,
      summary: `Reactivated employee ${t.name} [${t.paylocityId}] — still listed Active on the 2026-08-27 Paylocity roster`,
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
    console.log(`  reactivated  [${t.paylocityId}] ${t.name}`);
  }

  console.log(`\nDone — ${targets.length} employee(s) reactivated.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
