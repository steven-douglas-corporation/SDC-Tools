"use client";

import { useEffect, useRef, useState } from "react";
import type { WorkKind } from "../service/queries";

// The "?" beside a Kind field. It opens a small picture of the kinds as a list from the top
// down, with one line on what each is for and what can go under what.
//
// It closes when the "?" is clicked again, when anything outside it is clicked, and on Escape.
// The list comes from the kinds the database holds, so the picture cannot drift from the rule.

const WHAT_FOR: Record<string, string> = {
  epic: "A large goal that takes many weeks and is delivered in pieces.",
  feature: "One thing the result can do, or one piece of an Epic.",
  story: "A slice of a Feature that is useful by itself.",
  task: "A piece of work one person does. The default.",
  bug: "Something that is built and does not work as it should.",
  issue: "A problem or open question that needs someone to act.",
  milestone: "A date that matters, with no work of its own.",
};

export function KindHelp({ kinds }: { kinds: WorkKind[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const levels = [...new Set(kinds.map((k) => k.level))].sort((a, b) => a - b);
  const top = kinds.find((k) => k.level === levels[0])?.label ?? "The top kind";

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <span ref={box} className="relative inline-block normal-case tracking-normal">
      <button
        type="button"
        aria-label="What the kinds mean"
        aria-expanded={open}
        title="What the kinds mean"
        // Inside a <label>: without this the click would also land on the field the label is for.
        onClick={(e) => {
          e.preventDefault();
          setOpen((was) => !was);
        }}
        className={`flex h-4 w-4 items-center justify-center rounded-full border text-micro font-bold ${
          open
            ? "border-sdc-blue text-sdc-blue"
            : "border-sdc-gray-400 text-sdc-gray-600 hover:border-sdc-blue hover:text-sdc-blue"
        }`}
      >
        ?
      </button>
      {open && (
        <span
          role="dialog"
          aria-label="What the kinds mean"
          // A click inside is not a click on the label's field either.
          onClick={(e) => e.preventDefault()}
          className="absolute left-0 top-6 z-20 block w-80 cursor-default rounded-lg border border-sdc-border bg-white p-3 text-xs font-normal text-sdc-navy shadow-lg"
        >
          <span className="mb-2 block font-semibold">What can go under what</span>
          <span className="block space-y-1.5">
            {levels.map((level, i) => (
              // Each level is indented a little more than the one above, like the cards themselves.
              <span key={level} style={{ marginLeft: i * 14 }} className="block border-l-2 border-sdc-blue pl-2">
                {kinds
                  .filter((k) => k.level === level)
                  .map((k) => (
                    <span key={k.key} className="block leading-snug">
                      <strong>{k.label}</strong>
                      <span className="text-sdc-gray-600"> {WHAT_FOR[k.key] ?? ""}</span>
                    </span>
                  ))}
              </span>
            ))}
          </span>
          <span className="mt-2 block text-sdc-gray-600">
            A card can go under any card higher in this list, and levels can be skipped: a Story can go straight under
            an Epic. {top} is the top, so it goes under nothing. Nothing goes under the bottom level. A card with cards
            under it shows what they add up to and finishes when they do.
          </span>
        </span>
      )}
    </span>
  );
}
