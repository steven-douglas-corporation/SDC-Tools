import type { HiringPosition } from "@/lib/hiring-positions";
import { EMPLOYEE_TEAMS } from "@/lib/employee-teams";
import { workforceGroupForCardKey } from "@/lib/employee-workforce-groups";

// Hire requests (2026-10-29). A position created in SDC Reports is a manager's
// request for a hire, not an opening: the recruiter files it in Paylocity, and
// the Paylocity posting reaches the app with the next warehouse load. Only
// postings count toward hiring totals; a request never does (hiring-positions.ts
// sets isOpen false on every one).
//
// Once the posting shows up, the request should be closed. The app suggests the
// match and a person confirms it, the same "keep it human" rule as the Recruiting
// tab. Pure (no server-only), so the rules below are unit-tested directly and the
// client can run them over the positions it already holds.

export const REQUEST_STATUS = "Requested";

/** Teams a hire can be requested for: those whose hires belong to a workforce group (the delivery teams). The server applies the same rule. */
export const REQUESTABLE_TEAMS = EMPLOYEE_TEAMS.filter((t) => workforceGroupForCardKey(t.schedulerCode) !== "other");
export const isRequestableTeam = (code: string | null | undefined): code is string =>
  !!code && REQUESTABLE_TEAMS.some((t) => t.schedulerCode === code);

/** Lowercase letters and digits only: "Controls Engineer II" and "controls engineer ii " compare equal. */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Loose on purpose: the recruiter may post "Controls Engineer II" for a request
 * titled "Controls Engineer". One containing the other counts, since a person
 * confirms every suggestion.
 */
export function titlesMatch(a: string, b: string): boolean {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** "MM/DD/YYYY" (how a posting's published date is carried) to a local date, or null. */
function parseUsDate(value: string | null): Date | null {
  const m = value ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value) : null;
  return m ? new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : null;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * The Paylocity posting this request most likely became, or null. A posting
 * matches when its title matches, it names the request's hiring manager (or, for
 * a request with none, sits on the same team), and it was published on or after
 * the day the request was made. That last rule keeps an older posting for the
 * same role from closing a request for one more of it. A posting with no
 * published date is not ruled out by it. Earliest-published match wins.
 */
export function findPostingForRequest(request: HiringPosition, positions: readonly HiringPosition[]): HiringPosition | null {
  if (request.source !== "manual") return null;
  const requestedDay = request.requestedAt ? startOfDay(request.requestedAt) : null;
  const managerId = request.hiringManagerIds[0] ?? null;
  const candidates = positions.filter((p) => {
    if (p.source !== "workbook" || !titlesMatch(p.title, request.title)) return false;
    if (managerId ? !p.hiringManagerIds.includes(managerId) : !request.department || p.department !== request.department) return false;
    const published = parseUsDate(p.createdDate);
    return !requestedDay || !published || published >= requestedDay;
  });
  candidates.sort((a, b) => (parseUsDate(a.createdDate)?.getTime() ?? Infinity) - (parseUsDate(b.createdDate)?.getTime() ?? Infinity));
  return candidates[0] ?? null;
}

/** Whole calendar days from `from` to `now`; 0 on the same day. */
export function daysSince(from: Date, now: Date = new Date()): number {
  return Math.max(0, Math.round((startOfDay(now).getTime() - startOfDay(from).getTime()) / 86_400_000));
}

export function waitingLabel(from: Date | null, now: Date = new Date()): string {
  if (!from) return "";
  const days = daysSince(from, now);
  return days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
}

export type TeamLead = { paylocityId: string; name: string; team: string | null };

/**
 * Who can be named as hiring manager on a request: the ★ team leads
 * (EmployeeRow.isLead, from team-resolution.ts) who are active and in Paylocity.
 * Their Paylocity id is what the posting's "Hiring Managers" carries, which is
 * what makes the match above work.
 */
export function teamLeadOptions(
  employees: readonly { name: string; paylocityId: string; team: string | null; isLead: boolean; active: boolean }[],
): TeamLead[] {
  return employees
    .filter((e) => e.isLead && e.active && /^\d+$/.test(e.paylocityId))
    .map((e) => ({ paylocityId: e.paylocityId, name: e.name, team: e.team }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
