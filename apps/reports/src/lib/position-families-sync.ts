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

// ── Paylocity position families, plus our overrides (2026-10-02) ────────────
//
// One step of the hourly refresh (auto-sync.ts, source "position_families"),
// run just before the roster step: read Paylocity's Position_Families report
// and our overrides, and replace the PositionFamily table with what they say.
// The merge rule (an override replaces Paylocity's rows for its code) lives in
// position-families-parse.ts; this file is only the reads and the write.
//
// Paylocity's report: from the warehouse when DATAWAREHOUSE_URL is set (since
// 2026-10-04 the file is deleted from the share once the warehouse loader has
// it; paylocity-warehouse.ts), otherwise from PAYLOCITY_POSITION_FAMILIES_LOCAL_PATH,
// through the same grid parser. Neither set skips the step.
//
// Our overrides: the PositionFamilyOverride table, set on Data Management
// (position-family-override-actions.ts) since 2026-10-28. They were the
// hand-edited Position_Families_Overrides.xlsx on the SFTP share until then;
// the first pass after the switch copied the file into the table, and the
// file, its path setting and that one-time copy were removed afterwards.
export function familiesFilePath(): string | null {
  if (warehouseConfigured()) return WAREHOUSE_FAMILIES_LABEL;
  return process.env.PAYLOCITY_POSITION_FAMILIES_LOCAL_PATH?.trim() || null;
}

const NOT_CONFIGURED =
  "not configured — set DATAWAREHOUSE_URL in .env (or PAYLOCITY_POSITION_FAMILIES_LOCAL_PATH to Paylocity's Position_Families file)";

const fail = (m: string) => new PositionFamilyFileError(m);

async function readOverrides(): Promise<PositionFamilyRow[]> {
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
