"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { recordChanges, classifyChange } from "@/lib/change-log";
import { assertActionPermission } from "@/lib/require-permission";
import { applyTeamRule } from "@/lib/paylocity-roster-sync";
import { codeKey, familyChoices, mergePositionFamilies, withOverride, type FamilyChoice, type PositionFamilyRow } from "@/lib/position-families-parse";
import { teamMoves, TEAM_NAME } from "@/lib/team-resolution";

// ── Position family overrides, set on Data Management (2026-10-28) ──────────
//
// Replaces hand-editing Position_Families_Overrides.xlsx on the SFTP share. A
// code's override is its whole list of families: saving replaces every override
// row for the code, and saving an empty list removes the override so Paylocity's
// families apply again. Same merge rule as the file (position-families-parse.ts).
//
// Teams follow families (team-resolution.ts), so an edit can move whole branches
// of people. The editor therefore previews first — previewPositionFamilyOverride
// runs the team rule on the rows as they would be — and the save is a second,
// confirmed step. The save applies at once, without waiting for the hourly pass:
// it writes the code's rows straight into PositionFamily (the next pass rebuilds
// that table from the same sources and gets the same answer) and runs the team rule.
//
// employees:edit, the permission behind every other team change (the Employees
// page's team set by hand, Reconcile with Scheduler on this same page).

const OVERRIDE_AUDIT_PREFIX = "positionFamilyOverride.";

export type OverrideMove = { name: string; from: string; to: string; shown: boolean };
export type OverridePreview = { ok: true; moves: OverrideMove[] } | { ok: false; error: string };
export type OverrideSaveResult = { ok: true } | { ok: false; error: string };

const teamLabel = (t: string | null) => (t ? (TEAM_NAME[t] ?? t) : "No team");
const familyText = (fs: { code: string; name: string }[]) => (fs.length ? fs.map((f) => `${f.code} ${f.name}`.trim()).join("; ") : null);

async function currentRows(): Promise<PositionFamilyRow[]> {
  const rows = await prisma.positionFamily.findMany({
    select: { positionCode: true, familyCode: true, familyName: true, title: true, headcount: true, source: true },
  });
  return rows.map((r) => ({ ...r, source: r.source as PositionFamilyRow["source"] }));
}

type Checked = { code: string; families: FamilyChoice[]; title: string | null; rows: PositionFamilyRow[]; next: PositionFamilyRow[] };

// Both actions take the same input and refuse the same things, so the preview
// can't approve what the save would refuse.
async function check(positionCode: string, familyCodes: string[], title: string | null): Promise<Checked | { error: string }> {
  const code = positionCode.trim();
  if (!code) return { error: "Enter a position code." };
  if (code.length > 64) return { error: "That position code is too long." };
  const rows = await currentRows();
  if (!rows.length) return { error: "Position families haven't been imported yet, so there is nothing to choose from." };
  const choices = new Map(familyChoices(rows).map((f) => [f.code, f]));
  const families: FamilyChoice[] = [];
  for (const c of new Set(familyCodes)) {
    const f = choices.get(c);
    if (!f) return { error: `Family ${c} isn't one Paylocity's report or an override lists.` };
    families.push(f);
  }
  const t = title?.trim() || null;
  return { code, families, title: t, rows, next: withOverride(rows, code, families, t) };
}

export async function previewPositionFamilyOverride(positionCode: string, familyCodes: string[], title: string | null): Promise<OverridePreview> {
  await assertActionPermission("employees:edit");
  const c = await check(positionCode, familyCodes, title);
  if ("error" in c) return { ok: false, error: c.error };
  const people = await prisma.employee.findMany({ select: { id: true, name: true, positionCode: true, supervisorId: true, team: true, teamOverride: true, active: true } });
  const active = new Map(people.map((p) => [p.id, p.active]));
  const moves = teamMoves(people, c.rows, c.next).map((m) => ({ name: m.name, from: teamLabel(m.from), to: teamLabel(m.to), shown: active.get(m.id) ?? false }));
  return { ok: true, moves };
}

export async function savePositionFamilyOverride(positionCode: string, familyCodes: string[], title: string | null): Promise<OverrideSaveResult> {
  const session = await assertActionPermission("employees:edit");
  const c = await check(positionCode, familyCodes, title);
  if ("error" in c) return { ok: false, error: c.error };

  const k = codeKey(c.code);
  const before = mergePositionFamilies(c.rows).get(k);
  const previous = before?.source === "override" ? familyText(before.families) : null;
  const next = familyText(c.families);
  if (previous === next) return { ok: true };

  // Rows for this code under any casing ("Shop" = "SHOP"), found here rather
  // than trusting the database collation to match them.
  const [storedIds, appliedIds] = await Promise.all([
    prisma.positionFamilyOverride.findMany({ select: { id: true, positionCode: true } }).then((rs) => rs.filter((r) => codeKey(r.positionCode) === k).map((r) => r.id)),
    prisma.positionFamily.findMany({ where: { source: "override" }, select: { id: true, positionCode: true } }).then((rs) => rs.filter((r) => codeKey(r.positionCode) === k).map((r) => r.id)),
  ]);
  const email = session.user.email ?? null;
  await prisma.$transaction([
    prisma.positionFamilyOverride.deleteMany({ where: { id: { in: storedIds } } }),
    prisma.positionFamilyOverride.createMany({
      data: c.families.map((f) => ({ positionCode: c.code, familyCode: f.code, familyName: f.name, title: c.title, updatedByEmail: email })),
    }),
    prisma.positionFamily.deleteMany({ where: { id: { in: appliedIds } } }),
    prisma.positionFamily.createMany({
      data: c.families.map((f) => ({ positionCode: c.code, familyCode: f.code, familyName: f.name, title: c.title, headcount: null, source: "override" })),
    }),
  ]);
  const teams = await applyTeamRule();

  await logAudit({
    action: `${OVERRIDE_AUDIT_PREFIX}${c.families.length ? "set" : "remove"}`,
    entityType: "PositionFamilyOverride",
    entityId: c.code,
    summary: c.families.length ? `Position code ${c.code} set to family ${next}; ${teams}` : `Override for position code ${c.code} removed; ${teams}`,
    metadata: { before: previous, after: next, teams },
  });
  await recordChanges(
    [{
      tab: "Data Management",
      rowRef: `Position code ${c.code}`,
      columnName: "Position family override",
      previousValue: previous,
      newValue: next,
      changeType: classifyChange(previous, next),
      entityType: "PositionFamilyOverride",
      entityId: c.code,
    }],
    { action: `${OVERRIDE_AUDIT_PREFIX}${c.families.length ? "set" : "remove"}` },
  );
  revalidatePath("/admin/data-management");
  revalidatePath("/employees");
  return { ok: true };
}
