"use client";

import { useEffect } from "react";
import { DATE_CELL_SELECTOR } from "@/lib/date-cell";

// Behaviour for every date cell in a grid — ONE component, not one per cell.
//
// ── Why (2026-08-03) ────────────────────────────────────────────────────────
// DateCell was a client component per cell: two per row, so 466 hydration roots
// on the Projects grid with "Show all". All it did was open the picker on click,
// open it on Enter/Space, and toggle a CSS class when the value emptied — pure
// event handling plus one class, which a delegated listener does for the whole
// table at once. Same reasoning as JobCellMenuHost.
//
// The cells are now plain server-rendered <input type="date">s carrying
// `data-date-cell` (see lib/date-cell.ts).
export function GridDateCells() {
  useEffect(() => {
    const cellOf = (t: EventTarget | null) => (t as HTMLElement | null)?.closest<HTMLInputElement>(DATE_CELL_SELECTOR) ?? null;

    // showPicker() must run inside a user gesture and throws if the browser
    // won't oblige (unsupported, or already open) — swallow that rather than
    // break the click, since the input is still perfectly typeable either way.
    const openPicker = (el: HTMLInputElement) => {
      try {
        el.showPicker();
      } catch {
        /* keyboard entry still works */
      }
    };

    // mousedown, not click: mousedown is what focuses a date segment, so opening
    // here means ONE click gets the calendar rather than one to land on a segment
    // and another to open anything.
    const onMouseDown = (e: MouseEvent) => {
      // Left button only — right-click belongs to the browser's own menu (and,
      // on the Job columns, to JobCellMenuHost).
      if (e.button !== 0) return;
      const el = cellOf(e.target);
      if (!el || el.disabled) return;
      e.preventDefault(); // don't put the caret in a date segment first
      el.focus();
      openPicker(el);
    };

    // Keyboard parity: Enter/Space on a focused cell opens the same calendar.
    // Arrows and digits are left alone so typing a date still works.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const el = cellOf(e.target);
      if (!el || el.disabled) return;
      e.preventDefault();
      openPicker(el);
    };

    // Keeps `date-empty` in step as a date is picked or cleared, so a freshly
    // picked date shows immediately instead of waiting for a server re-render.
    const onInput = (e: Event) => {
      const el = cellOf(e.target);
      if (!el) return;
      el.classList.toggle("date-empty", el.value === "");
    };

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("input", onInput);
    document.addEventListener("change", onInput);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("input", onInput);
      document.removeEventListener("change", onInput);
    };
  }, []);

  return null;
}
