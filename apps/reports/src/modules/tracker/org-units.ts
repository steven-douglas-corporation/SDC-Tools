import { sectionOf, type SectionKey } from "@/lib/org-chart-groups";
import { EMPLOYEE_TEAMS } from "@/lib/employee-teams";
import { TEAM_CODES, TEAM_NAME } from "@/lib/team-names";
import type { OrgUnit } from "./service/departments";

// The company's departments, worked out from the employee roster for the tracker to copy.
//
// Nothing here is the tracker's own list. Which teams exist is read from the roster: a team is
// offered when at least one active employee is on it. What a team is called, and which group
// it belongs to, are the org chart's own answers (lib/employee-teams.ts, lib/team-names.ts,
// lib/org-chart-groups.ts),
// so the tracker and the org chart cannot disagree about either.
//
// The one thing written down here is what each group is called. The org chart draws those
// titles in its own component and does not export them; if it ever does, read them from there.
const GROUP_NAME: Record<SectionKey, string> = {
  growth: "Growth",
  pm: "Project Management",
  engineering: "Engineering",
  operations: "Operations",
  support: "Support",
};
const GROUP_ORDER: SectionKey[] = ["growth", "pm", "engineering", "operations", "support"];

/** For a project that is for everyone, such as the data warehouse. Always offered, always first. */
export const COMPANY_WIDE: OrgUnit = { code: "company", name: "Company-wide", parentCode: null };

/**
 * The org units for the teams in use, in the order they are shown: company-wide, then each
 * group with its teams under it, then any team the org chart puts in no group.
 *
 * A group with a single team is not made: the team stands on its own, since "all of Project
 * Management" and "Project Management" would be one choice listed twice.
 */
export function orgUnits(teamsInUse: Iterable<string | null | undefined>): OrgUnit[] {
  const used = new Set([...teamsInUse].filter((t): t is string => !!t));
  // The roster's card order first; a code the app does not know yet still gets listed, last.
  const codes = [...TEAM_CODES.filter((c) => used.has(c)), ...[...used].filter((c) => !TEAM_CODES.includes(c)).sort()];
  // The team's own name where the roster has one ("Mechanical Engineering"), which reads as a
  // department; otherwise the shared label for the code; otherwise the code itself.
  const name = (code: string) => EMPLOYEE_TEAMS.find((t) => t.schedulerCode === code)?.name ?? TEAM_NAME[code] ?? code;

  const units: OrgUnit[] = [COMPANY_WIDE];
  for (const group of GROUP_ORDER) {
    const teams = codes.filter((c) => sectionOf(c) === group);
    if (teams.length === 1) units.push({ code: teams[0]!, name: name(teams[0]!), parentCode: null });
    if (teams.length < 2) continue;
    const groupCode = `group:${group}`;
    units.push({ code: groupCode, name: GROUP_NAME[group], parentCode: null });
    for (const c of teams) units.push({ code: c, name: name(c), parentCode: groupCode });
  }
  for (const c of codes.filter((c) => sectionOf(c) == null)) units.push({ code: c, name: name(c), parentCode: null });
  return units;
}
