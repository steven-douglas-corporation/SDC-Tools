/**
 * Import departments, position titles (and optionally supervisors) for
 * existing employees from Employee_Department_Map.xlsx.
 *
 *   npx tsx scripts/import-employee-departments.ts                       # dry run, prints a plan
 *   npx tsx scripts/import-employee-departments.ts --apply               # writes departments + titles
 *   npx tsx scripts/import-employee-departments.ts --apply-supervisors   # also writes the reporting line
 *
 * Supervisors are behind their own flag: the sheet's Supervisor column would
 * rewrite the reporting line for most of the roster, which is a bigger change
 * than a department/title relabel and worth confirming separately. Position
 * title is bundled with department under the plain --apply flag — like
 * department, it's purely descriptive and has no downstream logic keyed off
 * it (unlike supervisorId, which drives the reporting-line relation).
 *
 * The workbook has one sheet with First Name / Last Name / Position Title /
 * Supervisor / Department / Function.
 *
 * Deliberate constraints, matching how sync-scheduler-team.ts already behaves:
 *   - Matches on a nickname-expanded, punctuation-stripped name key. Anything
 *     ambiguous is REPORTED, never guessed — a wrong employee getting another
 *     person's department is worse than a row left alone.
 *   - Does NOT create employees. The workbook is a mapping of existing staff;
 *     inventing rows here would bypass the Employees page's paylocityId
 *     uniqueness and soft-delete rules. Sheet-only people are listed for a human.
 *   - Does NOT deactivate anybody absent from the sheet. Employees are
 *     soft-deleted deliberately (historical hours), and a mapping file is not
 *     evidence someone left.
 *   - Supervisor is applied only when that person also resolves to exactly one
 *     employee row; the sheet writes them "Last, First".
 */
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import * as XLSX from "xlsx";

const FILE = "scripts/data/Employee_Department_Map.xlsx";
const APPLY_SUPERVISORS = process.argv.includes("--apply-supervisors");
const APPLY = process.argv.includes("--apply") || APPLY_SUPERVISORS;

const prisma = new PrismaClient();

// Same table + algorithm as src/lib/sync-scheduler-team.ts, so both importers
// agree on what counts as the same person.
const NICKNAMES: Record<string, string> = {
  mike: "michael", josh: "joshua", rich: "richard", tim: "timothy",
  matt: "matthew", rob: "robert", dave: "david", mitch: "mitchell",
  nick: "nicholas", greg: "gregory", dan: "daniel", tom: "thomas",
  jon: "jonathan", chris: "christopher", andy: "andrew", bill: "william",
  billy: "william", sam: "samuel", joe: "joseph", jim: "james", ben: "benjamin",
  // Added for this import: the sheet writes "Rick Wagner" where the app has
  // "Richard Wagner", which otherwise showed up as one row in each unmatched list.
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

type SheetRow = {
  "First Name": string | null;
  "Last Name": string | null;
  "Position Title": string | null;
  Supervisor: string | null;
  "Department / Function": string | null;
};

// The sheet writes supervisors "Last, First" and employees as two columns.
function supervisorToFullName(s: string): string {
  const [last, first] = s.split(",").map((p) => p.trim());
  return first ? `${first} ${last}` : s.trim();
}

async function main() {
  const wb = XLSX.read(fs.readFileSync(FILE), { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<SheetRow>(wb.Sheets[wb.SheetNames[0]], { defval: null });

  const employees = await prisma.employee.findMany({
    select: { id: true, name: true, department: true, positionTitle: true, active: true, supervisorId: true },
  });

  // Name key → employees. A key with >1 row is ambiguous and gets skipped.
  const byKey = new Map<string, typeof employees>();
  for (const e of employees) {
    const k = normalizeName(e.name);
    const list = byKey.get(k);
    if (list) list.push(e);
    else byKey.set(k, [e]);
  }

  const deptChanges: { id: number; name: string; from: string | null; to: string }[] = [];
  const titleChanges: { id: number; name: string; from: string | null; to: string }[] = [];
  const supChanges: { id: number; name: string; to: string; toId: number }[] = [];
  const unchanged: string[] = [];
  const ambiguous: string[] = [];
  const sheetOnly: string[] = [];
  const noDept: string[] = [];
  const noTitle: string[] = [];
  const supUnresolved = new Set<string>();
  const seenKeys = new Set<string>();

  for (const r of rows) {
    const full = `${(r["First Name"] ?? "").trim()} ${(r["Last Name"] ?? "").trim()}`.trim();
    if (!full) continue;
    const dept = (r["Department / Function"] ?? "").trim();
    const title = (r["Position Title"] ?? "").trim();
    const key = normalizeName(full);
    seenKeys.add(key);

    const matches = byKey.get(key);
    if (!matches || matches.length === 0) { sheetOnly.push(`${full}${dept ? ` (${dept})` : ""}`); continue; }
    if (matches.length > 1) { ambiguous.push(`${full} → ${matches.length} employee rows`); continue; }
    const emp = matches[0];

    if (!dept) { noDept.push(full); }
    else if ((emp.department ?? "") !== dept) deptChanges.push({ id: emp.id, name: emp.name, from: emp.department, to: dept });
    else unchanged.push(full);

    if (!title) { noTitle.push(full); }
    else if ((emp.positionTitle ?? "") !== title) titleChanges.push({ id: emp.id, name: emp.name, from: emp.positionTitle, to: title });

    const supRaw = (r.Supervisor ?? "").trim();
    if (supRaw) {
      const supKey = normalizeName(supervisorToFullName(supRaw));
      const supMatches = byKey.get(supKey);
      if (!supMatches || supMatches.length !== 1) supUnresolved.add(supervisorToFullName(supRaw));
      else if (supMatches[0].id !== emp.id && emp.supervisorId !== supMatches[0].id) {
        supChanges.push({ id: emp.id, name: emp.name, to: supMatches[0].name, toId: supMatches[0].id });
      }
    }
  }

  // Active employees the sheet says nothing about — reported, never touched.
  const dbOnly = employees.filter((e) => e.active && !seenKeys.has(normalizeName(e.name))).map((e) => e.name);

  const show = (label: string, items: string[]) => {
    if (!items.length) return;
    console.log(`\n${label} (${items.length}):`);
    for (const i of items) console.log(`  ${i}`);
  };

  console.log(`Sheet rows: ${rows.length}   DB employees: ${employees.length} (${employees.filter((e) => e.active).length} active)`);

  console.log(`\nDEPARTMENT CHANGES (${deptChanges.length}):`);
  for (const c of deptChanges) console.log(`  ${c.name}: ${c.from ?? "(none)"} → ${c.to}`);
  console.log(`\nPOSITION TITLE CHANGES (${titleChanges.length}):`);
  for (const c of titleChanges) console.log(`  ${c.name}: ${c.from ?? "(none)"} → ${c.to}`);
  console.log(`\nSUPERVISOR CHANGES (${supChanges.length}):`);
  for (const c of supChanges) console.log(`  ${c.name} → ${c.to}`);
  console.log(`\nAlready correct: ${unchanged.length}`);

  show("AMBIGUOUS — duplicate names in the DB, skipped", ambiguous);
  show("IN SHEET, NOT IN APP — no employee row; add on /employees if they should exist", sheetOnly);
  show("BLANK DEPARTMENT in the sheet, skipped", noDept);
  show("BLANK POSITION TITLE in the sheet, skipped", noTitle);
  show("SUPERVISOR NOT RESOLVABLE to a single employee, skipped", [...supUnresolved]);
  show("ACTIVE IN APP, NOT IN SHEET — left untouched (NOT deactivated)", dbOnly);

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply (departments + titles) or");
    console.log("--apply-supervisors (departments + titles + reporting line) to commit.");
    return;
  }

  // One update per employee covering whichever of department/title changed
  // for them, rather than two separate passes touching the same row twice.
  const byEmployee = new Map<number, { name: string; department?: string; positionTitle?: string }>();
  for (const c of deptChanges) byEmployee.set(c.id, { ...byEmployee.get(c.id), name: c.name, department: c.to });
  for (const c of titleChanges) byEmployee.set(c.id, { ...byEmployee.get(c.id), name: c.name, positionTitle: c.to });
  for (const [id, data] of byEmployee) {
    const { name: _name, ...fields } = data;
    await prisma.employee.update({ where: { id }, data: fields });
  }
  console.log(`\nApplied ${deptChanges.length} departments and ${titleChanges.length} position titles (${byEmployee.size} employees updated).`);

  if (APPLY_SUPERVISORS) {
    for (const c of supChanges) await prisma.employee.update({ where: { id: c.id }, data: { supervisorId: c.toId } });
    console.log(`Applied ${supChanges.length} supervisors.`);
  } else {
    console.log(`Skipped ${supChanges.length} supervisor changes — pass --apply-supervisors to write those too.`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
