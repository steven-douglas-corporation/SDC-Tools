import { TrackerError, one, type Actor, type Database, type Tx } from "./database";
import { requireProjectRole } from "./access";
import { lockTask } from "./tasks";

// A card's checklist: small steps to tick off that are not worth cards of their own. It is a
// reminder list only. Items carry no hours and the forecast never reads them, so nothing here
// reruns the forecast or writes to the card's history. Anyone who can change the project's
// cards (a contributor) can change a checklist; an archived card's checklist is frozen.

const MAX_ITEMS = 50;
const MAX_LENGTH = 500;

function clean(body: string): string {
  const text = body.trim().replace(/\s+/g, " ");
  if (!text) throw new TrackerError("invalid", "A checklist item cannot be empty.");
  if (text.length > MAX_LENGTH)
    throw new TrackerError("invalid", `That checklist item is too long (${MAX_LENGTH} characters at most).`);
  return text;
}

/** Locks the item's card, so two people changing one checklist cannot interleave, and checks the actor. */
async function lockItem(tx: Tx, actor: Actor, itemId: number): Promise<{ taskId: number; position: number }> {
  const item = await one<{ task_id: number; position: number }>(
    tx,
    `SELECT task_id, position FROM tracker.task_checklist_item WHERE id = $1`,
    [itemId],
    "Checklist item",
  );
  const task = await lockTask(tx, Number(item.task_id));
  await requireProjectRole(tx, task.project_id, actor, "contributor");
  // Read again under the lock: a move by someone else may have changed it while we waited.
  const now = await one<{ position: number }>(
    tx,
    `SELECT position FROM tracker.task_checklist_item WHERE id = $1`,
    [itemId],
    "Checklist item",
  );
  return { taskId: Number(item.task_id), position: Number(now.position) };
}

/** Adds an item to the end of a card's checklist. */
export async function addChecklistItem(db: Database, actor: Actor, taskId: number, body: string): Promise<number> {
  const text = clean(body);
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    await requireProjectRole(tx, task.project_id, actor, "contributor");
    const have = await one<{ n: number; last: number | null }>(
      tx,
      `SELECT count(*)::int AS n, max(position) AS last FROM tracker.task_checklist_item WHERE task_id = $1`,
      [taskId],
      "Checklist",
    );
    if (Number(have.n) >= MAX_ITEMS)
      throw new TrackerError(
        "invalid",
        `A checklist holds ${MAX_ITEMS} items at most. Work this big is better as cards under this one.`,
      );
    const row = await one<{ id: number }>(
      tx,
      `INSERT INTO tracker.task_checklist_item (task_id, body, position, created_by_person_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [taskId, text, Number(have.last ?? 0) + 1, actor.personId],
      "Checklist item",
    );
    return Number(row.id);
  });
}

/** Ticks or unticks an item. Ticking records who and when; ticking a ticked item changes nothing. */
export async function setChecklistItemDone(db: Database, actor: Actor, itemId: number, done: boolean): Promise<void> {
  await db.transaction(async (tx) => {
    await lockItem(tx, actor, itemId);
    if (done) {
      await tx.query(
        `UPDATE tracker.task_checklist_item SET done_at = now(), done_by_person_id = $2
          WHERE id = $1 AND done_at IS NULL`,
        [itemId, actor.personId],
      );
    } else {
      await tx.query(`UPDATE tracker.task_checklist_item SET done_at = NULL, done_by_person_id = NULL WHERE id = $1`, [
        itemId,
      ]);
    }
  });
}

/** Rewords an item. Whether it is ticked is left alone. */
export async function renameChecklistItem(db: Database, actor: Actor, itemId: number, body: string): Promise<void> {
  const text = clean(body);
  await db.transaction(async (tx) => {
    await lockItem(tx, actor, itemId);
    await tx.query(`UPDATE tracker.task_checklist_item SET body = $2 WHERE id = $1`, [itemId, text]);
  });
}

export async function removeChecklistItem(db: Database, actor: Actor, itemId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await lockItem(tx, actor, itemId);
    await tx.query(`DELETE FROM tracker.task_checklist_item WHERE id = $1`, [itemId]);
  });
}

/** Moves an item one place up or down its card's list. Moving past either end changes nothing. */
export async function moveChecklistItem(
  db: Database,
  actor: Actor,
  itemId: number,
  direction: "up" | "down",
): Promise<void> {
  if (direction !== "up" && direction !== "down") throw new TrackerError("invalid", "Move an item up or down.");
  await db.transaction(async (tx) => {
    const { taskId } = await lockItem(tx, actor, itemId);
    const { rows } = await tx.query<{ id: number }>(
      `SELECT id FROM tracker.task_checklist_item WHERE task_id = $1 ORDER BY position, id`,
      [taskId],
    );
    const order = rows.map((r) => Number(r.id));
    const from = order.indexOf(itemId);
    const to = direction === "up" ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to]!, order[from]!];
    // Renumber the whole list, so gaps and ties left by removals never build up.
    await tx.query(
      `UPDATE tracker.task_checklist_item i SET position = o.ord
         FROM unnest($1::bigint[]) WITH ORDINALITY AS o (id, ord)
        WHERE i.id = o.id AND i.position IS DISTINCT FROM o.ord`,
      [order],
    );
  });
}
