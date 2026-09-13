"use client";

import { useEffect } from "react";

// Excel-style grid behavior, wired up once at the document level so it
// covers every table's inputs/selects app-wide, including server-rendered
// ones with no client handlers of their own.
//
// 1. Focusing a numeric cell selects its whole value, so typing replaces it
//    (like Excel) instead of appending. This is also what makes Delete and
//    Backspace CLEAR a cell rather than nibble a digit off it: the value is
//    already fully selected when the caret lands, so either key empties the box,
//    which fires the normal change/autosave path (an empty value is a real edit —
//    see saveAllNewEtcDrafts).
// 2. Arrow keys move focus between cells instead of just the text cursor.
//    Left/Right step through the focused row's cells in DOM order; Up/Down
//    (and Enter/Shift+Enter) jump to the adjacent row's cell that's
//    horizontally closest — this handles rowSpan'd label columns (e.g.
//    "Billing Group") correctly without needing a real column index.
// 3. Escape cancels the edit in progress and restores the last value the SERVER
//    sent for that cell, the way Escape works in a spreadsheet. Cells declare
//    that value in `data-baseline` (the same attribute lib/dirty-form.ts uses to
//    decide what to submit), so this needs no per-grid wiring: a cell that
//    declares one gets Escape, one that doesn't is left alone rather than being
//    reset to a guess.

const FOCUSABLE_SELECTOR = 'input[type="number"], input[type="text"], select';

// Write a value into a React-controlled input the way a user would, so React's
// onChange runs and the component's own state, the dirty tracker and the autosave
// debounce all see it. Assigning `el.value` directly would update the DOM only, and
// the next render would paint the old state straight back over it.
function setControlledValue(el: HTMLInputElement, next: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(el, next);
  else el.value = next;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function isGridCell(el: EventTarget | null): el is HTMLInputElement | HTMLSelectElement {
  return (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) && !!el.closest("td");
}

function focusablesInRow(row: HTMLTableRowElement): HTMLElement[] {
  return Array.from(row.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

function moveFocus(el: HTMLElement) {
  el.focus();
  if (el instanceof HTMLInputElement) el.select();
}

export default function ExcelCellFocus() {
  useEffect(() => {
    function onFocusIn(e: FocusEvent) {
      const el = e.target;
      if (el instanceof HTMLInputElement && el.type === "number" && el.closest("td")) {
        el.select();
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      const el = e.target;
      if (!isGridCell(el)) return;

      // Escape — abandon this edit and put back what was last saved. Only for cells
      // that declare a baseline; without one there is nothing to restore to, and
      // guessing (blanking the cell, say) would be worse than doing nothing.
      if (e.key === "Escape") {
        if (!(el instanceof HTMLInputElement)) return;
        const baseline = el.getAttribute("data-baseline");
        if (baseline === null) return;
        e.preventDefault();
        if (el.value !== baseline) setControlledValue(el, baseline);
        el.select();
        return;
      }

      const isArrow = e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown";
      if (!isArrow && e.key !== "Enter") return;

      // Don't hijack left/right cursor movement inside partially-edited text —
      // only navigate cells when the field's whole value is still selected
      // (i.e. the user hasn't started typing yet), like Excel's edit vs.
      // navigation modes.
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && el instanceof HTMLInputElement && el.type === "text") {
        const fullySelected = el.selectionStart === 0 && el.selectionEnd === el.value.length && el.value.length > 0;
        if (!fullySelected) return;
      }

      // Number inputs natively increment/decrement their value on Up/Down —
      // always prevent that, even if there's no adjacent cell to move to.
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && el instanceof HTMLInputElement && el.type === "number") {
        e.preventDefault();
      }

      const row = el.closest("tr");
      const table = el.closest("table");
      if (!row || !table) return;

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const rowCells = focusablesInRow(row);
        const index = rowCells.indexOf(el);
        const nextIndex = e.key === "ArrowLeft" ? index - 1 : index + 1;
        if (nextIndex < 0 || nextIndex >= rowCells.length) return;
        e.preventDefault();
        moveFocus(rowCells[nextIndex]);
        return;
      }

      // Up/Down/Enter/Shift+Enter: find the nearest row (skipping empty
      // ones) in the requested direction, then pick whichever of its cells
      // sits closest, horizontally, to the cell we're leaving.
      const goingUp = e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey);
      const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>("tbody tr, tfoot tr"));
      const rowIndex = rows.indexOf(row);
      if (rowIndex === -1) return;

      const step = goingUp ? -1 : 1;
      let searchIndex = rowIndex + step;
      let candidates: HTMLElement[] = [];
      while (searchIndex >= 0 && searchIndex < rows.length) {
        candidates = focusablesInRow(rows[searchIndex]);
        if (candidates.length > 0) break;
        searchIndex += step;
      }
      if (candidates.length === 0) return;

      const centerX = el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2;
      let best = candidates[0];
      let bestDist = Infinity;
      for (const candidate of candidates) {
        const rect = candidate.getBoundingClientRect();
        const dist = Math.abs(rect.left + rect.width / 2 - centerX);
        if (dist < bestDist) {
          bestDist = dist;
          best = candidate;
        }
      }
      e.preventDefault();
      moveFocus(best);
    }

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return null;
}
