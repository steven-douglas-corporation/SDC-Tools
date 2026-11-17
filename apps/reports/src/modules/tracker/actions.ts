"use server";

import { revalidatePath } from "next/cache";
import { assertActionPermission } from "@/lib/require-permission";
import { trackerDb, trackerEngineDb } from "./db";
import { trackerActor } from "./current-actor";
import { TrackerError, type Actor } from "./service/database";
import {
  createProject,
  moveProjectRank,
  rankClash,
  setProjectMember,
  updateProject,
  type ProjectState,
  type RankClash,
} from "./service/projects";
import {
  addComment,
  addDependency,
  changeStatus,
  clearOwnHours,
  confirmRemainingEffort,
  createTask,
  removeDependency,
  updateTask,
  type OpenCard,
  type TaskChanges,
} from "./service/tasks";
import { addHoliday, addTimeOff, removeHoliday, removeTimeOff, setGlobalHours, setPersonHours } from "./service/people";
import {
  addChecklistItem,
  moveChecklistItem,
  removeChecklistItem,
  renameChecklistItem,
  setChecklistItemDone,
} from "./service/checklist";
import { runForecast } from "./service/forecast";

// The tracker screens' way in (docs/MODULES.md: "two doors, one room"). Each action checks the
// app permission, works out who is acting, and calls one service function. No business rule
// lives here: the service decides what is allowed on a project and does the logging.
//
// A refusal the user should read comes back as { ok: false, error }. Anything else is a bug and
// is left to throw.

export type ActionResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

/** Today on the server's calendar, not UTC: late in the evening UTC is already tomorrow. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Recomputes the stored forecast after a change, so the dates on screen are never older than
 * the last edit. This is the quick single schedule (milliseconds), never the simulation, which
 * runs only from scripts/tracker/run-forecast.ts. A failure here must not undo the change the
 * person just made, so it is reported to the server log and the screen shows the last forecast.
 */
async function reforecast(): Promise<void> {
  if (!process.env.TRACKER_ENGINE_DATABASE_URL?.trim()) return;
  try {
    await runForecast(trackerEngineDb, { asOf: today(), triggeredBy: "change" });
  } catch (e) {
    console.error("[tracker] forecast after a change failed:", e instanceof Error ? e.message : e);
  }
}

async function act<T extends object>(
  work: (actor: Actor) => Promise<T>,
  options: {
    paths: string[];
    forecast?: boolean;
    /** True when nothing was changed after all. */ unless?: () => boolean;
  },
): Promise<ActionResult<T>> {
  const session = await assertActionPermission("tracker:edit");
  let result: T;
  try {
    result = await work(await trackerActor(session));
  } catch (e) {
    if (e instanceof TrackerError) return { ok: false, error: e.message };
    throw e;
  }
  if (options.unless?.()) return { ok: true, ...result };
  if (options.forecast !== false) await reforecast();
  for (const p of options.paths) revalidatePath(p);
  return { ok: true, ...result };
}

const boardPath = (projectKey: string) => `/tracker/${projectKey.toUpperCase()}`;

export async function createProjectAction(input: {
  key: string;
  name: string;
  targetDate?: string | null;
}): Promise<ActionResult<{ key: string }>> {
  return act(
    async (actor) => {
      const p = await createProject(trackerDb, actor, {
        key: input.key,
        name: input.name,
        targetDate: input.targetDate || null,
      });
      return { key: p.key };
    },
    { paths: ["/tracker"], forecast: false },
  );
}

/**
 * Sets one project's stack rank. Only the portfolio owner (in this app: ELT) may.
 *
 * A rank another project holds is not taken silently: unless `replace` is set, nothing changes
 * and `clash` says who holds it and what would move, so the screen can ask first. With
 * `replace`, the project goes there and the others shift one place, so ranks never clash.
 */
export async function setProjectRankAction(
  projectId: number,
  rank: number | null,
  replace = false,
): Promise<ActionResult<{ clash: RankClash | null }>> {
  let changed = false;
  return act(
    async (actor) => {
      if (rank !== null && !replace && Number.isInteger(rank) && rank >= 1) {
        const clash = await rankClash(trackerDb, actor, projectId, rank);
        if (clash) return { clash };
      }
      await moveProjectRank(trackerDb, actor, projectId, rank);
      changed = true;
      return { clash: null };
    },
    // Asking the question changes nothing, so there is nothing to recompute or redraw.
    { paths: ["/tracker", "/tracker/timeline"], unless: () => !changed },
  );
}

/** Moves a project one place up or down the stack rank, swapping it with its neighbour. */
export async function moveProjectRankAction(projectId: number, direction: "up" | "down"): Promise<ActionResult> {
  return act(
    async (actor) => {
      await moveProjectRank(trackerDb, actor, projectId, direction === "up" ? "up" : "down");
      return {};
    },
    { paths: ["/tracker", "/tracker/timeline"] },
  );
}

export async function setProjectStateAction(
  projectId: number,
  projectKey: string,
  state: ProjectState,
): Promise<ActionResult> {
  return act(
    async (actor) => {
      await updateProject(trackerDb, actor, projectId, { state });
      return {};
    },
    { paths: ["/tracker", boardPath(projectKey)] },
  );
}

export async function createTaskAction(input: {
  projectId: number;
  projectKey: string;
  title: string;
  type: "task" | "milestone";
  kind?: string | null;
  effortBucketId: number | null;
  assigneePersonId: number | null;
  dueDate: string | null;
  description?: string | null;
  parentTaskId?: number | null;
  /** Left out or null: the person making the card. */
  requestedByPersonId?: number | null;
  priority?: number;
}): Promise<ActionResult<{ key: string }>> {
  return act(
    async (actor) => {
      const t = await createTask(trackerDb, actor, {
        projectId: input.projectId,
        title: input.title,
        type: input.type,
        kind: input.kind || (input.type === "milestone" ? "milestone" : "task"),
        effortBucketId: input.type === "milestone" || input.kind === "milestone" ? null : input.effortBucketId,
        assigneePersonId: input.assigneePersonId,
        dueDate: input.dueDate || null,
        description: input.description?.trim() || null,
        parentTaskId: input.parentTaskId ?? null,
        requestedByPersonId: input.requestedByPersonId ?? undefined,
        priority: input.priority,
      });
      return { key: t.key };
    },
    { paths: ["/tracker", boardPath(input.projectKey)] },
  );
}

export async function moveTaskAction(input: {
  taskId: number;
  projectKey: string;
  toStatusId: number;
  blockedReason?: string | null;
  expectedUnblockDate?: string | null;
  /** The answer to "this card still has open cards under it": finish them too, or cancel them. */
  closeUnder?: "done" | "cancelled";
}): Promise<ActionResult<{ openUnder: OpenCard[] }>> {
  return act(
    async (actor) => {
      // When openUnder comes back non-empty nothing was moved: the screen asks, then calls again.
      const result = await changeStatus(trackerDb, actor, input.taskId, input.toStatusId, {
        blockedReason: input.blockedReason,
        expectedUnblockDate: input.expectedUnblockDate || null,
        closeUnder: input.closeUnder === "done" || input.closeUnder === "cancelled" ? input.closeUnder : undefined,
      });
      return { openUnder: result.openUnder };
    },
    { paths: ["/tracker", boardPath(input.projectKey)] },
  );
}

/** The fields the board lets a person change on a task. */
export type TaskEdit = Pick<
  TaskChanges,
  | "title"
  | "description"
  | "assigneePersonId"
  | "requestedByPersonId"
  | "priority"
  | "effortBucketId"
  | "remainingEffortHours"
  | "dueDate"
  | "estimatedCompletionDate"
  | "kind"
  | "parentTaskId"
>;

export async function updateTaskAction(input: {
  taskId: number;
  projectKey: string;
  changes: TaskEdit;
  reason?: string | null;
}): Promise<ActionResult> {
  return act(
    async (actor) => {
      // Spelled out field by field: nothing a browser sends reaches the service unless it is
      // one of the fields this screen is meant to change.
      const c = input.changes;
      const changes: TaskChanges = {};
      if (c.title !== undefined) changes.title = c.title;
      if (c.description !== undefined) changes.description = c.description?.trim() || null;
      if (c.assigneePersonId !== undefined) changes.assigneePersonId = c.assigneePersonId;
      if (c.requestedByPersonId !== undefined) changes.requestedByPersonId = Number(c.requestedByPersonId);
      if (c.priority !== undefined) changes.priority = c.priority;
      if (c.effortBucketId !== undefined) changes.effortBucketId = c.effortBucketId;
      if (c.remainingEffortHours !== undefined) changes.remainingEffortHours = c.remainingEffortHours;
      if (c.dueDate !== undefined) changes.dueDate = c.dueDate || null;
      if (c.estimatedCompletionDate !== undefined) changes.estimatedCompletionDate = c.estimatedCompletionDate || null;
      if (c.kind !== undefined) changes.kind = c.kind || "task";
      if (c.parentTaskId !== undefined) changes.parentTaskId = c.parentTaskId;
      await updateTask(trackerDb, actor, input.taskId, changes, input.reason);
      return {};
    },
    { paths: ["/tracker", boardPath(input.projectKey)] },
  );
}

const taskPath = (taskKey: string) => {
  const cut = taskKey.lastIndexOf("-");
  return `/tracker/${taskKey.slice(0, cut).toUpperCase()}/${taskKey.slice(cut + 1)}`;
};

/** Gives a person a role on a project, changes it, or (role null) removes them. Managers only. */
export async function setMemberAction(input: {
  projectId: number;
  projectKey: string;
  personId: number;
  role: "viewer" | "contributor" | "manager" | null;
}): Promise<ActionResult> {
  return act(
    async (actor) => {
      await setProjectMember(trackerDb, actor, input.projectId, input.personId, input.role);
      return {};
    },
    { paths: ["/tracker", boardPath(input.projectKey)], forecast: false },
  );
}

/** Makes one task wait for another to finish. */
export async function addDependencyAction(input: {
  taskKey: string;
  projectKey: string;
  predecessorId: number;
  successorId: number;
  lagDays?: number;
}): Promise<ActionResult> {
  return act(
    async (actor) => {
      await addDependency(trackerDb, actor, input.predecessorId, input.successorId, input.lagDays ?? 0);
      return {};
    },
    { paths: [boardPath(input.projectKey), taskPath(input.taskKey)] },
  );
}

export async function removeDependencyAction(input: {
  taskKey: string;
  projectKey: string;
  predecessorId: number;
  successorId: number;
}): Promise<ActionResult> {
  return act(
    async (actor) => {
      await removeDependency(trackerDb, actor, input.predecessorId, input.successorId);
      return {};
    },
    { paths: [boardPath(input.projectKey), taskPath(input.taskKey)] },
  );
}

export async function addCommentAction(input: {
  taskId: number;
  taskKey: string;
  body: string;
}): Promise<ActionResult> {
  return act(
    async (actor) => {
      await addComment(trackerDb, actor, input.taskId, input.body);
      return {};
    },
    { paths: [taskPath(input.taskKey)], forecast: false },
  );
}

// ── Checklist ───────────────────────────────────────────────────────────────
// A checklist never changes the forecast, so none of these rerun it. The board is refreshed as
// well as the card, because the card's face on the board shows how many items are ticked.

export type ChecklistChange =
  | { do: "add"; body: string }
  | { do: "tick"; itemId: number; done: boolean }
  | { do: "rename"; itemId: number; body: string }
  | { do: "remove"; itemId: number }
  | { do: "move"; itemId: number; direction: "up" | "down" };

export async function checklistAction(input: {
  taskId: number;
  taskKey: string;
  projectKey: string;
  change: ChecklistChange;
}): Promise<ActionResult> {
  const c = input.change;
  return act(
    async (actor) => {
      if (c.do === "add") await addChecklistItem(trackerDb, actor, input.taskId, c.body);
      else if (c.do === "tick") await setChecklistItemDone(trackerDb, actor, c.itemId, c.done);
      else if (c.do === "rename") await renameChecklistItem(trackerDb, actor, c.itemId, c.body);
      else if (c.do === "remove") await removeChecklistItem(trackerDb, actor, c.itemId);
      else await moveChecklistItem(trackerDb, actor, c.itemId, c.direction);
      return {};
    },
    { paths: [boardPath(input.projectKey), taskPath(input.taskKey)], forecast: false },
  );
}

// ── Capacity, time off and holidays ─────────────────────────────────────────
// All of these change how much work fits in a day, so each one re-runs the forecast.

export async function setGlobalHoursAction(hoursPerDay: number): Promise<ActionResult> {
  return act(
    async (actor) => {
      await setGlobalHours(trackerDb, actor, hoursPerDay);
      return {};
    },
    { paths: ["/tracker", "/tracker/people"] },
  );
}

export async function setPersonHoursAction(personId: number, hoursPerDay: number | null): Promise<ActionResult> {
  return act(
    async (actor) => {
      await setPersonHours(trackerDb, actor, personId, hoursPerDay);
      return {};
    },
    { paths: ["/tracker", "/tracker/people"] },
  );
}

export async function addTimeOffAction(input: {
  personId: number;
  start: string;
  end: string;
  dayPortion?: number;
  note?: string | null;
}): Promise<ActionResult> {
  return act(
    async (actor) => {
      await addTimeOff(trackerDb, actor, input);
      return {};
    },
    { paths: ["/tracker", "/tracker/people"] },
  );
}

export async function removeTimeOffAction(timeOffId: number): Promise<ActionResult> {
  return act(
    async (actor) => {
      await removeTimeOff(trackerDb, actor, timeOffId);
      return {};
    },
    { paths: ["/tracker", "/tracker/people"] },
  );
}

export async function addHolidayAction(input: { date: string; name: string }): Promise<ActionResult> {
  return act(
    async (actor) => {
      await addHoliday(trackerDb, actor, input);
      return {};
    },
    { paths: ["/tracker", "/tracker/people"] },
  );
}

export async function removeHolidayAction(date: string): Promise<ActionResult> {
  return act(
    async (actor) => {
      await removeHoliday(trackerDb, actor, date);
      return {};
    },
    { paths: ["/tracker", "/tracker/people"] },
  );
}

/** Clears the size and hours left on a card that has cards under it, where the forecast ignores them. */
export async function clearOwnHoursAction(taskId: number, projectKey: string): Promise<ActionResult> {
  return act(
    async (actor) => {
      await clearOwnHours(trackerDb, actor, taskId);
      return {};
    },
    { paths: ["/tracker", boardPath(projectKey)] },
  );
}

/** "Still right": refreshes the date on remaining effort without changing the number. */
export async function confirmRemainingAction(taskId: number, projectKey: string): Promise<ActionResult> {
  return act(
    async (actor) => {
      await confirmRemainingEffort(trackerDb, actor, taskId);
      return {};
    },
    { paths: ["/tracker", boardPath(projectKey)], forecast: false },
  );
}
