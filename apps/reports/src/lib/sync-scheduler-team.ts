import "server-only";
import { prisma } from "@/lib/prisma";
import { DISCIPLINE_LABEL } from "@/lib/disciplines";
import { fetchSchedulerTeam } from "@/lib/scheduler-db";

// Read-only reconciliation against the SDC Scheduler's team board.
//
// The hourly name-matched PULL this file used to do (syncSchedulerTeam(),
// mirroring team_members.discipline into Employee.discipline) is retired as
// of 2026-08-13 — Employee.team is now the shared, authoritative grouping,
// written directly by Scheduler via a dedicated MySQL connection (see
// SDC_Scheduler/routes/team.js), matched by team_members.employee_id rather
// than by name. scripts/reconcile-employee-groups.ts is the ID-based
// successor to reconcileSchedulerRoster() below; that function stays for the
// "Reconcile with Scheduler" button, which still compares by name — it's
// read-only and non-blocking, so leaving it as a second, slightly different
// comparison is low-risk, but the ID-based script is the one to trust.
// That button moved off the Employees page to Admin > Data Management on
// 2026-08-24, being a diagnostic rather than day-to-day roster work.
//
// The two apps share no stable key for THIS name-based comparison, so it
// matches on the name, normalized to absorb spacing/case differences (e.g.
// "Xiaoli Liu" == "Xiao Li Liu"). What normalization can't safely bridge —
// nicknames like "Mike"/"Michael" or "Josh"/"Joshua" — is NOT guessed; those
// names are returned in the unmatched lists so a human can rename them.

// The Scheduler stores discipline as short codes; ETC groups by the full labels.
// The code → label map lives in lib/disciplines.ts, shared with the Employees
// page and the integration route. An unknown code is passed through verbatim so
// it surfaces rather than vanishing.
function toEtcDiscipline(code: string): string {
  return DISCIPLINE_LABEL[code.trim().toLowerCase()] ?? code;
}

// Common short-form → formal first names, so the Scheduler's casual names
// ("Mike", "Josh", "Rich") match ETC's formal ones ("Michael", "Joshua",
// "Richard"). Validated against the live roster: expanding these plus the
// last name matched 48/52 with zero false collisions (the remaining 4 aren't
// in ETC's roster at all). Last name is always kept, so an expansion can't
// collapse two different people (e.g. Josh vs Jonathan Belliveau stay distinct).
const NICKNAMES: Record<string, string> = {
  mike: "michael", josh: "joshua", rich: "richard", tim: "timothy",
  matt: "matthew", rob: "robert", dave: "david", mitch: "mitchell",
  nick: "nicholas", greg: "gregory", dan: "daniel", tom: "thomas",
  jon: "jonathan", chris: "christopher", andy: "andrew", bill: "william",
  billy: "william", sam: "samuel", joe: "joseph", jim: "james", ben: "benjamin",
};

// Whitespace-insensitive, case-insensitive, punctuation-stripped, nickname-
// expanded match key. Exported for employee-scheduler-overlay.ts, which needs
// the SAME key this file's own reconciliation uses — a second, slightly
// different normalizer would silently disagree with "Reconcile with
// Scheduler" about who matches whom.
export function normalizeName(name: string): string {
  const parts = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]/g, " ") // drop dots, hyphens, accents → space
    .trim()
    .split(/\s+/);
  if (parts.length > 0) parts[0] = NICKNAMES[parts[0]] ?? parts[0];
  return parts.join("");
}

// Read-only reconciliation of ETC's FULL roster (active + inactive) against the
// Scheduler's team list, on two dimensions: active status and team (grouping).
// Matches on the same nickname-normalized name key as the grouping sync;
// nothing is written. Includes inactive Scheduler members so status can differ.
export type RosterReconciliation = {
  ok: boolean;
  reason?: string;
  schedulerCount: number; // real Scheduler members (active + inactive)
  etcActiveCount: number;
  etcTotalCount: number;
  matched: number; // people found in both apps (by name)
  agree: number; // matched AND active-status + team both agree
  statusMismatches: { name: string; etcActive: boolean; schedulerActive: boolean }[];
  teamMismatches: { name: string; etcTeam: string; schedulerTeam: string }[];
  schedulerOnly: string[]; // Scheduler people not in ETC at all
  etcActiveOnly: string[]; // active ETC people not on the Scheduler roster
};

export async function reconcileSchedulerRoster(): Promise<RosterReconciliation> {
  let team;
  try {
    team = await fetchSchedulerTeam(true); // include inactive for status compare
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "Could not reach the Scheduler database.",
      schedulerCount: 0, etcActiveCount: 0, etcTotalCount: 0, matched: 0, agree: 0,
      statusMismatches: [], teamMismatches: [], schedulerOnly: [], etcActiveOnly: [],
    };
  }

  const employees = await prisma.employee.findMany({
    select: { name: true, active: true, discipline: true },
  });
  // ETC keyed by normalized name (first wins on the rare collision).
  const etcByKey = new Map<string, (typeof employees)[number]>();
  for (const e of employees) {
    const k = normalizeName(e.name);
    if (!etcByKey.has(k)) etcByKey.set(k, e);
  }
  const schedulerKeys = new Set(team.map((m) => normalizeName(m.name)));

  let matched = 0;
  let agree = 0;
  const statusMismatches: RosterReconciliation["statusMismatches"] = [];
  const teamMismatches: RosterReconciliation["teamMismatches"] = [];
  const schedulerOnly: string[] = [];

  for (const m of team) {
    const emp = etcByKey.get(normalizeName(m.name));
    if (!emp) {
      schedulerOnly.push(m.name);
      continue;
    }
    matched++;
    const statusOk = emp.active === m.active;
    const schedTeam = toEtcDiscipline(m.discipline);
    const teamOk = (emp.discipline ?? "") === schedTeam;
    if (!statusOk) {
      statusMismatches.push({ name: emp.name, etcActive: emp.active, schedulerActive: m.active });
    }
    if (!teamOk) {
      teamMismatches.push({ name: emp.name, etcTeam: emp.discipline ?? "—", schedulerTeam: schedTeam });
    }
    if (statusOk && teamOk) agree++;
  }

  const etcActiveOnly = employees
    .filter((e) => e.active && !schedulerKeys.has(normalizeName(e.name)))
    .map((e) => e.name)
    .sort();

  return {
    ok: true,
    schedulerCount: team.length,
    etcActiveCount: employees.filter((e) => e.active).length,
    etcTotalCount: employees.length,
    matched,
    agree,
    statusMismatches,
    teamMismatches,
    schedulerOnly,
    etcActiveOnly,
  };
}

