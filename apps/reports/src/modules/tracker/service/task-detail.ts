import { TrackerError, one, type Actor, type Database } from "./database";
import { projectRole, type ProjectRole } from "./access";
import { CARDS_UNDER } from "./tasks";
import { kindTakesChecklist } from "./checklist";
import {
  rollUp,
  uncountedHours,
  unsizedUnder,
  type BoardStatus,
  type BoardTask,
  type WorkKind,
  type WorkRollup,
} from "./queries";

// Everything the task page shows about one task: its fields, its forecast, what it waits on and
// what waits on it, its comments, and its history. History is the status log and the change log
// read back together, newest first, already put into words.

export interface LinkedTask {
  taskId: number;
  key: string;
  title: string;
  lagDays: number;
  /** True when that task is finished or cancelled. */
  closed: boolean;
  /** False for a card in a project the viewer has no role on: its title is withheld and it is not a link. */
  canOpen: boolean;
}

export interface ChildCard {
  key: string;
  title: string;
  kindLabel: string;
  statusName: string;
  /** True when that card is finished or cancelled. */
  closed: boolean;
  forecastFinish: string | null;
}

export interface HistoryEntry {
  /** UTC, ISO 8601. */
  at: string;
  who: string;
  what: string;
  /** The reason or note the person gave, if any. */
  why: string | null;
}

export interface TaskComment {
  id: number;
  author: string;
  body: string;
  /** UTC, ISO 8601. */
  at: string;
}

/** One line of a card's checklist: a small step to tick off, with no hours and no forecast. */
export interface ChecklistItem {
  id: number;
  body: string;
  done: boolean;
  /** Who ticked it, and when (UTC, ISO 8601). Null while it is not ticked. */
  doneBy: string | null;
  doneAt: string | null;
}

export interface TaskDetail {
  projectId: number;
  projectKey: string;
  projectName: string;
  myRole: ProjectRole;
  id: number;
  key: string;
  title: string;
  description: string | null;
  type: "task" | "milestone";
  /** The card's kind: epic, feature, story, task, bug, issue or milestone. */
  kind: string;
  kindLabel: string;
  /** The card this one sits under, or null. */
  parentTaskId: number | null;
  /** The cards above this one, top of the hierarchy first. Empty when it sits under nothing. */
  ancestors: { key: string; title: string }[];
  /** The cards directly under this one. */
  children: ChildCard[];
  /** What everything under this card adds up to, however deep. Null when nothing sits under it. */
  rollup: WorkRollup | null;
  /** Hours entered on this card that the forecast does not count, because cards sit under it. */
  uncountedHours: number | null;
  /** Open work cards under this one with no estimate, so what they add up to is known to be low. */
  unsizedUnder: number;
  /** Every unarchived card under this one, at any depth: what archiving it would take with it. */
  underCount: number;
  /** Every kind a card can be given, top of the hierarchy first. */
  kinds: WorkKind[];
  /** Cards in the same project this one could sit under, with the level each counts as. */
  parentCandidates: { id: number; key: string; title: string; kindLabel: string; level: number }[];
  statusId: number;
  statusName: string;
  statusCategory: BoardStatus["category"];
  priority: number;
  assigneePersonId: number | null;
  assigneeName: string | null;
  /** Who wants the work done. Starts as the creator and can be changed. */
  requestedByPersonId: number;
  requestedByName: string;
  /** Who made the card. Fixed. */
  createdByName: string;
  /** When it was made. UTC, ISO 8601. */
  createdAt: string;
  bucketId: number | null;
  bucketLabel: string | null;
  estimateHours: number | null;
  remainingHours: number | null;
  /** When remaining effort was last entered or confirmed. UTC, ISO 8601. */
  remainingUpdatedAt: string | null;
  plannedStartDate: string | null;
  estimatedCompletionDate: string | null;
  /** The first estimated completion date ever typed. Never replaced. */
  baselineCompletionDate: string | null;
  dueDate: string | null;
  actualCompletionDate: string | null;
  /** The day the work started: stamped on the first move into work, or set by a manager. */
  actualStartDate: string | null;
  notBeforeDate: string | null;
  notBeforeReason: string | null;
  blockedReason: string | null;
  expectedUnblockDate: string | null;
  archived: boolean;
  forecast: Pick<
    BoardTask,
    | "forecastStart"
    | "forecastFinish"
    | "p80Finish"
    | "driver"
    | "driverTaskKey"
    | "priorityFromKey"
    | "unscheduledReason"
  >;
  waitsOn: LinkedTask[];
  blocks: LinkedTask[];
  /**
   * Open cards this one could be made to wait on: this project's first, then those in every
   * other open project the viewer has a role on.
   */
  candidates: { id: number; key: string; title: string; projectKey: string }[];
  statuses: BoardStatus[];
  people: { id: number; name: string }[];
  buckets: { id: number; label: string; hours: number }[];
  /** In the order the card shows them. */
  checklist: ChecklistItem[];
  /** False for an Epic, Feature or Story: items it already has stay, but none can be added. */
  checklistAllowed: boolean;
  comments: TaskComment[];
  history: HistoryEntry[];
}

const UTC = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;
const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', ${UTC})`;

const FIELD_LABEL: Record<string, string> = {
  estimated_completion_date: "Estimated completion",
  planned_start_date: "Planned start",
  due_date: "Due date",
  not_before_date: "Not-before date",
  effort_estimate_hours: "Estimate",
  remaining_effort_hours: "Hours left",
  assignee: "Assignee",
  requested_by: "Requested by",
  role_pool: "Role pool",
  sprint: "Sprint",
  priority: "Priority",
  expected_unblock_date: "Expected unblock date",
  dependency: "Dependency",
  kind: "Kind",
};

interface DetailRow {
  project_id: number;
  project_key: string;
  project_name: string;
  id: number;
  number: number;
  title: string;
  description: string | null;
  type: "task" | "milestone";
  kind: string;
  kind_label: string;
  parent_task_id: number | null;
  status_id: number;
  status_name: string;
  status_category: BoardStatus["category"];
  priority: number;
  assignee_person_id: number | null;
  assignee_name: string | null;
  requested_by_person_id: number;
  requested_by_name: string;
  created_by_name: string;
  created_at: string;
  effort_bucket_id: number | null;
  bucket_label: string | null;
  estimate_hours: number | null;
  remaining_hours: number | null;
  remaining_updated_at: string | null;
  planned_start_date: string | null;
  estimated_completion_date: string | null;
  baseline_completion_date: string | null;
  due_date: string | null;
  actual_completion_date: string | null;
  actual_start_date: string | null;
  not_before_date: string | null;
  not_before_reason: string | null;
  blocked_reason: string | null;
  expected_unblock_date: string | null;
  archived: boolean;
  forecast_start: string | null;
  forecast_finish: string | null;
  p80_finish: string | null;
  driver: BoardTask["driver"];
  unscheduled_reason: string | null;
  driver_task_key: string | null;
  priority_from_key: string | null;
}

/** One task, by its project key and number (the "BIN" and "42" of BIN-42). */
export async function getTaskDetail(
  db: Database,
  actor: Actor,
  projectKey: string,
  taskNumber: number,
): Promise<TaskDetail> {
  if (!Number.isInteger(taskNumber) || taskNumber < 1) throw new TrackerError("not_found", "Task was not found.");
  return db.transaction(async (tx) => {
    const t = await one<DetailRow>(
      tx,
      `SELECT p.id AS project_id, p.key AS project_key, p.name AS project_name,
              t.id, t.number, t.title, t.description, t.type, t.status_id, s.name AS status_name,
              t.kind, k.label AS kind_label, t.parent_task_id,
              s.category AS status_category, t.priority,
              t.assignee_person_id, a.display_name AS assignee_name, t.requested_by_person_id, rp.display_name AS requested_by_name,
              cb.display_name AS created_by_name, ${utc("t.created_at")} AS created_at,
              t.effort_bucket_id, b.label AS bucket_label,
              t.effort_estimate_hours::float8 AS estimate_hours, t.remaining_effort_hours::float8 AS remaining_hours,
              ${utc("t.remaining_effort_updated_at")} AS remaining_updated_at,
              t.planned_start_date::text, t.estimated_completion_date::text, t.baseline_completion_date::text,
              t.due_date::text, t.actual_completion_date::text, t.actual_start_date::text, t.not_before_date::text, t.not_before_reason,
              t.blocked_reason, t.expected_unblock_date::text, (t.archived_at IS NOT NULL) AS archived,
              f.scheduled_start::text AS forecast_start, f.scheduled_finish::text AS forecast_finish,
              f.p80_finish::text, f.driver, f.unscheduled_reason,
              dp.key || '-' || dt.number AS driver_task_key, pp.key || '-' || pt.number AS priority_from_key
         FROM tracker.task t
         JOIN tracker.project p ON p.id = t.project_id
         JOIN tracker.workflow_status s ON s.id = t.status_id
         JOIN tracker.person rp ON rp.id = t.requested_by_person_id
         JOIN tracker.person cb ON cb.id = t.created_by_person_id
    LEFT JOIN tracker.person a ON a.id = t.assignee_person_id
    LEFT JOIN tracker.effort_bucket b ON b.id = t.effort_bucket_id
         JOIN tracker.work_kind k ON k.key = t.kind
    LEFT JOIN tracker.task_forecast f
           ON f.task_id = t.id AND f.run_id = (SELECT run_id FROM tracker.current_schedule_run)
    LEFT JOIN tracker.task dt ON dt.id = f.driver_task_id
    LEFT JOIN tracker.project dp ON dp.id = dt.project_id
    LEFT JOIN tracker.task pt ON pt.id = f.priority_from_task_id
    LEFT JOIN tracker.project pp ON pp.id = pt.project_id
        WHERE p.key = $1 AND t.number = $2`,
      [projectKey.toUpperCase(), taskNumber],
      "Task",
    );
    const projectId = Number(t.project_id);
    const taskId = Number(t.id);
    const role = await projectRole(tx, projectId, actor);
    if (!role) throw new TrackerError("not_found", "Task was not found.");

    const linked = `SELECT o.id AS task_id, op.key || '-' || o.number AS key, o.title, d.lag_days,
                           (os.category IN ('done', 'cancelled')) AS closed,
                           ($2::boolean OR EXISTS (SELECT 1 FROM tracker.project_member vm
                                                    WHERE vm.project_id = o.project_id AND vm.person_id = $3)) AS can_open
                      FROM tracker.task_dependency d`;
    const tail = `JOIN tracker.project op ON op.id = o.project_id
                  JOIN tracker.workflow_status os ON os.id = o.status_id`;
    type LinkRow = {
      task_id: number;
      key: string;
      title: string;
      lag_days: number;
      closed: boolean;
      can_open: boolean;
    };
    const admin = actor.admin === true;
    const toLink = (r: LinkRow): LinkedTask => ({
      taskId: Number(r.task_id),
      key: r.key,
      // The link itself is shown, since it moves this card's dates; what the other card says is not.
      title: r.can_open === true ? r.title : "a card in a project you cannot open",
      lagDays: Number(r.lag_days),
      closed: r.closed === true,
      canOpen: r.can_open === true,
    });
    const waitsOn = await tx.query<LinkRow>(
      `${linked} JOIN tracker.task o ON o.id = d.predecessor_task_id ${tail}
        WHERE d.successor_task_id = $1 ORDER BY op.key, o.number`,
      [taskId, admin, actor.personId],
    );
    const blocks = await tx.query<LinkRow>(
      `${linked} JOIN tracker.task o ON o.id = d.successor_task_id ${tail}
        WHERE d.predecessor_task_id = $1 ORDER BY op.key, o.number`,
      [taskId, admin, actor.personId],
    );
    const candidates = await tx.query<{ id: number; key: string; title: string; project_key: string }>(
      `SELECT o.id, p.key || '-' || o.number AS key, o.title, p.key AS project_key
         FROM tracker.task o
         JOIN tracker.project p ON p.id = o.project_id
         JOIN tracker.workflow_status os ON os.id = o.status_id
        WHERE o.id <> $2 AND o.archived_at IS NULL
          AND os.category NOT IN ('done', 'cancelled')
          AND (o.project_id = $1
               OR (p.state NOT IN ('completed', 'cancelled')
                   AND ($3::boolean OR EXISTS (SELECT 1 FROM tracker.project_member vm
                                                WHERE vm.project_id = o.project_id AND vm.person_id = $4))))
          AND NOT EXISTS (SELECT 1 FROM tracker.task_dependency d
                           WHERE d.predecessor_task_id = o.id AND d.successor_task_id = $2)
        ORDER BY (o.project_id <> $1), p.key, o.number`,
      [projectId, taskId, admin, actor.personId],
    );

    // The level drops at every step up, so this walk always ends; depth is how far up a card is.
    const ancestors = await tx.query<{ key: string; title: string }>(
      `WITH RECURSIVE up(id, parent_task_id, number, title, depth) AS (
           SELECT a.id, a.parent_task_id, a.number, a.title, 1 FROM tracker.task a WHERE a.id = $1
         UNION ALL
           SELECT a.id, a.parent_task_id, a.number, a.title, up.depth + 1
             FROM tracker.task a JOIN up ON a.id = up.parent_task_id
       )
       SELECT $2::text || '-' || number AS key, title FROM up ORDER BY depth DESC`,
      [t.parent_task_id, t.project_key],
    );
    const children = await tx.query<{
      id: number;
      key: string;
      title: string;
      kind_label: string;
      status_name: string;
      closed: boolean;
      forecast_finish: string | null;
    }>(
      `SELECT c.id, $2::text || '-' || c.number AS key, c.title, ck.label AS kind_label, cs.name AS status_name,
              (cs.category IN ('done', 'cancelled')) AS closed, cf.scheduled_finish::text AS forecast_finish
         FROM tracker.task c
         JOIN tracker.workflow_status cs ON cs.id = c.status_id
         JOIN tracker.work_kind ck ON ck.key = c.kind
    LEFT JOIN tracker.task_forecast cf
           ON cf.task_id = c.id AND cf.run_id = (SELECT run_id FROM tracker.current_schedule_run)
        WHERE c.parent_task_id = $1 AND c.archived_at IS NULL
        ORDER BY c.number`,
      [taskId, t.project_key],
    );
    // A card with cards under it has no forecast of its own, so it shows what they add up to.
    // The same sum the board uses, over the whole project, so the two screens cannot disagree.
    let rollups = new Map<number, WorkRollup>();
    let unsized = 0;
    if (children.rows.length) {
      const all = await tx.query<{
        id: number;
        parent_task_id: number | null;
        category: BoardStatus["category"];
        left_hours: number | null;
        type: string;
        forecast_finish: string | null;
      }>(
        `SELECT o.id, o.parent_task_id, os.category, o.type,
                coalesce(o.remaining_effort_hours, o.effort_estimate_hours)::float8 AS left_hours,
                f.scheduled_finish::text AS forecast_finish
           FROM tracker.task o
           JOIN tracker.workflow_status os ON os.id = o.status_id
      LEFT JOIN tracker.task_forecast f
             ON f.task_id = o.id AND f.run_id = (SELECT run_id FROM tracker.current_schedule_run)
          WHERE o.project_id = $1 AND o.archived_at IS NULL`,
        [projectId],
      );
      rollups = rollUp(
        all.rows.map((o) => ({
          id: Number(o.id),
          parentId: o.parent_task_id == null ? null : Number(o.parent_task_id),
          closed: o.category === "done" || o.category === "cancelled",
          cancelled: o.category === "cancelled",
          remainingHours: Number(o.left_hours ?? 0),
          forecastFinish: o.forecast_finish,
        })),
      );
      unsized =
        unsizedUnder(
          all.rows.map((o) => ({
            id: Number(o.id),
            parentId: o.parent_task_id == null ? null : Number(o.parent_task_id),
            open: o.category !== "done" && o.category !== "cancelled",
            sized: o.type === "milestone" || o.left_hours != null,
          })),
        ).get(taskId) ?? 0;
    }
    const kinds = await tx.query<WorkKind>(`SELECT key, label, level FROM tracker.work_kind ORDER BY sort_order`);
    // Only a card with a kind above the lowest level can have anything under it.
    const parentCandidates = await tx.query<{
      id: number;
      key: string;
      title: string;
      kind_label: string;
      level: number;
    }>(
      `SELECT o.id, $3::text || '-' || o.number AS key, o.title, ok.label AS kind_label, ok.level
         FROM tracker.task o
         JOIN tracker.work_kind ok ON ok.key = o.kind
        WHERE o.project_id = $1 AND o.id <> $2 AND (o.archived_at IS NULL OR o.id = $4)
          AND ok.level < (SELECT max(level) FROM tracker.work_kind)
        ORDER BY ok.level, o.number`,
      [projectId, taskId, t.project_key, t.parent_task_id],
    );

    const statuses = await tx.query<{
      id: number;
      name: string;
      category: BoardStatus["category"];
      wip_limit: number | null;
    }>(
      `SELECT id, name, category, wip_limit FROM tracker.workflow_status WHERE project_id = $1 ORDER BY sort_order, id`,
      [projectId],
    );
    const people = await tx.query<{ id: number; name: string }>(
      `SELECT id, display_name AS name FROM tracker.person WHERE active OR id = $1 OR id = $2 ORDER BY display_name`,
      [t.assignee_person_id, t.requested_by_person_id],
    );
    const buckets = await tx.query<{ id: number; label: string; hours: number }>(
      `SELECT id, label, hours::float8 AS hours FROM tracker.effort_bucket WHERE active OR id = $1 ORDER BY sort_order`,
      [t.effort_bucket_id],
    );
    const checklist = await tx.query<{ id: number; body: string; done_by: string | null; done_at: string | null }>(
      `SELECT i.id, i.body, p.display_name AS done_by, ${utc("i.done_at")} AS done_at
         FROM tracker.task_checklist_item i LEFT JOIN tracker.person p ON p.id = i.done_by_person_id
        WHERE i.task_id = $1 ORDER BY i.position, i.id`,
      [taskId],
    );
    const comments = await tx.query<{ id: number; author: string; body: string; at: string }>(
      `SELECT c.id, p.display_name AS author, c.body, ${utc("c.created_at")} AS at
         FROM tracker.task_comment c JOIN tracker.person p ON p.id = c.author_person_id
        WHERE c.task_id = $1 ORDER BY c.created_at, c.id`,
      [taskId],
    );

    const statusLog = await tx.query<{
      at: string;
      ts: number;
      who: string;
      from_name: string | null;
      to_name: string;
      note: string | null;
      id: number;
    }>(
      `SELECT ${utc("l.changed_at")} AS at, extract(epoch FROM l.changed_at)::float8 AS ts, p.display_name AS who, fs.name AS from_name, ts.name AS to_name, l.note, l.id
         FROM tracker.status_log l
         JOIN tracker.person p ON p.id = l.changed_by
         JOIN tracker.workflow_status ts ON ts.id = l.to_status_id
    LEFT JOIN tracker.workflow_status fs ON fs.id = l.from_status_id
        WHERE l.task_id = $1`,
      [taskId],
    );
    const changeLog = await tx.query<{
      at: string;
      ts: number;
      who: string;
      field: string;
      old_value: string | null;
      new_value: string | null;
      reason: string | null;
      id: number;
    }>(
      `SELECT ${utc("l.changed_at")} AS at, extract(epoch FROM l.changed_at)::float8 AS ts, p.display_name AS who, l.field::text, l.old_value, l.new_value, l.reason, l.id
         FROM tracker.task_change_log l JOIN tracker.person p ON p.id = l.changed_by
        WHERE l.task_id = $1`,
      [taskId],
    );
    // The change log stores an assignee as a person id. Turn it back into a name.
    const names = await tx.query<{ id: number; name: string }>(`SELECT id, display_name AS name FROM tracker.person`);
    const nameOf = new Map(names.rows.map((n) => [String(n.id), n.name]));
    const shown = (field: string, value: string | null): string => {
      if (value == null) return "nothing";
      if (field === "assignee" || field === "requested_by") return nameOf.get(value) ?? `person ${value}`;
      if (field === "effort_estimate_hours" || field === "remaining_effort_hours") return `${Number(value)} h`;
      return value;
    };

    const history: (HistoryEntry & { ts: number; rank: number; order: number })[] = [
      ...statusLog.rows.map((r) => ({
        at: r.at,
        who: r.who,
        ts: Number(r.ts),
        order: Number(r.id),
        rank: r.from_name ? 2 : 0,
        what: r.from_name ? `Moved from ${r.from_name} to ${r.to_name}` : `Created in ${r.to_name}`,
        why: r.note,
      })),
      ...changeLog.rows.map((r) => ({
        at: r.at,
        who: r.who,
        ts: Number(r.ts),
        order: Number(r.id),
        rank: 1,
        what:
          r.field === "dependency"
            ? r.new_value
              ? `Now ${r.new_value}`
              : `No longer ${r.old_value}`
            : r.field === "parent"
              ? r.new_value
                ? `Moved under ${r.new_value}${r.old_value ? ` (was under ${r.old_value})` : ""}`
                : `No longer under ${r.old_value}`
              : `${FIELD_LABEL[r.field] ?? r.field} changed from ${shown(r.field, r.old_value)} to ${shown(r.field, r.new_value)}`,
        why: r.reason,
      })),
    ];
    // Newest first, by the exact time. "at" is only to the second, which is not enough: several
    // changes often land within one. The two logs are separate tables, so when rows share an
    // exact time the tie is settled by kind (creation is always oldest, a move is taken as
    // newest), then by row id within the same log.
    history.sort((a, b) => b.ts - a.ts || b.rank - a.rank || b.order - a.order);

    return {
      projectId,
      projectKey: t.project_key,
      projectName: t.project_name,
      myRole: role,
      id: taskId,
      key: `${t.project_key}-${t.number}`,
      title: t.title,
      description: t.description,
      type: t.type,
      kind: t.kind,
      kindLabel: t.kind_label,
      parentTaskId: t.parent_task_id == null ? null : Number(t.parent_task_id),
      ancestors: ancestors.rows.map((a) => ({ key: a.key, title: a.title })),
      children: children.rows.map((c) => ({
        key: c.key,
        title: c.title,
        kindLabel: c.kind_label,
        statusName: c.status_name,
        closed: c.closed === true,
        // A child that is itself a parent shows the latest finish of what is under it.
        forecastFinish: rollups.get(Number(c.id))?.forecastFinish ?? c.forecast_finish,
      })),
      rollup: rollups.get(taskId) ?? null,
      unsizedUnder: unsized,
      underCount: (await tx.query(CARDS_UNDER, [taskId])).rows.length,
      uncountedHours: uncountedHours(
        rollups.has(taskId),
        t.status_category,
        t.remaining_hours == null ? null : Number(t.remaining_hours),
        t.estimate_hours == null ? null : Number(t.estimate_hours),
      ),
      kinds: kinds.rows.map((k) => ({ key: k.key, label: k.label, level: Number(k.level) })),
      parentCandidates: parentCandidates.rows.map((c) => ({
        id: Number(c.id),
        key: c.key,
        title: c.title,
        kindLabel: c.kind_label,
        level: Number(c.level),
      })),
      statusId: Number(t.status_id),
      statusName: t.status_name,
      statusCategory: t.status_category,
      priority: Number(t.priority),
      assigneePersonId: t.assignee_person_id == null ? null : Number(t.assignee_person_id),
      assigneeName: t.assignee_name,
      requestedByPersonId: Number(t.requested_by_person_id),
      requestedByName: t.requested_by_name,
      createdByName: t.created_by_name,
      createdAt: t.created_at,
      bucketId: t.effort_bucket_id == null ? null : Number(t.effort_bucket_id),
      bucketLabel: t.bucket_label,
      estimateHours: t.estimate_hours == null ? null : Number(t.estimate_hours),
      remainingHours: t.remaining_hours == null ? null : Number(t.remaining_hours),
      remainingUpdatedAt: t.remaining_updated_at,
      plannedStartDate: t.planned_start_date,
      estimatedCompletionDate: t.estimated_completion_date,
      baselineCompletionDate: t.baseline_completion_date,
      dueDate: t.due_date,
      actualCompletionDate: t.actual_completion_date,
      actualStartDate: t.actual_start_date,
      notBeforeDate: t.not_before_date,
      notBeforeReason: t.not_before_reason,
      blockedReason: t.blocked_reason,
      expectedUnblockDate: t.expected_unblock_date,
      archived: t.archived === true,
      forecast: {
        forecastStart: t.forecast_start,
        forecastFinish: t.forecast_finish,
        p80Finish: t.p80_finish,
        driver: t.driver,
        driverTaskKey: t.driver_task_key,
        priorityFromKey: t.priority_from_key,
        unscheduledReason: t.unscheduled_reason,
      },
      waitsOn: waitsOn.rows.map(toLink),
      blocks: blocks.rows.map(toLink),
      candidates: candidates.rows.map((c) => ({
        id: Number(c.id),
        key: c.key,
        title: c.title,
        projectKey: c.project_key,
      })),
      statuses: statuses.rows.map((s) => ({
        id: Number(s.id),
        name: s.name,
        category: s.category,
        wipLimit: s.wip_limit == null ? null : Number(s.wip_limit),
      })),
      people: people.rows.map((p) => ({ id: Number(p.id), name: p.name })),
      buckets: buckets.rows.map((b) => ({ id: Number(b.id), label: b.label, hours: Number(b.hours) })),
      checklist: checklist.rows.map((i) => ({
        id: Number(i.id),
        body: i.body,
        done: i.done_at != null,
        doneBy: i.done_by,
        doneAt: i.done_at,
      })),
      checklistAllowed: kindTakesChecklist(t.kind),
      comments: comments.rows.map((c) => ({ id: Number(c.id), author: c.author, body: c.body, at: c.at })),
      history: history.map(({ at, who, what, why }) => ({ at, who, what, why })),
    };
  });
}
