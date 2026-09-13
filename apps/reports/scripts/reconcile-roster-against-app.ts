/**
 * Reconcile the Employees tab against the two roster exports: list the unique
 * people the sheets contain, and the app rows the sheets say nothing about.
 *
 *   npx tsx scripts/reconcile-roster-against-app.ts             # report only
 *   npx tsx scripts/reconcile-roster-against-app.ts --apply     # deactivate app-only rows
 *
 * Sources (scripts/data/): Employee_Status_History.xlsx (paylocityId +
 * supervisor) and Temp_Employees_Listing.xls (temps, name only — its IDs are
 * P6/Temp1… , not paylocityIds, so temps match by name).
 *
 * "Remove" here means DEACTIVATE (active = false), which is what removal means
 * everywhere else in this app: Employee rows are soft-deleted on purpose
 * because hours, ETC history and job costs reference them, and a hard delete
 * would orphan that history (supervisorId is onDelete: SetNull, so it would
 * also silently cut reporting lines). Rows already inactive are left alone.
 */
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import * as XLSX from "xlsx";

const STATUS_FILE = "scripts/data/Employee_Status_History.xlsx";
const TEMP_FILE = "scripts/data/Temp_Employees_Listing.xls";
const APPLY = process.argv.includes("--apply");
// Opt-in and SEPARATE from --apply: creating a person and deactivating one are
// different decisions and must not share a switch.
const CREATE_MISSING = process.argv.includes("--create-missing");

const prisma = new PrismaClient();

const NICKNAMES: Record<string, string> = {
  mike: "michael", josh: "joshua", rich: "richard", tim: "timothy",
  matt: "matthew", rob: "robert", dave: "david", mitch: "mitchell",
  nick: "nicholas", greg: "gregory", dan: "daniel", tom: "thomas",
  jon: "jonathan", chris: "christopher", andy: "andrew", bill: "william",
  billy: "william", sam: "samuel", joe: "joseph", jim: "james", ben: "benjamin",
  rick: "richard", pat: "patrick",
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

function read(file: string, sheet?: string) {
  const wb = XLSX.read(fs.readFileSync(file), { type: "buffer" });
  return wb.Sheets[sheet ?? wb.SheetNames[0]];
}

type StatusRow = {
  "Employee Id": string | number | null;
  "Last Name": string | null;
  "Preferred/First Name": string | null;
  "Position Description": string | null;
};

async function main() {
  // ---- sheet 1: the Paylocity roster, unique by Employee Id --------------
  const statusRows = XLSX.utils.sheet_to_json<StatusRow>(read(STATUS_FILE), { defval: null });
  // Raw row count, kept so the reconciliation can state how many of the 83 are
  // duplicate history rows rather than people.
  const rosterRowCount = statusRows.filter((r) => String(r["Employee Id"] ?? "").trim()).length;
  const roster = new Map<string, { pid: string; name: string; title: string }>();
  for (const r of statusRows) {
    const pid = String(r["Employee Id"] ?? "").trim();
    if (!pid) continue;
    roster.set(pid, {
      pid,
      name: personName(r["Preferred/First Name"], r["Last Name"]),
      title: (r["Position Description"] ?? "").trim(),
    });
  }

  // ---- sheet 2: temps, name only ----------------------------------------
  const tempGrid = XLSX.utils.sheet_to_json<unknown[]>(read(TEMP_FILE), { defval: null, header: 1 });
  const tempHeader = tempGrid.findIndex((r) => String(r?.[0] ?? "").trim() === "ID");
  const temps = tempGrid
    .slice(tempHeader + 1)
    .map((r) => ({
      id: String(r?.[0] ?? "").trim(),
      name: `${String(r?.[1] ?? "").trim()} ${String(r?.[2] ?? "").trim()}`.trim(),
    }))
    .filter((t) => t.id && t.name);

  // The two sheets overlap: the temp sheet names Kedar Tarlekar and Vipin
  // Vijayan, who are on the roster as the "CE/ME Outsourced" rows. Keyed by
  // name, that overlap collapses on its own.
  const sheetNameKeys = new Set<string>();
  for (const p of roster.values()) sheetNameKeys.add(normalizeName(p.name));
  for (const t of temps) sheetNameKeys.add(normalizeName(t.name));
  const sheetPids = new Set(roster.keys());

  // ---- the app ----------------------------------------------------------
  const employees = await prisma.employee.findMany({
    select: { id: true, paylocityId: true, name: true, department: true, active: true },
    orderBy: { name: "asc" },
  });

  // An app row counts as "in the sheets" if its paylocityId is on the roster
  // OR its name matches either sheet. Both, because the temps carry no
  // paylocityId and the outsourced rows are named differently in each sheet.
  const inSheets = (e: (typeof employees)[number]) =>
    (e.paylocityId ? sheetPids.has(e.paylocityId.trim()) : false) || sheetNameKeys.has(normalizeName(e.name));

  const matched = employees.filter(inSheets);
  const appOnly = employees.filter((e) => !inSheets(e));
  const appOnlyActive = appOnly.filter((e) => e.active);
  const appOnlyInactive = appOnly.filter((e) => !e.active);

  // ── The other direction, which this script was blind to ──────────────────
  //
  // It only ever asked "which app rows do the sheets not cover", and answered
  // by deactivating them. It never asked the reverse — "who is on the roster
  // with no app row" — so somebody Paylocity lists as active could simply never
  // arrive, invisibly. Two people were in exactly that state when this was
  // written (2026-08-28): Jason Hitchcock [100804] and Jordan Priggins
  // [100806], both on the Status History roster and neither ever created,
  // because the sheet that SEEDS employees is the hand-maintained, NAME-keyed
  // Employee_Department_Map.xlsx and neither of them appears in it.
  //
  // Split in two, because the halves need opposite handling:
  //
  //   missing   no app row at all. A pure ingestion gap — safe to create.
  //   dormant   an app row exists but is inactive. NOT auto-reactivated, on
  //             purpose: each of today's seven was deactivated by an explicit
  //             request (scripts/archive/_deactivate_employees_*.ts,
  //             scripts/deactivate-employees.ts). Paylocity still listing them
  //             active means the two systems disagree — an HR question, not
  //             something a reconciliation script should silently overturn.
  const appByPid = new Map(employees.filter((e) => e.paylocityId).map((e) => [e.paylocityId!.trim(), e]));
  const appByName = new Map(employees.map((e) => [normalizeName(e.name), e]));
  const rosterApp = [...roster.values()].map((p) => ({
    p,
    row: appByPid.get(p.pid) ?? appByName.get(normalizeName(p.name)) ?? null,
  }));
  const missingFromApp = rosterApp.filter((x) => x.row === null);
  const dormantInApp = rosterApp.filter((x) => x.row !== null && !x.row!.active);


  console.log(`=== UNIQUE EMPLOYEES IN THE TWO SHEETS (${sheetNameKeys.size}) ===`);
  console.log(`\nRoster — Employee Status History (${roster.size}):`);
  for (const p of [...roster.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${p.name} [${p.pid}]${p.title && p.title !== "Not Defined" ? ` — ${p.title}` : ""}`);
  }
  console.log(`\nTemps — Temp Employees Listing (${temps.length}):`);
  for (const t of temps) console.log(`  ${t.name} [${t.id}]`);

  console.log(`\n=== APP ROWS NOT IN EITHER SHEET (${appOnly.length} of ${employees.length}) ===`);
  console.log(`\nACTIVE — these are what --apply would deactivate (${appOnlyActive.length}):`);
  for (const e of appOnlyActive) {
    console.log(`  #${e.id} ${e.name} [${e.paylocityId ?? "no id"}] — ${e.department || "(no dept)"}`);
  }
  console.log(`\nAlready inactive — left alone (${appOnlyInactive.length}):`);
  for (const e of appOnlyInactive) console.log(`  #${e.id} ${e.name} [${e.paylocityId ?? "no id"}]`);

  console.log(`
=== ON THE ROSTER BUT NOT ACTIVE IN THE APP (${missingFromApp.length + dormantInApp.length}) ===`);
  console.log(`
No app row at all — an ingestion gap (${missingFromApp.length}):`);
  for (const { p } of missingFromApp) console.log(`  ${p.name} [${p.pid}]${p.title && p.title !== "Not Defined" ? ` — ${p.title}` : ""}`);
  console.log(`
App row exists but INACTIVE — verify with HR, never auto-reactivated (${dormantInApp.length}):`);
  for (const { p, row } of dormantInApp) console.log(`  #${row!.id} ${p.name} [${p.pid}] — ${row!.department || "(no dept)"}`);

  console.log(`\nApp rows the sheets DO cover: ${matched.length} (${matched.filter((e) => e.active).length} active)`);

  console.log(`
=== RECONCILIATION ===`);
  console.log(`  ${rosterRowCount} status-history rows`);
  console.log(`  - ${rosterRowCount - roster.size} duplicate/history rows (same employee, earlier status record)`);
  console.log(`  = ${roster.size} unique employees on the Paylocity roster (every row's status is Active)`);
  console.log(`      - ${missingFromApp.length} never ingested (no app row)`);
  console.log(`      - ${dormantInApp.length} deactivated in-app by explicit request`);
  console.log(`      = ${roster.size - missingFromApp.length - dormantInApp.length} on the roster AND active here`);
  console.log(`  Employees tab shows ${employees.filter((e) => e.active).length} active (roster + temps + any name-only row)`);


  if (CREATE_MISSING) {
    // Created with NO department on purpose: the department map is the source
    // for that field and does not know these people either, so inventing one
    // would put a guess where a gap is. They land under "No department" on the
    // Employees tab — visible and fixable, rather than absent.
    for (const { p } of missingFromApp) {
      await prisma.employee.create({
        data: {
          paylocityId: p.pid,
          name: p.name,
          active: true,
          positionTitle: p.title && p.title !== "Not Defined" ? p.title : null,
        },
      });
      console.log(`  created ${p.name} [${p.pid}]`);
    }
    console.log(`
Created ${missingFromApp.length} employee(s) from the roster.`);
  }


  if (!APPLY) {
    console.log(`\nReport only — nothing written. Re-run with --apply to deactivate the ${appOnlyActive.length} active app-only row(s).`);
    return;
  }

  for (const e of appOnlyActive) await prisma.employee.update({ where: { id: e.id }, data: { active: false } });
  console.log(`\nDeactivated ${appOnlyActive.length} employee(s). No rows were hard-deleted.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
