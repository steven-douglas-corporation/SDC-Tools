import "server-only";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { readStableFile } from "@/lib/read-stable-file";
import { warehouseConfigured } from "@/lib/data-warehouse";
import { readPositionFamilyGridFromWarehouse, WAREHOUSE_FAMILIES_LABEL } from "@/lib/paylocity-warehouse";
import {
  parsePositionFamiliesGrid,
  parsePositionFamiliesWorkbook,
  positionFamilyFindings,
  describeFamilies,
  mergePositionFamilies,
  familyChoices,
  codeKey,
  PositionFamilyFileError,
  type FamilyChoice,
  type PositionFamilyRow,
  type PositionFamilyFindings,
} from "@/lib/position-families-parse";

// ── Paylocity position families, synced from two files (2026-10-02) ─────────
//
// One step of the hourly refresh (auto-sync.ts, source "position_families"),
// run just before the roster step: read Paylocity's Position_Families report
// and our Position_Families_Overrides file from the SFTP folder, and replace
// the PositionFamily table with what they say. The merge rule (an override
// replaces Paylocity's rows for its code) lives in position-families-parse.ts;
// this file is only the disk reads and the write.
//
// Two settings, same convention as PAYLOCITY_EMPLOYEES_LOCAL_PATH:
//   • PAYLOCITY_POSITION_FAMILIES_LOCAL_PATH — required; unset skips the step.
//   • PAYLOCITY_POSITION_FAMILY_OVERRIDES_LOCAL_PATH — optional. Set but missing
//     FAILS the step rather than importing without the overrides: dropping them
//     silently would move whole branches of people once teams follow families.
//     Read only once since 2026-10-28; see "Overrides from the app" below.
//
// Nothing here assigns anyone to a team yet. The table is read by the Data
// Quality tab today and by the team rule next.

// Since 2026-10-04 Paylocity's Position_Families file is deleted from the share
// once the warehouse loader has it, so with DATAWAREHOUSE_URL set it is read from
// the warehouse instead (paylocity-warehouse.ts), through the same grid parser.
// The overrides file is NOT: it is hand-edited on the share and stays there, so
// it is still read from PAYLOCITY_POSITION_FAMILY_OVERRIDES_LOCAL_PATH.
//
// ── Overrides from the app (2026-10-28) ──────────────────────────────────────
//
// The overrides now live in the PositionFamilyOverride table, set on Data
// Management (position-family-override-actions.ts). The file is read once
// more, by the first pass after this shipped, to fill that table — then never
// again: importOverridesFileOnce() won't run once the table has been filled or
// edited, which the audit log records. Removing that import, the path setting
// and the file itself is the follow-up.
export function familiesFilePath(): string | null {
  if (warehouseConfigured()) return WAREHOUSE_FAMILIES_LABEL;
  return process.env.PAYLOCITY_POSITION_FAMILIES_LOCAL_PATH?.trim() || null;
}

export function overridesFilePath(): string | null {
  return process.env.PAYLOCITY_POSITION_FAMILY_OVERRIDES_LOCAL_PATH?.trim() || null;
}

const NOT_CONFIGURED =
  "not configured — set DATAWAREHOUSE_URL in .env (or PAYLOCITY_POSITION_FAMILIES_LOCAL_PATH to Paylocity's Position_Families file)";

const fail = (m: string) => new PositionFamilyFileError(m);

/** Every audit action an override write records; any one of them means the table is ours now. */
export const OVERRIDE_AUDIT_PREFIX = "positionFamilyOverride.";

/**
 * Copies the overrides file into PositionFamilyOverride, once: only while the
 * table is empty and nothing has ever written it. Without that second check,
 * removing the last override in the app would bring the whole file back.
 */
export async function importOverridesFileOnce(): Promise<void> {
  const path = overridesFilePath();
  if (!path) return;
  if (await prisma.positionFamilyOverride.count()) return;
  if (await prisma.auditLog.findFirst({ where: { action: { startsWith: OVERRIDE_AUDIT_PREFIX } }, select: { id: true } })) return;
  // A set path whose file is missing still fails the step, as before: importing
  // without it would move whole branches of people.
  const rows = parsePositionFamiliesWorkbook(await readStableFile(path, "Position_Families_Overrides file", fail), "override");
  await prisma.positionFamilyOverride.createMany({
    data: rows.map((r) => ({ positionCode: r.positionCode, familyCode: r.familyCode, familyName: r.familyName, title: r.title, updatedByEmail: "import:overrides-file" })),
    skipDuplicates: true,
  });
  await logAudit({
    action: `${OVERRIDE_AUDIT_PREFIX}import`,
    entityType: "PositionFamilyOverride",
    entityId: 0,
    summary: `Position family overrides: ${rows.length} row${rows.length === 1 ? "" : "s"} copied from the overrides file, which is no longer read`,
    metadata: { path, rows: rows.map((r) => `${r.positionCode} ${r.familyCode}`) },
  });
}

async function readOverrides(): Promise<PositionFamilyRow[]> {
  await importOverridesFileOnce();
  const stored = await prisma.positionFamilyOverride.findMany({ select: { positionCode: true, familyCode: true, familyName: true, title: true } });
  return stored.map((r) => ({ ...r, headcount: null, source: "override" as const }));
}

async function readFiles(): Promise<PositionFamilyRow[] | { skip: string }> {
  const path = familiesFilePath();
  if (!path) return { skip: NOT_CONFIGURED };
  const rows = warehouseConfigured()
    ? parsePositionFamiliesGrid(await readPositionFamilyGridFromWarehouse(), "paylocity")
    : parsePositionFamiliesWorkbook(await readStableFile(path, "Position_Families file", fail), "paylocity");
  rows.push(...(await readOverrides()));
  return rows;
}

const rowKey = (r: Pick<PositionFamilyRow, "positionCode" | "familyCode" | "familyName" | "title" | "headcount" | "source">) =>
  [r.source, r.positionCode, r.familyCode, r.familyName, r.title ?? "", r.headcount ?? ""].join("|");

/**
 * The refresh step. Returns the one-line summary for the refresh log, or
 * { skip } when unconfigured. Throws (and the step records the failure) on an
 * unreadable or malformed file, leaving the table as the last good pass left it.
 */
export async function syncPositionFamilies(): Promise<string | { skip: string }> {
  const rows = await readFiles();
  if ("skip" in rows) return rows;
  const summary = describeFamilies(rows);

  const current = await prisma.positionFamily.findMany({
    select: { positionCode: true, familyCode: true, familyName: true, title: true, headcount: true, source: true },
  });
  const before = new Set(current.map((r) => rowKey({ ...r, source: r.source as PositionFamilyRow["source"] })));
  const after = new Set(rows.map(rowKey));
  // A string, not null, when nothing moved — see the same note in paylocity-roster-sync.ts.
  if (before.size === after.size && [...after].every((k) => before.has(k))) return `no changes — ${summary}`;

  // Whole-table replace in one transaction, so a reader never sees half a list.
  await prisma.$transaction([prisma.positionFamily.deleteMany(), prisma.positionFamily.createMany({ data: rows })]);

  const codesOf = (keys: Set<string>) => new Set([...keys].map((k) => k.split("|").slice(0, 2).join(" ")));
  const was = codesOf(before);
  const now = codesOf(after);
  await logAudit({
    action: "positionFamilies.sync",
    entityType: "PositionFamily",
    entityId: 0,
    summary: `Position families: ${summary}`,
    metadata: {
      added: [...now].filter((c) => !was.has(c)),
      removed: [...was].filter((c) => !now.has(c)),
      familiesPath: familiesFilePath(),
    },
  });
  return summary;
}

export type PositionFamilyOverrideEntry = { positionCode: string; title: string | null; families: FamilyChoice[] };

export type PositionFamilyQuality = {
  configured: boolean;
  lastSuccess: string | null;
  lastStatus: string | null;
  findings: PositionFamilyFindings | null;
  /** The overrides in effect, by code. */
  overrides: PositionFamilyOverrideEntry[];
  /** What an override can pick from. */
  choices: FamilyChoice[];
  /** Position code key → a job title someone with that code has, to name a code no family lists. */
  codeTitles: Record<string, string>;
};

/**
 * Data Management's Position families section. Reads the table the last
 * good pass wrote (not the files), because that table is what everything else
 * reads — a file problem shows as the step's failed status instead.
 */
export async function getPositionFamilyQuality(): Promise<PositionFamilyQuality> {
  const [freshness, rows, people] = await Promise.all([
    prisma.powerBiFreshness
      .findUnique({ where: { source: "position_families" }, select: { refreshedThrough: true, status: true } })
      .catch(() => null),
    prisma.positionFamily.findMany({
      select: { positionCode: true, familyCode: true, familyName: true, title: true, headcount: true, source: true },
    }),
    prisma.employee.findMany({ select: { name: true, paylocityId: true, positionCode: true, positionTitle: true, supervisorId: true, active: true } }),
  ]);
  const typed = rows.map((r) => ({ ...r, source: r.source as PositionFamilyRow["source"] }));
  const codeTitles: Record<string, string> = {};
  for (const p of people) if (p.positionCode && p.positionTitle) codeTitles[codeKey(p.positionCode)] ??= p.positionTitle;
  return {
    configured: familiesFilePath() !== null,
    lastSuccess: freshness?.refreshedThrough ? freshness.refreshedThrough.toISOString() : null,
    lastStatus: freshness?.status ?? null,
    findings: rows.length ? positionFamilyFindings(people, typed) : null,
    overrides: [...mergePositionFamilies(typed).values()]
      .filter((e) => e.source === "override")
      .map((e) => ({ positionCode: e.positionCode, title: e.title, families: e.families }))
      .sort((a, b) => a.positionCode.localeCompare(b.positionCode)),
    choices: familyChoices(typed),
    codeTitles,
  };
}
