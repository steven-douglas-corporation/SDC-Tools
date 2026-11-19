"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { BUTTON_COMPACT, BUTTON_PRIMARY, CARD_BASE, INPUT, LABEL } from "@/components/ui/classnames";
import {
  addCommentAction,
  addDependencyAction,
  clearOwnHoursAction,
  confirmRemainingAction,
  moveTaskAction,
  removeDependencyAction,
  updateTaskAction,
  type ActionResult,
  type TaskEdit,
} from "../actions";
import type { LinkedTask, TaskDetail } from "../service/task-detail";
import type { OpenCard } from "../service/tasks";
import { Checklist } from "./Checklist";
import { CloseUnderPrompt } from "./CloseUnderPrompt";
import { P80Help } from "./HelpTip";
import { KindHelp } from "./KindHelp";
import { forecastReason, hours, shortDate, uncountedComparison } from "./format";

// One task, in full: what people typed, what the forecast says and why, what it waits on and
// what waits on it, the conversation about it, and everything that has happened to it.

const taskHref = (key: string) => {
  const cut = key.lastIndexOf("-");
  return `/tracker/${key.slice(0, cut)}/${key.slice(cut + 1)}`;
};

/** A time in the reader's own time zone. Rendered on the client only, so server and browser cannot disagree. */
function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
    </time>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={`${CARD_BASE} p-4`}>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-sdc-gray-600">{title}</h2>
      {children}
    </section>
  );
}

function Links({
  title,
  empty,
  links,
  onRemove,
  pending,
}: {
  title: string;
  empty: string;
  links: LinkedTask[];
  onRemove?: (l: LinkedTask) => void;
  pending: boolean;
}) {
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-sdc-navy">{title}</h3>
      {links.length === 0 ? (
        <p className="text-sm text-sdc-gray-600">{empty}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {links.map((l) => (
            <li key={l.taskId} className="flex items-center justify-between gap-2">
              <span className={l.closed ? "text-sdc-gray-400 line-through" : ""}>
                {l.canOpen ? (
                  <Link
                    href={taskHref(l.key)}
                    className="font-mono text-xs font-semibold text-sdc-blue hover:underline"
                  >
                    {l.key}
                  </Link>
                ) : (
                  <span className="font-mono text-xs font-semibold text-sdc-navy">{l.key}</span>
                )}{" "}
                {l.title}
                {l.lagDays > 0 && <span className="text-sdc-gray-600"> (+{l.lagDays} days)</span>}
              </span>
              {onRemove && (
                <button type="button" disabled={pending} className={BUTTON_COMPACT} onClick={() => onRemove(l)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TaskDetailView({ task, canEdit }: { task: TaskDetail; canEdit: boolean }) {
  const mayChange = canEdit && !task.archived && (task.myRole === "contributor" || task.myRole === "manager");
  const closed = task.statusCategory === "done" || task.statusCategory === "cancelled";
  const isTask = task.type === "task";

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [assigneeId, setAssigneeId] = useState(task.assigneePersonId?.toString() ?? "");
  const [requestedById, setRequestedById] = useState(task.requestedByPersonId.toString());
  const [bucketId, setBucketId] = useState(task.bucketId?.toString() ?? "");
  const [remaining, setRemaining] = useState(task.remainingHours?.toString() ?? "");
  const [priority, setPriority] = useState(task.priority.toString());
  const [dueDate, setDueDate] = useState(task.dueDate ?? "");
  const [estimated, setEstimated] = useState(task.estimatedCompletionDate ?? "");
  const [kind, setKind] = useState(task.kind);
  const [parentId, setParentId] = useState(task.parentTaskId?.toString() ?? "");
  const [reason, setReason] = useState("");
  const [statusId, setStatusId] = useState(task.statusId.toString());
  const [blockedReason, setBlockedReason] = useState("");
  const [unblockDate, setUnblockDate] = useState("");
  // The open cards under this one, while the person is being asked what closing it does to them.
  const [openUnder, setOpenUnder] = useState<OpenCard[] | null>(null);
  const [waitOn, setWaitOn] = useState("");
  const [lag, setLag] = useState("0");
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [pending, start] = useTransition();

  function run(work: () => Promise<ActionResult>, done?: () => void) {
    setError("");
    setSaved("");
    start(async () => {
      const res = await work();
      if (!res.ok) return setError(res.error);
      done?.();
    });
  }

  function saveFields() {
    const changes: TaskEdit = {};
    if (title.trim() !== task.title) changes.title = title;
    if ((description.trim() || null) !== (task.description ?? null)) changes.description = description;
    const nextAssignee = assigneeId ? Number(assigneeId) : null;
    if (nextAssignee !== task.assigneePersonId) changes.assigneePersonId = nextAssignee;
    if (Number(requestedById) !== task.requestedByPersonId) changes.requestedByPersonId = Number(requestedById);
    const nextBucket = bucketId ? Number(bucketId) : null;
    if (isTask && nextBucket !== task.bucketId && nextBucket !== null) changes.effortBucketId = nextBucket;
    const nextRemaining = remaining.trim() === "" ? null : Number(remaining);
    if (isTask && nextRemaining !== task.remainingHours) {
      if (nextRemaining !== null && !Number.isFinite(nextRemaining)) return setError("Hours left must be a number.");
      changes.remainingEffortHours = nextRemaining;
    }
    if (kind !== task.kind) changes.kind = kind;
    const nextParent = parentId ? Number(parentId) : null;
    if (nextParent !== task.parentTaskId) changes.parentTaskId = nextParent;
    if (Number(priority) !== task.priority) changes.priority = Number(priority);
    if ((dueDate || null) !== task.dueDate) changes.dueDate = dueDate || null;
    if ((estimated || null) !== task.estimatedCompletionDate) changes.estimatedCompletionDate = estimated || null;
    if (Object.keys(changes).length === 0) return setSaved("Nothing to save.");
    run(
      () => updateTaskAction({ taskId: task.id, projectKey: task.projectKey, changes, reason: reason.trim() || null }),
      () => {
        setReason("");
        setSaved("Saved.");
      },
    );
  }

  // What this card could sit under, given the kind chosen in the form: anything of a higher kind.
  // A card with no kind counts as the lowest level.
  const lowest = Math.max(...task.kinds.map((k) => k.level));
  const ownLevel = task.kinds.find((k) => k.key === kind)?.level ?? lowest;
  const parents = task.parentCandidates.filter((c) => c.level < ownLevel || c.id === Number(parentId));
  const hasChildren = task.children.length > 0;

  const target = task.statuses.find((s) => s.id === Number(statusId));
  const moving = target && target.id !== task.statusId;
  const toBlocked = moving && target.category === "blocked";

  function moveTo(toStatusId: number, closeUnder?: "done" | "cancelled") {
    setError("");
    setSaved("");
    start(async () => {
      const res = await moveTaskAction({
        taskId: task.id,
        projectKey: task.projectKey,
        toStatusId,
        blockedReason: toBlocked ? blockedReason : null,
        expectedUnblockDate: toBlocked ? unblockDate || null : null,
        closeUnder,
      });
      if (!res.ok) return setError(res.error);
      // Not moved: it has open cards under it, and the person has to say what happens to them.
      if (res.openUnder.length) return setOpenUnder(res.openUnder);
      setOpenUnder(null);
      setBlockedReason("");
      setUnblockDate("");
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Section title="Card">
          <div className="space-y-3">
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Title</span>
              <input value={title} disabled={!mayChange} onChange={(e) => setTitle(e.target.value)} className={INPUT} />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Description</span>
              <textarea
                rows={5}
                value={description}
                disabled={!mayChange}
                onChange={(e) => setDescription(e.target.value)}
                className={`${INPUT} resize-y`}
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="flex flex-col gap-1">
                <span className={`${LABEL} flex items-center gap-1.5`}>
                  Kind <KindHelp kinds={task.kinds} />
                </span>
                <select value={kind} disabled={!mayChange} onChange={(e) => setKind(e.target.value)} className={INPUT}>
                  {task.kinds.map((k) => (
                    <option key={k.key} value={k.key}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 sm:col-span-1 lg:col-span-2">
                <span className={LABEL}>Sits under</span>
                <select
                  value={parentId}
                  disabled={!mayChange}
                  onChange={(e) => setParentId(e.target.value)}
                  className={INPUT}
                >
                  <option value="">Nothing</option>
                  {parents.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.key} {c.title} ({c.kindLabel})
                    </option>
                  ))}
                </select>
                <span className="text-xs text-sdc-gray-600">
                  {parents.length === 0
                    ? "Nothing in this project is of a higher kind than this card yet."
                    : "Only cards of a higher kind are listed."}
                </span>
              </label>
            </div>
            {hasChildren && isTask && task.uncountedHours == null && (
              <p className="text-xs text-sdc-gray-600">
                Cards sit under this one, so the forecast uses their hours and not the size or hours left entered here.
              </p>
            )}
            {task.uncountedHours != null && (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-sdc-border bg-sdc-yellow-bg px-3 py-2 text-sm text-sdc-yellow-text">
                <p className="min-w-[14rem] flex-1">
                  {hours(task.uncountedHours)} entered on this card {task.uncountedHours === 1 ? "is" : "are"} not
                  counted, because cards sit under it and the forecast uses theirs.{" "}
                  {uncountedComparison(task.uncountedHours, task.rollup?.remainingHours ?? 0, task.unsizedUnder)} If the
                  cards cover the work, clear the hours here. If they do not yet, add the rest as cards under it.
                </p>
                {mayChange && (
                  <button
                    type="button"
                    disabled={pending}
                    className={BUTTON_COMPACT}
                    onClick={() =>
                      run(
                        () => clearOwnHoursAction(task.id, task.projectKey),
                        () => setSaved("Cleared."),
                      )
                    }
                  >
                    Clear this card&apos;s own hours
                  </button>
                )}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {isTask && (
                <label className="flex flex-col gap-1">
                  <span className={LABEL}>Assignee</span>
                  <select
                    value={assigneeId}
                    disabled={!mayChange}
                    onChange={(e) => setAssigneeId(e.target.value)}
                    className={INPUT}
                  >
                    <option value="">Nobody yet</option>
                    {task.people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {isTask && (
                <label className="flex flex-col gap-1">
                  <span className={LABEL}>Size</span>
                  <select
                    value={bucketId}
                    disabled={!mayChange}
                    onChange={(e) => setBucketId(e.target.value)}
                    className={INPUT}
                  >
                    <option value="">
                      {task.estimateHours != null ? `${task.estimateHours} hours (typed)` : "No estimate yet"}
                    </option>
                    {task.buckets.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label} ({b.hours} hours)
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {isTask && (
                <label className="flex flex-col gap-1">
                  <span className={LABEL}>Hours left</span>
                  <input
                    inputMode="decimal"
                    value={remaining}
                    disabled={!mayChange}
                    placeholder={task.estimateHours != null ? `${task.estimateHours} (the estimate)` : "none"}
                    onChange={(e) => setRemaining(e.target.value)}
                    className={INPUT}
                  />
                  <span className="text-xs text-sdc-gray-600">
                    {task.remainingUpdatedAt ? (
                      <>
                        Last entered or confirmed <When iso={task.remainingUpdatedAt} />
                      </>
                    ) : (
                      "Never entered. The forecast uses the estimate."
                    )}
                  </span>
                </label>
              )}
              <label className="flex flex-col gap-1">
                <span className={LABEL}>Requested by</span>
                <select
                  value={requestedById}
                  disabled={!mayChange}
                  onChange={(e) => setRequestedById(e.target.value)}
                  className={INPUT}
                >
                  {task.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-sdc-gray-600">
                  Who wants this done. Change it if you made the card for someone else.
                </span>
              </label>
              <label className="flex flex-col gap-1">
                <span className={LABEL}>Priority</span>
                <select
                  value={priority}
                  disabled={!mayChange}
                  onChange={(e) => setPriority(e.target.value)}
                  className={INPUT}
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                      {n === 1 ? " (highest)" : n === 5 ? " (lowest)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={LABEL}>Due date</span>
                <input
                  type="date"
                  value={dueDate}
                  disabled={!mayChange}
                  onChange={(e) => setDueDate(e.target.value)}
                  className={INPUT}
                />
                <span className="text-xs text-sdc-gray-600">A commitment. The forecast is compared with it.</span>
              </label>
              <label className="flex flex-col gap-1">
                <span className={LABEL}>Your estimated completion</span>
                <input
                  type="date"
                  value={estimated}
                  disabled={!mayChange}
                  onChange={(e) => setEstimated(e.target.value)}
                  className={INPUT}
                />
                <span className="text-xs text-sdc-gray-600">
                  {task.baselineCompletionDate
                    ? `First estimate was ${shortDate(task.baselineCompletionDate)}; slip is measured from it.`
                    : "Your own prediction. The first one you enter is kept as the baseline."}
                </span>
              </label>
            </div>
            {mayChange && (
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex min-w-[14rem] flex-1 flex-col gap-1">
                  <span className={LABEL}>Reason for the change (optional)</span>
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className={INPUT}
                    placeholder="Kept in the history"
                  />
                </label>
                <button type="button" disabled={pending} className={BUTTON_PRIMARY} onClick={saveFields}>
                  {pending ? "Saving…" : "Save changes"}
                </button>
                {isTask && !closed && task.remainingHours != null && (
                  <button
                    type="button"
                    disabled={pending}
                    className={BUTTON_COMPACT}
                    title="Says the hours left are still right, without changing them"
                    onClick={() =>
                      run(
                        () => confirmRemainingAction(task.id, task.projectKey),
                        () => setSaved("Confirmed."),
                      )
                    }
                  >
                    Hours left are still right
                  </button>
                )}
              </div>
            )}
            {saved && <p className="text-sm text-sdc-green-text">{saved}</p>}
            {error && <p className="text-sm text-sdc-red-text">{error}</p>}
          </div>
        </Section>

        {hasChildren && (
          <Section title="Under this card">
            <ul className="space-y-1 text-sm">
              {task.children.map((c) => (
                <li key={c.key} className="grid grid-cols-[1fr_auto] gap-x-3">
                  <span className={c.closed ? "text-sdc-gray-400 line-through" : ""}>
                    <Link
                      href={taskHref(c.key)}
                      className="font-mono text-xs font-semibold text-sdc-blue hover:underline"
                    >
                      {c.key}
                    </Link>{" "}
                    {c.title}
                    <span className="text-sdc-gray-600"> ({c.kindLabel})</span>
                  </span>
                  <span className="text-xs text-sdc-gray-600">
                    {c.statusName}
                    {!c.closed && c.forecastFinish && ` · forecast ${shortDate(c.forecastFinish)}`}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* An Epic, Feature or Story has no checklist; one that already holds items still shows them. */}
        {(task.checklistAllowed || task.checklist.length > 0) && (
          <Section title="Checklist">
            <Checklist
              taskId={task.id}
              taskKey={task.key}
              projectKey={task.projectKey}
              items={task.checklist}
              mayChange={mayChange}
              mayAdd={task.checklistAllowed}
              kindLabel={task.kindLabel}
            />
          </Section>
        )}

        <Section title="Comments">
          {task.comments.length === 0 ? (
            <p className="text-sm text-sdc-gray-600">No comments yet.</p>
          ) : (
            <ul className="space-y-3">
              {task.comments.map((c) => (
                <li key={c.id} className="text-sm">
                  <p className="text-xs text-sdc-gray-600">
                    <strong className="text-sdc-navy">{c.author}</strong> · <When iso={c.at} />
                  </p>
                  <p className="whitespace-pre-wrap text-sdc-navy">{c.body}</p>
                </li>
              ))}
            </ul>
          )}
          {mayChange && (
            <form
              className="mt-3 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                run(
                  () => addCommentAction({ taskId: task.id, taskKey: task.key, body: comment }),
                  () => setComment(""),
                );
              }}
            >
              <textarea
                rows={2}
                required
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Add a comment"
                className={`${INPUT} resize-y`}
              />
              <button type="submit" disabled={pending} className={`${BUTTON_COMPACT} self-end`}>
                Add comment
              </button>
            </form>
          )}
        </Section>

        <Section title="History">
          <ul className="space-y-2 text-sm">
            {task.history.map((h, i) => (
              <li key={i} className="grid grid-cols-[9.5rem_1fr] gap-x-3">
                <span className="text-xs text-sdc-gray-600">
                  <When iso={h.at} />
                </span>
                <span>
                  <span className="text-sdc-navy">{h.what}</span>
                  <span className="text-sdc-gray-600"> · {h.who}</span>
                  {h.why && <span className="block text-xs italic text-sdc-gray-600">{h.why}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      <div className="space-y-4">
        <Section title="Status">
          <p className="mb-2 text-sm">
            <strong className="text-sdc-navy">{task.statusName}</strong>
            {task.actualCompletionDate && (
              <span className="text-sdc-gray-600"> · done {shortDate(task.actualCompletionDate)}</span>
            )}
          </p>
          {task.blockedReason && <p className="mb-2 text-sm text-sdc-red-text">Blocked: {task.blockedReason}</p>}
          {mayChange && (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (target && moving) moveTo(target.id);
              }}
            >
              <select
                aria-label="Move to"
                value={statusId}
                onChange={(e) => {
                  setStatusId(e.target.value);
                  setOpenUnder(null);
                }}
                className={`${INPUT} w-full`}
              >
                {task.statuses.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id === task.statusId ? `${s.name} (now)` : `Move to ${s.name}`}
                  </option>
                ))}
              </select>
              {toBlocked && (
                <>
                  <input
                    required
                    value={blockedReason}
                    onChange={(e) => setBlockedReason(e.target.value)}
                    placeholder="What is blocking it?"
                    className={`${INPUT} w-full`}
                  />
                  <label className="flex flex-col gap-1 text-xs text-sdc-gray-600">
                    Expected to be unblocked (optional)
                    <input
                      type="date"
                      value={unblockDate}
                      onChange={(e) => setUnblockDate(e.target.value)}
                      className={INPUT}
                    />
                  </label>
                </>
              )}
              {moving && !openUnder && (
                <button type="submit" disabled={pending} className={BUTTON_PRIMARY}>
                  Move to {target.name}
                </button>
              )}
              {moving && openUnder && (target.category === "done" || target.category === "cancelled") && (
                <CloseUnderPrompt
                  cardKey={task.key}
                  cards={openUnder}
                  toName={target.name}
                  toCategory={target.category}
                  pending={pending}
                  onChoose={(choice) => moveTo(target.id, choice)}
                  onCancel={() => setOpenUnder(null)}
                />
              )}
            </form>
          )}
        </Section>

        {!closed && task.rollup && (
          <Section title="Forecast">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-sdc-gray-600">Contains</dt>
              <dd className="text-sdc-navy">
                {task.rollup.cards} {task.rollup.cards === 1 ? "card" : "cards"}, {task.rollup.done} done
              </dd>
              <dt className="text-sdc-gray-600">Left</dt>
              <dd className="text-sdc-navy">{hours(task.rollup.remainingHours)}</dd>
              <dt className="text-sdc-gray-600">Finishes</dt>
              <dd className="font-semibold text-sdc-navy">{shortDate(task.rollup.forecastFinish)}</dd>
              {task.dueDate && (
                <>
                  <dt className="text-sdc-gray-600">Due</dt>
                  <dd
                    className={
                      task.rollup.forecastFinish && task.rollup.forecastFinish > task.dueDate
                        ? "font-semibold text-sdc-red-text"
                        : "text-sdc-navy"
                    }
                  >
                    {shortDate(task.dueDate)}
                  </dd>
                </>
              )}
            </dl>
            <p className="mt-2 text-sm italic text-sdc-gray-600">
              Finishes when the cards under it do.
              {task.rollup.notForecast > 0 &&
                ` ${task.rollup.notForecast} of them ${task.rollup.notForecast === 1 ? "is" : "are"} not forecast, so the date is not the whole story.`}
            </p>
          </Section>
        )}

        {!closed && !task.rollup && (
          <Section title="Forecast">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-sdc-gray-600">Starts</dt>
              <dd className="text-sdc-navy">{shortDate(task.forecast.forecastStart)}</dd>
              <dt className="text-sdc-gray-600">Finishes</dt>
              <dd className="font-semibold text-sdc-navy">{shortDate(task.forecast.forecastFinish)}</dd>
              <dt className="flex items-center gap-1.5 text-sdc-gray-600">
                P80 <P80Help />
              </dt>
              <dd className="text-sdc-navy">{shortDate(task.forecast.p80Finish)}</dd>
              {task.dueDate && (
                <>
                  <dt className="text-sdc-gray-600">Due</dt>
                  <dd
                    className={
                      task.forecast.forecastFinish &&
                      (task.forecast.p80Finish ?? task.forecast.forecastFinish) > task.dueDate
                        ? "font-semibold text-sdc-red-text"
                        : "text-sdc-navy"
                    }
                  >
                    {shortDate(task.dueDate)}
                  </dd>
                </>
              )}
            </dl>
            <p className="mt-2 text-sm italic text-sdc-gray-600">
              {forecastReason({
                ...task.forecast,
                assigneeName: task.assigneeName,
                expectedUnblockDate: task.expectedUnblockDate,
              })}
            </p>
            {isTask && (
              <p className="mt-1 text-xs text-sdc-gray-600">
                Based on {task.remainingHours != null ? hours(task.remainingHours) : hours(task.estimateHours)} left.
              </p>
            )}
          </Section>
        )}

        <Section title="Dependencies">
          <div className="space-y-4">
            <Links
              title="Waits on"
              empty="Nothing. It can start as soon as its assignee is free."
              links={task.waitsOn}
              pending={pending}
              onRemove={
                mayChange
                  ? (l) =>
                      run(() =>
                        removeDependencyAction({
                          taskKey: task.key,
                          projectKey: task.projectKey,
                          predecessorId: l.taskId,
                          successorId: task.id,
                        }),
                      )
                  : undefined
              }
            />
            {mayChange && task.candidates.length > 0 && (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!waitOn) return;
                  run(
                    () =>
                      addDependencyAction({
                        taskKey: task.key,
                        projectKey: task.projectKey,
                        predecessorId: Number(waitOn),
                        successorId: task.id,
                        lagDays: Number(lag) || 0,
                      }),
                    () => {
                      setWaitOn("");
                      setLag("0");
                    },
                  );
                }}
              >
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-sdc-gray-600">
                  Make it wait on
                  <select required value={waitOn} onChange={(e) => setWaitOn(e.target.value)} className={INPUT}>
                    <option value="">Choose a card</option>
                    {/* This project's cards first, then each other project the viewer can see. */}
                    {[...new Set(task.candidates.map((c) => c.projectKey))].map((projectKey) => (
                      <optgroup
                        key={projectKey}
                        label={projectKey === task.projectKey ? "This project" : `Another project: ${projectKey}`}
                      >
                        {task.candidates
                          .filter((c) => c.projectKey === projectKey)
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.key} {c.title}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <label className="flex w-20 flex-col gap-1 text-xs text-sdc-gray-600">
                  + days
                  <input
                    inputMode="numeric"
                    value={lag}
                    onChange={(e) => setLag(e.target.value.replace(/[^0-9]/g, ""))}
                    className={INPUT}
                  />
                </label>
                <button type="submit" disabled={pending} className={BUTTON_COMPACT}>
                  Add
                </button>
              </form>
            )}
            <Links title="Waited on by" empty="Nothing waits on this." links={task.blocks} pending={pending} />
          </div>
        </Section>

        <Section title="Details">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-sdc-gray-600">Project</dt>
            <dd className="text-sdc-navy">{task.projectName}</dd>
            <dt className="text-sdc-gray-600">Kind</dt>
            <dd className="text-sdc-navy">{task.kindLabel}</dd>
            <dt className="text-sdc-gray-600">Requested by</dt>
            <dd className="text-sdc-navy">{task.requestedByName}</dd>
            <dt className="text-sdc-gray-600">Created by</dt>
            <dd className="text-sdc-navy">
              {task.createdByName} · <When iso={task.createdAt} />
            </dd>
            {task.notBeforeDate && (
              <>
                <dt className="text-sdc-gray-600">Not before</dt>
                <dd className="text-sdc-navy">
                  {shortDate(task.notBeforeDate)}
                  {task.notBeforeReason ? ` (${task.notBeforeReason})` : ""}
                </dd>
              </>
            )}
          </dl>
        </Section>
      </div>
    </div>
  );
}
