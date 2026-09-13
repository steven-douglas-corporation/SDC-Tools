"use client";

import { useEffect } from "react";
import { findHandoffTarget, wheelPixels } from "@/lib/scroll-handoff";

// Nested-scroll handoff, wired up ONCE at the document level (same pattern as
// ExcelCellFocus and ColumnResize) so every scroll container in the app gets it
// without a single per-page listener, per-row handler or wrapper component.
//
// ── What it fixes, and what it deliberately does not ────────────────────────
//
// The audit that preceded this found NO scroll traps in this codebase: not one
// `overscroll-behavior: contain`, not one `overscroll-behavior: none`, and not one
// wheel handler anywhere in src/ (the single `overscroll-x-contain`, on the Job Hour
// Details chart, is horizontal-only and is exactly the "keep sideways movement inside
// the table" behaviour that is wanted). Scroll chaining is therefore already ENABLED
// everywhere — `auto` is the CSS default and nothing overrides it.
//
// What actually makes an inner table feel "stuck" is the browser's own SCROLL
// LATCHING. Chrome binds a scroll gesture to the element it started over and keeps it
// there for the whole gesture: a continuous wheel spin or a trackpad fling that begins
// inside a table stops dead when that table hits its end, and only a NEW gesture —
// pause, then scroll again — moves the page. `overscroll-behavior: auto` permits
// chaining BETWEEN gestures; it does not unlatch one in progress. No CSS change can,
// which is why this is the one place custom wheel logic earns its place.
//
// So: native behaviour is left completely alone while the inner container still has
// room to move (the common case, and the listener does nothing at all there), and the
// handoff only engages at the boundary — the exact moment the browser would otherwise
// swallow the event.
//
// ── Why one document listener rather than a scroll-container component ──────
//
// Every alternative means touching ~59 scroll containers across 40 files and
// remembering to use it in the 60th. One listener on `document` sees them all,
// including containers rendered by client-side navigation after this mounts, and it
// costs one closest()-style ancestor walk per wheel event — only on the events that
// reach a boundary. Nothing is attached to a row or a cell.
//
// The listener is on `document` in the BUBBLE phase, so anything that legitimately
// wants a wheel event to itself can stopPropagation() and this never runs. It must be
// non-passive (`{ passive: false }`) because handing off requires preventDefault:
// without it the browser would apply its own latched no-op to the inner element AND
// this would scroll the outer one, double-counting the gesture.
//
// The decision itself lives in lib/scroll-handoff.ts as pure functions, so the rules
// are unit-tested rather than only clickable (tests/scroll-handoff.test.ts).
export default function ScrollHandoff() {
  useEffect(() => {
    function onWheel(e: WheelEvent) {
      // Already handled by something with a better claim to it.
      if (e.defaultPrevented) return;
      // Horizontal gestures stay where they are. A table that scrolls sideways is the
      // one place a horizontal wheel/trackpad swipe means something specific, and
      // chaining it to the page would be actively wrong. Only the dominant axis is
      // considered, so a slightly-off-axis vertical scroll is still vertical.
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (e.deltaY === 0) return;
      if (!(e.target instanceof Element)) return;

      const target = findHandoffTarget(e.target, e.deltaY);
      if (!target) return;

      // Only now — the event is genuinely one the browser would waste.
      e.preventDefault();
      target.el.scrollTop += wheelPixels(e.deltaY, e.deltaMode, target.el.clientHeight) * target.scale;
    }

    document.addEventListener("wheel", onWheel, { passive: false });
    return () => document.removeEventListener("wheel", onWheel);
  }, []);

  return null;
}
