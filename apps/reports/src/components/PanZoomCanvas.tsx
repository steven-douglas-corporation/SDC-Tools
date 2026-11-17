"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// A pan-and-zoom viewport (2026-11-16, experimental): whatever is inside is laid
// out once at its natural size, and the viewer drags, scrolls and zooms around
// it — so a layout like the Org chart's Canvas view can be as wide as it likes
// instead of wrapping to the page.
//
//   Drag              pan (a drag that moves never clicks what it started on)
//   Wheel / trackpad  pan (Shift+wheel sideways)
//   Ctrl/⌘ + wheel    zoom around the pointer (a trackpad pinch sends this too)
//   Buttons           zoom out / in, Fit, 100%
//
// It is a CSS transform on the content, not a <canvas>: the cards stay real DOM,
// so clicks, hover notes and dropdowns work as they do anywhere else.
//
// Pointer maths use the measured ratio of screen px to layout px rather than the
// app's zoom (html { zoom }): getBoundingClientRect and clientX are screen px,
// offsetWidth and the transform are layout px, and the ratio converts whatever
// set it.
//
// ── Keeping it smooth (measured 2026-11-16) ─────────────────────────────────
//
// The first version re-painted and re-rasterised the whole chart on every frame
// of a drag (~10s of raster work in a 120-move drag, frames to 66ms). Now:
//   - The view lives in a ref and is written straight to the DOM once per
//     animation frame; React does not render at all during a gesture.
//   - While a gesture runs the content is its own GPU layer (will-change), so a
//     pan or zoom moves pixels already drawn instead of drawing them again. A
//     moment after it stops the layer is dropped, so the text re-rasterises
//     crisply at the new zoom (a kept layer would stay at its old resolution).
//   - The dot grid is its own layer that slides by transform (modulo one dot
//     step); its spacing follows the zoom once a gesture settles, never mid-way.
//   - The content ignores the pointer while dragging, so the rows passing under
//     it don't re-style for hover.

const MIN_SCALE = 0.2;
const MAX_SCALE = 1.5;
const BUTTON_STEP = 1.2;
// Movement (screen px) before a press becomes a drag, so a click still clicks.
const DRAG_THRESHOLD = 4;
// Breathing room around the content when fitting (layout px).
const FIT_PADDING = 24;
// The dot grid's spacing at 100% (layout px); the grid layer overhangs the
// viewport by the largest step so sliding it never shows an edge.
const GRID_STEP = 20;
const GRID_OVERHANG = Math.ceil(GRID_STEP * MAX_SCALE);
// How long after the last wheel event a gesture counts as over.
const SETTLE_MS = 150;

type View = { x: number; y: number; scale: number };

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function PanZoomCanvas({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ x: 0, y: 0, scale: 1 });
  const labelRef = useRef<HTMLButtonElement>(null);
  const [fitted, setFitted] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Write the view to the DOM, at most once a frame. The grid's spacing (a
  // repaint of the whole grid) only follows the zoom once a gesture settles;
  // until then the dots keep their spacing and just slide.
  const frame = useRef(0);
  const gesture = useRef(false);
  const gridStep = useRef(GRID_STEP);
  const draw = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const { x, y, scale } = view.current;
      const content = contentRef.current;
      const grid = gridRef.current;
      if (content) content.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
      if (grid) {
        if (!gesture.current && gridStep.current !== GRID_STEP * scale) {
          gridStep.current = GRID_STEP * scale;
          grid.style.backgroundSize = `${gridStep.current}px ${gridStep.current}px`;
        }
        const step = gridStep.current;
        const mod = (v: number) => (((v % step) + step) % step) - step;
        grid.style.transform = `translate3d(${mod(x)}px, ${mod(y)}px, 0)`;
      }
      // Straight to the DOM: a React render per zoom step is work for nothing.
      // Only when it changes: new text means a layout, and a pan doesn't need one.
      const label = `${Math.round(scale * 100)}%`;
      if (labelRef.current && labelRef.current.textContent !== label) labelRef.current.textContent = label;
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // A gesture under way: the content gets its own layer until it settles.
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const settle = useCallback(() => {
    clearTimeout(settleTimer.current);
    gesture.current = false;
    if (contentRef.current) contentRef.current.style.willChange = "";
    draw();
  }, [draw]);
  const moving = useCallback(
    (settleAfter: number | null) => {
      gesture.current = true;
      if (contentRef.current) contentRef.current.style.willChange = "transform";
      clearTimeout(settleTimer.current);
      if (settleAfter != null) settleTimer.current = setTimeout(settle, settleAfter);
    },
    [settle],
  );
  useEffect(() => () => clearTimeout(settleTimer.current), []);

  const setView = useCallback(
    (next: View) => {
      view.current = next;
      draw();
    },
    [draw],
  );

  // Screen px per layout px inside the viewport (the app's zoom, and the browser's).
  const ratio = () => {
    const el = viewportRef.current;
    return el && el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1;
  };

  const fit = useCallback(() => {
    const vp = viewportRef.current;
    const content = contentRef.current;
    if (!vp || !content) return;
    const [vw, vh] = [vp.clientWidth, vp.clientHeight];
    const [cw, ch] = [content.offsetWidth, content.offsetHeight];
    if (!cw || !ch) return;
    const scale = clampScale(Math.min(1, (vw - 2 * FIT_PADDING) / cw, (vh - 2 * FIT_PADDING) / ch));
    // Centred sideways; from the top, so the chart's head is where the eye lands.
    setView({ x: (vw - cw * scale) / 2, y: FIT_PADDING, scale });
  }, [setView]);

  // Fit once the content has a size (first paint).
  useLayoutEffect(() => {
    if (fitted) return;
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (content.offsetWidth && content.offsetHeight) {
        fit();
        // After draw()'s frame, so the content is never shown unplaced.
        requestAnimationFrame(() => setFitted(true));
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [fit, fitted]);

  // Zoom keeping the layout point (px, py) in the viewport where it is.
  const zoomAt = useCallback(
    (factor: number, px: number, py: number) => {
      const v = view.current;
      const scale = clampScale(v.scale * factor);
      const k = scale / v.scale;
      setView({ scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
    },
    [setView],
  );

  const zoomCentre = (factor: number) => {
    const vp = viewportRef.current;
    if (vp) zoomAt(factor, vp.clientWidth / 2, vp.clientHeight / 2);
  };

  // Wheel: a native, non-passive listener — React's onWheel is passive, so it
  // can't stop the page scrolling (or Ctrl+wheel zooming the whole app).
  // ScrollHandoff (the app's one document-level wheel listener) sees
  // defaultPrevented and leaves these alone.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      moving(SETTLE_MS);
      const r = ratio();
      // deltaMode 1 = lines (some mice): roughly 16px a line.
      const unit = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey) {
        const rect = vp.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * unit * 0.0015), (e.clientX - rect.left) / r, (e.clientY - rect.top) / r);
        return;
      }
      const [dx, dy] = e.shiftKey && !e.deltaX ? [e.deltaY, 0] : [e.deltaX, e.deltaY];
      const v = view.current;
      setView({ ...v, x: v.x - (dx * unit) / r, y: v.y - (dy * unit) / r });
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [zoomAt, setView, moving]);

  // Drag to pan. The press only becomes a drag past DRAG_THRESHOLD, and only then
  // is the pointer captured — capturing on press would send the release to the
  // viewport and swallow every click on a card.
  const press = useRef<{ id: number; sx: number; sy: number; vx: number; vy: number; r: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Leave form fields alone: selecting text in a search box is not a pan.
    if ((e.target as HTMLElement).closest("input, textarea, select, [data-no-pan]")) return;
    const v = view.current;
    press.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y, r: ratio(), moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    const [dx, dy] = [e.clientX - p.sx, e.clientY - p.sy];
    if (!p.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      p.moved = true;
      setDragging(true);
      moving(null);
      viewportRef.current?.setPointerCapture(e.pointerId);
    }
    setView({ ...view.current, x: p.vx + dx / p.r, y: p.vy + dy / p.r });
  };
  const endPress = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (p.moved) {
      suppressClick.current = true;
      settle();
    }
    press.current = null;
    setDragging(false);
  };
  // Capture phase, so a drag that ends over a person row doesn't open their panel.
  const onClickCapture = (e: React.MouseEvent) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.stopPropagation();
    e.preventDefault();
  };

  // (A button zoom is one step, not a gesture: no layer, so it lands crisp.)
  const btn =
    "flex h-8 min-w-8 items-center justify-center px-2 text-sm font-semibold text-sdc-gray-600 motion-interactive hover:bg-sdc-gray-50 hover:text-sdc-navy not-first:border-l not-first:border-sdc-border";

  return (
    <div
      ref={viewportRef}
      className={`relative isolate overflow-hidden rounded-xl border border-sdc-border bg-sdc-gray-50 touch-none ${dragging ? "cursor-grabbing select-none" : "cursor-grab"} ${className}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onClickCapture={onClickCapture}
    >
      {/* The dot grid: its own layer, slid by draw() so a pan reads as a pan. */}
      <div
        ref={gridRef}
        aria-hidden
        className="pointer-events-none absolute -z-10 will-change-transform"
        style={{
          inset: -GRID_OVERHANG,
          backgroundImage: "radial-gradient(circle, var(--color-sdc-border) 1px, transparent 1px)",
          backgroundSize: `${GRID_STEP}px ${GRID_STEP}px`,
        }}
      />
      <div
        ref={contentRef}
        className={`absolute left-0 top-0 w-max origin-top-left ${dragging ? "pointer-events-none" : ""}`}
        style={{ visibility: fitted ? undefined : "hidden" }}
      >
        {children}
      </div>

      <div className="absolute bottom-3 right-3 flex items-center gap-2" data-no-pan onPointerDown={(e) => e.stopPropagation()}>
        <span className="hidden rounded-md bg-white/80 px-2 py-1 text-note text-sdc-muted sm:inline">Drag or scroll to move · Ctrl + scroll to zoom</span>
        <div className="flex overflow-hidden rounded-lg border border-sdc-border bg-white shadow-sm">
          <button type="button" className={btn} onClick={() => zoomCentre(1 / BUTTON_STEP)} aria-label="Zoom out">
            −
          </button>
          <button ref={labelRef} type="button" className={`${btn} w-14 text-xs tabular-nums`} onClick={() => zoomCentre(1 / view.current.scale)} title="Zoom to 100%">
            100%
          </button>
          <button type="button" className={btn} onClick={() => zoomCentre(BUTTON_STEP)} aria-label="Zoom in">
            +
          </button>
          <button type="button" className={`${btn} text-xs`} onClick={fit}>
            Fit
          </button>
        </div>
      </div>
    </div>
  );
}
