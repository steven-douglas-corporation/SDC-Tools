"use client";

import { useState, useTransition } from "react";
import { BUTTON_COMPACT, BUTTON_PRIMARY, CARD_BASE, INPUT, LABEL } from "@/components/ui/classnames";
import { confirmRemainingAction, createTaskAction, moveTaskAction, updateTaskAction, type TaskEdit } from "../actions";
import type { Board as BoardData, BoardStatus, BoardTask } from "../service/queries";
import { forecastReason, hours, shortDate } from "./format";

// One project's board. Columns are the project's statuses; a card shows what a person typed
// (who, how much is left, due date) next to what the forecast says and why.
//
// Moving a card is a status change through the service, so the status log and completion date
// are written with it. A card is moved with its status menu, not by dragging: that keeps the
// first version small and usable from a keyboard. Dragging can be added on top later.

const SMALL_INPUT =
  "rounded-md border border-sdc-border bg-white px-2 py-1.5 text-sm text-sdc-navy focus:border-sdc-blue focus:outline-none";

const COLUMN_TONE: Record<BoardStatus["category"], string> = {
  todo: "border-t-sdc-border",
  in_progress: "border-t-sdc-blue",
  blocked: "border-t-sdc-red",
  done: "border-t-sdc-green",
  cancelled: "border-t-sdc-border",
};

function NewTask({ board }: { board: BoardData }) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<"task" | "milestone">("task");
  const [bucketId, setBucketId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  return (
    <form
      className={`${CARD_BASE} flex flex-wrap items-end gap-3 p-4`}
      onSubmit={(e) => {
        e.preventDefault();
        setError("");
        start(async () => {
          const res = await createTaskAction({
            projectId: board.project.id,
            projectKey: board.project.key,
            title,
            type,
            effortBucketId: bucketId ? Number(bucketId) : null,
            assigneePersonId: assigneeId ? Number(assigneeId) : null,
            dueDate: dueDate || null,
          });
          if (!res.ok) return setError(res.error);
          setTitle("");
          setBucketId("");
          setDueDate("");
        });
      }}
    >
      <label className="flex min-w-[16rem] flex-1 flex-col gap-1">
        <span className={LABEL}>New task</span>
        <input
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing"
          className={INPUT}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={LABEL}>Kind</span>
        <select value={type} onChange={(e) => setType(e.target.value as "task" | "milestone")} className={INPUT}>
          <option value="task">Task</option>
          <option value="milestone">Milestone</option>
        </select>
      </label>
      {type === "task" && (
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Size</span>
          <select value={bucketId} onChange={(e) => setBucketId(e.target.value)} className={INPUT}>
            <option value="">No estimate yet</option>
            {board.buckets.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label} ({b.hours} hours){b.shouldSplit ? " — consider splitting" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {type === "task" && (
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Assignee</span>
          <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className={INPUT}>
            <option value="">Nobody yet</option>
            {board.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className={LABEL}>Due</span>
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={INPUT} />
      </label>
      <button type="submit" disabled={pending} className={BUTTON_PRIMARY}>
        {pending ? "Adding…" : "Add"}
      </button>
      {error && <p className="w-full text-sm text-sdc-red-text">{error}</p>}
    </form>
  );
}

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

function Card({ task, board, canEdit }: { task: BoardTask; board: BoardData; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  // Set while the person is being asked why a task is blocked, before the move is sent.
  const [blockTo, setBlockTo] = useState<BoardStatus | null>(null);
  const [blockedReason, setBlockedReason] = useState("");
  const [unblockDate, setUnblockDate] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const status = board.statuses.find((s) => s.id === task.statusId);
  const closed = status?.category === "done" || status?.category === "cancelled";

  function move(to: BoardStatus, reason?: string, unblock?: string) {
    setError("");
    start(async () => {
      const res = await moveTaskAction({
        taskId: task.id,
        projectKey: board.project.key,
        toStatusId: to.id,
        blockedReason: reason ?? null,
        expectedUnblockDate: unblock || null,
      });
      if (!res.ok) return setError(res.error);
      setBlockTo(null);
      setBlockedReason("");
      setUnblockDate("");
    });
  }

  const late = !closed && task.dueDate && task.forecastFinish && (task.p80Finish ?? task.forecastFinish) > task.dueDate;

  return (
    <li className={`${CARD_BASE} p-3 text-sm ${pending ? "opacity-60" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-xs font-semibold text-sdc-gray-600">{task.key}</span>
        <span className="flex items-center gap-1">
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
      <p className="mt-1 font-semibold text-sdc-navy">{task.title}</p>

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-sdc-gray-600">
        {task.type === "task" && (
          <>
            <dt>Who</dt>
            <dd className="text-sdc-navy">{task.assigneeName ?? "Nobody yet"}</dd>
          </>
        )}
        {task.type === "task" && !closed && (
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
              {task.forecastFinish ? (
                <>
                  {task.forecastStart !== task.forecastFinish && `${shortDate(task.forecastStart)} → `}
                  <strong>{shortDate(task.forecastFinish)}</strong>
                  {task.p80Finish && task.p80Finish !== task.forecastFinish && ` (P80 ${shortDate(task.p80Finish)})`}
                </>
              ) : (
                "—"
              )}
            </dd>
          </>
        )}
      </dl>

      {!closed && <p className="mt-2 text-xs italic text-sdc-gray-600">{forecastReason(task)}</p>}
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

  return (
    <div className="space-y-4">
      {mayChange && <NewTask board={board} />}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {columns.map((s) => {
          const tasks = board.tasks.filter((t) => t.statusId === s.id);
          const over = s.wipLimit != null && tasks.length > s.wipLimit;
          return (
            <section
              key={s.id}
              aria-label={s.name}
              className={`flex w-72 shrink-0 flex-col rounded-xl border border-t-4 border-sdc-border bg-background p-2 ${COLUMN_TONE[s.category]}`}
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
              <ul className="flex flex-col gap-2">
                {tasks.map((t) => (
                  <Card key={t.id} task={t} board={board} canEdit={mayChange} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
