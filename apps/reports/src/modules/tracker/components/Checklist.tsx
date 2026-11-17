"use client";

import { useRef, useState, useTransition } from "react";
import { BUTTON_COMPACT, INPUT } from "@/components/ui/classnames";
import { checklistAction, type ChecklistChange } from "../actions";
import type { ChecklistItem } from "../service/task-detail";

// A card's checklist: small steps to tick off. It is a reminder list only, so it says so:
// ticking items never moves the forecast, and work that needs an owner or hours is a card.

/** A short "who, when" for a ticked item, in the reader's own time zone. */
function tickedBy(item: ChecklistItem): string | undefined {
  if (!item.doneAt) return undefined;
  const when = new Date(item.doneAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Ticked by ${item.doneBy ?? "someone"}, ${when}`;
}

export function Checklist({
  taskId,
  taskKey,
  projectKey,
  items,
  mayChange,
}: {
  taskId: number;
  taskKey: string;
  projectKey: string;
  items: ChecklistItem[];
  mayChange: boolean;
}) {
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const addBox = useRef<HTMLInputElement>(null);
  function send(change: ChecklistChange, done?: () => void) {
    setError("");
    start(async () => {
      const res = await checklistAction({ taskId, taskKey, projectKey, change });
      if (!res.ok) return setError(res.error);
      done?.();
    });
  }

  const ticked = items.filter((i) => i.done).length;

  return (
    <div>
      {items.length === 0 ? (
        <p className="text-sm text-sdc-gray-600">
          No checklist yet. Use one for small steps that are not worth cards of their own.
        </p>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-3">
            <div
              className="h-2 flex-1 overflow-hidden rounded-full bg-sdc-gray-100"
              role="progressbar"
              aria-label="Checklist items ticked"
              aria-valuemin={0}
              aria-valuemax={items.length}
              aria-valuenow={ticked}
            >
              <div
                className={`h-full rounded-full ${ticked === items.length ? "bg-sdc-green" : "bg-sdc-blue"}`}
                style={{ width: `${(ticked / items.length) * 100}%` }}
              />
            </div>
            <span className="text-xs font-semibold text-sdc-navy">
              {ticked} of {items.length} ticked
            </span>
          </div>
          <ul className="space-y-1">
            {items.map((item, i) => (
              <li key={item.id} className="flex items-start gap-2 text-sm">
                {editing?.id === item.id ? (
                  <form
                    className="flex flex-1 flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      send({ do: "rename", itemId: item.id, body: editing.body }, () => setEditing(null));
                    }}
                  >
                    <input
                      autoFocus
                      required
                      maxLength={500}
                      aria-label="Checklist item"
                      value={editing.body}
                      onChange={(e) => setEditing({ id: item.id, body: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setEditing(null);
                      }}
                      className={`${INPUT} min-w-0 flex-1`}
                    />
                    <button type="submit" disabled={pending} className={BUTTON_COMPACT}>
                      Save
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      className={BUTTON_COMPACT}
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <label className="flex min-w-0 flex-1 items-start gap-2 py-1" title={tickedBy(item)}>
                      <input
                        type="checkbox"
                        checked={item.done}
                        disabled={!mayChange || pending}
                        onChange={(e) => send({ do: "tick", itemId: item.id, done: e.target.checked })}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-sdc-blue"
                      />
                      <span className={`break-words ${item.done ? "text-sdc-gray-400 line-through" : "text-sdc-navy"}`}>
                        {item.body}
                      </span>
                    </label>
                    {mayChange && (
                      <span className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          disabled={pending || i === 0}
                          className={BUTTON_COMPACT}
                          aria-label={`Move "${item.body}" up`}
                          title="Move up"
                          onClick={() => send({ do: "move", itemId: item.id, direction: "up" })}
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          disabled={pending || i === items.length - 1}
                          className={BUTTON_COMPACT}
                          aria-label={`Move "${item.body}" down`}
                          title="Move down"
                          onClick={() => send({ do: "move", itemId: item.id, direction: "down" })}
                        >
                          ▼
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          className={BUTTON_COMPACT}
                          aria-label={`Edit "${item.body}"`}
                          onClick={() => setEditing({ id: item.id, body: item.body })}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          className={BUTTON_COMPACT}
                          aria-label={`Remove "${item.body}"`}
                          onClick={() => send({ do: "remove", itemId: item.id })}
                        >
                          Remove
                        </button>
                      </span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {mayChange && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send({ do: "add", body: text }, () => {
              setText("");
              // The box is never disabled, so it can take the next item without another click.
              addBox.current?.focus();
            });
          }}
        >
          <input
            ref={addBox}
            required
            maxLength={500}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Add an item"
            aria-label="Add a checklist item"
            className={`${INPUT} min-w-0 flex-1`}
          />
          <button type="submit" disabled={pending} className={BUTTON_COMPACT}>
            Add
          </button>
        </form>
      )}
      {error && <p className="mt-2 text-sm text-sdc-red-text">{error}</p>}
      {items.length > 0 && (
        <p className="mt-3 text-xs text-sdc-gray-600">
          A checklist is a reminder list. Ticking items does not change the hours left or the forecast.
        </p>
      )}
    </div>
  );
}
