import type { Actor, Database } from "./database";
import { projectRole } from "./access";
import {
  getBoard,
  listProjects,
  throughLens,
  type BoardStatus,
  type DepartmentLens,
  type DepartmentLevel,
  type ProjectListItem,
} from "./queries";

// What the timeline screen reads: one project's cards laid out as rows, each with the dates its
// bar is drawn from, plus the dependency links between them. It is the board's data in another
// shape, so the two screens cannot disagree about a date.

export interface TimelineRow {
  id: number;
  key: string;
  title: string;
  kindLabel: string;
  type: "task" | "milestone";
  /** 0 for a card that sits under nothing, 1 for a card under it, and so on. */
  depth: number;
  /** True when cards sit under this one. Its bar then spans them; it has no dates of its own. */
  isParent: boolean;
  statusName: string;
  category: BoardStatus["category"];
  assigneeName: string | null;
  /** Where the bar starts and ends. Both null when there is nothing to draw. */
  start: string | null;
  finish: string | null;
  /** Leaf cards only: the P80 finish, when a simulation has run and it is later than `finish`. */
  p80Finish: string | null;
  dueDate: string | null;
  /** The day a finished card was finished. */
  doneOn: string | null;
  /**
   * The first day work on it is known to have happened: the day it first left To do, or the day
   * the first of it was finished, whichever is earlier. Null when nothing has been done yet.
   */
  startedOn: string | null;
  /** Why an open card has no bar, in the engine's words; the screen turns it into a sentence. */
  unscheduledReason: string | null;
  /** Hours entered on a parent card that the forecast does not count. Null when there are none. */
  uncountedHours: number | null;
}

export interface TimelineLink {
  /** The card that has to finish first. */
  fromId: number;
  /** The card that waits. */
  toId: number;
  lagDays: number;
}

export interface Timeline {
  project: ProjectListItem;
  rows: TimelineRow[];
  links: TimelineLink[];
  /** The day the stored forecast was made for, or null if none has run. */
  forecastAsOf: string | null;
}

export interface TimelineCard {
  id: number;
  parentId: number | null;
  number: number;
  /** A leaf's own forecast dates. Ignored for a card that turns out to have cards under it. */
  start: string | null;
  finish: string | null;
  closed: boolean;
}

/**
 * Puts cards in the order the timeline draws them and works out each parent's span. Under each
 * parent, and at the top, cards run by start date, then by number; a card with no dates comes
 * last. A parent spans the open cards under it, however deep. No SQL, so it can be tested alone.
 */
export function layoutTimeline(
  cards: TimelineCard[],
): { id: number; depth: number; isParent: boolean; start: string | null; finish: string | null }[] {
  const known = new Set(cards.map((c) => c.id));
  const children = new Map<number | null, TimelineCard[]>();
  for (const c of cards) {
    // A card whose parent is not in the list (archived) is drawn at the top.
    const parent = c.parentId != null && known.has(c.parentId) ? c.parentId : null;
    const list = children.get(parent);
    if (list) list.push(c);
    else children.set(parent, [c]);
  }
  const span = new Map<number, { start: string | null; finish: string | null }>();
  const measure = (c: TimelineCard): { start: string | null; finish: string | null } => {
    const kids = children.get(c.id);
    let s: { start: string | null; finish: string | null };
    if (!kids) s = c.closed ? { start: null, finish: null } : { start: c.start, finish: c.finish };
    else {
      s = { start: null, finish: null };
      for (const kid of kids) {
        const k = measure(kid);
        if (k.start && (!s.start || k.start < s.start)) s.start = k.start;
        if (k.finish && (!s.finish || k.finish > s.finish)) s.finish = k.finish;
      }
    }
    span.set(c.id, s);
    return s;
  };
  for (const top of children.get(null) ?? []) measure(top);

  const order = (a: TimelineCard, b: TimelineCard) => {
    const sa = span.get(a.id)?.start ?? null;
    const sb = span.get(b.id)?.start ?? null;
    if (sa !== sb) return sa == null ? 1 : sb == null ? -1 : sa < sb ? -1 : 1;
    return a.number - b.number;
  };
  const out: { id: number; depth: number; isParent: boolean; start: string | null; finish: string | null }[] = [];
  const walk = (parent: number | null, depth: number) => {
    for (const c of [...(children.get(parent) ?? [])].sort(order)) {
      out.push({
        id: c.id,
        depth,
        isParent: children.has(c.id),
        ...(span.get(c.id) as { start: string | null; finish: string | null }),
      });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The earlier of two days, either of which may be missing. */
function earliest(a: string | null, b: string | null): string | null {
  if (!a || !b) return a ?? b;
  return a < b ? a : b;
}

/** The first day each card of a project, or of every project, was being worked on or finished. */
const FIRST_WORKED = `
  SELECT l.task_id, min(l.changed_at)::date AS day
    FROM tracker.status_log l
    JOIN tracker.workflow_status w ON w.id = l.to_status_id
   WHERE w.category IN ('in_progress', 'done')
   GROUP BY l.task_id`;

/** One project's timeline. Cancelled cards are left out; finished ones are kept, without a bar. */
export async function getTimeline(db: Database, actor: Actor, projectKey: string): Promise<Timeline> {
  // getBoard does the access check and refuses a project that is not the caller's.
  const board = await getBoard(db, actor, projectKey);
  const category = new Map(board.statuses.map((s) => [s.id, s]));
  const cards = board.tasks.filter((t) => category.get(t.statusId)?.category !== "cancelled");
  const idByKey = new Map(cards.map((t) => [t.key, t.id]));
  const byId = new Map(cards.map((t) => [t.id, t]));

  const laid = layoutTimeline(
    cards.map((t) => ({
      id: t.id,
      parentId: t.parentKey ? (idByKey.get(t.parentKey) ?? null) : null,
      number: Number(t.key.slice(t.key.lastIndexOf("-") + 1)),
      start: t.forecastStart,
      finish: t.forecastFinish,
      closed: category.get(t.statusId)?.category === "done",
    })),
  );

  const links = await db.transaction(async (tx) => {
    // Asked again here, inside this transaction, so the links are never read without the check.
    if (!(await projectRole(tx, board.project.id, actor))) return [];
    const { rows } = await tx.query<{ predecessor_task_id: number; successor_task_id: number; lag_days: number }>(
      `SELECT d.predecessor_task_id, d.successor_task_id, d.lag_days
         FROM tracker.task_dependency d
         JOIN tracker.task a ON a.id = d.predecessor_task_id
         JOIN tracker.task b ON b.id = d.successor_task_id
        WHERE a.project_id = $1 AND b.project_id = $1`,
      [board.project.id],
    );
    return rows
      .map((r) => ({
        fromId: Number(r.predecessor_task_id),
        toId: Number(r.successor_task_id),
        lagDays: Number(r.lag_days),
      }))
      .filter((l) => byId.has(l.fromId) && byId.has(l.toId));
  });

  const started = await db.transaction(async (tx) => {
    if (!(await projectRole(tx, board.project.id, actor))) return new Map<number, string>();
    const { rows } = await tx.query<{ task_id: number; day: string }>(
      `SELECT s.task_id, s.day::text AS day
         FROM (${FIRST_WORKED}) s
         JOIN tracker.task t ON t.id = s.task_id
        WHERE t.project_id = $1`,
      [board.project.id],
    );
    return new Map(rows.map((r) => [Number(r.task_id), r.day]));
  });

  return {
    project: board.project,
    rows: laid.map((l) => {
      const t = byId.get(l.id)!;
      const status = category.get(t.statusId)!;
      const done = status.category === "done";
      return {
        id: t.id,
        key: t.key,
        title: t.title,
        kindLabel: t.kindLabel,
        type: t.type,
        depth: l.depth,
        isParent: l.isParent,
        statusName: status.name,
        category: status.category,
        assigneeName: t.assigneeName,
        start: done ? null : l.start,
        finish: done ? null : l.finish,
        p80Finish: !done && !l.isParent && t.p80Finish && l.finish && t.p80Finish > l.finish ? t.p80Finish : null,
        dueDate: t.dueDate,
        doneOn: done ? t.actualCompletionDate : null,
        startedOn: l.isParent ? null : earliest(started.get(t.id) ?? null, done ? t.actualCompletionDate : null),
        unscheduledReason: done || l.isParent ? null : t.unscheduledReason,
        uncountedHours: l.isParent ? t.uncountedHours : null,
      };
    }),
    links,
    forecastAsOf: board.forecastAsOf,
  };
}

// ── All projects on one timeline ─────────────────────────────────────────────

/** Why a project has no bar, in the forecast's own words; the screen turns it into a sentence. */
function projectUnscheduledReason(p: ProjectListItem): string {
  if (p.state === "on_hold") return "project on hold";
  if (p.portfolioRank == null) return "project has no stack rank";
  return "nothing in it has a forecast date yet";
}

/**
 * Every open project the viewer can see as one row, in stack-rank order: a bar from the first
 * forecast start of its work to its forecast finish, its target as the due date, and a link
 * wherever an open card in one project waits on an open card in another. It reuses the card
 * timeline's row shape, so one component draws both.
 */
export async function getPortfolioTimeline(
  db: Database,
  actor: Actor,
  view: {
    /** Only the projects that are for one of these departments (see departmentScope). Null for all. */
    scope?: Set<number> | null;
    /** A row per department above its projects, spanning them, with the projects one level in. */
    grouped?: boolean;
    /** Which department the scope and the rows mean: who it is for (the default), or who does the work. */
    lens?: DepartmentLens;
    /** What a grouped row is: the group a department sits in (the default), or the department itself. */
    level?: DepartmentLevel;
    /** Finished projects too, each as a row from when its work started to when it was finished. */
    finished?: boolean;
  } = {},
): Promise<Pick<Timeline, "rows" | "links" | "forecastAsOf">> {
  // listProjects applies the "only your projects, or all for an admin" rule.
  const open = throughLens(
    await listProjects(db, actor),
    view.lens ?? "for",
    view.grouped ? (view.level ?? "group") : "group",
  ).filter((p) => p.state !== "cancelled" && (view.finished === true || p.state !== "completed"));
  const scope = view.scope ?? null;
  const inScope = scope ? open.filter((p) => p.forDepartmentId != null && scope.has(p.forDepartmentId)) : open;
  // Grouped: a department's projects together, departments in the company's order, none last.
  // The sort is stable, so each department's projects stay in stack-rank order.
  const last = Number.MAX_SAFE_INTEGER;
  const projects = view.grouped
    ? [...inScope].sort((a, b) => (a.forGroupSort ?? last) - (b.forGroupSort ?? last))
    : inScope;
  const visible = new Set(projects.map((p) => p.id));

  return db.transaction(async (tx) => {
    const starts = await tx.query<{ project_id: number; start: string }>(
      `SELECT t.project_id, min(f.scheduled_start)::text AS start
         FROM tracker.task_forecast f
         JOIN tracker.task t ON t.id = f.task_id
        WHERE f.run_id = (SELECT run_id FROM tracker.current_schedule_run) AND f.scheduled_start IS NOT NULL
        GROUP BY t.project_id`,
    );
    const startOf = new Map(starts.rows.map((r) => [Number(r.project_id), r.start]));
    // What has already happened: when each project's work began, and when a finished one ended.
    const worked = await tx.query<{ project_id: number; started: string | null }>(
      `SELECT t.project_id, min(least(s.day, t.actual_completion_date))::text AS started
         FROM tracker.task t
    LEFT JOIN (${FIRST_WORKED}) s ON s.task_id = t.id
        WHERE t.archived_at IS NULL
        GROUP BY t.project_id`,
    );
    const workedFrom = new Map(worked.rows.map((r) => [Number(r.project_id), r.started]));
    const ended = await tx.query<{ id: number; day: string | null }>(
      `SELECT id, actual_completion_date::text AS day FROM tracker.project WHERE state = 'completed'`,
    );
    const endedOn = new Map(ended.rows.map((r) => [Number(r.id), r.day]));
    // A project waits on another when an open card in it waits on an open card in the other.
    const waits = await tx.query<{ from_project: number; to_project: number }>(
      `SELECT DISTINCT a.project_id AS from_project, b.project_id AS to_project
         FROM tracker.task_dependency d
         JOIN tracker.task a ON a.id = d.predecessor_task_id
         JOIN tracker.task b ON b.id = d.successor_task_id
         JOIN tracker.workflow_status sa ON sa.id = a.status_id
         JOIN tracker.workflow_status sb ON sb.id = b.status_id
        WHERE a.project_id <> b.project_id
          AND a.archived_at IS NULL AND b.archived_at IS NULL
          AND sa.category NOT IN ('done', 'cancelled') AND sb.category NOT IN ('done', 'cancelled')`,
    );
    const run = await tx.query<{ as_of: string }>(`SELECT as_of_date::text AS as_of FROM tracker.current_schedule_run`);

    const projectRows = projects.map((p): TimelineRow => {
      const done = p.state === "completed";
      const finish = done ? null : p.forecastFinish;
      const doneOn = done ? (endedOn.get(p.id) ?? null) : null;
      const state = p.state.replace("_", " ");
      return {
        id: p.id,
        key: p.key,
        title: p.name,
        kindLabel: "Task", // the default kind goes unmarked, which is what a project row wants
        type: "task",
        depth: view.grouped ? 1 : 0,
        isParent: false,
        statusName: state.charAt(0).toUpperCase() + state.slice(1),
        category: done ? "done" : p.state === "active" ? "in_progress" : "todo",
        assigneeName: `owner ${p.ownerName}`,
        start: finish ? (startOf.get(p.id) ?? finish) : null,
        finish,
        p80Finish: finish && p.p80Finish && p.p80Finish > finish ? p.p80Finish : null,
        dueDate: p.targetDate,
        doneOn,
        startedOn: earliest(workedFrom.get(p.id) ?? null, doneOn),
        unscheduledReason: finish || done ? null : projectUnscheduledReason(p),
        uncountedHours: null,
      };
    });

    // A department's own row: no dates of its own, a bar from the first start to the last
    // finish among its projects. Its id is negative so it can never be taken for a project's,
    // which is what the links and the "closed" list in the address go by.
    const rows: TimelineRow[] = [];
    projects.forEach((p, i) => {
      if (view.grouped && (i === 0 || projects[i - 1]!.forGroupId !== p.forGroupId)) {
        const mine = projects
          .map((x, j) => ({ x, row: projectRows[j]! }))
          .filter(({ x }) => x.forGroupId === p.forGroupId)
          .map(({ row }) => row);
        const starts = mine
          .map((r) => r.start)
          .filter((d): d is string => d != null)
          .sort();
        const finishes = mine
          .map((r) => r.finish)
          .filter((d): d is string => d != null)
          .sort();
        rows.push({
          id: -(p.forGroupId ?? 0) - 1,
          key: "",
          title: p.forGroupName ?? "No department yet",
          kindLabel: "Department",
          type: "task",
          depth: 0,
          isParent: true,
          statusName: `${mine.length} project${mine.length === 1 ? "" : "s"}`,
          category: "todo",
          assigneeName: null,
          start: starts[0] ?? null,
          finish: finishes[finishes.length - 1] ?? null,
          p80Finish: null,
          dueDate: null,
          doneOn: null,
          startedOn: null,
          unscheduledReason: null,
          uncountedHours: null,
        });
      }
      rows.push(projectRows[i]!);
    });

    return {
      rows,
      links: waits.rows
        .map((w) => ({ fromId: Number(w.from_project), toId: Number(w.to_project), lagDays: 0 }))
        .filter((l) => visible.has(l.fromId) && visible.has(l.toId)),
      forecastAsOf: run.rows[0]?.as_of ?? null,
    };
  });
}
