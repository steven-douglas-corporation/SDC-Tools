"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { BUTTON_COMPACT, BUTTON_COMPACT_DANGER } from "@/components/ui/classnames";

// Asked before a card is archived, in front of the page so it cannot be missed or mistaken
// for part of the form. Nothing has changed yet. It says what goes with the card, because a
// card with cards under it takes them along.

export function ArchivePrompt({
  cardKey,
  title,
  underCount,
  pending,
  onArchive,
  onKeep,
}: {
  cardKey: string;
  title: string;
  /** Unarchived cards under this one, at any depth. */
  underCount: number;
  pending: boolean;
  onArchive: () => void;
  onKeep: () => void;
}) {
  const keep = useRef<HTMLButtonElement>(null);

  // Opens on the safe choice, and Escape takes it.
  useEffect(() => {
    keep.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onKeep();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKeep]);

  const many = underCount > 0;
  // Drawn at the top of the page, not inside the card's form: there it sat under the form's own
  // buttons and took on its fading.
  return createPortal(
    <div
      className="motion-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onKeep();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="archive-title"
        aria-describedby="archive-text"
        className="motion-dialog w-full max-w-md rounded-xl border border-sdc-border bg-white p-5 shadow-xl"
      >
        <h2 id="archive-title" className="text-base font-semibold text-sdc-navy">
          {many
            ? `Archive ${cardKey} and the ${underCount} card${underCount === 1 ? "" : "s"} under it?`
            : `Archive ${cardKey}?`}
        </h2>
        <p className="mt-1 truncate text-sm text-sdc-gray-600" title={title}>
          {title}
        </p>
        <ul id="archive-text" className="mt-3 list-disc space-y-1 pl-5 text-sm text-sdc-navy">
          <li>{many ? "They leave" : "It leaves"} the board, the timeline and the forecast.</li>
          <li>Nothing waits on {many ? "them" : "it"} any more.</li>
          <li>{many ? "Their" : "Its"} history is kept.</li>
        </ul>
        <p className="mt-3 text-sm font-semibold text-sdc-red-text">This cannot be undone here.</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button ref={keep} type="button" disabled={pending} className={BUTTON_COMPACT} onClick={onKeep}>
            Keep {many ? "them" : "it"}
          </button>
          <button type="button" disabled={pending} className={BUTTON_COMPACT_DANGER} onClick={onArchive}>
            {pending ? "Archiving…" : many ? `Archive all ${underCount + 1}` : "Archive"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
