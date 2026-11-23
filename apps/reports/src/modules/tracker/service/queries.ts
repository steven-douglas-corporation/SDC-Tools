import { TrackerError, one, type Actor, type Database } from "./database";
import { projectRole, type ProjectRole } from "./access";

// What the tracker's screens read. Like every other file here it is the only way to these
// tables: a page asks for a list or a board and gets plain objects back.
//
// Every date is a YYYY-MM-DD string and every number a number, whatever the database driver
// returned, so the screens never have to care.

export interface ProjectListItem {
  id: number;
  key: string;
  name: string;
  state: string;
  portfolioRank: number | null;
  ownerName: string;
  ownerPersonId: number;
  /** Why it is worth doing. Null only on a project made before this was asked for. */
  justification: string | null;
  valueBucketId: number | null;
  /** What it is worth in a year, as the range's own words, e.g. "$50k to $250k a year". */
  valueLabel: string | null;
  /** The range's place among the ranges, smallest first, for sorting by value. */
  valueSort: number | null;
  /** The department the project is for. Null only on a project made before this was asked for. */
  forDepartmentId: number | null;
  forDepartmentName: string | null;
  /** The department's own place among the departments of its group. */
  forDepartmentSort: number | null;
  /** The group that department sits in, or the department itself when it stands alone. Lists are grouped by it. */
  forGroupId: number | null;
  forGroupName: string | null;
  forGroupSort: number | null;
  /** The department that does the work. Null only on a project made before this was asked for. */
  doneByDepartmentId: number | null;
  doneByDepartmentName: string | null;
  doneByDepartmentSort: number | null;
  /** The group that department sits in, or the department itself when it stands alone. */
  doneByGroupId: number | null;
  doneByGroupName: string | null;
  doneByGroupSort: number | null;
  targetDate: string | null;
  /** The day the project started, where a manager has said so. Otherwise its cards decide. */
  startDate: string | null;
  taskCount: number;
  doneCount: number;
  remainingHours: number;
  /** Hours estimated across the project's cards, done or not: what the remaining hours are left of. */
  estimatedHours: number;
  /** How many of its cards carry an estimate, and how many finished ones never had one. */
  estimatedCards: number;
  unestimatedDoneCards: number;
  /** The people named on its open cards, by name. Empty when the work is the department's as a whole. */
  assigneeNames: string[];
  forecastFinish: string | null;
  p80Finish: string | null;
  atRisk: boolean | null;
  atRiskBasis: string | null;
  unscheduledTasks: number;
  unestimatedTasks: number;
  staleTasks: number;
  nextMilestone: string | null;
  /** The viewer's role on this project. An admin is a manager everywhere. */
  myRole: ProjectRole | null;
}

interface ProjectRow {
  project_id: number;
  key: string;
  name: string;
  state: string;
  portfolio_rank: number | null;
  owner_name: string;
  owner_person_id: number;
  justification: string | null;
  value_bucket_id: number | null;
  value_label: string | null;
  value_sort: number | null;
  for_team_id: number | null;
  for_name: string | null;
  for_sort: number | null;
  for_group_id: number | null;
  for_group_name: string | null;
  for_group_sort: number | null;
  estimated_hours: number | null;
  estimated_cards: number | null;
  unestimated_done_cards: number | null;
  assignee_names: string[] | null;
  done_by_team_id: number | null;
  done_by_name: string | null;
  done_by_sort: number | null;
  done_by_group_id: number | null;
  done_by_group_name: string | null;
  done_by_group_sort: number | null;
  target_date: string | null;
  start_date: string | null;
  task_count: string | number | null;
  done_count: string | number | null;
  remaining_hours: number | null;
  forecast_finish: string | null;
  p80_finish: string | null;
  at_risk: boolean | null;
  at_risk_basis: string | null;
  unscheduled_tasks: string | number;
  unestimated_tasks: string | number;
  stale_tasks: string | number;
  next_milestone: string | null;
  my_role: ProjectRole | null;
}

const PROJECT_COLUMNS = `
  r.project_id, r.key, r.name, r.state, r.portfolio_rank, o.display_name AS owner_name, r.owner_person_id,
  pj.justification, pj.value_bucket_id, vb.label AS value_label, vb.sort_order AS value_sort,
  pj.for_team_id, fd.name AS for_name, fd.sort_order AS for_sort, dd.sort_order AS done_by_sort, coalesce(fg.id, fd.id) AS for_group_id,
  coalesce(fg.name, fd.name) AS for_group_name, coalesce(fg.sort_order, fd.sort_order) AS for_group_sort,
  pj.done_by_team_id, dd.name AS done_by_name, coalesce(dg.id, dd.id) AS done_by_group_id,
  coalesce(dg.name, dd.name) AS done_by_group_name, coalesce(dg.sort_order, dd.sort_order) AS done_by_group_sort,
  r.target_date::text, pj.actual_start_date::text AS start_date, r.task_count, r.done_count, r.remaining_hours::float8,
  r.forecast_completion_date::text AS forecast_finish, r.p80_finish::text, r.at_risk, r.at_risk_basis,
  r.unscheduled_tasks, r.unestimated_tasks, r.stale_tasks, r.next_milestone, m.role AS my_role,
  (SELECT coalesce(sum(e.effort_estimate_hours), 0)::float8
     FROM tracker.task e
     JOIN tracker.workflow_status es ON es.id = e.status_id
    WHERE e.project_id = r.project_id AND e.archived_at IS NULL AND es.category <> 'cancelled'
      AND NOT EXISTS (SELECT 1 FROM tracker.task c WHERE c.parent_task_id = e.id AND c.archived_at IS NULL)
  ) AS estimated_hours,
  (SELECT count(*)::int
     FROM tracker.task e
     JOIN tracker.workflow_status es ON es.id = e.status_id
    WHERE e.project_id = r.project_id AND e.archived_at IS NULL AND es.category <> 'cancelled'
      AND NOT EXISTS (SELECT 1 FROM tracker.task c WHERE c.parent_task_id = e.id AND c.archived_at IS NULL)
      AND e.effort_estimate_hours IS NOT NULL
  ) AS estimated_cards,
  (SELECT count(*)::int
     FROM tracker.task e
     JOIN tracker.workflow_status es ON es.id = e.status_id
    WHERE e.project_id = r.project_id AND e.archived_at IS NULL AND es.category <> 'cancelled'
      AND NOT EXISTS (SELECT 1 FROM tracker.task c WHERE c.parent_task_id = e.id AND c.archived_at IS NULL)
      AND e.effort_estimate_hours IS NULL AND e.type <> 'milestone' AND es.category = 'done'
  ) AS unestimated_done_cards,
  (SELECT array_agg(DISTINCT ap.display_name ORDER BY ap.display_name)
     FROM tracker.task a
     JOIN tracker.workflow_status s ON s.id = a.status_id
     JOIN tracker.person ap ON ap.id = a.assignee_person_id
    WHERE a.project_id = r.project_id AND a.archived_at IS NULL AND s.category NOT IN ('done', 'cancelled')
  ) AS assignee_names`;

/**
 * Which of a project's two departments a list is filtered and grouped by: the one it is for,
 * or the one doing the work.
 */
export type DepartmentLens = "for" | "by";

/**
 * How finely a grouped list is gathered: under the group a department sits in (Engineering),
 * or under the department itself (Controls Engineering).
 */
export type DepartmentLevel = "group" | "team";

type Lensed = Pick<
  ProjectListItem,
  | "forDepartmentId"
  | "forDepartmentName"
  | "forDepartmentSort"
  | "forGroupId"
  | "forGroupName"
  | "forGroupSort"
  | "doneByDepartmentId"
  | "doneByDepartmentName"
  | "doneByDepartmentSort"
  | "doneByGroupId"
  | "doneByGroupName"
  | "doneByGroupSort"
>;

/**
 * The projects as a list filters and groups them. Everything that narrows or gathers by
 * department reads forDepartmentId and the three forGroup fields, so this hands back the same
 * projects with those four set for the view asked for: taken from who does the work when
 * looking through "by", and naming the department itself, not its group, at the "team" level.
 * The names shown in the For and Done by columns are not touched. Through "for" at the "group"
 * level nothing changes.
 */
export function throughLens<P extends Lensed>(
  projects: P[],
  lens: DepartmentLens,
  level: DepartmentLevel = "group",
): P[] {
  if (lens === "for" && level === "group") return projects;
  return projects.map((p) => {
    const by = lens === "by";
    const id = by ? p.doneByDepartmentId : p.forDepartmentId;
    const group = {
      id: by ? p.doneByGroupId : p.forGroupId,
      name: by ? p.doneByGroupName : p.forGroupName,
      sort: by ? p.doneByGroupSort : p.forGroupSort,
    };
    const own = {
      name: by ? p.doneByDepartmentName : p.forDepartmentName,
      sort: by ? p.doneByDepartmentSort : p.forDepartmentSort,
    };
    return {
      ...p,
      forDepartmentId: id,
      // Departments stay together under their group's place in the company's order.
      forGroupId: level === "team" ? id : group.id,
      // A department is named with the group it sits in, so a heading says where it belongs.
      forGroupName:
        level !== "team"
          ? group.name
          : group.id != null && group.id !== id && group.name && own.name
            ? `${group.name} › ${own.name}`
            : own.name,
      forGroupSort: level === "team" && group.sort != null ? group.sort * 1000 + (own.sort ?? 0) : group.sort,
      // The other department, so a check for a missing one still sees both.
      doneByDepartmentId: by ? p.forDepartmentId : p.doneByDepartmentId,
    };
  });
}

function toProject(r: ProjectRow, admin: boolean): ProjectListItem {
  return {
    id: Number(r.project_id),
    key: r.key,
    name: r.name,
    state: r.state,
    portfolioRank: r.portfolio_rank == null ? null : Number(r.portfolio_rank),
    ownerName: r.owner_name,
    ownerPersonId: Number(r.owner_person_id),
    justification: r.justification,
    valueBucketId: r.value_bucket_id == null ? null : Number(r.value_bucket_id),
    valueLabel: r.value_label,
    valueSort: r.value_sort == null ? null : Number(r.value_sort),
    forDepartmentId: r.for_team_id == null ? null : Number(r.for_team_id),
    forDepartmentName: r.for_name,
    forDepartmentSort: r.for_sort == null ? null : Number(r.for_sort),
    forGroupId: r.for_group_id == null ? null : Number(r.for_group_id),
    forGroupName: r.for_group_name,
    forGroupSort: r.for_group_sort == null ? null : Number(r.for_group_sort),
    doneByDepartmentId: r.done_by_team_id == null ? null : Number(r.done_by_team_id),
    doneByDepartmentName: r.done_by_name,
    doneByDepartmentSort: r.done_by_sort == null ? null : Number(r.done_by_sort),
    doneByGroupId: r.done_by_group_id == null ? null : Number(r.done_by_group_id),
    doneByGroupName: r.done_by_group_name,
    doneByGroupSort: r.done_by_group_sort == null ? null : Number(r.done_by_group_sort),
    targetDate: r.target_date,
    startDate: r.start_date,
    taskCount: Number(r.task_count ?? 0),
    doneCount: Number(r.done_count ?? 0),
    remainingHours: Number(r.remaining_hours ?? 0),
    estimatedHours: Number(r.estimated_hours ?? 0),
    estimatedCards: Number(r.estimated_cards ?? 0),
    unestimatedDoneCards: Number(r.unestimated_done_cards ?? 0),
    assigneeNames: r.assignee_names ?? [],
    forecastFinish: r.forecast_finish,
    p80Finish: r.p80_finish,
    atRisk: r.at_risk,
    atRiskBasis: r.at_risk_basis,
    unscheduledTasks: Number(r.unscheduled_tasks),
    unestimatedTasks: Number(r.unestimated_tasks),
    // The roll-up counts a task with no estimate as stale too (its remaining effort was never
    // entered). On screen that would report one task twice, so stale here means "has a number
    // that may be out of date".
    staleTasks: Math.max(0, Number(r.stale_tasks) - Number(r.unestimated_tasks)),
    nextMilestone: r.next_milestone,
    myRole: admin ? "manager" : r.my_role,
  };
}

/** The projects a person may see: the ones they are a member of, or all of them for an admin. */
export async function listProjects(db: Database, actor: Actor): Promise<ProjectListItem[]> {
  const admin = actor.admin === true;
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS}
         FROM tracker.project_rollup r
         JOIN tracker.person o ON o.id = r.owner_person_id
         JOIN tracker.project pj ON pj.id = r.project_id
    LEFT JOIN tracker.value_bucket vb ON vb.id = pj.value_bucket_id
    LEFT JOIN tracker.team fd ON fd.id = pj.for_team_id
    LEFT JOIN tracker.team fg ON fg.id = fd.parent_team_id
    LEFT JOIN tracker.team dd ON dd.id = pj.done_by_team_id
    LEFT JOIN tracker.team dg ON dg.id = dd.parent_team_id
    LEFT JOIN tracker.project_member m ON m.project_id = r.project_id AND m.person_id = $1
        WHERE $2::boolean OR m.role IS NOT NULL
        ORDER BY (r.state IN ('completed', 'cancelled')), r.portfolio_rank NULLS LAST, r.key`,
      [actor.personId, admin],
    );
    return rows.map((r) => toProject(r, admin));
  });
}

export interface BoardStatus {
  id: number;
  name: string;
  category: "todo" | "in_progress" | "blocked" | "done" | "cancelled";
  wipLimit: number | null;
}

export interface WorkKind {
  key: string;
  label: string;
  /** 1 is the top. A card may sit only under a card with a lower number. */
  level: number;
}

/** What the cards under a parent add up to. Only cards that carry work themselves are counted. */
export interface WorkRollup {
  cards: number;
  done: number;
  remainingHours: number;
  /** The latest forecast finish among the open cards, or null if none of them has one. */
  forecastFinish: string | null;
  /** Open cards the forecast could not place. While this is above zero the finish date is not the whole story. */
  notForecast: number;
}

interface RollupInput {
  id: number;
  parentId: number | null;
  closed: boolean;
  cancelled: boolean;
  remainingHours: number;
  forecastFinish: string | null;
}

/**
 * Adds up, for every card that has cards under it, the work beneath it. A cancelled card is
 * left out altogether, as it is everywhere else. Kept free of SQL so it can be tested alone.
 */
export function rollUp(tasks: RollupInput[]): Map<number, WorkRollup> {
  const children = new Map<number, RollupInput[]>();
  for (const t of tasks) {
    if (t.parentId == null) continue;
    const list = children.get(t.parentId);
    if (list) list.push(t);
    else children.set(t.parentId, [t]);
  }
  const result = new Map<number, WorkRollup>();
  const visit = (id: number): WorkRollup | null => {
    const kids = children.get(id);
    if (!kids) return null;
    const sum: WorkRollup = { cards: 0, done: 0, remainingHours: 0, forecastFinish: null, notForecast: 0 };
    for (const kid of kids) {
      const below = visit(kid.id);
      if (below) {
        sum.cards += below.cards;
        sum.done += below.done;
        sum.remainingHours += below.remainingHours;
        sum.notForecast += below.notForecast;
        if (below.forecastFinish && (!sum.forecastFinish || below.forecastFinish > sum.forecastFinish)) {
          sum.forecastFinish = below.forecastFinish;
        }
        continue;
      }
      if (kid.cancelled) continue;
      sum.cards++;
      if (kid.closed) {
        sum.done++;
        continue;
      }
      sum.remainingHours += kid.remainingHours;
      if (!kid.forecastFinish) sum.notForecast++;
      else if (!sum.forecastFinish || kid.forecastFinish > sum.forecastFinish) sum.forecastFinish = kid.forecastFinish;
    }
    result.set(id, sum);
    return sum;
  };
  for (const id of children.keys()) if (!result.has(id)) visit(id);
  return result;
}

/**
 * For every card with cards under it: how many open work cards beneath it, however deep, have
 * no hours at all. While that is above zero, what the cards under a parent add up to is too low.
 */
export function unsizedUnder(
  tasks: { id: number; parentId: number | null; open: boolean; sized: boolean }[],
): Map<number, number> {
  const children = new Map<number, typeof tasks>();
  for (const t of tasks) {
    if (t.parentId == null) continue;
    const list = children.get(t.parentId);
    if (list) list.push(t);
    else children.set(t.parentId, [t]);
  }
  const result = new Map<number, number>();
  const visit = (id: number): number => {
    let n = 0;
    for (const kid of children.get(id) ?? []) {
      if (children.has(kid.id)) n += visit(kid.id);
      else if (kid.open && !kid.sized) n++;
    }
    result.set(id, n);
    return n;
  };
  for (const id of children.keys()) if (!result.has(id)) visit(id);
  return result;
}

/** The hours on a parent card that the forecast leaves out, or null when there are none to flag. */
export function uncountedHours(
  isParent: boolean,
  category: BoardStatus["category"],
  remainingHours: number | null,
  estimateHours: number | null,
): number | null {
  if (!isParent || category === "done" || category === "cancelled") return null;
  const own = remainingHours ?? estimateHours ?? 0;
  return own > 0 ? own : null;
}

export interface BoardTask {
  id: number;
  key: string;
  title: string;
  type: "task" | "milestone";
  /** Epic, Feature, Story, Task, Bug, Issue or Milestone, as shown. */
  kindLabel: string;
  /** The card this one sits under, if any. */
  parentKey: string | null;
  /**
   * Set only for a card that has other cards under it. Such a card carries no hours of its own
   * in the forecast, so what it shows is added up from the cards beneath it, however deep.
   */
  rollup: WorkRollup | null;
  /**
   * Hours entered on an open card that has cards under it. The forecast does not count them,
   * so the screens say so: otherwise turning a sized card into a parent quietly shrinks the plan.
   * Null when there is nothing to flag.
   */
  uncountedHours: number | null;
  /** For a parent: open work cards under it with no estimate, so its totals are known to be low. */
  unsizedUnder: number;
  statusId: number;
  priority: number;
  assigneePersonId: number | null;
  assigneeName: string | null;
  estimateHours: number | null;
  remainingHours: number | null;
  bucketLabel: string | null;
  dueDate: string | null;
  estimatedCompletionDate: string | null;
  actualCompletionDate: string | null;
  blockedReason: string | null;
  expectedUnblockDate: string | null;
  /** True when remaining effort has not been entered or confirmed within the stale window. */
  stale: boolean;
  forecastStart: string | null;
  forecastFinish: string | null;
  p80Finish: string | null;
  /** Why the forecast starts when it does. */
  driver: "start" | "not_before" | "blocked_until" | "predecessor" | "resource" | null;
  driverTaskKey: string | null;
  /** The more important task this one was pulled forward for. */
  priorityFromKey: string | null;
  unscheduledReason: string | null;
  /** The card's checklist: how many items it has and how many are ticked. Both 0 when it has none. */
  checklistTotal: number;
  checklistDone: number;
}

export interface Board {
  project: ProjectListItem;
  statuses: BoardStatus[];
  tasks: BoardTask[];
  people: { id: number; name: string }[];
  buckets: { id: number; label: string; hours: number; shouldSplit: boolean }[];
  /** The kinds a card can be given, top of the hierarchy first. */
  kinds: WorkKind[];
  /**
   * How many cards of each kind the project has and how many are done, for the kinds it uses.
   * Cancelled cards are left out. Empty for a project that uses no kinds.
   */
  kindCounts: { label: string; total: number; done: number }[];
  /** The day the stored forecast was made for, or null if none has run. */
  forecastAsOf: string | null;
}

interface TaskRow {
  id: number;
  key: string;
  title: string;
  type: "task" | "milestone";
  kind_label: string;
  parent_task_id: number | null;
  parent_key: string | null;
  category: BoardStatus["category"];
  status_id: number;
  priority: number;
  assignee_person_id: number | null;
  assignee_name: string | null;
  estimate_hours: number | null;
  remaining_hours: number | null;
  bucket_label: string | null;
  due_date: string | null;
  estimated_completion_date: string | null;
  actual_completion_date: string | null;
  blocked_reason: string | null;
  expected_unblock_date: string | null;
  stale: boolean;
  forecast_start: string | null;
  forecast_finish: string | null;
  p80_finish: string | null;
  driver: BoardTask["driver"];
  driver_task_key: string | null;
  priority_from_key: string | null;
  unscheduled_reason: string | null;
  checklist_total: number;
  checklist_done: number;
}

/** One project's board: its columns, its unarchived tasks with their forecast, and what the forms need. */
export async function getBoard(db: Database, actor: Actor, projectKey: string): Promise<Board> {
  const admin = actor.admin === true;
  return db.transaction(async (tx) => {
    const header = await one<ProjectRow>(
      tx,
      `SELECT ${PROJECT_COLUMNS}
         FROM tracker.project_rollup r
         JOIN tracker.person o ON o.id = r.owner_person_id
         JOIN tracker.project pj ON pj.id = r.project_id
    LEFT JOIN tracker.value_bucket vb ON vb.id = pj.value_bucket_id
    LEFT JOIN tracker.team fd ON fd.id = pj.for_team_id
    LEFT JOIN tracker.team fg ON fg.id = fd.parent_team_id
    LEFT JOIN tracker.team dd ON dd.id = pj.done_by_team_id
    LEFT JOIN tracker.team dg ON dg.id = dd.parent_team_id
    LEFT JOIN tracker.project_member m ON m.project_id = r.project_id AND m.person_id = $1
        WHERE r.key = $2`,
      [actor.personId, projectKey.toUpperCase()],
      "Project",
    );
    const projectId = Number(header.project_id);
    // The same answer for "no such project" and "not yours", so a key cannot be probed.
    if (!(await projectRole(tx, projectId, actor))) throw new TrackerError("not_found", "Project was not found.");

    const statuses = await tx.query<{
      id: number;
      name: string;
      category: BoardStatus["category"];
      wip_limit: number | null;
    }>(
      `SELECT id, name, category, wip_limit FROM tracker.workflow_status WHERE project_id = $1 ORDER BY sort_order, id`,
      [projectId],
    );
    const tasks = await tx.query<TaskRow>(
      `SELECT t.id, p.key || '-' || t.number AS key, t.title, t.type, t.status_id, t.priority,
              k.label AS kind_label, t.parent_task_id, s.category,
              (SELECT p.key || '-' || up.number FROM tracker.task up WHERE up.id = t.parent_task_id) AS parent_key,
              t.assignee_person_id, a.display_name AS assignee_name,
              t.effort_estimate_hours::float8 AS estimate_hours, t.remaining_effort_hours::float8 AS remaining_hours,
              b.label AS bucket_label, t.due_date::text, t.estimated_completion_date::text,
              t.actual_completion_date::text, t.blocked_reason, t.expected_unblock_date::text,
              (t.type = 'task' AND s.category NOT IN ('done', 'cancelled')
                 AND (t.remaining_effort_updated_at IS NULL
                      OR t.remaining_effort_updated_at <
                         now() - make_interval(days => (SELECT stale_after_days FROM tracker.settings)))) AS stale,
              f.scheduled_start::text AS forecast_start, f.scheduled_finish::text AS forecast_finish,
              f.p80_finish::text, f.driver, f.unscheduled_reason,
              dp.key || '-' || dt.number AS driver_task_key,
              pp.key || '-' || pt.number AS priority_from_key,
              coalesce(cl.total, 0)::int AS checklist_total, coalesce(cl.done, 0)::int AS checklist_done
         FROM tracker.task t
         JOIN tracker.project p ON p.id = t.project_id
         JOIN tracker.workflow_status s ON s.id = t.status_id
    LEFT JOIN tracker.person a ON a.id = t.assignee_person_id
    LEFT JOIN tracker.effort_bucket b ON b.id = t.effort_bucket_id
         JOIN tracker.work_kind k ON k.key = t.kind
    LEFT JOIN tracker.task_forecast f
           ON f.task_id = t.id AND f.run_id = (SELECT run_id FROM tracker.current_schedule_run)
    LEFT JOIN tracker.task dt ON dt.id = f.driver_task_id
    LEFT JOIN tracker.project dp ON dp.id = dt.project_id
    LEFT JOIN tracker.task pt ON pt.id = f.priority_from_task_id
    LEFT JOIN tracker.project pp ON pp.id = pt.project_id
    LEFT JOIN (SELECT task_id, count(*) AS total, count(done_at) AS done
                 FROM tracker.task_checklist_item GROUP BY task_id) cl ON cl.task_id = t.id
        WHERE t.project_id = $1 AND t.archived_at IS NULL
        ORDER BY t.board_rank, t.id`,
      [projectId],
    );
    const people = await tx.query<{ id: number; name: string }>(
      `SELECT id, display_name AS name FROM tracker.person WHERE active ORDER BY display_name`,
    );
    const buckets = await tx.query<{ id: number; label: string; hours: number; should_split: boolean }>(
      `SELECT id, label, hours::float8 AS hours, should_split FROM tracker.effort_bucket WHERE active ORDER BY sort_order`,
    );
    const run = await tx.query<{ as_of: string }>(`SELECT as_of_date::text AS as_of FROM tracker.current_schedule_run`);
    const kinds = await tx.query<WorkKind>(`SELECT key, label, level FROM tracker.work_kind ORDER BY sort_order`);
    const rollups = rollUp(
      tasks.rows.map((t) => ({
        id: Number(t.id),
        parentId: t.parent_task_id == null ? null : Number(t.parent_task_id),
        closed: t.category === "done" || t.category === "cancelled",
        cancelled: t.category === "cancelled",
        remainingHours: Number(t.remaining_hours ?? t.estimate_hours ?? 0),
        forecastFinish: t.forecast_finish,
      })),
    );

    const unsized = unsizedUnder(
      tasks.rows.map((t) => ({
        id: Number(t.id),
        parentId: t.parent_task_id == null ? null : Number(t.parent_task_id),
        open: t.category !== "done" && t.category !== "cancelled",
        // A milestone never has hours, so it is not "missing an estimate".
        sized: t.type === "milestone" || t.remaining_hours != null || t.estimate_hours != null,
      })),
    );

    return {
      project: toProject(header, admin),
      statuses: statuses.rows.map((s) => ({
        id: Number(s.id),
        name: s.name,
        category: s.category,
        wipLimit: s.wip_limit == null ? null : Number(s.wip_limit),
      })),
      tasks: tasks.rows.map((t) => ({
        id: Number(t.id),
        key: t.key,
        title: t.title,
        type: t.type,
        kindLabel: t.kind_label,
        parentKey: t.parent_key,
        rollup: rollups.get(Number(t.id)) ?? null,
        uncountedHours: uncountedHours(
          rollups.has(Number(t.id)),
          t.category,
          t.remaining_hours == null ? null : Number(t.remaining_hours),
          t.estimate_hours == null ? null : Number(t.estimate_hours),
        ),
        unsizedUnder: unsized.get(Number(t.id)) ?? 0,
        statusId: Number(t.status_id),
        priority: Number(t.priority),
        assigneePersonId: t.assignee_person_id == null ? null : Number(t.assignee_person_id),
        assigneeName: t.assignee_name,
        estimateHours: t.estimate_hours == null ? null : Number(t.estimate_hours),
        remainingHours: t.remaining_hours == null ? null : Number(t.remaining_hours),
        bucketLabel: t.bucket_label,
        dueDate: t.due_date,
        estimatedCompletionDate: t.estimated_completion_date,
        actualCompletionDate: t.actual_completion_date,
        blockedReason: t.blocked_reason,
        expectedUnblockDate: t.expected_unblock_date,
        stale: t.stale === true,
        forecastStart: t.forecast_start,
        forecastFinish: t.forecast_finish,
        p80Finish: t.p80_finish,
        driver: t.driver,
        driverTaskKey: t.driver_task_key,
        priorityFromKey: t.priority_from_key,
        unscheduledReason: t.unscheduled_reason,
        checklistTotal: Number(t.checklist_total),
        checklistDone: Number(t.checklist_done),
      })),
      people: people.rows.map((p) => ({ id: Number(p.id), name: p.name })),
      buckets: buckets.rows.map((b) => ({
        id: Number(b.id),
        label: b.label,
        hours: Number(b.hours),
        shouldSplit: b.should_split === true,
      })),
      kinds: kinds.rows.map((k) => ({ key: k.key, label: k.label, level: Number(k.level) })),
      kindCounts: kinds.rows
        .map((k) => {
          const cards = tasks.rows.filter((t) => t.kind_label === k.label && t.category !== "cancelled");
          return { label: k.label, total: cards.length, done: cards.filter((t) => t.category === "done").length };
        })
        .filter((c) => c.total > 0),
      forecastAsOf: run.rows[0]?.as_of ?? null,
    };
  });
}

/** One of the dollar ranges a project's yearly value is chosen from. */
export interface ValueBucket {
  id: number;
  label: string;
}

/** The value ranges, smallest first, for the forms that ask what a project is worth. */
export async function listValueBuckets(db: Database): Promise<ValueBucket[]> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: number; label: string }>(
      `SELECT id, label FROM tracker.value_bucket ORDER BY sort_order`,
    );
    return rows.map((r) => ({ id: Number(r.id), label: r.label }));
  });
}
