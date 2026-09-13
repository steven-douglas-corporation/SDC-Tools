import { EMPLOYEE_TEAMS } from "@/lib/employee-teams";
import { workforceGroupForCardKey, type WorkforceGroupKey } from "@/lib/employee-workforce-groups";
import type { HiringPositionSourceRow } from "@/lib/hiring-workbook";

// ── Best-effort default classification for an open position (2026-08-19) ────
//
// This is a DEFAULT, not an authority — hiring-positions.ts only ever
// consults it for a position with NO row in HiringPositionAssignment yet. The
// moment someone assigns or moves a position (hiring-actions.ts), that
// manual choice wins forever after, regardless of what this function would
// guess. Its whole job is to make a freshly-posted requisition land somewhere
// useful on day one instead of starting every position in "Unassigned".
//
// Two signals, checked in order, and neither is a lookup keyed on a specific
// position's own title/id (the task's own "do not hardcode individual job
// positions"):
//
//   1. Function Code — the hiring workbook's own numeric code, confirmed
//      (2026-08-19) to use the SAME numbering sections.ts already classifies
//      punches by (111 = PM, 312/313 = Controls' Design/Software split,
//      411/412/413 = the three Shop columns). Reused rather than reinvented.
//   2. A small set of GENERIC discipline keywords against the title/section
//      text — patterns of words ("controls", "machine builder", "service
//      technician"), never a specific requisition's own wording.
//
// A position neither signal can place stays Unassigned, which is the
// intended outcome for a vague or unusual title — not a gap to keep patching
// with ever more keywords.

export type ClassifiedWorkforce = {
  workforceGroup: WorkforceGroupKey | null;
  /** A DepartmentCard key (an employee-teams.ts schedulerCode), or null alongside a null workforceGroup. */
  department: string | null;
};

// Completed 2026-08-20 against the centralized Paylocity mapping audit, which
// found this table silently missing Function 211 (Mechanical Engineering),
// 311 (Controls Engineering) and 414 (Manufacturing's other raw code, aliased
// to 413 everywhere else) — a position posted under any of the three fell
// through to the keyword heuristic below instead of the same numbering
// sections.ts already classifies punches by. General Engineering (515-518)
// and Engineering "Other" (112/118/119/120) still have no entry: unlike the
// five above, there is no existing employee-team card for "General
// Engineering" hiring to land on (see employee-teams.ts's EMPLOYEE_TEAMS —
// seven delivery teams, none of them that), and inventing one is a workforce-
// roster decision outside what centralizing the Paylocity HOURS mapping asks
// for. Those codes keep falling through to the keyword heuristic, same as
// today, rather than being guessed into the wrong team.
const FUNCTION_CODE_TEAM: Record<string, string> = {
  "111": "pm",
  "211": "mech",
  "311": "controls",
  "312": "controls",
  "313": "controls",
  "411": "build",
  "412": "wire",
  "413": "mfgops",
  "414": "mfgops",
};

const KEYWORD_TEAM: { pattern: RegExp; teamCode: string }[] = [
  { pattern: /\belectrical controls\b/i, teamCode: "controls" },
  { pattern: /\bcontrols?\s+engineer/i, teamCode: "controls" },
  { pattern: /\bplc\b/i, teamCode: "controls" },
  { pattern: /\bmechanical\s+(engineer|design)/i, teamCode: "mech" },
  { pattern: /\bmachine\s+build(er)?\b/i, teamCode: "build" },
  { pattern: /\belectrician\b/i, teamCode: "wire" },
  { pattern: /\belectrical\s+build\b/i, teamCode: "wire" },
  { pattern: /\bwiring\b/i, teamCode: "wire" },
  { pattern: /\bmanufactur\w*/i, teamCode: "mfgops" },
  { pattern: /\bproduction\b/i, teamCode: "mfgops" },
  { pattern: /\bservice\s+(technician|engineer)/i, teamCode: "service" },
  { pattern: /\bfield\s+service\b/i, teamCode: "service" },
  { pattern: /\b(project|program)\s+manager\b/i, teamCode: "pm" },
];

const TEAM_CODES = new Set(EMPLOYEE_TEAMS.map((t) => t.schedulerCode));

export function classifyHiringPosition(row: HiringPositionSourceRow): ClassifiedWorkforce {
  let teamCode: string | null = null;
  if (row.functionCode && FUNCTION_CODE_TEAM[row.functionCode]) {
    teamCode = FUNCTION_CODE_TEAM[row.functionCode];
  } else {
    const haystack = `${row.title} ${row.sectionDescription ?? ""} ${row.functionDescription ?? ""}`;
    teamCode = KEYWORD_TEAM.find((k) => k.pattern.test(haystack))?.teamCode ?? null;
  }
  if (!teamCode || !TEAM_CODES.has(teamCode)) return { workforceGroup: null, department: null };
  return { workforceGroup: workforceGroupForCardKey(teamCode), department: teamCode };
}
