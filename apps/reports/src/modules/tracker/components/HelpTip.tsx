"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// A small "?" that opens a short explanation next to the thing it explains. It closes when the
// "?" is clicked again, when anything outside it is clicked, and on Escape.
//
// Everything inside is a <span>, so it can sit inside a <label> or a table heading. Pass the
// explanation as children, built from spans with "block" where a new line is wanted.

export function HelpTip({ label, children }: { label: string; children: React.ReactNode }) {
  // Where to draw the explanation, in window coordinates; null while it is closed. It is drawn
  // at the end of the page and fixed to the window, not inside its parent, for two reasons: a
  // scrolling table or card would cut it off, and this app's zoom control scales everything
  // inside the page, which would put it in the wrong place.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const open = at !== null;
  const setOpen = (next: boolean | ((was: boolean) => boolean)) =>
    setAt((was) => {
      const want = typeof next === "function" ? next(was !== null) : next;
      const el = box.current;
      if (!want || !el) return null;
      const r = el.getBoundingClientRect();
      // The app's zoom control scales the whole page, so a pixel on screen is not a CSS pixel.
      // How big the "?" is drawn against how big it is laid out gives the scale to undo.
      const scale = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
      const left = r.left / scale;
      // 320px wide (w-80): kept on screen when the "?" is near the right edge.
      return { top: r.bottom / scale + 6, left: Math.max(8, Math.min(left, window.innerWidth / scale - 328)) };
    });
  const box = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    // It does not follow the page, so it closes when the page moves under it.
    const moved = () => setAt(null);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    const away = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!box.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <span ref={box} className="relative inline-block normal-case tracking-normal">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={label}
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
      {at &&
        createPortal(
          <span
            ref={panel}
            role="dialog"
            aria-label={label}
            style={at}
            // A click inside is not a click on the label's field either.
            onClick={(e) => e.preventDefault()}
            className="fixed z-50 block w-80 cursor-default whitespace-normal rounded-lg border border-sdc-border bg-white p-3 text-left text-xs font-normal leading-snug text-sdc-navy shadow-lg"
          >
            {children}
          </span>,
          document.body,
        )}
    </span>
  );
}

/** What P80 means, wherever a P80 date is shown. */
export function P80Help() {
  return (
    <HelpTip label="What P80 means">
      <span className="mb-1 block font-semibold">P80: the date to promise</span>
      <span className="block">
        The 80th percentile. The forecast is run thousands of times, each time letting every estimate come in a little
        under or over. P80 is the date the work is finished by in 4 runs out of 5.
      </span>
      <span className="mt-2 block text-sdc-gray-600">
        The Forecast date is what happens if every estimate is exactly right, so it is the earlier of the two. P80 is
        blank until the simulation has run, and again after a change until it next runs.
      </span>
    </HelpTip>
  );
}
