import "server-only";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { readStableFile } from "@/lib/read-stable-file";
import {
  parsePositionFamiliesWorkbook,
  positionFamilyFindings,
  describeFamilies,
  PositionFamilyFileError,
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
//
// Nothing here assigns anyone to a team yet. The table is read by the Data
// Quality tab today and by the team rule next.

export function familiesFilePath(): string | null {
  return process.env.PAYLOCITY_POSITION_FAMILIES_LOCAL_PATH?.trim() || null;
}

export function overridesFilePath(): string | null {
  return process.env.PAYLOCITY_POSITION_FAMILY_OVERRIDES_LOCAL_PATH?.trim() || null;
}

const NOT_CONFIGURED = "not configured — set PAYLOCITY_POSITION_FAMILIES_LOCAL_PATH in .env to Paylocity's Position_Families file";

const fail = (m: string) => new PositionFamilyFileError(m);

async function readFiles(): Promise<PositionFamilyRow[] | { skip: string }> {
  const path = familiesFilePath();
  if (!path) return { skip: NOT_CONFIGURED };
  const rows = parsePositionFamiliesWorkbook(await readStableFile(path, "Position_Families file", fail), "paylocity");
  const overrides = overridesFilePath();
  if (overrides) rows.push(...parsePositionFamiliesWorkbook(await readStableFile(overrides, "Position_Families_Overrides file", fail), "override"));
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
  const summary = describeFamilies(rows) + (overridesFilePath() ? "" : " (overrides file not configured)");

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
      overridesPath: overridesFilePath(),
    },
  });
  return summary;
}

export type PositionFamilyQuality = {
  configured: boolean;
  overridesConfigured: boolean;
  lastSuccess: string | null;
  lastStatus: string | null;
  findings: PositionFamilyFindings | null;
};

/**
 * The Data Quality tab's Position families section. Reads the table the last
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
    prisma.employee.findMany({ select: { name: true, paylocityId: true, positionCode: true, supervisorId: true, active: true } }),
  ]);
  return {
    configured: familiesFilePath() !== null,
    overridesConfigured: overridesFilePath() !== null,
    lastSuccess: freshness?.refreshedThrough ? freshness.refreshedThrough.toISOString() : null,
    lastStatus: freshness?.status ?? null,
    findings: rows.length
      ? positionFamilyFindings(people, rows.map((r) => ({ ...r, source: r.source as PositionFamilyRow["source"] })))
      : null,
  };
}
