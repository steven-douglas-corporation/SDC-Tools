"use client";

import { BUTTON_COMPACT } from "@/components/ui/classnames";
import type { OpenCard } from "../service/tasks";

// Asked when someone closes a card that still has open cards under it. Nothing has been moved
// yet. The open cards are usually one of two things: work that was done and never updated, or
// work that is no longer needed. Only the person closing the card knows which, so they choose.

const SHOWN = 6;

export function CloseUnderPrompt({
  cardKey,
  cards,
  toName,
  toCategory,
  pending,
  onChoose,
  onCancel,
}: {
  cardKey: string;
  cards: OpenCard[];
  toName: string;
  toCategory: "done" | "cancelled";
  pending: boolean;
  onChoose: (closeUnder: "done" | "cancelled") => void;
  onCancel: () => void;
}) {
  const n = cards.length;
  return (
    <div
      className="mt-3 space-y-2 border-t border-sdc-border-soft pt-3 text-xs"
      role="alertdialog"
      aria-label="Open cards"
    >
      <p className="font-semibold text-sdc-navy">
        {n} card{n === 1 ? "" : "s"} under {cardKey} {n === 1 ? "is" : "are"} still open:
      </p>
      <ul className="space-y-0.5 text-sdc-gray-600">
        {cards.slice(0, SHOWN).map((c) => (
          <li key={c.id}>
            <span className="font-mono font-semibold text-sdc-navy">{c.key}</span> {c.title}
            <span> ({c.statusName})</span>
          </li>
        ))}
        {n > SHOWN && <li>and {n - SHOWN} more</li>}
      </ul>
      <p className="text-sdc-gray-600">
        Moving {cardKey} to {toName} closes {n === 1 ? "it" : "them"} as well. Nothing has changed yet.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={BUTTON_COMPACT} onClick={onCancel}>
          Leave everything as it is
        </button>
        <button type="button" disabled={pending} className={BUTTON_COMPACT} onClick={() => onChoose("cancelled")}>
          Cancel {n === 1 ? "it" : "them"}
        </button>
        {toCategory === "done" && (
          <button type="button" disabled={pending} className={BUTTON_COMPACT} onClick={() => onChoose("done")}>
            Mark {n === 1 ? "it" : "them"} done
          </button>
        )}
      </div>
    </div>
  );
}
