"use client";

import { useRef, type ReactNode } from "react";

// Click-and-drag panning for a scrollable container (grab the grid and drag to
// scroll, like the Scheduler). Renders the scroll container itself, so callers
// just swap their `<div className="… overflow-auto">` for `<DragScroll className=…>`.
//
// ── Why this is more than "ignore interactive elements" ──────────────────────
// It used to bail on any mousedown inside an input/select/link/button, so panning
// only worked on the "dead" parts of a grid. On the Projects grid there are almost
// none: every cell holds an input or a dropdown — job name, customer, type,
// billable, status, both dates, thirteen section-hour cells, two money cells — so
// dragging did nothing almost everywhere, which is exactly how it was reported.
//
// The rule now distinguishes two kinds of interactive content:
//
//   NEVER pan from these — the mousedown IS the interaction, and suppressing it
//   would break them: a <select> must open its dropdown, a date input opens its
//   picker (GridDateCells calls showPicker on mousedown), links/buttons/summaries act.
//
//   PAN from a text or number input that is NOT currently focused. So the first
//   press on a cell pans, and once you are actually editing that cell, dragging
//   inside it selects text as usual.
//
// ── The first click focuses the cell again (§38.1, 2026-08-04) ───────────────
//
// This used to call preventDefault() on every mousedown over an unfocused cell input,
// to stop a pan-that-turned-out-to-be-a-click from dropping a caret into live data.
// The cost of that was the first symptom §38 reports: a single click on a cell did
// NOTHING VISIBLE. Focus is this grid's only selection model — the input IS the cell —
// so suppressing focus suppressed selection, and the user had to click again (or
// double-click) to get anywhere. §38.1 forbids exactly that ("the first click must
// never be ignored"), and §38.16 #3 asks for the opposite behaviour outright.
//
// The gesture is separated by MOVEMENT instead of by click count, which is what
// actually distinguishes a pan from a click:
//
//   press, don't move  -> the browser focuses the cell. It is selected, immediately.
//   press, move >3px   -> blur, drop the text selection, and pan.
//
// A caret in a cell is not an edit — nothing is written until a value changes — and it
// is exactly what "selecting a cell" looks like on a grid whose cells are inputs.
// Double-click still selects the whole value, as a spreadsheet does.
// ── One drag surface, from ANYWHERE in the grid (2026-09-01) ────────────────
//
// This list used to also contain `a`, `button`, `summary`, `label` and
// `[role='button']`. That is what made the Projects grid feel like only its
// HEADER could be dragged, which is exactly how it was reported.
//
// The grid's STICKY LEFT columns — the frozen job information anyone would
// naturally grab to pan a wide table — are built almost entirely from those
// elements: Job Id and Job Name are <Link>s, the row menu is a [role=button],
// and Type / Billable / Status are <select>s. Every press there was "ignore",
// so the one place with an obvious affordance did nothing. The numeric cells to
// the right always panned (they are bare <input type="number">, which reads as
// "pan" while unfocused), but by then the user had already concluded that only
// the header worked.
//
// A link or a button is safe to pan from because mousedown does NOT activate
// it — the CLICK does, and onClickCapture below swallows the click when a pan
// actually happened. So a press that never moves still navigates or activates
// normally, and a press that moves pans instead. That is the same
// movement-decides-the-gesture rule the cell inputs already used.
//
// What genuinely cannot pan, and why the mousedown itself is the interaction:
//
//   select                — the native dropdown opens on mousedown. Suppressing
//                           that to pan would need preventDefault, which is
//                           what §38.1 forbids (it also cancels the click).
//   input[type='date']    — GridDateCells calls showPicker() on mousedown.
//   [contenteditable]     — the caret is placed on mousedown.
//   checkbox / radio      — no technical obstacle (they activate on click, so
//                           suppression would cover them), but they are ~16px
//                           targets nobody grabs to pan a table, and starting a
//                           drag from one is far more likely to be an accident
//                           than an intent. Left out deliberately.
const NEVER_PAN = [
  "select",
  "[contenteditable]",
  "input[type='date']",
  "input[type='checkbox']",
  "input[type='radio']",
].join(",");

// Past this much movement the press is a pan, not a click. 6px sits inside the
// 5-8px the request asks for: comfortably above the 1-2px wobble of a deliberate
// click, comfortably below any movement a person means as a drag.
const DRAG_THRESHOLD_PX = 6;

/**
 * What a mousedown on this grid means. Pure, and exported, because getting it wrong in
 * either direction is a reported bug: too eager and a `<select>` never opens or a
 * focused cell cannot be text-selected, too shy and the grid stops panning.
 *
 *   "ignore"  — not ours: a control whose mousedown IS the interaction, or a grid with
 *               nothing to scroll.
 *   "editing" — a text input that already has focus. Leave the press completely alone
 *               so selecting inside the value still works.
 *   "pan"     — anything else. Track for movement; the browser is left to do its own
 *               focusing, so a press that never moves is a plain click on a cell.
 *
 * The §34.2 stale-border rule that used to live here is GONE, along with the
 * preventDefault that made it necessary: focus now transfers the way the browser
 * transfers it, so no cell can be left outlined after the pointer has moved on.
 */
export type PressKind = "ignore" | "editing" | "pan";

export function pressKindFor(opts: {
  neverPan: boolean;
  scrollable: boolean;
  isTextish: boolean;
  alreadyFocused: boolean;
}): PressKind {
  if (opts.neverPan) return "ignore";
  if (!opts.scrollable) return "ignore";
  if (opts.isTextish && opts.alreadyFocused) return "editing";
  return "pan";
}

export function DragScroll({
  className,
  children,
  scrollRef,
  style,
  scrollKey,
}: {
  className?: string;
  children: ReactNode;
  /**
   * The element that actually scrolls, handed back to the caller.
   *
   * Added 2026-09-04 for the Parts List's row windowing, which has to read scrollTop
   * and clientHeight off this exact element. A wrapper ref would not do: the overflow
   * lives here, so a parent's scrollTop is always 0.
   */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  /**
   * A stable name for this scroller, so its position survives a tab switch by NAME
   * rather than by where it happens to sit in the DOM tree.
   *
   * Added 2026-09-04 with the per-tab scroll restore (lib/tab-scroll-state.ts). That
   * mechanism falls back to a structural path, which is enough for a hide-and-show but
   * cannot survive a re-render that changes the tree above the scroller — and the grids
   * this component wraps are exactly the positions worth not losing.
   */
  scrollKey?: string;
  /** Inline styles for the scroll element — the Parts List sets a fixed height here. */
  style?: React.CSSProperties;
}) {
  const own = useRef<HTMLDivElement>(null);
  const ref = scrollRef ?? own;
  const moved = useRef(false);

  const scrollable = (el: HTMLElement) => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;

  // Only show the grab cursor when there's actually something to pan, so
  // non-overflowing tables don't get a misleading "grab" affordance.
  function onMouseEnter() {
    const el = ref.current;
    if (el) el.style.cursor = scrollable(el) ? "grab" : "";
  }

  function onMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return; // left button only
    const target = e.target as HTMLElement;
    const el = ref.current;
    if (!el) return;

    const textish = target.closest("input,textarea") as HTMLElement | null;
    const kind = pressKindFor({
      neverPan: target.closest(NEVER_PAN) !== null,
      scrollable: scrollable(el),
      isTextish: textish !== null,
      alreadyFocused: textish !== null && document.activeElement === textish,
    });
    if (kind !== "pan") return;

    // ── No preventDefault (§38.1, §38.5) ────────────────────────────────────
    //
    // The press is left entirely alone, so the browser focuses the cell itself and
    // the click registers on the FIRST press. Everything below only watches for
    // movement; nothing here delays or suppresses the interaction.
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = el.scrollLeft;
    const startTop = el.scrollTop;
    moved.current = false;

    // Restores everything the pan turned off. Called from BOTH exit paths, so a
    // drag that ends off-window cannot leave the grid stuck in "grabbing" with
    // text selection disabled.
    // Arrow functions, not `function` declarations: hoisting would lift them
    // above the `if (!el) return` above and lose its narrowing of `el`. All three
    // are initialised before any of them can run.
    const endPan = () => {
      el.style.cursor = scrollable(el) ? "grab" : "";
      el.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onUp);
      // Clear the "this was a pan" flag on the next tick. The click that ends a
      // pan fires synchronously right after mouseup, so onClickCapture still
      // sees `true` and swallows it — but if no click follows (mouseup landed
      // outside the container, or off-window entirely) the flag would otherwise
      // sit there and eat the NEXT genuine click.
      setTimeout(() => {
        moved.current = false;
      }, 0);
    };

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved.current) {
        // Still a click, not a pan. Threshold on EITHER axis, so a press that
        // drifts vertically is not left half-committed.
        if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        moved.current = true;
        // NOW it is a pan: take focus off the cell the press landed in and drop the
        // text selection the browser started, so dragging scrolls the grid instead of
        // sweeping a selection through a value. Doing it here rather than on mousedown
        // is the whole fix — on mousedown it also cancelled the click.
        el.style.cursor = "grabbing";
        // Belt and braces on top of GRID_SCROLLER's `select-none`: the other
        // DragScroll callers (JobProcurement's two tables) do not carry that
        // class, and a pan that sweeps a selection through half a table looks
        // broken even when the scrolling itself is right.
        el.style.userSelect = "none";
        if (document.activeElement instanceof HTMLElement && el.contains(document.activeElement)) {
          document.activeElement.blur();
        }
        window.getSelection()?.removeAllRanges();
      }
      // Native scrollLeft/scrollTop, clamped by the browser — so the far-left and
      // far-right boundaries just stop, and this never fights the wheel, the
      // scrollbar, a trackpad swipe or a touch scroll. The drag is an ADDITIONAL
      // way to move the same container, not a replacement for any of them.
      el.scrollLeft = startLeft - dx;
      el.scrollTop = startTop - dy;
    };

    const onUp = () => endPan();

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // A mouseup that happens outside the browser window never reaches us; without
    // this the grid stays in grabbing/user-select-none until the next press.
    window.addEventListener("blur", onUp);
  }

  // Swallow the click that fires at the end of a pan.
  //
  // This carries more weight since 2026-09-01: links, buttons and row menus are
  // pannable now, so this is the ONLY thing standing between "I dragged the grid
  // sideways starting from a job name" and "I navigated to that job". Capture
  // phase, so it runs before the anchor's or button's own handler, and
  // preventDefault cancels the default action (navigation) too.
  //
  // A press that never passed DRAG_THRESHOLD_PX leaves `moved` false and is not
  // touched at all — so a plain click on a link, a sort button, a toggle or a
  // cell behaves exactly as it did.
  function onClickCapture(e: React.MouseEvent) {
    if (moved.current) {
      e.stopPropagation();
      e.preventDefault();
      moved.current = false;
    }
  }

  // Double-click SELECTS THE WHOLE VALUE, the way a spreadsheet does. It is no longer
  // what focuses the cell — the single click does that now (see onMouseDown) — so this
  // is the "replace this value" gesture rather than the only way in, and it matches the
  // select-all ExcelCellFocus gives a cell reached by keyboard.
  function onDoubleClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    const textish = target.closest("input,textarea") as HTMLInputElement | HTMLTextAreaElement | null;
    if (!textish || textish.disabled || textish.readOnly) return;
    textish.focus();
    if (textish instanceof HTMLInputElement && textish.type !== "date") textish.select();
  }

  return (
    <div
      ref={ref}
      className={className}
      data-scroll-key={scrollKey}
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseDown={onMouseDown}
      onClickCapture={onClickCapture}
      onDoubleClick={onDoubleClick}
    >
      {children}
    </div>
  );
}
