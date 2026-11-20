import type { BoardTask, ProjectListItem } from "../service/queries";

// How the tracker's screens word dates and forecast reasons. Dependency-free so it can be
// unit-tested and used from both server and client components.

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Today on this machine's calendar, not UTC: late in the evening UTC is already tomorrow. */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "2026-11-23" -> "Mon Nov 23". Parsed as a calendar date, never through a time zone. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Hours without a trailing ".0": 6 -> "6 h", 4.5 -> "4.5 h". */
export function hours(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${Number.isInteger(value) ? value : Math.round(value * 10) / 10} h`;
}

/**
 * How the hours typed on a parent compare with what the cards under it add up to. This is the
 * check a person makes before clearing the parent's own hours, so the screen makes it for them.
 */
export function uncountedComparison(own: number, under: number, unsized: number): string {
  const gap = Math.round((own - under) * 10) / 10;
  const compared =
    gap > 0
      ? `${hours(gap)} less than this card says`
      : gap < 0
        ? `${hours(-gap)} more than this card says`
        : "the same as this card says";
  const missing =
    unsized > 0
      ? ` ${unsized} of them ${unsized === 1 ? "has" : "have"} no estimate yet, so their total is too low.`
      : "";
  return `The cards under it have ${hours(under)} left, ${compared}.${missing}`;
}

/**
 * What a project's forecast leaves out, as short phrases. A card with no estimate is one of the
 * cards with no forecast date, so it is given as the reason, not counted a second time.
 */
export function leftOutOfForecast(noDate: number, noEstimate: number, unconfirmed: number): string[] {
  const out: string[] = [];
  if (noDate > 0) {
    const why =
      noEstimate <= 0
        ? ""
        : noEstimate >= noDate
          ? noDate === 1
            ? ": it has no estimate"
            : ": none of them has an estimate"
          : `, ${noEstimate} for lack of an estimate`;
    out.push(`${noDate} card${noDate === 1 ? " has" : "s have"} no forecast date${why}`);
  }
  if (unconfirmed > 0) {
    out.push(`${unconfirmed} card${unconfirmed === 1 ? " has" : "s have"} hours left that nobody has confirmed lately`);
  }
  return out;
}

type ReasonInput = Pick<
  BoardTask,
  | "driver"
  | "driverTaskKey"
  | "priorityFromKey"
  | "unscheduledReason"
  | "assigneeName"
  | "expectedUnblockDate"
  | "forecastFinish"
>;

const UNSCHEDULED: Record<string, string> = {
  "no estimate": "Not forecast: it has no estimate yet.",
  "no assignee": "Not forecast: nobody is assigned.",
  blocked: "Not forecast: blocked, with no expected unblock date.",
  "no capacity profile": "Not forecast: the assignee has no capacity set.",
  "no capacity within horizon": "Not forecast: the assignee has no free time in the next three years.",
  "no allocation to this project": "Not forecast: the assignee has no share of their time on this project.",
  "role pool has no members with capacity": "Not forecast: its role pool has nobody available.",
  "dependency cycle": "Not forecast: its dependencies form a loop.",
  "project has no stack rank": "Not forecast: the project has no stack rank yet.",
  "project on hold": "Not forecast: the project is on hold.",
};

/**
 * One plain sentence on why a task's forecast is what it is. The engine records the reason;
 * this is the only place that turns it into words.
 */
export function forecastReason(t: ReasonInput): string {
  if (t.unscheduledReason) {
    const known = UNSCHEDULED[t.unscheduledReason];
    if (known) return known;
    const waiting = /^blocked by unscheduled predecessor (.+)$/.exec(t.unscheduledReason);
    if (waiting) return "Not forecast: it waits on work that is not forecast itself.";
    return `Not forecast: ${t.unscheduledReason}.`;
  }
  if (!t.forecastFinish) return "No forecast yet.";
  const pulled = t.priorityFromKey ? ` Moved up because ${t.priorityFromKey} waits on it.` : "";
  switch (t.driver) {
    case "predecessor":
      return `Starts after ${t.driverTaskKey ?? "the work it waits on"} finishes.${pulled}`;
    case "resource":
      return `Starts when ${t.assigneeName ?? "the assignee"} is free of higher-priority work.${pulled}`;
    case "not_before":
      return `Starts on its not-before date.${pulled}`;
    case "blocked_until":
      return `Starts when it is expected to be unblocked (${shortDate(t.expectedUnblockDate)}).${pulled}`;
    default:
      return `Can start now.${pulled}`;
  }
}

/**
 * What taking a stack rank another project holds does to the others, in words. `moved` counts
 * the projects that change place, the one holding the rank included.
 */
export function rankClashEffect(clash: { holderKey: string; moved: number; direction: "down" | "up" }): string {
  return clash.moved <= 1
    ? `${clash.holderKey} moves ${clash.direction} one place.`
    : `${clash.holderKey} and ${clash.moved - 1} other ${clash.moved === 2 ? "project" : "projects"} each move ${clash.direction} one place.`;
}

/** The project list, added up. Open means planned, active or on hold: work still to come. */
export interface PortfolioSummary {
  open: number;
  active: number;
  /** Open projects with a target date. */
  withTarget: number;
  /** Open projects whose forecast (the safe date when there is one) is after their target. */
  atRisk: number;
  hoursLeft: number;
  /** Open cards the forecast could not give a date. */
  notForecast: number;
  /** How many of those have no estimate. */
  noEstimate: number;
  /** Open projects whose target date has already gone by. */
  pastTarget: number;
  /** The soonest target date still to come, and whose it is. */
  nextTarget: { key: string; date: string } | null;
}

export function portfolioSummary(
  projects: Pick<
    ProjectListItem,
    "key" | "state" | "targetDate" | "atRisk" | "remainingHours" | "unscheduledTasks" | "unestimatedTasks"
  >[],
  /** YYYY-MM-DD. Passed in, so the sums do not depend on the clock. */
  today: string,
): PortfolioSummary {
  const open = projects.filter((p) => p.state === "planned" || p.state === "active" || p.state === "on_hold");
  const upcoming = open
    .filter((p): p is typeof p & { targetDate: string } => p.targetDate != null && p.targetDate >= today)
    .sort((a, b) => a.targetDate.localeCompare(b.targetDate) || a.key.localeCompare(b.key));
  return {
    open: open.length,
    active: open.filter((p) => p.state === "active").length,
    withTarget: open.filter((p) => p.targetDate != null).length,
    atRisk: open.filter((p) => p.atRisk === true).length,
    hoursLeft: Math.round(open.reduce((sum, p) => sum + p.remainingHours, 0) * 10) / 10,
    notForecast: open.reduce((sum, p) => sum + p.unscheduledTasks, 0),
    noEstimate: open.reduce((sum, p) => sum + p.unestimatedTasks, 0),
    pastTarget: open.filter((p) => p.targetDate != null && p.targetDate < today).length,
    nextTarget: upcoming[0] ? { key: upcoming[0].key, date: upcoming[0].targetDate } : null,
  };
}

/** What the project list and the timeline of all projects read from the address. */
export interface DepartmentView {
  /** The department chosen in the filter, or null for all of them. */
  forId: number | null;
  /** Whether the rows are gathered under a heading per department. */
  grouped: boolean;
}

export function departmentView(params: { for?: string | string[]; group?: string | string[] }): DepartmentView {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const id = Number(one(params.for));
  return { forId: Number.isInteger(id) && id > 0 ? id : null, grouped: one(params.group) === "1" };
}

/** The projects that are for one of `scope` (see departmentScope). A project with no department is for none. */
export function projectsFor<P extends Pick<ProjectListItem, "forDepartmentId">>(
  projects: P[],
  scope: Set<number> | null,
): P[] {
  if (!scope) return projects;
  return projects.filter((p) => p.forDepartmentId != null && scope.has(p.forDepartmentId));
}

/**
 * The same projects with each department's together, departments in the company's own order,
 * and those with no department last. Inside a department the order given is kept, so a list
 * that came in stack-rank order is still in rank order under each heading.
 */
export function byDepartment<P extends Pick<ProjectListItem, "forGroupSort">>(projects: P[]): P[] {
  const last = Number.MAX_SAFE_INTEGER;
  return projects
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.forGroupSort ?? last) - (b.p.forGroupSort ?? last) || a.i - b.i)
    .map((x) => x.p);
}

/** What a move inside a department does to the company's ranks, for the question asked before it. */
export function departmentMoveEffect(move: {
  moved: { key: string; from: number; to: number };
  other: { key: string; from: number; to: number };
  passes: number;
}): string {
  const passing =
    move.passes === 0
      ? ""
      : `, ${move.moved.to < move.moved.from ? "ahead of" : "behind"} ${move.passes} ${move.passes === 1 ? "project" : "projects"} of other departments`;
  return `${move.moved.key} moves from company rank ${move.moved.from} to ${move.moved.to}${passing}. ${move.other.key} moves to ${move.other.to}.`;
}
