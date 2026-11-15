import type { Actor, Database } from "./database";
import { projectRole } from "./access";
import { getBoard, type BoardStatus, type ProjectListItem } from "./queries";

// What the timeline screen reads: one project's cards laid out as rows, each with the dates its
// bar is drawn from, plus the dependency links between them. It is the board's data in another
// shape, so the two screens cannot disagree about a date.

export interface TimelineRow {
  id: number;
  key: string;
  title: string;
  kindLabel: string | null;
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
        unscheduledReason: done || l.isParent ? null : t.unscheduledReason,
        uncountedHours: l.isParent ? t.uncountedHours : null,
      };
    }),
    links,
    forecastAsOf: board.forecastAsOf,
  };
}
