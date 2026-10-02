import * as XLSX from "xlsx";

// ── Paylocity position families, parsed and merged (2026-10-02) ─────────────
//
// The pure half of lib/position-families-sync.ts: no `fs`, no Prisma, so the
// rules are unit-testable against synthetic grids
// (tests/position-families.test.ts). Same split as paylocity-roster-parse.ts.
//
// ── The two files ───────────────────────────────────────────────────────────
//
// Both have one layout, Paylocity's Position_Families report ("Report" sheet):
//
//   Family Code | Family Name | Position Code | Title | Total Headcount
//
//   • Position_Families.xlsx — straight from Paylocity. A position code can sit
//     in several families (SCE is listed under 106, 301 and 500).
//   • Position_Families_Overrides.xlsx — ours, for where Paylocity's report
//     falls short. An override row REPLACES every Paylocity row for its position
//     code: it fills a code the report lacks (AII, HRM, …) and can correct one
//     the report files wrongly. Delete it once Paylocity has the code right;
//     the Data Quality tab lists the overrides Paylocity now covers.
//
// Codes are matched ignoring case and surrounding spaces ("Shop" = "SHOP").

export class PositionFamilyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PositionFamilyFileError";
  }
}

export type PositionFamilySource = "paylocity" | "override";

export type PositionFamilyRow = {
  positionCode: string;
  familyCode: string;
  familyName: string;
  title: string | null;
  headcount: number | null;
  source: PositionFamilySource;
};

/** Family 100 is a level, not a department: Leadership. */
export const LEADERSHIP_FAMILY = "100";

const FILE_LABEL: Record<PositionFamilySource, string> = {
  paylocity: "The Position_Families file",
  override: "The Position_Families_Overrides file",
};

function headerKey(h: unknown): string {
  return String(h ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

// A re-export can turn "108" into the number 108 or "108.0"; all are family 108.
function codeText(v: unknown): string {
  const s = cellText(v);
  return /^\d+\.0+$/.test(s) ? s.replace(/\.0+$/, "") : s;
}

export function codeKey(positionCode: string): string {
  return positionCode.trim().toLowerCase();
}

const COLUMNS = {
  familyCode: "familycode",
  familyName: "familyname",
  positionCode: "positioncode",
  title: "title",
} as const;

export const REQUIRED_HEADERS = ["Family Code", "Family Name", "Position Code", "Title"];

export function parsePositionFamiliesWorkbook(buf: Buffer, source: PositionFamilySource): PositionFamilyRow[] {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: "buffer" });
  } catch (err) {
    throw new PositionFamilyFileError(`${FILE_LABEL[source]} could not be opened as a workbook: ${err instanceof Error ? err.message : String(err)}`);
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new PositionFamilyFileError(`${FILE_LABEL[source]} has no sheets.`);
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
  return parsePositionFamiliesGrid(grid, source);
}

/** The grid half of parsePositionFamiliesWorkbook — header row first — so tests need no .xlsx. */
export function parsePositionFamiliesGrid(grid: unknown[][], source: PositionFamilySource): PositionFamilyRow[] {
  const label = FILE_LABEL[source];
  const header = (grid[0] ?? []).map(headerKey);
  const col = {} as Record<keyof typeof COLUMNS, number>;
  const missing: string[] = [];
  (Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]).forEach((k, i) => {
    const at = header.indexOf(COLUMNS[k]);
    if (at < 0) missing.push(REQUIRED_HEADERS[i]);
    col[k] = at;
  });
  if (missing.length) throw new PositionFamilyFileError(`${label} is missing column(s): ${missing.join(", ")}. Nothing was imported.`);
  const headcountCol = header.indexOf("totalheadcount"); // optional: informational only

  const rows: PositionFamilyRow[] = [];
  const seen = new Set<string>();
  for (const r of grid.slice(1)) {
    const positionCode = cellText(r[col.positionCode]);
    if (!positionCode) continue; // blank trailing rows
    const familyCode = codeText(r[col.familyCode]);
    if (!familyCode) {
      throw new PositionFamilyFileError(`${label} lists position code ${positionCode} with no Family Code. Nothing was imported.`);
    }
    // The same code listed twice under one family is one fact, not two.
    const dupKey = `${codeKey(positionCode)}|${familyCode}`;
    if (seen.has(dupKey)) continue;
    seen.add(dupKey);
    const hc = headcountCol < 0 ? NaN : Number(cellText(r[headcountCol]));
    rows.push({
      positionCode,
      familyCode,
      familyName: cellText(r[col.familyName]),
      title: cellText(r[col.title]) || null,
      headcount: Number.isFinite(hc) ? hc : null,
      source,
    });
  }

  // Paylocity's report empty means a broken export: importing it would leave
  // every position code without a family. An empty overrides file is just
  // "no overrides".
  if (source === "paylocity" && rows.length === 0) {
    throw new PositionFamilyFileError(`${label} has a header but no position codes — that looks like a broken export. Nothing was imported.`);
  }
  return rows;
}

export type PositionCodeEntry = {
  /** As written in the file that won. */
  positionCode: string;
  title: string | null;
  families: { code: string; name: string }[];
  source: PositionFamilySource;
};

/** Position code key → its families, overrides replacing Paylocity's rows for the same code. */
export function mergePositionFamilies(rows: PositionFamilyRow[]): Map<string, PositionCodeEntry> {
  const byCode = new Map<string, PositionCodeEntry>();
  const overridden = new Set(rows.filter((r) => r.source === "override").map((r) => codeKey(r.positionCode)));
  for (const r of rows) {
    const k = codeKey(r.positionCode);
    if (r.source === "paylocity" && overridden.has(k)) continue;
    const entry = byCode.get(k) ?? { positionCode: r.positionCode, title: r.title, families: [], source: r.source };
    entry.families.push({ code: r.familyCode, name: r.familyName });
    entry.title ??= r.title;
    byCode.set(k, entry);
  }
  for (const e of byCode.values()) e.families.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  return byCode;
}

// ── Data quality ────────────────────────────────────────────────────────────
//
// The Data Quality tab's Position families section. Everything here is a gap a
// person has to close — in Paylocity, in the overrides file, or on the
// Employees page — so it lists, it never acts.

export type FamilyPerson = {
  name: string;
  paylocityId: string | null;
  positionCode: string | null;
  supervisorId: number | null;
  active: boolean;
};

export type FamilyFinding = { name: string; paylocityId: string | null; detail: string };

export type PositionFamilyFindings = {
  /** Active people whose position code is in neither file. */
  unknownCodes: FamilyFinding[];
  /** Active people with no position code at all. */
  noCode: FamilyFinding[];
  /** Active people, not Leadership, with no supervisor — the reporting line can't place them. */
  noSupervisor: FamilyFinding[];
  /** Override codes Paylocity's report now has too — the override may be ready to delete. */
  overridesCovered: { positionCode: string; override: string; paylocity: string }[];
  codes: number;
  overrides: number;
};

const familyList = (fs: { code: string; name: string }[]) => fs.map((f) => `${f.code} ${f.name}`.trim()).join("; ");

export function positionFamilyFindings(people: FamilyPerson[], rows: PositionFamilyRow[]): PositionFamilyFindings {
  const merged = mergePositionFamilies(rows);
  const active = people.filter((p) => p.active);
  const byName = (a: FamilyFinding, b: FamilyFinding) => a.name.localeCompare(b.name);

  const unknownCodes = active
    .filter((p) => p.positionCode && !merged.has(codeKey(p.positionCode)))
    .map((p) => ({ name: p.name, paylocityId: p.paylocityId, detail: `Position code ${p.positionCode}` }))
    .sort(byName);
  const noCode = active
    .filter((p) => !p.positionCode)
    .map((p) => ({ name: p.name, paylocityId: p.paylocityId, detail: p.paylocityId ? "No position code in Paylocity" : "Not in Paylocity" }))
    .sort(byName);
  const isLeader = (p: FamilyPerson) =>
    !!p.positionCode && !!merged.get(codeKey(p.positionCode))?.families.some((f) => f.code === LEADERSHIP_FAMILY);
  const noSupervisor = active
    .filter((p) => p.supervisorId == null && !isLeader(p))
    .map((p) => ({ name: p.name, paylocityId: p.paylocityId, detail: p.paylocityId ? "No supervisor in Paylocity" : "Not in Paylocity — set one on the Employees page" }))
    .sort(byName);

  const paylocityOnly = mergePositionFamilies(rows.filter((r) => r.source === "paylocity"));
  const overridesCovered = [...merged.values()]
    .filter((e) => e.source === "override" && paylocityOnly.has(codeKey(e.positionCode)))
    .map((e) => ({ positionCode: e.positionCode, override: familyList(e.families), paylocity: familyList(paylocityOnly.get(codeKey(e.positionCode))!.families) }))
    .sort((a, b) => a.positionCode.localeCompare(b.positionCode));

  return {
    unknownCodes,
    noCode,
    noSupervisor,
    overridesCovered,
    codes: merged.size,
    overrides: [...merged.values()].filter((e) => e.source === "override").length,
  };
}

/** One line for the refresh log and the Data Sources panel. */
export function describeFamilies(rows: PositionFamilyRow[]): string {
  const merged = mergePositionFamilies(rows);
  const overrides = [...merged.values()].filter((e) => e.source === "override").length;
  // Families still in use once overrides have replaced Paylocity's rows.
  const families = new Set([...merged.values()].flatMap((e) => e.families.map((f) => f.code))).size;
  return `${merged.size} position codes in ${families} families, ${overrides} from overrides`;
}
