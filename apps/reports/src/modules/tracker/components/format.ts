import type { BoardTask, DepartmentLens, DepartmentLevel, ProjectListItem } from "../service/queries";

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

/** Hours without a trailing ".0", and with a comma in the thousands: 6 -> "6 h", 4.5 -> "4.5 h", 3494 -> "3,494 h". */
export function hours(value: number | null | undefined): string {
  if (value == null) return "—";
  // en-US is named so the server and every browser write the same thing, whatever their own locale.
  return `${(Math.round(value * 10) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 })} h`;
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

/** Cards being worked on whose hours left nobody has touched for a while, in words. */
export const STALE_HOURS = (n: number) =>
  `${n} card${n === 1 ? " has" : "s have"} hours left that have not been updated in over a week`;

/**
 * The caveat on a project's forecast date: how many of its cards the forecast could not date,
 * and why when it is for lack of an estimate. Null when every card is dated. The date is then
 * the earliest the project could finish, not when it will.
 */
export function notInForecast(noDate: number, noEstimate: number): string | null {
  if (noDate <= 0) return null;
  const why =
    noEstimate <= 0
      ? ""
      : noEstimate >= noDate
        ? noDate === 1
          ? ": it has no estimate"
          : ": none of them has an estimate"
        : `, ${noEstimate} for lack of an estimate`;
  return `${noDate} card${noDate === 1 ? " is" : "s are"} not in this forecast${why}. The real finish is later.`;
}

/**
 * How far along a project is. Weighted by hours where its cards have estimates, so one large
 * card counts for more than several small ones; by the count of cards where none has.
 *
 * Cards with no estimate still count. Work recorded after it was done often has none, and
 * leaving it out would show a half-finished project as not started. Each such card is taken to
 * be the size of the project's average estimated card: a guess, but a fairer one than zero.
 */
export function progress(p: {
  taskCount: number;
  doneCount: number;
  remainingHours: number;
  estimatedHours: number;
  estimatedCards?: number;
  /** Finished cards that never had an estimate. */
  unestimatedDoneCards?: number;
  /** Open cards with no estimate. */
  unestimatedTasks?: number;
}): { percent: number; byHours: boolean; doneHours: number } {
  if (p.estimatedHours > 0) {
    const doneHours = Math.max(0, p.estimatedHours - p.remainingHours);
    const average = p.estimatedCards && p.estimatedCards > 0 ? p.estimatedHours / p.estimatedCards : 0;
    const unsizedDone = (p.unestimatedDoneCards ?? 0) * average;
    const unsizedOpen = (p.unestimatedTasks ?? 0) * average;
    const total = p.estimatedHours + unsizedDone + unsizedOpen;
    return { percent: Math.min(100, Math.round(((doneHours + unsizedDone) / total) * 100)), byHours: true, doneHours };
  }
  return { percent: p.taskCount > 0 ? Math.round((p.doneCount / p.taskCount) * 100) : 0, byHours: false, doneHours: 0 };
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
    out.push(STALE_HOURS(unconfirmed));
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
  nextTarget: { key: string; name: string; date: string } | null;
}

export function portfolioSummary(
  projects: Pick<
    ProjectListItem,
    "key" | "name" | "state" | "targetDate" | "atRisk" | "remainingHours" | "unscheduledTasks" | "unestimatedTasks"
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
    nextTarget: upcoming[0] ? { key: upcoming[0].key, name: upcoming[0].name, date: upcoming[0].targetDate } : null,
  };
}

/** What the project list and the timeline of all projects read from the address. */
/**
 * How a list is gathered under headings, as it is written in the address (?group=...): not at
 * all, or by one of a project's two departments, at the level of the group a department sits in
 * or of the department itself.
 */
export const GROUPINGS = {
  "": "No grouping",
  for: "Who it is for: department group",
  "for-team": "Who it is for: department",
  by: "Who does the work: department group",
  "by-team": "Who does the work: department",
} as const;
export type Grouping = keyof typeof GROUPINGS;

export interface DepartmentView {
  /** The departments ticked in the For filter. Empty for all of them. */
  forIds: number[];
  /** The departments ticked in the Done by filter. Empty for all of them. */
  byIds: number[];
  /** Whether the rows are gathered under a heading per department. */
  grouped: boolean;
  /** Which of a project's two departments the headings are: who it is for, or who does the work. */
  lens: DepartmentLens;
  /** What a heading is when grouped: the group a department sits in, or the department itself. */
  level: DepartmentLevel;
}

/** A list of ids from the address: "12,14". Anything that is not a department's id is dropped. */
function idList(value: string | undefined): number[] {
  const ids = (value ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)];
}

export function departmentView(params: {
  for?: string | string[];
  by?: string | string[];
  group?: string | string[];
}): DepartmentView {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  // "1" and "team" are how the first two were written before there were four.
  const asked = one(params.group) ?? "";
  const group = asked === "1" ? "for" : asked === "team" ? "for-team" : asked;
  const grouping: Grouping = group in GROUPINGS ? (group as Grouping) : "";
  return {
    forIds: idList(one(params.for)),
    byIds: idList(one(params.by)),
    grouped: grouping !== "",
    level: grouping === "for-team" || grouping === "by-team" ? "team" : "group",
    lens: grouping === "by" || grouping === "by-team" ? "by" : "for",
  };
}

/** The view's grouping as the address writes it. */
export function groupingOf(view: Pick<DepartmentView, "grouped" | "lens" | "level">): Grouping {
  if (!view.grouped) return "";
  if (view.lens === "by") return view.level === "team" ? "by-team" : "by";
  return view.level === "team" ? "for-team" : "for";
}

/**
 * The projects that pass the two department filters: for one of `forScope`, and done by one of
 * `byScope` (see departmentsScope). Null is no filter. A project with no department passes
 * neither filter when one is set.
 */
export function inDepartments<P extends Pick<ProjectListItem, "forDepartmentId" | "doneByDepartmentId">>(
  projects: P[],
  forScope: Set<number> | null,
  byScope: Set<number> | null,
): P[] {
  return projects.filter(
    (p) =>
      (!forScope || (p.forDepartmentId != null && forScope.has(p.forDepartmentId))) &&
      (!byScope || (p.doneByDepartmentId != null && byScope.has(p.doneByDepartmentId))),
  );
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

/** What dropping a project at a new place in its department does to the company's ranks. */
export function departmentDropEffect(drop: {
  moved: { key: string; from: number; to: number };
  shifted: number;
  passes: number;
}): string {
  const passing =
    drop.passes === 0
      ? ""
      : `, ${drop.moved.to < drop.moved.from ? "ahead of" : "behind"} ${drop.passes} ${drop.passes === 1 ? "project" : "projects"} of other departments`;
  const making =
    drop.shifted === 0
      ? ""
      : ` ${drop.shifted} other ${drop.shifted === 1 ? "project" : "projects"} of its department ${drop.shifted === 1 ? "moves" : "each move"} one place to make room.`;
  return `${drop.moved.key} moves from company rank ${drop.moved.from} to ${drop.moved.to}${passing}.${making}`;
}

// ── The project list's view ────────────────────────────────────────────────────
// Which projects the list shows and in what order, all of it in the address: the department
// and grouping above, plus a search, a sort, one figure to narrow to, and whether finished
// projects are shown. Pure, so the page can be drawn on the server and the rules tested.

export type ListSort = "rank" | "name" | "target" | "forecast" | "value";
export type ListOnly = "active" | "at-risk" | "not-forecast" | "incomplete";

export const SORT_LABEL: Record<ListSort, string> = {
  rank: "Stack rank",
  name: "Name",
  target: "Target date, soonest first",
  forecast: "Forecast, soonest first",
  value: "Value, highest first",
};
export const ONLY_LABEL: Record<ListOnly, string> = {
  active: "active projects",
  "at-risk": "projects at risk",
  "not-forecast": "projects with cards the forecast could not date",
  incomplete: "projects missing a justification, a value or a department",
};

export interface ListView extends DepartmentView {
  sort: ListSort;
  only: ListOnly | null;
  /** What was typed in the search box, trimmed. */
  q: string;
  /** Whether finished and cancelled projects are shown. They are not, unless asked for. */
  finished: boolean;
}

export function listView(params: Record<string, string | string[] | undefined>): ListView {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const sort = one(params.sort);
  const only = one(params.only);
  return {
    ...departmentView(params),
    sort: sort in SORT_LABEL ? (sort as ListSort) : "rank",
    only: only in ONLY_LABEL ? (only as ListOnly) : null,
    q: one(params.q).trim().slice(0, 80),
    finished: one(params.done) === "1",
  };
}

/** The list's address for a view, or for a view with some of it changed. Defaults are left out. */
export function listHref(view: ListView, change: Partial<ListView> = {}): string {
  const v = { ...view, ...change };
  const query = new URLSearchParams();
  if (v.forIds.length) query.set("for", v.forIds.join(","));
  if (v.byIds.length) query.set("by", v.byIds.join(","));
  if (v.grouped) query.set("group", groupingOf(v));
  if (v.sort !== "rank") query.set("sort", v.sort);
  if (v.only) query.set("only", v.only);
  if (v.q) query.set("q", v.q);
  if (v.finished) query.set("done", "1");
  const text = query.toString();
  return text ? `/tracker?${text}` : "/tracker";
}

/** Planned, active or on hold: work still to come. */
export function isOpen(p: Pick<ProjectListItem, "state">): boolean {
  return p.state !== "completed" && p.state !== "cancelled";
}

/** Missing one of the four things every project is asked for. */
export function isIncomplete(
  p: Pick<ProjectListItem, "justification" | "valueBucketId" | "forDepartmentId" | "doneByDepartmentId">,
): boolean {
  return !p.justification || p.valueBucketId == null || p.forDepartmentId == null || p.doneByDepartmentId == null;
}

/**
 * True when ranks can only be read: the list is not every project in rank order. A rank is a
 * place among all of them, so it is changed with all of them in view. Grouping alone does not
 * lock them (a project is then moved within its department), and neither does showing
 * finished projects, which hold no place in the order. Grouped by who does the work, or by
 * department within a group, they are locked: a move within a heading is defined for the group
 * a project is for.
 */
export function ranksLocked(
  view: Pick<ListView, "forIds" | "byIds" | "sort" | "only" | "q" | "grouped" | "lens" | "level">,
): boolean {
  return (
    view.forIds.length > 0 ||
    view.byIds.length > 0 ||
    view.sort !== "rank" ||
    view.only != null ||
    view.q !== "" ||
    (view.grouped && (view.lens === "by" || view.level === "team"))
  );
}

type Listed = Pick<
  ProjectListItem,
  | "key"
  | "name"
  | "state"
  | "targetDate"
  | "forecastFinish"
  | "atRisk"
  | "unscheduledTasks"
  | "justification"
  | "valueBucketId"
  | "valueSort"
  | "forDepartmentId"
  | "doneByDepartmentId"
  | "forGroupSort"
>;

/**
 * Applies a view to the projects, which arrive in stack-rank order.
 *
 * `described` is the list before a figure narrows it: the department, the search and whether
 * finished projects are in. The figures above the list are worked out from it, so choosing a
 * figure never changes the figures. `shown` is that, narrowed to the chosen figure, sorted and
 * grouped: the rows of the table.
 */
export function narrowProjects<P extends Listed>(
  projects: P[],
  view: ListView,
  scope: Set<number> | null,
): { described: P[]; shown: P[] } {
  const words = view.q.toLowerCase();
  const described = projectsFor(projects, scope)
    .filter((p) => view.finished || isOpen(p))
    .filter((p) => !words || p.key.toLowerCase().includes(words) || p.name.toLowerCase().includes(words));

  const wanted: Record<ListOnly, (p: P) => boolean> = {
    active: (p) => p.state === "active",
    "at-risk": (p) => isOpen(p) && p.atRisk === true,
    "not-forecast": (p) => isOpen(p) && p.unscheduledTasks > 0,
    incomplete: (p) => isOpen(p) && isIncomplete(p),
  };
  const only = view.only;
  const narrowed = only ? described.filter(wanted[only]) : described;

  // Blanks go last whichever way the column runs: a project with no target is not "soonest".
  const blankLast =
    <T>(get: (p: P) => T | null, compare: (a: T, b: T) => number) =>
    (a: P, b: P) => {
      const [x, y] = [get(a), get(b)];
      if (x == null || y == null) return (x == null ? 1 : 0) - (y == null ? 1 : 0);
      return compare(x, y);
    };
  const order: Record<ListSort, ((a: P, b: P) => number) | null> = {
    rank: null,
    name: (a, b) => a.name.localeCompare(b.name),
    target: blankLast(
      (p) => p.targetDate,
      (a, b) => a.localeCompare(b),
    ),
    forecast: blankLast(
      (p) => p.forecastFinish,
      (a, b) => a.localeCompare(b),
    ),
    value: blankLast(
      (p) => p.valueSort,
      (a, b) => b - a,
    ),
  };
  const compare = order[view.sort];
  // Stable, so ties stay in rank order.
  const sorted = compare
    ? narrowed
        .map((p, i) => ({ p, i }))
        .sort((a, b) => compare(a.p, b.p) || a.i - b.i)
        .map((x) => x.p)
    : narrowed;
  return { described, shown: view.grouped ? byDepartment(sorted) : sorted };
}
