"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, INPUT, LABEL } from "@/components/ui/classnames";
import { createTaskAction } from "../actions";
import type { Board as BoardData } from "../service/queries";
import { KindHelp } from "./KindHelp";

// The "New card" button on a board, and the form it opens over the board. The form holds every
// field a card can be given when it is made, which a row along the top of the board had no room
// for. "Save and add another" keeps the form open, for entering several cards in a row.
//
// Closing it with something typed asks first: Escape or a stray click outside must not throw
// away a description somebody has just written.

export function NewCardDialog({ board }: { board: BoardData }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={opener} type="button" className={BUTTON_PRIMARY} onClick={() => setOpen(true)}>
        New card
      </button>
      {open && (
        <Form
          board={board}
          onClose={() => {
            setOpen(false);
            // Back to where the keyboard was, or a keyboard user is left at the top of the page.
            opener.current?.focus();
          }}
        />
      )}
    </>
  );
}

function Form({ board, onClose }: { board: BoardData; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("task");
  const [parentId, setParentId] = useState("");
  const [bucketId, setBucketId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [requestedById, setRequestedById] = useState("");
  const [priority, setPriority] = useState("3");
  const [dueDate, setDueDate] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [added, setAdded] = useState("");
  // Set while the person is being asked whether to throw away what they typed.
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();
  const panel = useRef<HTMLFormElement>(null);
  const titleBox = useRef<HTMLInputElement>(null);

  const isMilestone = kind === "milestone";
  const levelOf = (label: string) => board.kinds.find((k) => k.label === label)?.level ?? Infinity;
  const ownLevel = board.kinds.find((k) => k.key === kind)?.level ?? Infinity;
  // Only cards of a higher kind: the same rule the service and the database enforce.
  const parents = board.tasks.filter((t) => levelOf(t.kindLabel) < ownLevel);
  // Only what was typed counts. A choice from a list is quick to make again.
  const dirty = title.trim() !== "" || description.trim() !== "";

  function tryClose() {
    if (pending) return;
    if (dirty) setAsking(true);
    else onClose();
  }
  // The key handler below is set up once, so it reaches the latest tryClose through this.
  const tryCloseRef = useRef(tryClose);
  useEffect(() => {
    tryCloseRef.current = tryClose;
  });

  // The board behind holds still while the form is open, without the page jumping sideways
  // when its scrollbar goes.
  useEffect(() => {
    const { body } = document;
    const overflow = body.style.overflow;
    const padding = body.style.paddingRight;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (gap > 0) body.style.paddingRight = `${gap}px`;
    return () => {
      body.style.overflow = overflow;
      body.style.paddingRight = padding;
    };
  }, []);

  useEffect(() => {
    titleBox.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // An open "?" explanation takes the Escape for itself.
        if (panel.current?.querySelector('[aria-expanded="true"]')) return;
        tryCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      // Tab stays inside the form, so it cannot wander onto the board behind.
      const stops = panel.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
      );
      if (!stops || stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // After "Save and add another", the keyboard goes back to the title. Done here, not in save(),
  // because the fields are switched off while a save is running and cannot take it until then.
  useEffect(() => {
    if (!pending && added) titleBox.current?.focus();
  }, [pending, added]);

  function save(another: boolean) {
    // The browser's own check, so a missing title is pointed at in the usual way.
    if (!panel.current?.reportValidity()) return;
    setError("");
    setAdded("");
    start(async () => {
      const res = await createTaskAction({
        projectId: board.project.id,
        projectKey: board.project.key,
        title,
        type: isMilestone ? "milestone" : "task",
        kind,
        effortBucketId: bucketId ? Number(bucketId) : null,
        assigneePersonId: assigneeId ? Number(assigneeId) : null,
        dueDate: dueDate || null,
        description: description.trim() || null,
        parentTaskId: parentId ? Number(parentId) : null,
        requestedByPersonId: requestedById ? Number(requestedById) : null,
        priority: Number(priority),
      });
      if (!res.ok) return setError(res.error);
      if (!another) return onClose();
      // What differs from card to card is cleared. Kind, parent, people and priority stay,
      // because several cards entered together usually share them.
      setAdded(`${res.key} added.`);
      setTitle("");
      setDescription("");
      setBucketId("");
      setDueDate("");
    });
  }

  return (
    <div
      className="motion-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        // Only a press on the dimmed area itself. A press inside the form, or in a "?"
        // explanation drawn outside it, also arrives here and must not close anything.
        if (e.target === e.currentTarget) tryClose();
      }}
    >
      <form
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-card-title"
        className="motion-dialog styled-scrollbar max-h-full w-full max-w-2xl overflow-y-auto rounded-xl border border-sdc-border bg-white p-5 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          save(false);
        }}
      >
        <h2 id="new-card-title" className="mb-4 text-base font-semibold text-sdc-navy">
          New card in {board.project.name}
        </h2>

        {/* Switched off while a save is running: anything typed then would be wiped when it lands. */}
        <fieldset disabled={pending} className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className={LABEL}>Title</span>
            <input
              ref={titleBox}
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs doing"
              className={INPUT}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className={`${LABEL} flex items-center gap-1.5`}>
              Kind <KindHelp kinds={board.kinds} />
            </span>
            <select
              value={kind}
              onChange={(e) => {
                const next = e.target.value;
                setKind(next);
                // A parent that the new kind cannot go under is dropped, not sent and refused.
                const nextLevel = board.kinds.find((k) => k.key === next)?.level ?? Infinity;
                const parent = board.tasks.find((t) => t.id === Number(parentId));
                if (parent && levelOf(parent.kindLabel) >= nextLevel) setParentId("");
              }}
              className={INPUT}
            >
              {board.kinds.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className={LABEL}>Sits under</span>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              disabled={parents.length === 0}
              className={INPUT}
            >
              <option value="">{parents.length === 0 ? "Nothing it can go under yet" : "Nothing"}</option>
              {parents.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.key} {t.title} ({t.kindLabel})
                </option>
              ))}
            </select>
          </label>

          {!isMilestone && (
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

          {!isMilestone && (
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
            <span className={LABEL}>Requested by</span>
            <select value={requestedById} onChange={(e) => setRequestedById(e.target.value)} className={INPUT}>
              <option value="">Me</option>
              {board.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className={LABEL}>Priority</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value)} className={INPUT}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                  {n === 1 ? " (highest)" : n === 5 ? " (lowest)" : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className={LABEL}>Due</span>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={INPUT} />
          </label>

          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className={LABEL}>Description</span>
            <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} className={INPUT} />
          </label>
        </fieldset>

        {/* Always here, so a message arriving does not move the buttons under the pointer. */}
        <p aria-live="polite" className="mt-3 min-h-5 text-sm">
          {error ? (
            <span className="text-sdc-red-text">{error}</span>
          ) : (
            added && <span className="text-sdc-green-text">{added}</span>
          )}
        </p>

        {asking ? (
          <div
            role="alertdialog"
            aria-label="Close without saving"
            className="mt-2 flex flex-wrap items-center justify-end gap-2"
          >
            <span className="mr-auto text-sm text-sdc-navy">Close without saving this card?</span>
            <button type="button" className={BUTTON_SECONDARY} onClick={() => setAsking(false)}>
              Keep editing
            </button>
            <button type="button" className={BUTTON_SECONDARY} onClick={onClose}>
              Close without saving
            </button>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <button type="button" disabled={pending} className={BUTTON_SECONDARY} onClick={tryClose}>
              Cancel
            </button>
            <button type="button" disabled={pending} className={BUTTON_SECONDARY} onClick={() => save(true)}>
              Save and add another
            </button>
            <button type="submit" disabled={pending} className={BUTTON_PRIMARY}>
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
