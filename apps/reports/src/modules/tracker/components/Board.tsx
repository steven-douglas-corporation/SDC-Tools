"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { BUTTON_COMPACT, CARD_BASE } from "@/components/ui/classnames";
import { confirmRemainingAction, moveTaskAction, updateTaskAction, type TaskEdit } from "../actions";
import type { Board as BoardData, BoardStatus, BoardTask } from "../service/queries";
import type { OpenCard } from "../service/tasks";
import { CloseUnderPrompt } from "./CloseUnderPrompt";
import { NewCardDialog } from "./NewCardDialog";
import { forecastReason, hours, shortDate, uncountedComparison } from "./format";

/** A move that is waiting for an answer about the open cards under the card being closed. */
interface CloseAsk {
  status: BoardStatus;
  cards: OpenCard[];
}

// One project's board. Columns are the project's statuses; a card shows what a person typed
// (who, how much is left, due date) next to what the forecast says and why.
//
// Moving a card is a status change through the service, so the status log and completion date
// are written with it. A card can be dragged to another column, or moved with the status menu
// on it. The menu stays because dragging cannot be done from a keyboard or easily on a phone.

const SMALL_INPUT =
  "rounded-md border border-sdc-border bg-white px-2 py-1.5 text-sm text-sdc-navy focus:border-sdc-blue focus:outline-none";

const COLUMN_TONE: Record<BoardStatus["category"], string> = {
  todo: "border-t-sdc-border",
  in_progress: "border-t-sdc-blue",
  blocked: "border-t-sdc-red",
  done: "border-t-sdc-green",
  cancelled: "border-t-sdc-border",
};

function Editor({ task, board, onDone }: { task: BoardTask; board: BoardData; onDone: () => void }) {
  const [assigneeId, setAssigneeId] = useState(task.assigneePersonId?.toString() ?? "");
  const [remaining, setRemaining] = useState(task.remainingHours?.toString() ?? "");
  const [priority, setPriority] = useState(task.priority.toString());
  const [dueDate, setDueDate] = useState(task.dueDate ?? "");
  const [estimated, setEstimated] = useState(task.estimatedCompletionDate ?? "");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const isTask = task.type === "task";

  function save() {
    const changes: TaskEdit = {};
    const nextAssignee = assigneeId ? Number(assigneeId) : null;
    if (nextAssignee !== task.assigneePersonId) changes.assigneePersonId = nextAssignee;
    const nextRemaining = remaining.trim() === "" ? null : Number(remaining);
    if (isTask && nextRemaining !== task.remainingHours) changes.remainingEffortHours = nextRemaining;
    if (Number(priority) !== task.priority) changes.priority = Number(priority);
    if ((dueDate || null) !== task.dueDate) changes.dueDate = dueDate || null;
    if ((estimated || null) !== task.estimatedCompletionDate) changes.estimatedCompletionDate = estimated || null;
    if (Object.keys(changes).length === 0) return onDone();
    if (changes.remainingEffortHours != null && !Number.isFinite(changes.remainingEffortHours)) {
      return setError("Remaining hours must be a number.");
    }
    setError("");
    start(async () => {
      const res = await updateTaskAction({ taskId: task.id, projectKey: board.project.key, changes });
      if (!res.ok) return setError(res.error);
      onDone();
    });
  }

  return (
    <div className="mt-3 space-y-2 border-t border-sdc-border-soft pt-3 text-xs">
      {isTask && (
        <label className="flex items-center justify-between gap-2">
          <span className="font-semibold text-sdc-navy">Assignee</span>
          <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className={`${SMALL_INPUT} w-40`}>
            <option value="">Nobody</option>
            {board.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {isTask && (
        <label className="flex items-center justify-between gap-2">
          <span className="font-semibold text-sdc-navy">Hours left</span>
          <input
            inputMode="decimal"
            value={remaining}
            placeholder={task.estimateHours != null ? `${task.estimateHours} (the estimate)` : "none"}
            onChange={(e) => setRemaining(e.target.value)}
            className={`${SMALL_INPUT} w-40`}
          />
        </label>
      )}
      <label className="flex items-center justify-between gap-2">
        <span className="font-semibold text-sdc-navy">Priority</span>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} className={`${SMALL_INPUT} w-40`}>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n}
              {n === 1 ? " (highest)" : n === 5 ? " (lowest)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="font-semibold text-sdc-navy">Due</span>
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          className={`${SMALL_INPUT} w-40`}
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="font-semibold text-sdc-navy">Your estimate</span>
        <input
          type="date"
          value={estimated}
          onChange={(e) => setEstimated(e.target.value)}
          className={`${SMALL_INPUT} w-40`}
        />
      </label>
      {error && <p className="text-sdc-red-text">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        {isTask && task.stale && task.remainingHours != null && (
          <button
            type="button"
            disabled={pending}
            className={BUTTON_COMPACT}
            title="Says the hours left are still right, without changing them"
            onClick={() =>
              start(async () => {
                const res = await confirmRemainingAction(task.id, board.project.key);
                if (!res.ok) setError(res.error);
              })
            }
          >
            Still right
          </button>
        )}
        <button type="button" disabled={pending} className={BUTTON_COMPACT} onClick={onDone}>
          Cancel
        </button>
        <button type="button" disabled={pending} className={BUTTON_COMPACT} onClick={save}>
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/** What a dragged card carries. A custom type, so a dragged link or file is never mistaken for a card. */
const DRAG_TYPE = "application/x-sdc-tracker-task";

function Card({
  task,
  board,
  canEdit,
  blockTo,
  setBlockTo,
  closeAsk,
  setCloseAsk,
}: {
  task: BoardTask;
  board: BoardData;
  canEdit: boolean;
  /** Set while the person is being asked why this task is blocked, before the move is sent. */
  blockTo: BoardStatus | null;
  setBlockTo: (status: BoardStatus | null) => void;
  /** Set while the person is being asked what to do with the open cards under this one. */
  closeAsk: CloseAsk | null;
  setCloseAsk: (ask: CloseAsk | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [blockedReason, setBlockedReason] = useState("");
  const [unblockDate, setUnblockDate] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const status = board.statuses.find((s) => s.id === task.statusId);
  const closed = status?.category === "done" || status?.category === "cancelled";

  function move(to: BoardStatus, reason?: string, unblock?: string, closeUnder?: "done" | "cancelled") {
    setError("");
    start(async () => {
      const res = await moveTaskAction({
        taskId: task.id,
        projectKey: board.project.key,
        toStatusId: to.id,
        blockedReason: reason ?? null,
        expectedUnblockDate: unblock || null,
        closeUnder,
      });
      if (!res.ok) return setError(res.error);
      // Not moved: it has open cards under it, and the person has to say what happens to them.
      if (res.openUnder.length) return setCloseAsk({ status: to, cards: res.openUnder });
      setCloseAsk(null);
      setBlockTo(null);
      setBlockedReason("");
      setUnblockDate("");
    });
  }

  const late = !closed && task.dueDate && task.forecastFinish && (task.p80Finish ?? task.forecastFinish) > task.dueDate;

  return (
    <li
      className={`${CARD_BASE} p-3 text-sm ${pending ? "opacity-60" : ""} ${canEdit && !editing && !blockTo ? "cursor-grab active:cursor-grabbing" : ""}`}
      // Not draggable while a form on the card is open: dragging would fight with selecting text in it.
      draggable={canEdit && !editing && !blockTo && !closeAsk}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, String(task.id));
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <div className="flex items-start justify-between gap-2">
        {/* Blue, like every other link in the app, so it is obvious the card opens. */}
        <Link
          href={`/tracker/${board.project.key}/${task.key.slice(task.key.lastIndexOf("-") + 1)}`}
          draggable={false}
          title={`Open ${task.key}`}
          className="font-mono text-xs font-semibold text-sdc-blue hover:underline"
        >
          {task.key}
        </Link>
        <span className="flex items-center gap-1">
          {/* Task is the default and goes unmarked, so a plain board is not a wall of labels. */}
          {task.kindLabel !== "Task" && (
            <span className="rounded-full bg-sdc-gray-100 px-2 py-0.5 text-micro font-bold uppercase text-sdc-gray-600">
              {task.kindLabel}
            </span>
          )}
          {task.type === "milestone" && (
            <span className="rounded-full bg-sdc-blue-light px-2 py-0.5 text-micro font-bold uppercase text-sdc-blue-dark">
              Milestone
            </span>
          )}
          {task.priority <= 2 && (
            <span className="rounded-full bg-sdc-yellow-bg px-2 py-0.5 text-micro font-bold text-sdc-yellow-text">
              P{task.priority}
            </span>
          )}
        </span>
      </div>
      <p className="mt-1 font-semibold">
        <Link
          href={`/tracker/${board.project.key}/${task.key.slice(task.key.lastIndexOf("-") + 1)}`}
          draggable={false}
          className="text-sdc-navy hover:text-sdc-blue hover:underline"
        >
          {task.title}
        </Link>
      </p>

      {task.parentKey && (
        <p className="mt-0.5 text-xs text-sdc-gray-600">
          Under{" "}
          <Link
            href={`/tracker/${board.project.key}/${task.parentKey.slice(task.parentKey.lastIndexOf("-") + 1)}`}
            draggable={false}
            className="font-mono font-semibold text-sdc-blue hover:underline"
          >
            {task.parentKey}
          </Link>
        </p>
      )}

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-sdc-gray-600">
        {/* A card with cards under it carries no hours itself: it shows what they add up to. */}
        {task.rollup && (
          <>
            <dt>Contains</dt>
            <dd className="text-sdc-navy">
              {task.rollup.cards} {task.rollup.cards === 1 ? "card" : "cards"}, {task.rollup.done} done
            </dd>
            {!closed && (
              <>
                <dt>Left</dt>
                <dd className="text-sdc-navy">{hours(task.rollup.remainingHours)}</dd>
              </>
            )}
          </>
        )}
        {task.type === "task" && !task.rollup && (
          <>
            <dt>Who</dt>
            <dd className="text-sdc-navy">{task.assigneeName ?? "Nobody yet"}</dd>
          </>
        )}
        {task.type === "task" && !task.rollup && !closed && (
          <>
            <dt>Left</dt>
            <dd className="text-sdc-navy">
              {task.remainingHours != null
                ? hours(task.remainingHours)
                : task.estimateHours != null
                  ? `${hours(task.estimateHours)} (${task.bucketLabel ?? "estimate"})`
                  : "No estimate"}
              {/* Only worth saying when there is a number that could have gone out of date. */}
              {task.stale && task.remainingHours != null && (
                <span className="ml-1 text-sdc-yellow-text">· not updated lately</span>
              )}
            </dd>
          </>
        )}
        {task.checklistTotal > 0 && (
          <>
            <dt>Checklist</dt>
            <dd className="text-sdc-navy">
              {task.checklistDone} of {task.checklistTotal} ticked
            </dd>
          </>
        )}
        {task.dueDate && (
          <>
            <dt>Due</dt>
            <dd className={late ? "font-semibold text-sdc-red-text" : "text-sdc-navy"}>{shortDate(task.dueDate)}</dd>
          </>
        )}
        {closed ? (
          task.actualCompletionDate && (
            <>
              <dt>Done</dt>
              <dd className="text-sdc-navy">{shortDate(task.actualCompletionDate)}</dd>
            </>
          )
        ) : (
          <>
            <dt>Forecast</dt>
            <dd className="text-sdc-navy">
              {task.rollup ? (
                task.rollup.forecastFinish ? (
                  <strong>{shortDate(task.rollup.forecastFinish)}</strong>
                ) : (
                  "—"
                )
              ) : task.forecastFinish ? (
                <>
                  {task.forecastStart !== task.forecastFinish && `${shortDate(task.forecastStart)} → `}
                  <strong>{shortDate(task.forecastFinish)}</strong>
                  {task.p80Finish &&
                    task.p80Finish !== task.forecastFinish &&
                    ` (safe date ${shortDate(task.p80Finish)})`}
                </>
              ) : (
                "—"
              )}
            </dd>
          </>
        )}
      </dl>

      {!closed && (
        <p className="mt-2 text-xs italic text-sdc-gray-600">
          {task.rollup
            ? task.rollup.notForecast > 0
              ? `Finishes when the cards under it do. ${task.rollup.notForecast} of them ${task.rollup.notForecast === 1 ? "is" : "are"} not forecast, so the date is not the whole story.`
              : "Finishes when the cards under it do."
            : forecastReason(task)}
        </p>
      )}
      {task.uncountedHours != null && (
        <p className="mt-1 text-xs text-sdc-yellow-text">
          {hours(task.uncountedHours)} entered on this card {task.uncountedHours === 1 ? "is" : "are"} not counted,
          because cards sit under it.{" "}
          {uncountedComparison(task.uncountedHours, task.rollup?.remainingHours ?? 0, task.unsizedUnder)}
        </p>
      )}
      {task.blockedReason && <p className="mt-1 text-xs text-sdc-red-text">Blocked: {task.blockedReason}</p>}

      {canEdit && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <select
            aria-label={`Move ${task.key}`}
            value={task.statusId}
            disabled={pending}
            onChange={(e) => {
              const to = board.statuses.find((s) => s.id === Number(e.target.value));
              if (!to || to.id === task.statusId) return;
              if (to.category === "blocked") setBlockTo(to);
              else move(to);
            }}
            className={`${SMALL_INPUT} min-w-0 flex-1`}
          >
            {board.statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id === task.statusId ? s.name : `Move to ${s.name}`}
              </option>
            ))}
          </select>
          {!editing && (
            <button type="button" className={BUTTON_COMPACT} onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
        </div>
      )}

      {blockTo && (
        <form
          className="mt-3 space-y-2 border-t border-sdc-border-soft pt-3 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            move(blockTo, blockedReason, unblockDate);
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="font-semibold text-sdc-navy">What is blocking it?</span>
            <input
              required
              autoFocus
              value={blockedReason}
              onChange={(e) => setBlockedReason(e.target.value)}
              className={SMALL_INPUT}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-semibold text-sdc-navy">Expected to be unblocked (optional)</span>
            <input
              type="date"
              value={unblockDate}
              onChange={(e) => setUnblockDate(e.target.value)}
              className={SMALL_INPUT}
            />
            <span className="text-sdc-gray-600">
              With a date it is forecast from then. Without one it is left out of the forecast.
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className={BUTTON_COMPACT} onClick={() => setBlockTo(null)}>
              Cancel
            </button>
            <button type="submit" disabled={pending} className={BUTTON_COMPACT}>
              Move to {blockTo.name}
            </button>
          </div>
        </form>
      )}

      {closeAsk && (closeAsk.status.category === "done" || closeAsk.status.category === "cancelled") && (
        <CloseUnderPrompt
          cardKey={task.key}
          cards={closeAsk.cards}
          toName={closeAsk.status.name}
          toCategory={closeAsk.status.category}
          pending={pending}
          onChoose={(choice) => move(closeAsk.status, undefined, undefined, choice)}
          onCancel={() => setCloseAsk(null)}
        />
      )}

      {error && <p className="mt-2 text-xs text-sdc-red-text">{error}</p>}
      {editing && <Editor task={task} board={board} onDone={() => setEditing(false)} />}
    </li>
  );
}

export function Board({ board, canEdit }: { board: BoardData; canEdit: boolean }) {
  // A viewer on this project sees the board but cannot change it, whatever the app permission says.
  const mayChange = canEdit && (board.project.myRole === "contributor" || board.project.myRole === "manager");
  // Cancelled is kept off the board unless something is in it: an empty column nobody uses is noise.
  const columns = board.statuses.filter(
    (s) => s.category !== "cancelled" || board.tasks.some((t) => t.statusId === s.id),
  );

  // Which card is being asked for a blocked reason. Held here, not on the card, because the
  // question can be raised two ways: from the card's own menu, or by dropping it on a blocked column.
  const [blockPrompt, setBlockPrompt] = useState<{ taskId: number; status: BoardStatus } | null>(null);
  // The same for "what about the open cards under it", which a drop can raise as well.
  const [closePrompt, setClosePrompt] = useState<({ taskId: number } & CloseAsk) | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [dropError, setDropError] = useState("");
  const [dropping, startDrop] = useTransition();

  function drop(status: BoardStatus, e: React.DragEvent) {
    e.preventDefault();
    setDragOver(null);
    const task = board.tasks.find((t) => t.id === Number(e.dataTransfer.getData(DRAG_TYPE)));
    if (!task || task.statusId === status.id) return;
    setDropError("");
    // A blocked status needs a reason, so the drop opens the same question the menu does.
    if (status.category === "blocked") return setBlockPrompt({ taskId: task.id, status });
    startDrop(async () => {
      const res = await moveTaskAction({ taskId: task.id, projectKey: board.project.key, toStatusId: status.id });
      if (!res.ok) return setDropError(`${task.key}: ${res.error}`);
      if (res.openUnder.length) setClosePrompt({ taskId: task.id, status, cards: res.openUnder });
    });
  }

  return (
    <div className="space-y-4">
      {mayChange && (
        <div className="flex justify-end">
          <NewCardDialog board={board} />
        </div>
      )}
      {dropError && <p className="text-sm text-sdc-red-text">{dropError}</p>}
      <div className={`flex gap-3 overflow-x-auto pb-2 ${dropping ? "opacity-70" : ""}`}>
        {columns.map((s) => {
          const tasks = board.tasks.filter((t) => t.statusId === s.id);
          const over = s.wipLimit != null && tasks.length > s.wipLimit;
          return (
            <section
              key={s.id}
              aria-label={s.name}
              onDragOver={(e) => {
                if (!mayChange || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOver !== s.id) setDragOver(s.id);
              }}
              onDragLeave={(e) => {
                // Leaving for a child of the column is not leaving the column.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(null);
              }}
              onDrop={(e) => mayChange && drop(s, e)}
              className={`flex w-72 shrink-0 flex-col rounded-xl border border-t-4 border-sdc-border p-2 ${COLUMN_TONE[s.category]} ${
                dragOver === s.id ? "bg-sdc-blue-light ring-2 ring-sdc-blue/40" : "bg-background"
              }`}
            >
              <h2 className="flex items-center justify-between px-1 pb-2 text-sm font-semibold text-sdc-navy">
                {s.name}
                <span
                  className={`text-xs font-normal ${over ? "font-semibold text-sdc-red-text" : "text-sdc-gray-600"}`}
                >
                  {tasks.length}
                  {s.wipLimit != null ? ` / ${s.wipLimit}` : ""}
                </span>
              </h2>
              {/* min-h so an empty column is still something to drop on */}
              <ul className="flex min-h-16 flex-1 flex-col gap-2">
                {tasks.map((t) => (
                  <Card
                    key={t.id}
                    task={t}
                    board={board}
                    canEdit={mayChange}
                    blockTo={blockPrompt?.taskId === t.id ? blockPrompt.status : null}
                    setBlockTo={(status) => setBlockPrompt(status ? { taskId: t.id, status } : null)}
                    closeAsk={closePrompt?.taskId === t.id ? closePrompt : null}
                    setCloseAsk={(ask) => setClosePrompt(ask ? { taskId: t.id, ...ask } : null)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
