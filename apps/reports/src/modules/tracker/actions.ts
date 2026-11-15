"use server";

import { revalidatePath } from "next/cache";
import { assertActionPermission } from "@/lib/require-permission";
import { trackerDb, trackerEngineDb } from "./db";
import { trackerActor } from "./current-actor";
import { TrackerError, type Actor } from "./service/database";
import { createProject, setPortfolioRanks, updateProject, type ProjectState } from "./service/projects";
import { changeStatus, confirmRemainingEffort, createTask, updateTask, type TaskChanges } from "./service/tasks";
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
  options: { paths: string[]; forecast?: boolean },
): Promise<ActionResult<T>> {
  const session = await assertActionPermission("tracker:edit");
  let result: T;
  try {
    result = await work(await trackerActor(session));
  } catch (e) {
    if (e instanceof TrackerError) return { ok: false, error: e.message };
    throw e;
  }
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

/** Sets one project's stack rank. Only the portfolio owner (in this app: ELT) may. */
export async function setProjectRankAction(projectId: number, rank: number | null): Promise<ActionResult> {
  return act(
    async (actor) => {
      await setPortfolioRanks(trackerDb, actor, [{ projectId, rank }]);
      return {};
    },
    { paths: ["/tracker"] },
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
  effortBucketId: number | null;
  assigneePersonId: number | null;
  dueDate: string | null;
}): Promise<ActionResult<{ key: string }>> {
  return act(
    async (actor) => {
      const t = await createTask(trackerDb, actor, {
        projectId: input.projectId,
        title: input.title,
        type: input.type,
        effortBucketId: input.type === "milestone" ? null : input.effortBucketId,
        assigneePersonId: input.assigneePersonId,
        dueDate: input.dueDate || null,
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
}): Promise<ActionResult> {
  return act(
    async (actor) => {
      await changeStatus(trackerDb, actor, input.taskId, input.toStatusId, {
        blockedReason: input.blockedReason,
        expectedUnblockDate: input.expectedUnblockDate || null,
      });
      return {};
    },
    { paths: ["/tracker", boardPath(input.projectKey)] },
  );
}

/** The fields the board lets a person change on a task. */
export type TaskEdit = Pick<
  TaskChanges,
  | "title"
  | "assigneePersonId"
  | "priority"
  | "effortBucketId"
  | "remainingEffortHours"
  | "dueDate"
  | "estimatedCompletionDate"
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
      if (c.assigneePersonId !== undefined) changes.assigneePersonId = c.assigneePersonId;
      if (c.priority !== undefined) changes.priority = c.priority;
      if (c.effortBucketId !== undefined) changes.effortBucketId = c.effortBucketId;
      if (c.remainingEffortHours !== undefined) changes.remainingEffortHours = c.remainingEffortHours;
      if (c.dueDate !== undefined) changes.dueDate = c.dueDate || null;
      if (c.estimatedCompletionDate !== undefined) changes.estimatedCompletionDate = c.estimatedCompletionDate || null;
      await updateTask(trackerDb, actor, input.taskId, changes, input.reason);
      return {};
    },
    { paths: ["/tracker", boardPath(input.projectKey)] },
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
