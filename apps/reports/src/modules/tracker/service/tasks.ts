import { TrackerError, assertIsoDate, one, type Actor, type Database, type Tx } from "./database";
import { requireProjectRole } from "./access";
import { childrenByParent, inSameLine, wouldLoop } from "./dependencies";

// Everything that changes a task goes through this file, so the status log, the change log and
// the completion dates are always written in the same transaction as the change itself.

export interface NewTask {
  projectId: number;
  title: string;
  description?: string | null;
  type?: "task" | "milestone";
  assigneePersonId?: number | null;
  rolePoolId?: number | null;
  priority?: number;
  /** One of the company-standard sizes. Its hours become the estimate. */
  effortBucketId?: number | null;
  /** Only for work too large for a bucket, such as one line per job and function. */
  effortEstimateHours?: number | null;
  remainingEffortHours?: number | null;
  plannedStartDate?: string | null;
  estimatedCompletionDate?: string | null;
  dueDate?: string | null;
  notBeforeDate?: string | null;
  notBeforeReason?: string | null;
  /** Optional: epic, feature, story, task, bug or issue. */
  kind?: string | null;
  /** The card this one sits under. It must be of a higher kind. */
  parentTaskId?: number | null;
  statusId?: number;
  sprintId?: number | null;
  jobNumber?: string | null;
  sectionCode?: string | null;
  functionCode?: string | null;
}

export interface TaskChanges {
  title?: string;
  description?: string | null;
  assigneePersonId?: number | null;
  rolePoolId?: number | null;
  priority?: number;
  effortBucketId?: number | null;
  effortEstimateHours?: number | null;
  remainingEffortHours?: number | null;
  plannedStartDate?: string | null;
  estimatedCompletionDate?: string | null;
  dueDate?: string | null;
  notBeforeDate?: string | null;
  notBeforeReason?: string | null;
  expectedUnblockDate?: string | null;
  sprintId?: number | null;
  /** Optional: epic, feature, story, task, bug or issue. Null clears it. */
  kind?: string | null;
  /** The card this one sits under, which must be of a higher kind. Null lifts it out. */
  parentTaskId?: number | null;
}

interface TaskRow {
  id: number;
  project_id: number;
  kind: string | null;
  parent_task_id: number | null;
  status_id: number;
  type: "task" | "milestone";
  assignee_person_id: number | null;
  role_pool_id: number | null;
  priority: number;
  effort_bucket_id: number | null;
  effort_estimate_hours: string | null;
  remaining_effort_hours: string | null;
  planned_start_date: string | null;
  estimated_completion_date: string | null;
  baseline_completion_date: string | null;
  due_date: string | null;
  not_before_date: string | null;
  expected_unblock_date: string | null;
  actual_completion_date: string | null;
  sprint_id: number | null;
  archived_at: unknown;
}

const TASK_COLUMNS = `id, project_id, kind, parent_task_id, status_id, type, assignee_person_id, role_pool_id, priority, effort_bucket_id,
  effort_estimate_hours::text, remaining_effort_hours::text, planned_start_date::text,
  estimated_completion_date::text, baseline_completion_date::text, due_date::text, not_before_date::text,
  expected_unblock_date::text, actual_completion_date::text, sprint_id, archived_at`;

async function lockTask(tx: Tx, taskId: number): Promise<TaskRow> {
  const row = await one<TaskRow>(
    tx,
    `SELECT ${TASK_COLUMNS} FROM tracker.task WHERE id = $1 FOR UPDATE`,
    [taskId],
    "Task",
  );
  if (row.archived_at) throw new TrackerError("invalid", "This task is archived.");
  return {
    ...row,
    id: Number(row.id),
    project_id: Number(row.project_id),
    status_id: Number(row.status_id),
    parent_task_id: row.parent_task_id == null ? null : Number(row.parent_task_id),
  };
}

// ── Kinds and what sits under what ──────────────────────────────────────────
// A card may sit only under a card of a higher kind. The database enforces the same rule
// (db/tracker/migrations/0003_work_kinds.sql); it is checked here first so a person gets a
// sentence they can act on instead of a constraint name.

interface Placed {
  label: string;
  level: number;
}

/** A kind's label and level. A card with no kind counts as the lowest level there is. */
async function placeOf(tx: Tx, kind: string | null): Promise<Placed> {
  const { rows } = await tx.query<{ label: string | null; level: number }>(
    `SELECT (SELECT label FROM tracker.work_kind WHERE key = $1::text) AS label, tracker.work_level($1::text) AS level`,
    [kind],
  );
  const row = rows[0]!;
  if (kind != null && row.label == null) throw new TrackerError("invalid", "That kind of card does not exist.");
  return { label: row.label ?? "card with no kind", level: Number(row.level) };
}

const withArticle = (label: string) => `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;

/** Checks that a card of `kind` may sit under `parentTaskId`, and returns the parent's key. */
async function checkParent(
  tx: Tx,
  projectId: number,
  taskId: number | null,
  own: Placed,
  parentTaskId: number,
): Promise<string> {
  if (parentTaskId === taskId) throw new TrackerError("invalid", "A card cannot sit under itself.");
  const { rows } = await tx.query<{ key: string; project_id: number; kind: string | null; archived: boolean }>(
    `SELECT p.key || '-' || t.number AS key, t.project_id, t.kind, (t.archived_at IS NOT NULL) AS archived
       FROM tracker.task t JOIN tracker.project p ON p.id = t.project_id WHERE t.id = $1`,
    [parentTaskId],
  );
  const parent = rows[0];
  if (!parent || Number(parent.project_id) !== projectId) {
    throw new TrackerError("invalid", "A card can sit only under a card in the same project.");
  }
  if (parent.archived) throw new TrackerError("invalid", `${parent.key} is archived.`);
  const above = await placeOf(tx, parent.kind);
  if (above.level >= own.level) {
    throw new TrackerError(
      "invalid",
      `${parent.key} is ${withArticle(above.label)}, and ${withArticle(own.label)} can sit only under something of a higher kind.`,
    );
  }
  return parent.key;
}

async function logTaskChange(
  tx: Tx,
  taskId: number,
  field: string,
  oldValue: unknown,
  newValue: unknown,
  actor: Actor,
  reason: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO tracker.task_change_log (task_id, field, old_value, new_value, changed_by, reason)
     VALUES ($1, $2::tracker.task_tracked_field, $3, $4, $5, $6)`,
    [
      taskId,
      field,
      oldValue == null ? null : String(oldValue),
      newValue == null ? null : String(newValue),
      actor.personId,
      reason,
    ],
  );
}

function assertHours(value: number | null | undefined, label: string): void {
  if (value == null) return;
  if (!Number.isFinite(value) || value < 0) throw new TrackerError("invalid", `${label} must be zero or more hours.`);
}

function assertPriority(value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new TrackerError("invalid", "Priority is a whole number from 1 (highest) to 5.");
  }
}

async function bucketHours(tx: Tx, bucketId: number): Promise<number> {
  const b = await one<{ hours: string }>(
    tx,
    `SELECT hours::text FROM tracker.effort_bucket WHERE id = $1 AND active`,
    [bucketId],
    "Estimate size",
  );
  return Number(b.hours);
}

/** Same number of hours, whatever text form the database returned them in. */
function sameHours(a: string | number | null, b: string | number | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Number(a) === Number(b);
}

/**
 * Creates a task. Its number comes from the project's counter, it starts in the project's first
 * "to do" column unless a status is given, and the first status-log row is written with it.
 * The first estimated completion date typed becomes the baseline that slip is measured against.
 */
export async function createTask(
  db: Database,
  actor: Actor,
  input: NewTask,
): Promise<{ id: number; number: number; key: string }> {
  if (!input.title.trim()) throw new TrackerError("invalid", "A task needs a title.");
  assertPriority(input.priority);
  assertHours(input.effortEstimateHours, "The estimate");
  assertHours(input.remainingEffortHours, "Remaining effort");
  assertIsoDate(input.plannedStartDate, "Planned start");
  assertIsoDate(input.estimatedCompletionDate, "Estimated completion");
  assertIsoDate(input.dueDate, "Due date");
  assertIsoDate(input.notBeforeDate, "Not-before date");
  if (input.notBeforeDate && !input.notBeforeReason?.trim()) {
    throw new TrackerError("invalid", "A not-before date needs a reason.");
  }
  const type = input.type ?? "task";

  return db.transaction(async (tx) => {
    await requireProjectRole(tx, input.projectId, actor, "contributor");
    // Locking the project row is what makes task numbers gap-free and unique under concurrency.
    const project = await one<{ key: string; next_task_number: number }>(
      tx,
      `SELECT key, next_task_number FROM tracker.project WHERE id = $1 FOR UPDATE`,
      [input.projectId],
      "Project",
    );
    const number = Number(project.next_task_number);
    await tx.query(`UPDATE tracker.project SET next_task_number = next_task_number + 1 WHERE id = $1`, [
      input.projectId,
    ]);

    let statusId = input.statusId;
    if (statusId === undefined) {
      const s = await one<{ id: number }>(
        tx,
        `SELECT id FROM tracker.workflow_status WHERE project_id = $1 AND category = 'todo' ORDER BY sort_order LIMIT 1`,
        [input.projectId],
        "A to-do status for this project",
      );
      statusId = Number(s.id);
    }

    const kind = input.kind || null;
    const own = await placeOf(tx, kind);
    if (input.parentTaskId != null) await checkParent(tx, input.projectId, null, own, input.parentTaskId);

    let estimate = input.effortEstimateHours ?? null;
    if (type === "milestone") {
      if ((estimate ?? 0) > 0 || (input.remainingEffortHours ?? 0) > 0 || input.effortBucketId) {
        throw new TrackerError("invalid", "A milestone carries no effort.");
      }
      estimate = null;
    } else if (input.effortBucketId != null) {
      estimate = await bucketHours(tx, input.effortBucketId);
    }

    const rank = await one<{ next: string }>(
      tx,
      `SELECT (coalesce(max(board_rank), 0) + 1)::text AS next FROM tracker.task WHERE project_id = $1 AND status_id = $2`,
      [input.projectId, statusId],
      "Board position",
    );

    const row = await one<{ id: number }>(
      tx,
      `INSERT INTO tracker.task
         (project_id, number, parent_task_id, type, title, description, assignee_person_id, role_pool_id,
          reporter_person_id, status_id, priority, effort_bucket_id, effort_estimate_hours, remaining_effort_hours,
          not_before_date, not_before_reason, planned_start_date, estimated_completion_date,
          baseline_completion_date, due_date, sprint_id, job_number, section_code, function_code, board_rank, kind)
       VALUES ($1, $2, $3, $4::tracker.task_type, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $17, $18, $18, $19, $20, $21, $22, $23, $24, $25)
       RETURNING id`,
      [
        input.projectId,
        number,
        input.parentTaskId ?? null,
        type,
        input.title.trim(),
        input.description ?? null,
        input.assigneePersonId ?? null,
        input.rolePoolId ?? null,
        actor.personId,
        statusId,
        input.priority ?? 3,
        type === "milestone" ? null : (input.effortBucketId ?? null),
        estimate,
        input.remainingEffortHours ?? null,
        input.notBeforeDate ?? null,
        input.notBeforeReason?.trim() || null,
        input.plannedStartDate ?? null,
        input.estimatedCompletionDate ?? null,
        input.dueDate ?? null,
        input.sprintId ?? null,
        input.jobNumber ?? null,
        input.sectionCode ?? null,
        input.functionCode ?? null,
        rank.next,
        kind,
      ],
      "Task",
    );
    const id = Number(row.id);
    await tx.query(
      `INSERT INTO tracker.status_log (task_id, from_status_id, to_status_id, changed_by) VALUES ($1, NULL, $2, $3)`,
      [id, statusId, actor.personId],
    );
    // A new open card under a finished parent reopens it.
    await settleParents(tx, input.projectId, input.parentTaskId ?? null, actor);
    return { id, number, key: `${project.key}-${number}` };
  });
}

/**
 * Changes a task's fields. Changes to dates, effort, assignee, pool, sprint and priority are
 * logged with who made them and an optional reason. Title and description are not logged.
 */
export async function updateTask(
  db: Database,
  actor: Actor,
  taskId: number,
  changes: TaskChanges,
  reason?: string | null,
): Promise<void> {
  assertPriority(changes.priority);
  assertHours(changes.effortEstimateHours, "The estimate");
  assertHours(changes.remainingEffortHours, "Remaining effort");
  assertIsoDate(changes.plannedStartDate, "Planned start");
  assertIsoDate(changes.estimatedCompletionDate, "Estimated completion");
  assertIsoDate(changes.dueDate, "Due date");
  assertIsoDate(changes.notBeforeDate, "Not-before date");
  assertIsoDate(changes.expectedUnblockDate, "Expected unblock date");
  if (changes.title !== undefined && !changes.title.trim()) throw new TrackerError("invalid", "A task needs a title.");

  await db.transaction(async (tx) => {
    const cur = await lockTask(tx, taskId);
    await requireProjectRole(tx, cur.project_id, actor, "contributor");
    const why = reason ?? null;
    const set: string[] = [];
    const params: unknown[] = [taskId];
    const assign = (column: string, value: unknown, cast = "") => {
      params.push(value);
      set.push(`${column} = $${params.length}${cast}`);
    };

    if (changes.title !== undefined) assign("title", changes.title.trim());
    if (changes.description !== undefined) assign("description", changes.description);

    // Kind and parent are checked together, against each other and against the cards underneath.
    const nextKind = changes.kind === undefined ? cur.kind : changes.kind || null;
    const nextParent = changes.parentTaskId === undefined ? cur.parent_task_id : changes.parentTaskId;
    if (nextKind !== cur.kind || nextParent !== cur.parent_task_id) {
      const own = await placeOf(tx, nextKind);
      const parentKey = nextParent == null ? null : await checkParent(tx, cur.project_id, taskId, own, nextParent);
      if (nextKind !== cur.kind) {
        const under = await tx.query<{ key: string; label: string | null }>(
          `SELECT p.key || '-' || c.number AS key, k.label
             FROM tracker.task c
             JOIN tracker.project p ON p.id = c.project_id
        LEFT JOIN tracker.work_kind k ON k.key = c.kind
            WHERE c.parent_task_id = $1 AND tracker.work_level(c.kind) <= $2
            ORDER BY c.number LIMIT 1`,
          [taskId, own.level],
        );
        const child = under.rows[0];
        if (child) {
          throw new TrackerError(
            "invalid",
            `${child.key} sits under this card and is ${withArticle(child.label ?? "card with no kind")}, so this card has to stay a higher kind than that.`,
          );
        }
        const before = await placeOf(tx, cur.kind);
        assign("kind", nextKind);
        await logTaskChange(
          tx,
          taskId,
          "kind",
          cur.kind == null ? null : before.label,
          nextKind == null ? null : own.label,
          actor,
          why,
        );
      }
      if (nextParent !== cur.parent_task_id) {
        const oldKey =
          cur.parent_task_id == null
            ? null
            : (
                await one<{ key: string }>(
                  tx,
                  `SELECT p.key || '-' || t.number AS key FROM tracker.task t JOIN tracker.project p ON p.id = t.project_id WHERE t.id = $1`,
                  [cur.parent_task_id],
                  "Parent card",
                )
              ).key;
        assign("parent_task_id", nextParent);
        await logTaskChange(tx, taskId, "parent", oldKey, parentKey, actor, why);
      }
    }

    // A bucket sets the estimate; a typed estimate clears the bucket.
    let newEstimate: number | null | undefined;
    if (changes.effortBucketId !== undefined && changes.effortBucketId !== null) {
      newEstimate = await bucketHours(tx, changes.effortBucketId);
      assign("effort_bucket_id", changes.effortBucketId);
    } else if (changes.effortEstimateHours !== undefined) {
      newEstimate = changes.effortEstimateHours;
      assign("effort_bucket_id", null);
    } else if (changes.effortBucketId === null) {
      assign("effort_bucket_id", null);
    }
    if (newEstimate !== undefined && !sameHours(cur.effort_estimate_hours, newEstimate)) {
      if (cur.type === "milestone" && (newEstimate ?? 0) > 0)
        throw new TrackerError("invalid", "A milestone carries no effort.");
      assign("effort_estimate_hours", newEstimate);
      await logTaskChange(tx, taskId, "effort_estimate_hours", cur.effort_estimate_hours, newEstimate, actor, why);
    }

    if (
      changes.remainingEffortHours !== undefined &&
      !sameHours(cur.remaining_effort_hours, changes.remainingEffortHours)
    ) {
      if (cur.type === "milestone" && (changes.remainingEffortHours ?? 0) > 0) {
        throw new TrackerError("invalid", "A milestone carries no effort.");
      }
      assign("remaining_effort_hours", changes.remainingEffortHours);
      await logTaskChange(
        tx,
        taskId,
        "remaining_effort_hours",
        cur.remaining_effort_hours,
        changes.remainingEffortHours,
        actor,
        why,
      );
    }

    const tracked: [keyof TaskChanges, keyof TaskRow, string, string, string][] = [
      ["assigneePersonId", "assignee_person_id", "assignee_person_id", "assignee", ""],
      ["rolePoolId", "role_pool_id", "role_pool_id", "role_pool", ""],
      ["priority", "priority", "priority", "priority", ""],
      ["sprintId", "sprint_id", "sprint_id", "sprint", ""],
      ["plannedStartDate", "planned_start_date", "planned_start_date", "planned_start_date", "::date"],
      [
        "estimatedCompletionDate",
        "estimated_completion_date",
        "estimated_completion_date",
        "estimated_completion_date",
        "::date",
      ],
      ["dueDate", "due_date", "due_date", "due_date", "::date"],
      ["expectedUnblockDate", "expected_unblock_date", "expected_unblock_date", "expected_unblock_date", "::date"],
    ];
    for (const [key, curKey, column, field, cast] of tracked) {
      const next = changes[key];
      if (next === undefined) continue;
      const before = cur[curKey] as string | number | null;
      const same = before == null || next == null ? before == null && next == null : String(before) === String(next);
      if (same) continue;
      assign(column, next, cast);
      await logTaskChange(tx, taskId, field, before, next, actor, why);
    }

    // The first estimated completion date ever typed is the baseline, and it is never replaced.
    if (changes.estimatedCompletionDate && cur.baseline_completion_date == null) {
      assign("baseline_completion_date", changes.estimatedCompletionDate, "::date");
    }

    if (changes.notBeforeDate !== undefined && changes.notBeforeDate !== cur.not_before_date) {
      if (changes.notBeforeDate && !(changes.notBeforeReason ?? "").trim()) {
        throw new TrackerError("invalid", "A not-before date needs a reason.");
      }
      assign("not_before_date", changes.notBeforeDate, "::date");
      assign("not_before_reason", changes.notBeforeDate ? (changes.notBeforeReason as string).trim() : null);
      await logTaskChange(
        tx,
        taskId,
        "not_before_date",
        cur.not_before_date,
        changes.notBeforeDate,
        actor,
        why ?? (changes.notBeforeDate ? (changes.notBeforeReason as string).trim() : null),
      );
    }

    if (set.length) await tx.query(`UPDATE tracker.task SET ${set.join(", ")} WHERE id = $1`, params);

    // Moving a card changes what sits under two parents: the one it left and the one it joined.
    if (nextParent !== cur.parent_task_id) {
      await settleParents(tx, cur.project_id, cur.parent_task_id, actor);
      await settleParents(tx, cur.project_id, nextParent, actor);
    }
  });
}

/** "I checked, the remaining effort is still right": refreshes its date without changing it. */
export async function confirmRemainingEffort(db: Database, actor: Actor, taskId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const cur = await lockTask(tx, taskId);
    await requireProjectRole(tx, cur.project_id, actor, "contributor");
    await tx.query(`UPDATE tracker.task SET remaining_effort_updated_at = now() WHERE id = $1`, [taskId]);
  });
}

/**
 * Moves a task to another status (a drag on the board). In one transaction it writes the
 * status-log row, sets the actual completion date on entering a done status and clears it on
 * leaving one, and requires a reason for a blocked status.
 *
 * Closing a card that has open cards under it needs `closeUnder`. Without it nothing changes
 * and the result lists those cards (`moved: false`), so the screen can ask what to do with them.
 * After any move, the cards above are brought into line: see settleParents.
 */
export async function changeStatus(
  db: Database,
  actor: Actor,
  taskId: number,
  toStatusId: number,
  options: {
    note?: string | null;
    blockedReason?: string | null;
    expectedUnblockDate?: string | null;
    /**
     * What to do with open cards under this one when it is being closed: mark them done too, or
     * cancel them. Left out, a card with open cards under it is not moved; see the return value.
     */
    closeUnder?: "done" | "cancelled";
  } = {},
): Promise<{ moved: boolean; openUnder: OpenCard[] }> {
  assertIsoDate(options.expectedUnblockDate, "Expected unblock date");
  return db.transaction(async (tx) => {
    const cur = await lockTask(tx, taskId);
    await requireProjectRole(tx, cur.project_id, actor, "contributor");
    if (cur.status_id === toStatusId) return { moved: false, openUnder: [] };

    const statuses = await tx.query<{ id: number; project_id: number; category: string }>(
      `SELECT id, project_id, category FROM tracker.workflow_status WHERE id = ANY(ARRAY[$1::bigint, $2::bigint])`,
      [cur.status_id, toStatusId],
    );
    const from = statuses.rows.find((s) => Number(s.id) === cur.status_id);
    const to = statuses.rows.find((s) => Number(s.id) === toStatusId);
    if (!to || Number(to.project_id) !== cur.project_id) {
      throw new TrackerError("invalid", "That status belongs to a different project.");
    }
    const blockedReason = options.blockedReason?.trim() || null;
    if (to.category === "blocked" && !blockedReason) {
      throw new TrackerError("invalid", "Say what is blocking this task.");
    }

    // Closing a card that still has open cards under it is never done silently. Without an
    // answer the move is not made and the open cards are handed back, so the screen can ask.
    if (to.category === "done" || to.category === "cancelled") {
      const open = await openCardsUnder(tx, taskId);
      if (open.length) {
        if (!options.closeUnder) {
          return {
            moved: false,
            openUnder: open.map((c) => ({
              id: c.id,
              key: c.key,
              title: c.title,
              kindLabel: c.kindLabel,
              statusName: c.statusName,
            })),
          };
        }
        const target = await firstStatus(tx, cur.project_id, [options.closeUnder]);
        if (!target) throw new TrackerError("invalid", `This project has no ${options.closeUnder} status.`);
        const { key } = await taskKey(tx, taskId);
        for (const card of open) {
          await applyStatus(tx, cur.project_id, card.id, card.statusId, target, actor, `Closed with ${key}`);
        }
      }
    }

    await applyStatus(
      tx,
      cur.project_id,
      taskId,
      from ? cur.status_id : null,
      { id: toStatusId, category: to.category },
      actor,
      options.note ?? blockedReason,
      to.category === "blocked" ? { reason: blockedReason, unblock: options.expectedUnblockDate ?? null } : undefined,
    );
    await settleParents(tx, cur.project_id, cur.parent_task_id, actor);
    return { moved: true, openUnder: [] };
  });
}

// ── Parents follow the cards under them ─────────────────────────────────────
// A card with cards under it is finished when they are. So it is moved to done when the last
// open card under it closes, and moved back when a card under it is open again. Both are
// ordinary status changes, written to the status log by whoever made the change that caused them.

/** A card under a parent that is neither done nor cancelled. */
export interface OpenCard {
  id: number;
  key: string;
  title: string;
  kindLabel: string | null;
  statusName: string;
}

interface StatusRef {
  id: number;
  category: string;
}

async function firstStatus(tx: Tx, projectId: number, categories: string[]): Promise<StatusRef | null> {
  const { rows } = await tx.query<{ id: number; category: string }>(
    `SELECT id, category FROM tracker.workflow_status
      WHERE project_id = $1 AND category::text = ANY($2::text[])
      ORDER BY array_position($2::text[], category::text), sort_order, id LIMIT 1`,
    [projectId, categories],
  );
  return rows[0] ? { id: Number(rows[0].id), category: rows[0].category } : null;
}

/** Every unarchived card under a card, at any depth, that is still open. */
async function openCardsUnder(tx: Tx, taskId: number): Promise<(OpenCard & { statusId: number })[]> {
  const { rows } = await tx.query<{
    id: number;
    key: string;
    title: string;
    kind_label: string | null;
    status_name: string;
    status_id: number;
  }>(
    `WITH RECURSIVE under(id) AS (
         SELECT c.id FROM tracker.task c WHERE c.parent_task_id = $1 AND c.archived_at IS NULL
       UNION ALL
         SELECT c.id FROM tracker.task c JOIN under u ON c.parent_task_id = u.id WHERE c.archived_at IS NULL
     )
     SELECT t.id, p.key || '-' || t.number AS key, t.title, k.label AS kind_label, s.name AS status_name, t.status_id
       FROM under
       JOIN tracker.task t ON t.id = under.id
       JOIN tracker.project p ON p.id = t.project_id
       JOIN tracker.workflow_status s ON s.id = t.status_id
  LEFT JOIN tracker.work_kind k ON k.key = t.kind
      WHERE s.category NOT IN ('done', 'cancelled')
      ORDER BY t.number`,
    [taskId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    key: r.key,
    title: r.title,
    kindLabel: r.kind_label,
    statusName: r.status_name,
    statusId: Number(r.status_id),
  }));
}

/** The one place a card's status is written: the row, its board position, its dates and the log. */
async function applyStatus(
  tx: Tx,
  projectId: number,
  taskId: number,
  fromStatusId: number | null,
  to: StatusRef,
  actor: Actor,
  note: string | null,
  blocked?: { reason: string | null; unblock: string | null },
): Promise<void> {
  const rank = await one<{ next: string }>(
    tx,
    `SELECT (coalesce(max(board_rank), 0) + 1)::text AS next FROM tracker.task WHERE project_id = $1 AND status_id = $2`,
    [projectId, to.id],
    "Board position",
  );
  await tx.query(
    `UPDATE tracker.task
        SET status_id = $2,
            board_rank = $3::numeric,
            actual_completion_date = CASE WHEN $4 THEN coalesce(actual_completion_date, CURRENT_DATE) ELSE NULL END,
            blocked_reason = $5,
            expected_unblock_date = $6::date
      WHERE id = $1`,
    [taskId, to.id, rank.next, to.category === "done", blocked?.reason ?? null, blocked?.unblock ?? null],
  );
  await tx.query(
    `INSERT INTO tracker.status_log (task_id, from_status_id, to_status_id, changed_by, note) VALUES ($1, $2, $3, $4, $5)`,
    [taskId, fromStatusId, to.id, actor.personId, note],
  );
}

/**
 * Brings a parent into line with the cards under it, then its own parent, and so on up. Called
 * after anything that can change the answer: a status change, a new card, a card moved under
 * something else or lifted out, a card archived. A cancelled parent is left alone, and so is a
 * parent whose cards were all cancelled: nothing was finished, so it is not "done".
 */
async function settleParents(tx: Tx, projectId: number, parentId: number | null, actor: Actor): Promise<void> {
  let id = parentId;
  while (id != null) {
    const { rows } = await tx.query<{
      status_id: number;
      category: string;
      parent_task_id: number | null;
      archived: boolean;
      open: number;
      done: number;
    }>(
      `SELECT t.status_id, s.category, t.parent_task_id, (t.archived_at IS NOT NULL) AS archived,
              (SELECT count(*) FROM tracker.task c JOIN tracker.workflow_status cs ON cs.id = c.status_id
                WHERE c.parent_task_id = t.id AND c.archived_at IS NULL
                  AND cs.category NOT IN ('done', 'cancelled'))::int AS open,
              (SELECT count(*) FROM tracker.task c JOIN tracker.workflow_status cs ON cs.id = c.status_id
                WHERE c.parent_task_id = t.id AND c.archived_at IS NULL AND cs.category = 'done')::int AS done
         FROM tracker.task t JOIN tracker.workflow_status s ON s.id = t.status_id
        WHERE t.id = $1 FOR UPDATE OF t`,
      [id],
    );
    const p = rows[0];
    if (!p || p.archived) return;
    const isOpen = p.category !== "done" && p.category !== "cancelled";
    let to: StatusRef | null = null;
    let note = "";
    if (isOpen && Number(p.open) === 0 && Number(p.done) > 0) {
      to = await firstStatus(tx, projectId, ["done"]);
      note = "Everything under it is finished";
    } else if (p.category === "done" && Number(p.open) > 0) {
      to = await firstStatus(tx, projectId, ["in_progress", "todo"]);
      note = "Work under it is open again";
    }
    if (!to) return;
    await applyStatus(tx, projectId, id, Number(p.status_id), to, actor, note);
    id = p.parent_task_id == null ? null : Number(p.parent_task_id);
  }
}

async function taskKey(tx: Tx, taskId: number): Promise<{ key: string; projectId: number }> {
  const r = await one<{ key: string; project_id: number }>(
    tx,
    `SELECT p.key || '-' || t.number AS key, t.project_id FROM tracker.task t JOIN tracker.project p ON p.id = t.project_id WHERE t.id = $1`,
    [taskId],
    "Task",
  );
  return { key: r.key, projectId: Number(r.project_id) };
}

/**
 * Makes `successorId` wait for `predecessorId` to finish, plus optional lag in calendar days.
 * Refuses a link that would create a loop. Logged on the waiting task.
 */
export async function addDependency(
  db: Database,
  actor: Actor,
  predecessorId: number,
  successorId: number,
  lagDays = 0,
  reason?: string | null,
): Promise<void> {
  if (predecessorId === successorId) throw new TrackerError("invalid", "A task cannot depend on itself.");
  if (!Number.isInteger(lagDays) || lagDays < 0)
    throw new TrackerError("invalid", "Lag is a whole number of days, zero or more.");
  await db.transaction(async (tx) => {
    const successor = await taskKey(tx, successorId);
    const predecessor = await taskKey(tx, predecessorId);
    await requireProjectRole(tx, successor.projectId, actor, "contributor");

    // A link stands for the work cards under each end, so both checks look through the hierarchy.
    const placed = await tx.query<{ id: number; parent_task_id: number }>(
      `SELECT id, parent_task_id FROM tracker.task WHERE archived_at IS NULL AND parent_task_id IS NOT NULL`,
    );
    const children = childrenByParent(
      placed.rows.map((r) => ({ id: Number(r.id), parentId: Number(r.parent_task_id) })),
    );
    if (inSameLine(predecessorId, successorId, children)) {
      throw new TrackerError(
        "invalid",
        `${successor.key} and ${predecessor.key} sit one under the other, so one cannot wait on the other.`,
      );
    }
    const existing = await tx.query<{ predecessor_task_id: number; successor_task_id: number; lag_days: number }>(
      `SELECT predecessor_task_id, successor_task_id, lag_days FROM tracker.task_dependency`,
    );
    const loop = wouldLoop(
      existing.rows.map((d) => ({
        predecessorId: Number(d.predecessor_task_id),
        successorId: Number(d.successor_task_id),
        lagDays: Number(d.lag_days),
      })),
      { predecessorId, successorId, lagDays },
      children,
    );
    if (loop) {
      throw new TrackerError(
        "invalid",
        `${predecessor.key} already waits on ${successor.key}, directly or through the cards under them, so this would create a loop.`,
      );
    }
    const inserted = await tx.query(
      `INSERT INTO tracker.task_dependency (predecessor_task_id, successor_task_id, lag_days) VALUES ($1, $2, $3)
       ON CONFLICT (predecessor_task_id, successor_task_id) DO NOTHING RETURNING 1`,
      [predecessorId, successorId, lagDays],
    );
    if (!inserted.rows.length)
      throw new TrackerError("conflict", `${successor.key} already waits on ${predecessor.key}.`);
    await logTaskChange(
      tx,
      successorId,
      "dependency",
      null,
      `waits on ${predecessor.key}${lagDays ? ` (+${lagDays} days)` : ""}`,
      actor,
      reason ?? null,
    );
  });
}

export async function removeDependency(
  db: Database,
  actor: Actor,
  predecessorId: number,
  successorId: number,
  reason?: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const successor = await taskKey(tx, successorId);
    const predecessor = await taskKey(tx, predecessorId);
    await requireProjectRole(tx, successor.projectId, actor, "contributor");
    const removed = await tx.query(
      `DELETE FROM tracker.task_dependency WHERE predecessor_task_id = $1 AND successor_task_id = $2 RETURNING 1`,
      [predecessorId, successorId],
    );
    if (!removed.rows.length)
      throw new TrackerError("not_found", `${successor.key} does not wait on ${predecessor.key}.`);
    await logTaskChange(tx, successorId, "dependency", `waits on ${predecessor.key}`, null, actor, reason ?? null);
  });
}

/** Adds a comment to a task. Anyone who can change the project's tasks can comment. */
export async function addComment(db: Database, actor: Actor, taskId: number, body: string): Promise<number> {
  const text = body.trim();
  if (!text) throw new TrackerError("invalid", "A comment cannot be empty.");
  if (text.length > 10_000) throw new TrackerError("invalid", "That comment is too long (10,000 characters at most).");
  return db.transaction(async (tx) => {
    const cur = await lockTask(tx, taskId);
    await requireProjectRole(tx, cur.project_id, actor, "contributor");
    const row = await one<{ id: number }>(
      tx,
      `INSERT INTO tracker.task_comment (task_id, author_person_id, body) VALUES ($1, $2, $3) RETURNING id`,
      [taskId, actor.personId, text],
      "Comment",
    );
    return Number(row.id);
  });
}

/** Tasks are archived, never deleted, so their history stays intact. */
export async function archiveTask(db: Database, actor: Actor, taskId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const cur = await lockTask(tx, taskId);
    await requireProjectRole(tx, cur.project_id, actor, "manager");
    await tx.query(`UPDATE tracker.task SET archived_at = now() WHERE id = $1`, [taskId]);
    await settleParents(tx, cur.project_id, cur.parent_task_id, actor);
  });
}
