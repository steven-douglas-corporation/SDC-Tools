/**
 * Derive each employee's department from their SUPERVISOR, using the
 * supervisor→department mapper, and write it onto the Employees tab.
 *
 *   npx tsx scripts/import-departments-from-status-history.ts            # dry run
 *   npx tsx scripts/import-departments-from-status-history.ts --apply    # writes departments
 *
 * Sources (all under scripts/data/):
 *   - Employee_Status_History.xlsx — the Paylocity roster export. Carries
 *     "Employee Id" (== Employee.paylocityId, a stable key, so no name
 *     matching) and "Supervisor's Name (Last, First)".
 *   - Temp_Employees_Listing.xls — the temp/contractor roster. Has no
 *     supervisor column and its IDs (P6, Temp1…) are not paylocityIds, so
 *     these people are matched by name only, and only to report whether the
 *     app already knows them. They are never guessed at.
 *   - Employee_Department_Map.xlsx "Sheet1" — THE MAPPER: one row per
 *     supervisor/manager giving that manager's own department. This is the
 *     only thing that turns a reporting line into a department.
 *   - Employee_Department_Map.xlsx "Employee-Department Map" — the curated
 *     per-person sheet, which carries a hand-corrected Supervisor column.
 *
 * Resolution order for one person, first hit wins:
 *   1. They are themselves a manager in Sheet1 → their own mapper row.
 *      (Monica Saggio reports to Patrick Morrison, but she IS Service
 *      Engineering, not Operations — the reporting line lies for managers.)
 *   2. The curated per-person sheet names a supervisor → map THAT one.
 *      This outranks the roster on purpose: Paylocity files all ten machine
 *      builders under Patrick Morrison, the VP of Operations, which maps them
 *      to "Operations". The curated sheet has their real supervisor, Dewayne
 *      Cantrell, and therefore "Mechanical Build / Manufacturing". Taking the
 *      roster here would overwrite ten correct departments with a coarser one.
 *   3. The roster names a supervisor who is in Sheet1 → that department.
 *   4. The roster's supervisor is not in Sheet1 but IS in the roster → walk
 *      one link up and retry (Sarah Pfaff → Pat Laffey → Lisa Andreani →
 *      Finance). Cycle-guarded.
 *   Anything unresolved is REPORTED, never guessed.
 *
 * A resolved department that CONTRADICTS a non-empty department already on the
 * employee is reported, not written, unless --overwrite is passed. Departments
 * on the Employees page are hand-editable, and a stale export is not grounds
 * to silently undo somebody's correction. Blanks are always filled.
 *
 * Deliberate constraints, matching scripts/import-employee-departments.ts:
 *   - Does NOT create employees. A roster export is a mapping of existing
 *     staff; inventing rows bypasses the Employees page's paylocityId
 *     uniqueness and soft-delete rules. Roster-only people are listed for a human.
 *   - Does NOT deactivate or reactivate anybody. Employees are soft-deleted
 *     deliberately (historical hours), and absence from a sheet is not
 *     evidence someone left.
 *   - Writes `department` only. Supervisor/title have their own importer.
 */
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import * as XLSX from "xlsx";

const STATUS_FILE = "scripts/data/Employee_Status_History.xlsx";
const TEMP_FILE = "scripts/data/Temp_Employees_Listing.xls";
const MAPPER_FILE = "scripts/data/Employee_Department_Map.xlsx";
const APPLY = process.argv.includes("--apply");
const OVERWRITE = process.argv.includes("--overwrite");

const prisma = new PrismaClient();

// Same nickname table as import-employee-departments.ts, so both importers
// agree on what counts as the same person. Only used for the mapper lookup
// and the temp roster — the main roster joins on paylocityId.
const NICKNAMES: Record<string, string> = {
  mike: "michael", josh: "joshua", rich: "richard", tim: "timothy",
  matt: "matthew", rob: "robert", dave: "david", mitch: "mitchell",
  nick: "nicholas", greg: "gregory", dan: "daniel", tom: "thomas",
  jon: "jonathan", chris: "christopher", andy: "andrew", bill: "william",
  billy: "william", sam: "samuel", joe: "joseph", jim: "james", ben: "benjamin",
  rick: "richard",
  // The roster writes "Laffey, Pat" where the mapper and the app both have
  // "Patrick Laffey"; without this his reports stall one link short.
  pat: "patrick",
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

// Outsourced staff are filed with the AGENCY in the Last Name column and the
// person's actual name in Preferred/First Name — "CE Outsourced" / "Kedar
// Tarlekar". Concatenating gives "Kedar Tarlekar CE Outsourced", which matches
// nothing; the first-name column alone is already the full name.
function personName(first: string | null, last: string | null): string {
  const f = (first ?? "").trim();
  const l = (last ?? "").trim();
  if (/outsourced/i.test(l)) return f || l;
  return `${f} ${l}`.trim();
}

// The roster writes supervisors "Last, First"; the mapper's Sheet1 writes
// managers "First Last".
function supervisorToFullName(s: string): string {
  const [last, first] = s.split(",").map((p) => p.trim());
  return first ? `${first} ${last}` : s.trim();
}

function read(file: string, sheet?: string) {
  const wb = XLSX.read(fs.readFileSync(file), { type: "buffer" });
  return wb.Sheets[sheet ?? wb.SheetNames[0]];
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

type StatusRow = {
  "Employee Id": string | number | null;
  "Last Name": string | null;
  "Preferred/First Name": string | null;
  "Employee Status Description": string | null;
  "Supervisor's Name (Last, First)": string | null;
  "Position Description": string | null;
};

type MapperRow = {
  "Supervisor / Manager": string | null;
  "Department / Function": string | null;
};

type CuratedRow = {
  "First Name": string | null;
  "Last Name": string | null;
  Supervisor: string | null;
};

type Person = { pid: string; name: string; supervisor: string; title: string };

async function main() {
  // ---- the mapper: manager name key → department -------------------------
  const mapperRows = XLSX.utils.sheet_to_json<MapperRow>(read(MAPPER_FILE, "Sheet1"), { defval: null });
  const deptByManager = new Map<string, string>();
  for (const r of mapperRows) {
    const mgr = (r["Supervisor / Manager"] ?? "").trim();
    const dept = (r["Department / Function"] ?? "").trim();
    if (mgr && dept) deptByManager.set(normalizeName(mgr), dept);
  }

  // ---- curated per-person supervisors, keyed by name ---------------------
  const curatedRows = XLSX.utils.sheet_to_json<CuratedRow>(read(MAPPER_FILE, "Employee-Department Map"), { defval: null });
  const curatedSup = new Map<string, string>();
  for (const r of curatedRows) {
    const full = personName(r["First Name"], r["Last Name"]);
    const sup = (r.Supervisor ?? "").trim();
    if (full && sup) curatedSup.set(normalizeName(full), sup);
  }

  // ---- roster: paylocityId → person, deduped -----------------------------
  const statusRows = XLSX.utils.sheet_to_json<StatusRow>(read(STATUS_FILE), { defval: null });
  const roster = new Map<string, Person>();
  for (const r of statusRows) {
    const pid = String(r["Employee Id"] ?? "").trim();
    if (!pid) continue;
    const name = personName(r["Preferred/First Name"], r["Last Name"]);
    // The export repeats a row per status change; later rows are the newer
    // status, so last-write-wins gives the current reporting line.
    roster.set(pid, {
      pid,
      name,
      supervisor: (r["Supervisor's Name (Last, First)"] ?? "").trim(),
      title: (r["Position Description"] ?? "").trim(),
    });
  }
  // Name key → roster person, for walking a supervisor up the chain.
  const rosterByName = new Map<string, Person[]>();
  for (const p of roster.values()) push(rosterByName, normalizeName(p.name), p);

  // ---- temps: name only, no supervisor column ----------------------------
  // The sheet has banner rows before the real header, so read positionally.
  const tempGrid = XLSX.utils.sheet_to_json<unknown[]>(read(TEMP_FILE), { defval: null, header: 1 });
  const tempHeader = tempGrid.findIndex((r) => String(r?.[0] ?? "").trim() === "ID");
  const temps = tempGrid
    .slice(tempHeader + 1)
    .map((r) => ({
      id: String(r?.[0] ?? "").trim(),
      name: `${String(r?.[1] ?? "").trim()} ${String(r?.[2] ?? "").trim()}`.trim(),
    }))
    .filter((t) => t.id && t.name);

  // ---- resolve a department for one roster person ------------------------
  const reason = new Map<string, string>();
  function resolveDept(p: Person): string | null {
    const self = deptByManager.get(normalizeName(p.name));
    if (self) {
      reason.set(p.pid, "is a manager in the mapper");
      return self;
    }

    // The curated sheet's supervisor outranks the roster's — see the header.
    const curated = curatedSup.get(normalizeName(p.name));
    let sup = curated ?? p.supervisor;
    const source = curated ? "curated supervisor" : "supervisor";
    const seen = new Set<string>();
    let hops = 0;
    while (sup) {
      const full = supervisorToFullName(sup);
      const key = normalizeName(full);
      if (seen.has(key)) return null; // cycle
      seen.add(key);
      const dept = deptByManager.get(key);
      if (dept) {
        reason.set(p.pid, hops === 0 ? `${source} ${full}` : `${source} chain → ${full}`);
        return dept;
      }
      // Supervisor isn't a mapper manager — walk one link up.
      const up = rosterByName.get(key);
      if (!up || up.length !== 1) return null;
      sup = up[0].supervisor;
      hops++;
    }
    return null;
  }

  // ---- the app's employees ----------------------------------------------
  const employees = await prisma.employee.findMany({
    select: { id: true, paylocityId: true, name: true, department: true, active: true },
  });
  const byPid = new Map<string, typeof employees>();
  for (const e of employees) {
    if (e.paylocityId) push(byPid, e.paylocityId.trim(), e);
  }
  const byName = new Map<string, typeof employees>();
  for (const e of employees) push(byName, normalizeName(e.name), e);

  type Change = { id: number; name: string; from: string | null; to: string; why: string };
  const fills: Change[] = [];
  const conflicts: Change[] = [];
  const unchanged: string[] = [];
  const noSupervisor: string[] = [];
  const unresolvedSup = new Set<string>();
  const rosterOnly: string[] = [];
  const ambiguous: string[] = [];

  for (const p of roster.values()) {
    const matches = byPid.get(p.pid);
    if (!matches || matches.length === 0) {
      rosterOnly.push(`${p.name} [${p.pid}]${p.title ? ` — ${p.title}` : ""}`);
      continue;
    }
    if (matches.length > 1) {
      ambiguous.push(`${p.name} [${p.pid}] → ${matches.length} employee rows`);
      continue;
    }
    const emp = matches[0];

    const dept = resolveDept(p);
    if (!dept) {
      if (!p.supervisor) noSupervisor.push(`${p.name} [${p.pid}]`);
      else unresolvedSup.add(`${supervisorToFullName(p.supervisor)} (blocks ${p.name})`);
      continue;
    }
    const current = (emp.department ?? "").trim();
    if (current === dept) { unchanged.push(p.name); continue; }
    const change = { id: emp.id, name: emp.name, from: emp.department, to: dept, why: reason.get(p.pid) ?? "" };
    // A blank is a gap to fill; a different non-empty value may be somebody's
    // manual correction, so it needs --overwrite.
    if (current) conflicts.push(change);
    else fills.push(change);
  }

  // Temps carry no supervisor, so there is nothing to map them by.
  const tempKnown: string[] = [];
  const tempUnknown: string[] = [];
  for (const t of temps) {
    const m = byName.get(normalizeName(t.name));
    if (m && m.length === 1) tempKnown.push(`${t.name} [${t.id}] → employee #${m[0].id}, dept ${m[0].department || "(none)"}`);
    else tempUnknown.push(`${t.name} [${t.id}]${m && m.length > 1 ? " — ambiguous name" : " — not in the app"}`);
  }

  const show = (label: string, items: string[]) => {
    if (!items.length) return;
    console.log(`\n${label} (${items.length}):`);
    for (const i of items) console.log(`  ${i}`);
  };

  console.log(
    `Roster: ${roster.size} unique employees (${statusRows.length} rows)   ` +
      `Temps: ${temps.length}   Mapper managers: ${deptByManager.size}   ` +
      `App employees: ${employees.length} (${employees.filter((e) => e.active).length} active)`,
  );

  console.log(`\nBLANK DEPARTMENTS TO FILL (${fills.length}):`);
  for (const c of fills) console.log(`  ${c.name}: (none) → ${c.to}   [${c.why}]`);
  console.log(`\nCONFLICTS with a department already set (${conflicts.length})${OVERWRITE ? " — WILL BE OVERWRITTEN" : " — not written; pass --overwrite"}:`);
  for (const c of conflicts) console.log(`  ${c.name}: ${c.from} → ${c.to}   [${c.why}]`);
  console.log(`\nAlready correct: ${unchanged.length}`);

  show("NO SUPERVISOR in the roster — nothing to map by, skipped", noSupervisor);
  show("SUPERVISOR NOT IN THE MAPPER — add them to Sheet1, skipped", [...unresolvedSup]);
  show("AMBIGUOUS — duplicate paylocityId in the app, skipped", ambiguous);
  show("IN ROSTER, NOT IN APP — add on /employees if they should exist", rosterOnly);
  show("TEMPS the app already knows (no supervisor in the sheet, so untouched)", tempKnown);
  show("TEMPS not resolvable to one employee — add on /employees if they should exist", tempUnknown);

  const toWrite = OVERWRITE ? [...fills, ...conflicts] : fills;

  if (!APPLY) {
    console.log(`\nDry run — nothing written. Re-run with --apply to write ${toWrite.length} department(s)`);
    console.log("(add --overwrite to also replace departments that are already set).");
    return;
  }

  for (const c of toWrite) await prisma.employee.update({ where: { id: c.id }, data: { department: c.to } });
  console.log(`\nApplied ${toWrite.length} department changes${OVERWRITE ? "" : `; left ${conflicts.length} conflict(s) alone`}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
