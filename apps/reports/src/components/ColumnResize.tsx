"use client";

import { useEffect } from "react";

// Generic Excel-style column-width drag handle, wired up once at the document
// level (same pattern as ExcelCellFocus) so any table can opt a
// column into resizing just by rendering a `.col-resize-handle` element in
// that column's header cell — no per-page drag logic needed.
//
// The handle's `data-resize-var` names a CSS custom property, set on the
// nearest <table> while dragging, that every cell in that column reads via
// `style={{ width: "var(--that-property, <default>)" }}`. Custom properties
// inherit down the DOM, so one write on <table> reaches the header cell and
// every row's cell in that column at once, in sync, without React state.
//
// Widths persist to localStorage keyed by the CSS variable name, so a resize
// survives a reload. A MutationObserver (not just a mount-time pass) applies
// the saved width whenever a handle appears, because this component mounts
// once at the app root — client-side navigation between routes swaps in a
// brand-new table without remounting ColumnResize itself.
const STORAGE_PREFIX = "col-resize:";

// localStorage can throw (private mode, storage disabled, quota) — guarded like every
// other storage site in the repo, because an unguarded throw here used to leave a
// drag stuck: the body kept its col-resize cursor and user-select:none for the rest
// of the session (2026-09-14). Widths are a convenience; losing one is fine.
function readWidth(varName: string): string | null {
  try {
    return localStorage.getItem(STORAGE_PREFIX + varName);
  } catch {
    return null;
  }
}

function writeWidth(varName: string, value: string): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + varName, value);
  } catch {
    // Not persisted; the width still applies for this page.
  }
}

function restoreWidth(handle: HTMLElement) {
  const table = handle.closest("table");
  const varName = handle.dataset.resizeVar;
  if (!table || !varName) return;
  const saved = readWidth(varName);
  if (saved) table.style.setProperty(varName, saved);
}

export default function ColumnResize() {
  useEffect(() => {
    let drag: {
      table: HTMLTableElement;
      varName: string;
      startX: number;
      startWidth: number;
      min: number;
      max: number;
    } | null = null;

    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const handle = target.closest<HTMLElement>(".col-resize-handle");
      if (!handle) return;
      const table = handle.closest("table");
      const varName = handle.dataset.resizeVar;
      const column = handle.parentElement;
      if (!table || !varName || !column) return;

      const current = getComputedStyle(table).getPropertyValue(varName).trim();
      const startWidth = current ? parseFloat(current) : column.getBoundingClientRect().width;
      drag = {
        table,
        varName,
        startX: e.clientX,
        startWidth,
        min: Number(handle.dataset.resizeMin) || 80,
        max: Number(handle.dataset.resizeMax) || 800,
      };
      // Match Excel: the whole page shows a resize cursor and can't select
      // text while dragging, not just while the pointer is over the thin
      // handle itself (which it won't be once the drag moves the column edge
      // away from the cursor's original position).
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    }

    function onPointerMove(e: PointerEvent) {
      if (!drag) return;
      const next = Math.min(drag.max, Math.max(drag.min, drag.startWidth + (e.clientX - drag.startX)));
      drag.table.style.setProperty(drag.varName, `${next}px`);
      e.preventDefault();
    }

    function onPointerUp() {
      if (!drag) return;
      const ended = drag;
      // The drag state and the body styles are reset FIRST, unconditionally, so
      // nothing that follows can leave them behind.
      drag = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        writeWidth(ended.varName, getComputedStyle(ended.table).getPropertyValue(ended.varName).trim());
      } catch {
        // A detached table (the grid re-rendered mid-drag) has no computed style
        // worth saving.
      }
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);

    // Restore whatever's already on the page now, then keep watching for
    // handles that appear later (client-side navigation to another table).
    document.querySelectorAll<HTMLElement>(".col-resize-handle").forEach(restoreWidth);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (node.matches(".col-resize-handle")) restoreWidth(node);
          node.querySelectorAll?.(".col-resize-handle").forEach((el) => restoreWidth(el as HTMLElement));
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
      observer.disconnect();
    };
  }, []);

  return null;
}
