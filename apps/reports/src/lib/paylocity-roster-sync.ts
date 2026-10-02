import "server-only";
import { prisma } from "@/lib/prisma";
import { readStableFile } from "@/lib/read-stable-file";
import { logAudit } from "@/lib/audit";
import { recordChanges, type CellChange } from "@/lib/change-log";
import {
  parseRosterWorkbook,
  planRosterSync,
  isEmptyPlan,
  describePlan,
  rosterQualityFindings,
  RosterFileError,
  type RosterFileRow,
  type RosterPlan,
  type RosterQualityFindings,
} from "@/lib/paylocity-roster-parse";
import { planTeamWrites } from "@/lib/team-resolution";
import type { PositionFamilyRow } from "@/lib/position-families-parse";

// ── The Paylocity employee roster, synced from a file (2026-09-30) ──────────
//
// One step of the hourly refresh (auto-sync.ts, source "employee_roster"): read
// the roster report Paylocity drops into the SFTP folder, then add new people,
// keep supervisors, job titles and position codes in step, hide leavers, and
// set teams by the team rule (lib/team-resolution.ts). The rules — what may
// and may not change — are declared and tested in paylocity-roster-parse.ts
// and team-resolution.ts; this file is only the disk read and the writes.
//
// Configured by PAYLOCITY_EMPLOYEES_LOCAL_PATH, the same convention as
// JOB_HOURS_LOCAL_PATH: a path to the file, no default. Unset means the step is
// skipped with that reason on its freshness row, so the Data Sources panel says
// "not configured" instead of the roster silently never updating.
//
// The SFTP server keeps the previous upload under a dated name and gives the new
// one the main name. The step reads only the main name, so the dated copies are
// never read; if a pass lands mid-upload, the stable-read check below refuses
// the half-written file and the next pass picks it up.

export function rosterFilePath(): string | null {
  return process.env.PAYLOCITY_EMPLOYEES_LOCAL_PATH?.trim() || null;
}

const NOT_CONFIGURED = "not configured — set PAYLOCITY_EMPLOYEES_LOCAL_PATH in .env to the Paylocity employee roster file";

const readStable = (path: string) => readStableFile(path, "roster file", (m) => new RosterFileError(m));

async function loadAppEmployees() {
  return prisma.employee.findMany({
    select: { id: true, name: true, paylocityId: true, positionTitle: true, positionCode: true, supervisorId: true, active: true },
  });
}

export type RosterQuality = {
  configured: boolean;
  /** When the last successful pass ran, and the step's stored status (a failure or wait, if any). */
  lastSuccess: string | null;
  lastStatus: string | null;
  /** Set when the file couldn't be read or was refused — the findings are then empty. */
  fileError: string | null;
  findings: RosterQualityFindings | null;
};

/**
 * The Data Quality tab's roster section. Reads the file live (it is small), so
 * the findings describe the file as it is now, not as of the last pass. Never
 * throws: a bad file is itself the finding.
 */
export async function getRosterQuality(): Promise<RosterQuality> {
  const path = rosterFilePath();
  const freshness = await prisma.powerBiFreshness
    .findUnique({ where: { source: "employee_roster" }, select: { refreshedThrough: true, status: true } })
    .catch(() => null);
  const base = {
    configured: path !== null,
    lastSuccess: freshness?.refreshedThrough ? freshness.refreshedThrough.toISOString() : null,
    lastStatus: freshness?.status ?? null,
  };
  if (!path) return { ...base, fileError: null, findings: null };
  try {
    const rows = parseRosterWorkbook(await readStable(path));
    return { ...base, fileError: null, findings: rosterQualityFindings(rows, await loadAppEmployees()) };
  } catch (err) {
    return { ...base, fileError: err instanceof Error ? err.message : String(err), findings: null };
  }
}

/** Parse the configured file and work out what would change. Writes nothing. */
export async function previewRosterSync(path = rosterFilePath()): Promise<RosterPlan | { skip: string }> {
  if (!path) return { skip: NOT_CONFIGURED };
  const rows = parseRosterWorkbook(await readStable(path));
  return planRosterSync(rows, await loadAppEmployees());
}

/**
 * The refresh step. Returns the one-line summary for the refresh log, or
 * { skip } when unconfigured. Throws (and
 * the step records the failure) on an unreadable or malformed file.
 */
export async function syncPaylocityRoster(): Promise<string | { skip: string }> {
  const path = rosterFilePath();
  if (!path) return { skip: NOT_CONFIGURED };
  const rows = parseRosterWorkbook(await readStable(path));
  const app = await loadAppEmployees();
  const plan = planRosterSync(rows, app);
  // Always a string, never null: null means "skipped" to the runner, which would
  // leave the freshness row unstamped and the source looking stale on every quiet day.
  const roster = isEmptyPlan(plan) ? `no roster changes — ${describePlan(plan)}` : await applyRosterPlan(path, rows, plan);
  // The team rule runs every pass, not only when the file changed: a new
  // override, or a supervisor set on the Employees page, moves people too.
  return `${roster}; ${await applyTeamRule()}`;
}

async function applyRosterPlan(path: string, rows: RosterFileRow[], plan: RosterPlan): Promise<string> {
  // One transaction: a pass either lands whole or not at all, so a failure
  // halfway can't leave new people created without their reporting lines.
  await prisma.$transaction(
    async (tx) => {
      for (const l of plan.link) {
        await tx.employee.update({ where: { id: l.employeeId }, data: { paylocityId: l.paylocityId } });
      }
      for (const r of plan.create) {
        // Hidden on arrival — see paylocity-roster-parse.ts's header.
        await tx.employee.create({
          data: { paylocityId: r.paylocityId, name: r.name, positionTitle: r.positionTitle, positionCode: r.positionCode ?? null, active: false },
        });
      }
      for (const t of plan.titleChanges) {
        await tx.employee.update({ where: { paylocityId: t.paylocityId }, data: { positionTitle: t.to } });
      }
      for (const c of plan.positionCodeChanges) {
        await tx.employee.update({ where: { paylocityId: c.paylocityId }, data: { positionCode: c.to } });
      }
      if (!plan.hideHeld) {
        for (const h of plan.hide) {
          await tx.employee.update({ where: { paylocityId: h.paylocityId }, data: { active: false } });
        }
      }

      // Supervisors last, once every person they can point at exists.
      const idByPid = new Map(
        (await tx.employee.findMany({ where: { paylocityId: { not: null } }, select: { id: true, paylocityId: true } })).map((e) => [e.paylocityId!, e.id]),
      );
      for (const s of plan.supervisorChanges) {
        const supervisorId = s.toPaylocityId ? (idByPid.get(s.toPaylocityId) ?? null) : null;
        await tx.employee.update({ where: { paylocityId: s.paylocityId }, data: { supervisorId } });
      }
    },
    { timeout: 30_000 },
  );

  const summary = describePlan(plan);
  await logAudit({
    action: "employee.rosterSync",
    entityType: "Employee",
    entityId: 0,
    summary: `Paylocity roster: ${summary}`,
    metadata: {
      path,
      created: plan.create.map((r) => ({ paylocityId: r.paylocityId, name: r.name })),
      linked: plan.link,
      titleChanges: plan.titleChanges,
      positionCodeChanges: plan.positionCodeChanges,
      hidden: plan.hideHeld ? [] : plan.hide,
      hideHeld: plan.hideHeld ? plan.hide : [],
      supervisorChanges: plan.supervisorChanges,
      ambiguous: plan.ambiguous,
      unresolvedSupervisors: plan.unresolvedSupervisors,
    },
  });

  // Keeps every open Employees tab current. `system`: the refresh toast already
  // reports the pass, so no per-change notification cards on top of it.
  // New people are one row between them — the first pass alone adds ~150, and
  // their initial supervisors are part of being added, not separate edits.
  const pidToName = new Map(rows.map((r) => [r.paylocityId, r.name]));
  const created = new Set(plan.create.map((r) => r.paylocityId));
  const changes: CellChange[] = [
    ...(plan.create.length
      ? [
          {
            tab: "Employees",
            rowRef: "Paylocity roster",
            columnName: "Employees added (hidden)",
            previousValue: null,
            newValue: plan.create.length <= 5 ? plan.create.map((r) => r.name).join(", ") : `${plan.create.length} people`,
            changeType: "added" as const,
            system: true,
          },
        ]
      : []),
    ...plan.titleChanges.map((t) => ({
      tab: "Employees",
      rowRef: t.name,
      columnName: "Title",
      previousValue: t.from,
      newValue: t.to,
      changeType: "edited" as const,
      system: true,
    })),
    // Position codes: one row per person for a handful, one row between them for
    // a bulk fill (the first pass sets ~140 at once) — same idea as new people.
    ...(plan.positionCodeChanges.length > 5
      ? [
          {
            tab: "Employees",
            rowRef: "Paylocity roster",
            columnName: "Position code",
            previousValue: null,
            newValue: `${plan.positionCodeChanges.length} people`,
            changeType: "edited" as const,
            system: true,
          },
        ]
      : plan.positionCodeChanges.map((c) => ({
          tab: "Employees",
          rowRef: c.name,
          columnName: "Position code",
          previousValue: c.from,
          newValue: c.to,
          changeType: "edited" as const,
          system: true,
        }))),
    ...(plan.hideHeld ? [] : plan.hide).map((h) => ({
      tab: "Employees",
      rowRef: h.name,
      columnName: "Shown",
      previousValue: "Shown",
      newValue: "Hidden (inactive in Paylocity)",
      changeType: "edited" as const,
      system: true,
    })),
    ...plan.supervisorChanges.filter((s) => !created.has(s.paylocityId)).map((s) => ({
      tab: "Employees",
      rowRef: s.name,
      columnName: "Supervisor",
      previousValue: s.fromName,
      newValue: s.toPaylocityId ? (pidToName.get(s.toPaylocityId) ?? s.toPaylocityId) : null,
      changeType: "edited" as const,
      system: true,
    })),
  ];
  await recordChanges(changes, { action: "employee.rosterSync" });

  return summary;
}

// The team rule (lib/team-resolution.ts), applied. Reads the people as they are
// AFTER the roster plan landed, so today's supervisors and position codes decide.
async function applyTeamRule(): Promise<string> {
  const familyRows = await prisma.positionFamily.findMany({
    select: { positionCode: true, familyCode: true, familyName: true, title: true, headcount: true, source: true },
  });
  // Without families the rule has nothing to go on, and must not clear anyone.
  if (!familyRows.length) return "teams left alone (position families not imported yet)";
  const people = await prisma.employee.findMany({ select: { id: true, name: true, positionCode: true, supervisorId: true, team: true } });
  const writes = planTeamWrites(people, familyRows.map((r) => ({ ...r, source: r.source as PositionFamilyRow["source"] })));
  if (!writes.length) return "teams unchanged";

  await prisma.$transaction(writes.map((w) => prisma.employee.update({ where: { id: w.id }, data: { team: w.to } })));
  await logAudit({
    action: "employee.teamRule",
    entityType: "Employee",
    entityId: 0,
    summary: `Team rule: ${writes.length} team${writes.length === 1 ? "" : "s"} set from position families and reporting lines`,
    metadata: { writes },
  });
  // Same bulk rule as position codes: the first pass sets most of the roster.
  await recordChanges(
    writes.length > 5
      ? [{ tab: "Employees", rowRef: "Team rule", columnName: "Team", previousValue: null, newValue: `${writes.length} people`, changeType: "edited" as const, system: true }]
      : writes.map((w) => ({ tab: "Employees", rowRef: w.name, columnName: "Team", previousValue: w.from, newValue: w.to, changeType: "edited" as const, system: true })),
    { action: "employee.teamRule" },
  );
  return `${writes.length} team${writes.length === 1 ? "" : "s"} set`;
}
