/**
 * SDC Project Tracker: completion forecast.
 *
 * Ported from forecast_prototype.py (2026-11-11) and extended per docs/project-tracker/DESIGN.md.
 *
 * Rules
 *  - All effort and capacity is in hours of project work. A person's hoursPerDay is the project
 *    hours they have on a working day (6 by default), already resolved by the caller from the
 *    global, team and person capacity settings.
 *  - Tasks are placed one at a time in priority order: tasks with a planned start first, then
 *    project stack rank, then tasks in an active sprint, then task priority, then task number.
 *    A planned start is a commitment to begin a particular piece of work on a particular day,
 *    whatever project it is in, so it is placed before the rank order is worked through. This is
 *    what lets a week's plan take one card from each of several projects.
 *  - Priority inheritance: a task that blocks more important work is placed at the priority of
 *    the most important thing waiting on it, through chains of dependencies.
 *  - A task starts on the first day on or after its earliest date on which its assignee has free
 *    capacity, and books capacity day by day until its remaining effort is used. Lower-priority
 *    work fills days that higher-priority work leaves idle.
 *  - Earliest date = as-of date, not-before date, expected-unblock date, or the day after a
 *    predecessor finishes plus lag (calendar days). Only finish-to-start is supported.
 *  - A task with a role pool and no assignee goes to the pool member who would finish it first.
 *  - If a person has allocations in effect on a day, each project gets its share of that day; a
 *    share whose project has no work for them in this run is released to the others.
 *  - Tasks that cannot be scheduled come back with a reason instead of being dropped: no
 *    estimate, no assignee, blocked, and so on.
 *  - A predecessor that is not in the task list is treated as finished. The caller passes open
 *    tasks only, so this is right for completed predecessors.
 *  - simulate() reruns the schedule with sampled efforts to give P50 and P80 finish dates. Part
 *    of each task's estimate error is shared across its project so the range does not collapse
 *    as the number of tasks grows.
 */

const DAY_MS = 86_400_000;
const EPS = 1e-9;
export const HORIZON_DAYS = 1100;

// ---------- dates: whole days since 1970-01-01, ISO strings at the boundary ----------

export function toDay(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`not an ISO date: ${iso}`);
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

export function fromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** ISO weekday, 1 = Monday. 1970-01-01 was a Thursday. */
export function isoWeekday(day: number): number {
  return ((((day + 3) % 7) + 7) % 7) + 1;
}

// ---------- inputs ----------

export interface TimeOff {
  start: string;
  end: string;
  /** Part of each day that is off, 0 to 1. Default 1 (the whole day). */
  dayPortion?: number;
}

export interface CapacityPeriod {
  start: string;
  end: string;
  hoursPerDay: number;
}

export interface Allocation {
  project: string;
  percent: number;
  start?: string;
  end?: string;
}

export interface Resource {
  id: string;
  /** Hours of project work on a working day. */
  hoursPerDay: number;
  /** ISO weekdays worked, 1 = Monday. Default Monday to Friday. */
  weekdays?: number[];
  timeOff?: TimeOff[];
  /** Date-ranged overrides of hoursPerDay, e.g. a busy stretch on untracked work. */
  periods?: CapacityPeriod[];
  allocations?: Allocation[];
}

export interface Predecessor {
  id: string;
  /** Calendar days added after the predecessor finishes. */
  lagDays?: number;
}

export interface Task {
  id: string;
  project: string;
  /** Company-wide stack rank of the project, 1 = first. */
  projectRank: number;
  /** Hours left. null means nobody has estimated it. */
  remainingHours: number | null;
  /** Milestones carry no effort and need no assignee. */
  isMilestone?: boolean;
  assignee?: string | null;
  /** Role pool to schedule against while there is no assignee. */
  pool?: string | null;
  priority?: number;
  number?: number;
  inSprint?: boolean;
  /** Has a planned start: placed ahead of the stack-rank order. The caller also gives the day as notBefore. */
  planned?: boolean;
  notBefore?: string | null;
  /** In a blocked status. Without expectedUnblock the task is not scheduled. */
  blocked?: boolean;
  expectedUnblock?: string | null;
  preds?: Predecessor[];
  /** Simulation range as multiples of remainingHours. Defaults come from SimOptions. */
  lowFactor?: number;
  highFactor?: number;
}

export interface Inputs {
  tasks: Task[];
  resources: Resource[];
  /** Role pool id -> resource ids. */
  pools?: Record<string, string[]>;
  holidays?: string[];
  asOf: string;
}

// ---------- outputs ----------

export type Driver = "start" | "not_before" | "blocked_until" | "predecessor" | "resource";

export interface Scheduled {
  scheduled: true;
  start: string;
  finish: string;
  /** Why it starts when it does. */
  driver: Driver;
  driverTask: string | null;
  /** The person booked. For a pool task, the member chosen. null for milestones. */
  assignedTo: string | null;
  /** The more important task this one was pulled forward for, if any. */
  priorityFrom: string | null;
}

export interface Unscheduled {
  scheduled: false;
  reason: string;
}

export type Result = Scheduled | Unscheduled;

export interface ScheduleOutput {
  results: Map<string, Result>;
  /** Hours booked per person per day, keyed `${resourceId}|${day}`. */
  bookings: Map<string, number>;
}

export interface ProjectSummary {
  project: string;
  /** Latest finish among scheduled tasks, or null if none are scheduled. */
  finish: string | null;
  unscheduledTasks: number;
  /** Known hours left out of the dates. Unestimated tasks add nothing here; see unestimatedTasks. */
  unscheduledHours: number;
  unestimatedTasks: number;
}

// ---------- ordering ----------

type Key = readonly [number, number, number, number, number, string];

function ownKey(t: Task): Key {
  return [t.planned ? 0 : 1, t.projectRank, t.inSprint ? 0 : 1, t.priority ?? 3, t.number ?? 0, t.id];
}

function cmpKey(a: Key, b: Key): number {
  for (let i = 0; i < 5; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a[5] < b[5] ? -1 : a[5] > b[5] ? 1 : 0;
}

/** Topological order of `ids`; anything it cannot order (cycles and what follows them) is left out. */
function kahn(ids: string[], predsOf: (id: string) => string[], succsOf: (id: string) => string[]): string[] {
  const inSet = new Set(ids);
  const pending = new Map<string, number>();
  for (const id of ids) pending.set(id, predsOf(id).filter((p) => inSet.has(p)).length);
  const queue = ids.filter((id) => pending.get(id) === 0);
  const order: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] as string;
    order.push(id);
    for (const s of succsOf(id)) {
      if (!inSet.has(s)) continue;
      const left = (pending.get(s) as number) - 1;
      pending.set(s, left);
      if (left === 0) queue.push(s);
    }
  }
  return order;
}

// ---------- compiled model (built once, reused by every simulation run) ----------

interface CompiledTask {
  task: Task;
  preds: { id: string; lag: number }[];
  notBefore: number | null;
  unblock: number | null;
  effKey: Key;
  priorityFrom: string | null;
  /** Set when the task can be ruled out before any placement. */
  deadReason: string | null;
}

interface CompiledResource {
  res: Resource;
  weekdays: Set<number>;
  timeOff: { start: number; end: number; portion: number }[];
  periods: { start: number; end: number; hours: number }[];
  allocations: { project: string; percent: number; start: number; end: number }[];
  allocatedProjects: Set<string>;
  /** Projects with schedulable work assigned to this person in this run. */
  projectsWithWork: Set<string>;
  capCache: Map<number, number>;
}

export interface Model {
  asOf: number;
  holidays: Set<number>;
  tasks: Map<string, CompiledTask>;
  /** Schedulable tasks, in the order they are placed. */
  order: CompiledTask[];
  resources: Map<string, CompiledResource>;
  pools: Map<string, string[]>;
}

function needsPerson(t: Task): boolean {
  return !t.isMilestone && (t.remainingHours ?? 0) > EPS;
}

export function compile(inputs: Inputs): Model {
  const asOf = toDay(inputs.asOf);
  const holidays = new Set((inputs.holidays ?? []).map(toDay));

  const resources = new Map<string, CompiledResource>();
  for (const res of inputs.resources) {
    const allocations = (res.allocations ?? []).map((a) => ({
      project: a.project,
      percent: a.percent,
      start: a.start ? toDay(a.start) : -Infinity,
      end: a.end ? toDay(a.end) : Infinity,
    }));
    resources.set(res.id, {
      res,
      weekdays: new Set(res.weekdays ?? [1, 2, 3, 4, 5]),
      timeOff: (res.timeOff ?? []).map((o) => ({
        start: toDay(o.start),
        end: toDay(o.end),
        portion: o.dayPortion ?? 1,
      })),
      periods: (res.periods ?? []).map((p) => ({ start: toDay(p.start), end: toDay(p.end), hours: p.hoursPerDay })),
      allocations,
      allocatedProjects: new Set(allocations.map((a) => a.project)),
      projectsWithWork: new Set(),
      capCache: new Map(),
    });
  }

  const pools = new Map<string, string[]>();
  for (const [id, members] of Object.entries(inputs.pools ?? {})) {
    pools.set(id, members.filter((m) => resources.has(m)).sort());
  }

  const tasks = new Map<string, CompiledTask>();
  for (const t of inputs.tasks) {
    if (tasks.has(t.id)) throw new Error(`duplicate task id: ${t.id}`);
    tasks.set(t.id, {
      task: t,
      preds: [],
      notBefore: t.notBefore ? toDay(t.notBefore) : null,
      unblock: t.blocked && t.expectedUnblock ? toDay(t.expectedUnblock) : null,
      effKey: ownKey(t),
      priorityFrom: null,
      deadReason: null,
    });
  }
  const succs = new Map<string, string[]>();
  for (const ct of tasks.values()) {
    for (const p of ct.task.preds ?? []) {
      if (!tasks.has(p.id)) continue; // not in the list: treated as finished
      ct.preds.push({ id: p.id, lag: p.lagDays ?? 0 });
      const list = succs.get(p.id);
      if (list) list.push(ct.task.id);
      else succs.set(p.id, [ct.task.id]);
    }
  }
  const predsOf = (id: string) => (tasks.get(id) as CompiledTask).preds.map((p) => p.id);
  const succsOf = (id: string) => succs.get(id) ?? [];

  const ids = [...tasks.values()].sort((a, b) => cmpKey(ownKey(a.task), ownKey(b.task))).map((c) => c.task.id);

  // Cycles: whatever a first pass cannot order, minus whatever merely follows a cycle.
  const firstPass = new Set(kahn(ids, predsOf, succsOf));
  const leftover = ids.filter((id) => !firstPass.has(id));
  const downstream = new Set(kahn(leftover, succsOf, predsOf)); // reversed graph strips the tails
  const inCycle = new Set(leftover.filter((id) => !downstream.has(id)));
  const acyclic = ids.filter((id) => !inCycle.has(id));
  const topo = kahn(acyclic, (id) => predsOf(id).filter((p) => !inCycle.has(p)), succsOf);

  // Rule out what can be known before placing anything.
  for (const id of inCycle) (tasks.get(id) as CompiledTask).deadReason = "dependency cycle";
  for (const id of topo) {
    const ct = tasks.get(id) as CompiledTask;
    const t = ct.task;
    if (t.blocked && ct.unblock === null) ct.deadReason = "blocked";
    else if (!t.isMilestone && t.remainingHours === null) ct.deadReason = "no estimate";
    else if (needsPerson(t)) {
      if (t.assignee) {
        if (!resources.has(t.assignee)) ct.deadReason = "no capacity profile";
      } else if (t.pool) {
        if (!pools.get(t.pool)?.length) ct.deadReason = "role pool has no members with capacity";
      } else ct.deadReason = "no assignee";
    }
    if (ct.deadReason === null) {
      const bad = ct.preds.find((p) => (tasks.get(p.id) as CompiledTask).deadReason !== null);
      if (bad) ct.deadReason = `blocked by unscheduled predecessor ${bad.id}`;
    }
  }

  // Priority inheritance, from the ends of the chains backwards. Unschedulable work lends nothing.
  const live = topo.filter((id) => (tasks.get(id) as CompiledTask).deadReason === null);
  for (let i = live.length - 1; i >= 0; i--) {
    const ct = tasks.get(live[i] as string) as CompiledTask;
    for (const sid of succsOf(ct.task.id)) {
      const s = tasks.get(sid) as CompiledTask;
      if (s.deadReason !== null) continue;
      if (cmpKey(s.effKey, ct.effKey) < 0) {
        ct.effKey = s.effKey;
        ct.priorityFrom = s.priorityFrom ?? s.task.id;
      }
    }
  }

  // A predecessor's effective key is never after its successor's, so sorting by it (ties broken
  // by dependency order) always places predecessors first.
  const topoIndex = new Map(live.map((id, i) => [id, i]));
  const order = live
    .map((id) => tasks.get(id) as CompiledTask)
    .sort(
      (a, b) =>
        cmpKey(a.effKey, b.effKey) || (topoIndex.get(a.task.id) as number) - (topoIndex.get(b.task.id) as number),
    );

  for (const ct of order) {
    if (ct.task.assignee && needsPerson(ct.task)) {
      resources.get(ct.task.assignee)?.projectsWithWork.add(ct.task.project);
    }
  }

  return { asOf, holidays, tasks, order, resources, pools };
}

// ---------- capacity ----------

/** Hours of project work a person has on a day, before bookings and allocations. */
function capacityOn(model: Model, cr: CompiledResource, day: number): number {
  const cached = cr.capCache.get(day);
  if (cached !== undefined) return cached;
  let hours = 0;
  if (cr.weekdays.has(isoWeekday(day)) && !model.holidays.has(day)) {
    hours = cr.res.hoursPerDay;
    for (const p of cr.periods) if (p.start <= day && day <= p.end) hours = p.hours;
    let off = 0;
    for (const o of cr.timeOff) if (o.start <= day && day <= o.end) off += o.portion;
    hours *= Math.max(0, 1 - off);
  }
  cr.capCache.set(day, hours);
  return hours;
}

/**
 * Share of a person's day that a project may use, 0 to 1. With no allocation in effect that day
 * the person works in plain priority order (share 1). Shares of allocated projects that have no
 * work for this person are handed to the ones that do, in proportion.
 */
function shareOn(cr: CompiledResource, project: string, day: number): number {
  let any = false;
  let mine = 0;
  let idle = 0;
  let working = 0;
  for (const a of cr.allocations) {
    if (day < a.start || day > a.end) continue;
    any = true;
    if (a.project === project) mine += a.percent;
    if (cr.projectsWithWork.has(a.project)) working += a.percent;
    else idle += a.percent;
  }
  if (!any) return 1;
  if (mine === 0) return 0;
  const share = cr.projectsWithWork.has(project) && working > 0 ? mine + (idle * mine) / working : mine;
  return Math.min(1, share / 100);
}

// ---------- placement ----------

interface State {
  total: Map<string, number>;
  byProject: Map<string, number>;
}

interface Placement {
  resource: string;
  start: number;
  finish: number;
  waitedForCapacity: boolean;
  days: [number, number][];
}

function tryPlace(
  model: Model,
  st: State,
  cr: CompiledResource,
  project: string,
  hours: number,
  earliest: number,
): Placement | null {
  const shared = cr.allocations.length > 0;
  const days: [number, number][] = [];
  let left = hours;
  let start: number | null = null;
  let firstCapDay: number | null = null;
  for (let day = earliest; day < earliest + HORIZON_DAYS; day++) {
    const cap = capacityOn(model, cr, day);
    if (cap <= EPS) continue;
    const share = shared ? shareOn(cr, project, day) : 1;
    const dayCap = cap * share;
    if (dayCap <= EPS) continue;
    if (firstCapDay === null) firstCapDay = day;
    let free = cap - (st.total.get(`${cr.res.id}|${day}`) ?? 0);
    if (share < 1) free = Math.min(free, dayCap - (st.byProject.get(`${cr.res.id}|${project}|${day}`) ?? 0));
    if (free <= EPS) continue;
    const use = Math.min(free, left);
    days.push([day, use]);
    left -= use;
    if (start === null) start = day;
    if (left <= EPS) {
      return { resource: cr.res.id, start, finish: day, waitedForCapacity: start > (firstCapDay as number), days };
    }
  }
  return null;
}

function commit(st: State, cr: CompiledResource, project: string, p: Placement): void {
  for (const [day, use] of p.days) {
    const k = `${cr.res.id}|${day}`;
    st.total.set(k, (st.total.get(k) ?? 0) + use);
    if (cr.allocations.length > 0) {
      const kp = `${cr.res.id}|${project}|${day}`;
      st.byProject.set(kp, (st.byProject.get(kp) ?? 0) + use);
    }
  }
}

interface Internal {
  start: number;
  finish: number;
}

/** Runs one schedule. `effort` overrides remaining hours per task id (used by the simulation). */
export function scheduleModel(model: Model, effort?: Map<string, number>): ScheduleOutput {
  const results = new Map<string, Result>();
  const placed = new Map<string, Internal>();
  const st: State = { total: new Map(), byProject: new Map() };

  for (const ct of model.tasks.values()) {
    if (ct.deadReason !== null) results.set(ct.task.id, { scheduled: false, reason: ct.deadReason });
  }

  for (const ct of model.order) {
    const t = ct.task;
    const failed = ct.preds.find((p) => !placed.has(p.id));
    if (failed) {
      results.set(t.id, { scheduled: false, reason: `blocked by unscheduled predecessor ${failed.id}` });
      continue;
    }

    let earliest = model.asOf;
    let driver: Driver = "start";
    let driverTask: string | null = null;
    if (ct.notBefore !== null && ct.notBefore > earliest) {
      earliest = ct.notBefore;
      driver = "not_before";
    }
    if (ct.unblock !== null && ct.unblock > earliest) {
      earliest = ct.unblock;
      driver = "blocked_until";
    }
    for (const p of ct.preds) {
      const d = (placed.get(p.id) as Internal).finish + 1 + p.lag;
      if (d > earliest) {
        earliest = d;
        driver = "predecessor";
        driverTask = p.id;
      }
    }

    const hours = t.isMilestone ? 0 : (effort?.get(t.id) ?? t.remainingHours ?? 0);
    if (hours <= EPS) {
      // A milestone, or work with nothing left: done when its inputs are.
      placed.set(t.id, { start: earliest, finish: earliest });
      results.set(t.id, {
        scheduled: true,
        start: fromDay(earliest),
        finish: fromDay(earliest),
        driver,
        driverTask,
        assignedTo: null,
        priorityFrom: ct.priorityFrom,
      });
      continue;
    }

    const candidates = t.assignee ? [t.assignee] : (model.pools.get(t.pool as string) ?? []);
    let best: Placement | null = null;
    let sawAllocation = false;
    for (const id of candidates) {
      const cr = model.resources.get(id) as CompiledResource;
      if (cr.allocations.length > 0 && !cr.allocatedProjects.has(t.project)) continue;
      sawAllocation = true;
      const p = tryPlace(model, st, cr, t.project, hours, earliest);
      if (p && (best === null || p.finish < best.finish || (p.finish === best.finish && p.start < best.start)))
        best = p;
    }
    if (best === null) {
      results.set(t.id, {
        scheduled: false,
        reason: sawAllocation ? "no capacity within horizon" : "no allocation to this project",
      });
      continue;
    }
    commit(st, model.resources.get(best.resource) as CompiledResource, t.project, best);
    placed.set(t.id, { start: best.start, finish: best.finish });
    results.set(t.id, {
      scheduled: true,
      start: fromDay(best.start),
      finish: fromDay(best.finish),
      driver: best.waitedForCapacity ? "resource" : driver,
      driverTask: best.waitedForCapacity ? null : driverTask,
      assignedTo: best.resource,
      priorityFrom: ct.priorityFrom,
    });
  }
  return { results, bookings: st.total };
}

export function schedule(inputs: Inputs): ScheduleOutput {
  return scheduleModel(compile(inputs));
}

export function summarize(tasks: Task[], results: Map<string, Result>): ProjectSummary[] {
  const by = new Map<string, ProjectSummary>();
  for (const t of tasks) {
    let s = by.get(t.project);
    if (!s)
      by.set(
        t.project,
        (s = { project: t.project, finish: null, unscheduledTasks: 0, unscheduledHours: 0, unestimatedTasks: 0 }),
      );
    const r = results.get(t.id) as Result;
    if (r.scheduled) {
      if (s.finish === null || r.finish > s.finish) s.finish = r.finish;
    } else {
      s.unscheduledTasks++;
      s.unscheduledHours += t.remainingHours ?? 0;
      if (!t.isMilestone && t.remainingHours === null) s.unestimatedTasks++;
    }
  }
  return [...by.values()];
}

// ---------- simulation ----------

export interface SimOptions {
  /** Number of schedules to run. Default 2000. */
  runs?: number;
  seed?: number;
  /** Range for a task with no factors of its own, as multiples of its remaining hours. Placeholders. */
  lowFactor?: number;
  highFactor?: number;
  /**
   * How much of each task's estimate error is shared with the rest of its project, 0 to 1.
   * 0 samples every task independently, which makes ranges collapse on large plans.
   * Placeholder; calibrate from history.
   */
  correlation?: number;
}

export interface Percentiles {
  p50: string | null;
  p80: string | null;
}

export interface SimulationOutput {
  tasks: Map<string, Percentiles>;
  projects: Map<string, Percentiles>;
}

/** Small seeded generator (mulberry32), so a forecast can be reproduced. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inverse CDF of a triangular distribution on [low, high] with its peak at 1. */
function triangular(u: number, low: number, high: number): number {
  if (high - low <= EPS) return 1;
  const cut = (1 - low) / (high - low);
  return u < cut
    ? low + Math.sqrt(u * (high - low) * (1 - low))
    : high - Math.sqrt((1 - u) * (high - low) * (high - 1));
}

function percentile(sorted: number[], q: number): string | null {
  if (sorted.length === 0) return null;
  return fromDay(sorted[Math.floor(q * (sorted.length - 1))] as number);
}

export function simulate(inputs: Inputs, options: SimOptions = {}): SimulationOutput {
  const { runs = 2000, seed = 7, lowFactor = 0.8, highFactor = 1.5, correlation = 0.5 } = options;
  const model = compile(inputs);
  const next = rng(seed);
  const taskFinish = new Map<string, number[]>(inputs.tasks.map((t) => [t.id, []]));
  const projectFinish = new Map<string, number[]>();
  const sampled = model.order.filter((ct) => needsPerson(ct.task));

  for (let i = 0; i < runs; i++) {
    const shared = new Map<string, number>();
    const effort = new Map<string, number>();
    for (const ct of sampled) {
      const t = ct.task;
      let s = shared.get(t.project);
      if (s === undefined) shared.set(t.project, (s = next()));
      const low = t.lowFactor ?? lowFactor;
      const high = t.highFactor ?? highFactor;
      const factor = (1 - correlation) * triangular(next(), low, high) + correlation * triangular(s, low, high);
      effort.set(t.id, (t.remainingHours as number) * factor);
    }
    const { results } = scheduleModel(model, effort);
    const latest = new Map<string, number>();
    for (const t of inputs.tasks) {
      const r = results.get(t.id) as Result;
      if (!r.scheduled) continue;
      const day = toDay(r.finish);
      (taskFinish.get(t.id) as number[]).push(day);
      if (day > (latest.get(t.project) ?? -Infinity)) latest.set(t.project, day);
    }
    for (const [project, day] of latest) {
      const list = projectFinish.get(project);
      if (list) list.push(day);
      else projectFinish.set(project, [day]);
    }
  }

  const pct = (m: Map<string, number[]>) =>
    new Map(
      [...m].map(([k, v]) => {
        const sorted = [...v].sort((a, b) => a - b);
        return [k, { p50: percentile(sorted, 0.5), p80: percentile(sorted, 0.8) }] as const;
      }),
    );
  return { tasks: pct(taskFinish), projects: pct(projectFinish) };
}

// ---------- self-checks ----------

/**
 * Checks a schedule against the rules: nobody overbooked or booked on a day off, dates and
 * dependencies respected, effort conserved, and nothing placed ahead of work it depends on.
 * Returns a list of problems; empty means the schedule is sound.
 */
export function verify(inputs: Inputs, out: ScheduleOutput): string[] {
  const problems: string[] = [];
  const model = compile(inputs);
  const asOf = toDay(inputs.asOf);

  for (const [key, hours] of out.bookings) {
    const [id, dayText] = key.split("|") as [string, string];
    const day = Number(dayText);
    const cap = capacityOn(model, model.resources.get(id) as CompiledResource, day);
    if (cap <= EPS) problems.push(`${id} booked on a non-working day ${fromDay(day)}`);
    if (hours > cap + 1e-6) problems.push(`${id} overbooked on ${fromDay(day)}: ${hours} of ${cap}`);
  }

  let wanted = 0;
  for (const t of inputs.tasks) {
    const r = out.results.get(t.id);
    if (!r) {
      problems.push(`${t.id} has no result`);
      continue;
    }
    if (!r.scheduled) continue;
    const start = toDay(r.start);
    const finish = toDay(r.finish);
    if (!t.isMilestone) wanted += t.remainingHours ?? 0;
    if (start < asOf) problems.push(`${t.id} starts before the as-of date`);
    if (finish < start) problems.push(`${t.id} finishes before it starts`);
    if (t.notBefore && start < toDay(t.notBefore)) problems.push(`${t.id} starts before its not-before date`);
    if (t.blocked && t.expectedUnblock && start < toDay(t.expectedUnblock))
      problems.push(`${t.id} starts while still blocked`);
    for (const p of t.preds ?? []) {
      const pr = out.results.get(p.id);
      if (!pr) continue;
      if (!pr.scheduled) problems.push(`${t.id} is scheduled but its predecessor ${p.id} is not`);
      else if (start < toDay(pr.finish) + 1 + (p.lagDays ?? 0)) problems.push(`${t.id} starts before ${p.id} finishes`);
      const a = model.tasks.get(p.id) as CompiledTask;
      const b = model.tasks.get(t.id) as CompiledTask;
      if (cmpKey(a.effKey, b.effKey) > 0) problems.push(`${p.id} is ranked after ${t.id}, which depends on it`);
    }
  }

  let booked = 0;
  for (const h of out.bookings.values()) booked += h;
  if (Math.abs(booked - wanted) > 1e-6) problems.push(`booked ${booked} hours but scheduled effort is ${wanted}`);
  return problems;
}
