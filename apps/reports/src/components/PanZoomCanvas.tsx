"use client";

import { createContext, use, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// A pan-and-zoom viewport (2026-11-16, experimental): whatever is inside is laid
// out once at its natural size, and the viewer drags, scrolls and zooms around
// it — so a layout like the Org chart's Canvas view can be as wide as it likes
// instead of wrapping to the page.
//
//   Drag              pan (a drag that moves never clicks what it started on)
//   Wheel / trackpad  pan (Shift+wheel sideways)
//   Ctrl/⌘ + wheel    zoom around the pointer (a trackpad pinch sends this too)
//   Click / dbl-click a [data-canvas-zoom-on-click] element / any [data-canvas-item]: zoom to it
//   Keys              arrows pan, + / − zoom, 0 fits, Esc leaves full screen
//   Buttons           zoom out / in, Fit, 100%, Full screen, Save as PDF
//   Overview map      bottom left: where you are; click or drag in it to move
//
// It is a CSS transform on the content, not a <canvas>: the cards stay real DOM,
// so clicks, hover notes and dropdowns work as they do anywhere else.
//
// Pointer maths use the measured ratio of screen px to layout px rather than the
// app's zoom (html { zoom }): getBoundingClientRect and clientX are screen px,
// offsetWidth and the transform are layout px, and the ratio converts whatever
// set it.
//
// ── What the content can mark (data attributes) ─────────────────────────────
//
//   data-canvas-item="card"|"panel"  drawn on the overview map; double-click zooms
//                                    to it (a panel fits whole, a card fits its width)
//   data-canvas-key="…"              a stable id, so the view can hold a card still
//                                    while the detail level changes its size
//   data-canvas-zoom-on-click        a plain click zooms to it (summary cards)
//   data-canvas-match                a search match: the canvas jumps between these
//                                    and marks the current one data-canvas-current
//
// ── Detail by zoom (2026-11-19) ─────────────────────────────────────────────
//
// Below COMPACT_BELOW nobody can read a name, so the content is told to draw
// summaries instead (useCanvasCompact). The switch waits for a gesture to
// settle, and keeps the card nearest the middle (or the one being zoomed to)
// where it was on screen, so the chart doesn't jump. A search turns it off
// (allowCompact): the matches are people, and summaries have none.
//
// ── Keeping it smooth (measured 2026-11-16) ─────────────────────────────────
//
// The first version re-painted and re-rasterised the whole chart on every frame
// of a drag (~10s of raster work in a 120-move drag, frames to 66ms). Now:
//   - The view lives in a ref and is written straight to the DOM once per
//     animation frame; React does not render at all during a gesture.
//   - The content is its own GPU layer (will-change) the whole time it is shown,
//     so a pan or zoom moves pixels already drawn instead of drawing them again.
//     (2026-11-19) It used to be a layer only during a gesture, which cost a full
//     redraw of the chart at the start AND the end of every gesture — and a mouse
//     wheel's notches, further apart than the settle delay, each counted as one.
//   - A layer keeps the resolution it was drawn at, so after the zoom changes
//     and settles, the layer is dropped for one frame and re-made: one redraw,
//     while the viewer is still, and the text is crisp at the new zoom. A pan
//     never changes the zoom, so it never redraws.
//   - The dot grid is its own layer that slides by transform (modulo one dot
//     step); its spacing follows the zoom once a gesture settles, never mid-way.
//   - While dragging, a clear overlay sits over the content, so the rows passing
//     under the pointer don't re-style for hover — without restyling the chart
//     itself (a pointer-events class on the content touched every card twice a drag).
//     The grabbing cursor is on that overlay too: `cursor` is inherited, so
//     switching it on the viewport restyled every card as well.
//
// ── Focus ───────────────────────────────────────────────────────────────────
//
// The viewport is overflow: clip, not hidden. A hidden box can still be scrolled
// by the browser (tabbing to an off-screen row scrolls it into view), which would
// shift the content behind the transform's back. Clip can't be scrolled; instead,
// keyboard focus landing off-screen pans the canvas to it.

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
// How long after the last wheel event a gesture counts as over. Long enough that
// a mouse wheel's separate notches read as one zoom, not a redraw between each.
const SETTLE_MS = 300;
// Below this zoom the content draws summaries (see "Detail by zoom").
const COMPACT_BELOW = 0.6;
const ANIMATE_MS = 280;
// An arrow key's pan (layout px).
const KEY_PAN = 120;
// A search jump lands at least this close in, so the names are readable.
const MATCH_SCALE = 0.9;
// The overview map's largest size (px).
const MAP_W = 180;
const MAP_MAX_H = 140;

type View = { x: number; y: number; scale: number };
type Box = { x: number; y: number; w: number; h: number };

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

// Screen px per layout px inside an element (the app's zoom, and the browser's).
const layoutRatio = (el: HTMLElement) => (el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1);

// An element's box in the content's own (unscaled) coordinates. Measured against
// the content's rect, so it is right whatever transform is on it at the moment.
function boxIn(content: HTMLElement, el: Element): Box {
  const c = content.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const k = content.offsetWidth ? c.width / content.offsetWidth : 1;
  return { x: (r.left - c.left) / k, y: (r.top - c.top) / k, w: r.width / k, h: r.height / k };
}

function readSavedView(key: string | undefined): View | null {
  if (!key) return null;
  try {
    const v = JSON.parse(sessionStorage.getItem(key) ?? "null");
    return v && [v.x, v.y, v.scale].every((n) => typeof n === "number" && Number.isFinite(n))
      ? { x: v.x, y: v.y, scale: clampScale(v.scale) }
      : null;
  } catch {
    return null;
  }
}

const CompactContext = createContext(false);
/** True while the canvas is zoomed out far enough that the content should draw summaries. */
export const useCanvasCompact = () => use(CompactContext);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function PanZoomCanvas({
  children,
  className = "",
  storageKey,
  allowCompact = true,
  matchKey = "",
  toolbar,
  exportTitle = "Chart",
}: {
  children: React.ReactNode;
  /** The viewport's size when not full screen. */
  className?: string;
  /** Remembers the view in sessionStorage under this key, so leaving and coming back lands where you were. */
  storageKey?: string;
  /** False keeps full detail at every zoom (a search is on). */
  allowCompact?: boolean;
  /** The search text: when it changes, the canvas jumps to the first [data-canvas-match]. */
  matchKey?: string;
  /** Extra controls, drawn before the canvas's own. */
  toolbar?: React.ReactNode;
  /** The saved PDF's title. */
  exportTitle?: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLButtonElement>(null);
  const mapViewRef = useRef<SVGRectElement>(null);
  const view = useRef<View>({ x: 0, y: 0, scale: 1 });
  const [fitted, setFitted] = useState(false);
  const fittedRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [zoomCompact, setZoomCompact] = useState(false);
  const compactRef = useRef(false);
  // The props the frame-by-frame code reads, kept current after each render.
  const allowCompactRef = useRef(allowCompact);
  const storageKeyRef = useRef(storageKey);
  useLayoutEffect(() => {
    allowCompactRef.current = allowCompact;
    storageKeyRef.current = storageKey;
  }, [allowCompact, storageKey]);
  const compact = allowCompact && zoomCompact;

  // A card to hold still across a change of detail: where it was on screen.
  const anchor = useRef<{ key: string; px: number; py: number } | null>(null);
  // The card being zoomed to, which is the one to hold still when it arrives.
  const anchorHint = useRef<string | null>(null);
  // A Fit that changed the detail level fits again once the new layout is in.
  const refitPending = useRef(false);

  // ── Drawing ────────────────────────────────────────────────────────────────

  const frame = useRef(0);
  const gesture = useRef(false);
  const gridStep = useRef(GRID_STEP);
  // The zoom the content's layer was last drawn at, and the frame re-making it.
  const rasterScale = useRef(1);
  const redrawFrame = useRef(0);
  const mapScale = useRef(0);

  // Out of a gesture: summaries or full detail, by the zoom. Returns whether it
  // changed. `hold` keeps a card still on screen across the change.
  const syncDetail = useCallback((hold: boolean) => {
    const want = view.current.scale < COMPACT_BELOW;
    if (want === compactRef.current) {
      // A zoom-to that didn't change the detail: its hint is spent either way.
      anchorHint.current = null;
      return false;
    }
    compactRef.current = want;
    const content = contentRef.current;
    const vp = viewportRef.current;
    anchor.current = null;
    if (hold && allowCompactRef.current && content && vp) {
      const { x, y, scale } = view.current;
      const hinted = anchorHint.current
        ? content.querySelector(`[data-canvas-key="${CSS.escape(anchorHint.current)}"]`)
        : null;
      let best: Element | null = hinted;
      if (!best) {
        let bestD = Infinity;
        for (const el of content.querySelectorAll('[data-canvas-item="card"][data-canvas-key]')) {
          const b = boxIn(content, el);
          const d = Math.hypot(x + (b.x + b.w / 2) * scale - vp.clientWidth / 2, y + b.y * scale - vp.clientHeight / 2);
          if (d < bestD) [best, bestD] = [el, d];
        }
      }
      if (best) {
        const b = boxIn(content, best);
        anchor.current = { key: best.getAttribute("data-canvas-key")!, px: x + b.x * scale, py: y + b.y * scale };
      }
    }
    anchorHint.current = null;
    setZoomCompact(want);
    return true;
  }, []);

  // Writes the view to the DOM now. Use draw() for anything frequent.
  const apply = useCallback(() => {
    const { x, y, scale } = view.current;
    const content = contentRef.current;
    const grid = gridRef.current;
    const vp = viewportRef.current;
    if (content) content.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    // Zoom settled at a new scale: drop the layer this frame (drawn at the true
    // size) and re-make it the next, so it is crisp and still a layer.
    if (content && !gesture.current && scale !== rasterScale.current) {
      rasterScale.current = scale;
      content.style.willChange = "auto";
      cancelAnimationFrame(redrawFrame.current);
      redrawFrame.current = requestAnimationFrame(() => {
        redrawFrame.current = 0;
        content.style.willChange = "transform";
      });
    }
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
    // The overview map's "you are here" box.
    const mv = mapViewRef.current;
    const m = mapScale.current;
    if (mv && vp && m) {
      mv.setAttribute("x", String((-x / scale) * m));
      mv.setAttribute("y", String((-y / scale) * m));
      mv.setAttribute("width", String((vp.clientWidth / scale) * m));
      mv.setAttribute("height", String((vp.clientHeight / scale) * m));
    }
    if (!gesture.current && fittedRef.current) {
      syncDetail(true);
      try {
        if (storageKeyRef.current) sessionStorage.setItem(storageKeyRef.current, JSON.stringify(view.current));
      } catch {
        // Storage off (private window, blocked): the view just isn't remembered.
      }
    }
  }, [syncDetail]);

  // At most once a frame.
  const draw = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      apply();
    });
  }, [apply]);

  // The content is a layer from the start (see "Keeping it smooth").
  useEffect(() => {
    if (contentRef.current) contentRef.current.style.willChange = "transform";
    return () => {
      cancelAnimationFrame(frame.current);
      cancelAnimationFrame(redrawFrame.current);
    };
  }, []);

  const setView = useCallback(
    (next: View) => {
      view.current = next;
      draw();
    },
    [draw],
  );

  // A gesture under way: hold back the grid's spacing, the crisp redraw and the
  // detail level until it settles.
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const settle = useCallback(() => {
    clearTimeout(settleTimer.current);
    gesture.current = false;
    draw();
  }, [draw]);
  const moving = useCallback(
    (settleAfter: number | null) => {
      gesture.current = true;
      clearTimeout(settleTimer.current);
      if (settleAfter != null) settleTimer.current = setTimeout(settle, settleAfter);
    },
    [settle],
  );
  useEffect(() => () => clearTimeout(settleTimer.current), []);

  // ── Animated moves (zoom to a card, jump to a match) ──────────────────────

  const anim = useRef(0);
  const cancelAnim = useCallback(() => {
    if (!anim.current) return;
    cancelAnimationFrame(anim.current);
    anim.current = 0;
    settle();
  }, [settle]);
  useEffect(() => () => cancelAnimationFrame(anim.current), []);

  const animateTo = useCallback(
    (to: View) => {
      cancelAnimationFrame(anim.current);
      anim.current = 0;
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        clearTimeout(settleTimer.current);
        gesture.current = false;
        setView(to);
        return;
      }
      const from = { ...view.current };
      const t0 = performance.now();
      gesture.current = true;
      clearTimeout(settleTimer.current);
      const step = (t: number) => {
        const p = Math.min(1, (t - t0) / ANIMATE_MS);
        const e = 1 - (1 - p) ** 3;
        view.current = {
          // Zoom eased by ratio, so zooming in and out feel the same speed.
          scale: from.scale * (to.scale / from.scale) ** e,
          x: from.x + (to.x - from.x) * e,
          y: from.y + (to.y - from.y) * e,
        };
        apply();
        if (p < 1) anim.current = requestAnimationFrame(step);
        else {
          anim.current = 0;
          view.current = to;
          settle();
        }
      };
      anim.current = requestAnimationFrame(step);
    },
    [apply, setView, settle],
  );

  // Zooms so an element fills the view: a card by its width (it may be taller
  // than the screen), a panel whole. Lands with its top near the top.
  const zoomToElement = useCallback(
    (el: Element, how: "card" | "panel") => {
      const content = contentRef.current;
      const vp = viewportRef.current;
      if (!content || !vp) return;
      const b = boxIn(content, el);
      const [vw, vh] = [vp.clientWidth, vp.clientHeight];
      const pad = FIT_PADDING * 2;
      let s = Math.min(1, (vw - 2 * pad) / b.w);
      if (how === "panel") s = Math.min(s, (vh - 2 * pad) / b.h);
      s = clampScale(s);
      anchorHint.current = el.getAttribute("data-canvas-key");
      animateTo({ scale: s, x: vw / 2 - (b.x + b.w / 2) * s, y: pad - b.y * s });
    },
    [animateTo],
  );

  // ── Fit ────────────────────────────────────────────────────────────────────

  const fit = useCallback(() => {
    const vp = viewportRef.current;
    const content = contentRef.current;
    if (!vp || !content) return;
    cancelAnimationFrame(anim.current);
    anim.current = 0;
    clearTimeout(settleTimer.current);
    gesture.current = false;
    const [vw, vh] = [vp.clientWidth, vp.clientHeight];
    const [cw, ch] = [content.offsetWidth, content.offsetHeight];
    if (!cw || !ch) return;
    let scale = clampScale(Math.min(1, (vw - 2 * FIT_PADDING) / cw, (vh - 2 * FIT_PADDING) / ch));
    // Already summaries: stay summaries. They are shorter, so the fit can come
    // out above the switch, and full detail would then no longer fit.
    if (compactRef.current && allowCompactRef.current) scale = Math.min(scale, COMPACT_BELOW - 0.01);
    // Centred sideways; from the top, so the chart's head is where the eye lands.
    view.current = { x: (vw - cw * scale) / 2, y: FIT_PADDING, scale };
    // Fitting is a placement, not a move: no card to hold still, and if the
    // detail changes, fit again to the new layout.
    if (fittedRef.current && syncDetail(false)) refitPending.current = allowCompactRef.current;
    apply();
  }, [apply, syncDetail]);

  // First placement, once the content has a size: where the viewer left it this
  // session, else fitted.
  useLayoutEffect(() => {
    if (fitted) return;
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (!content.offsetWidth || !content.offsetHeight || fittedRef.current) return;
      const saved = readSavedView(storageKeyRef.current);
      fittedRef.current = true;
      if (saved) {
        view.current = saved;
        syncDetail(false);
        apply();
      } else {
        // Fits, and if that changes the detail, fits again once it's drawn.
        fit();
      }
      // After the placement is written, so the content is never shown unplaced.
      requestAnimationFrame(() => setFitted(true));
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [fit, fitted, apply, syncDetail]);

  // The detail level changed: hold the anchored card still, or re-fit.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (refitPending.current) {
      refitPending.current = false;
      fit();
      return;
    }
    const a = anchor.current;
    anchor.current = null;
    if (!a || !content) return;
    const el = content.querySelector(`[data-canvas-key="${CSS.escape(a.key)}"]`);
    if (!el) return;
    const b = boxIn(content, el);
    const v = view.current;
    view.current = { ...v, x: v.x + a.px - (v.x + b.x * v.scale), y: v.y + a.py - (v.y + b.y * v.scale) };
    apply();
  }, [compact, fit, apply]);

  // ── Zoom ───────────────────────────────────────────────────────────────────

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
    cancelAnim();
    if (vp) zoomAt(factor, vp.clientWidth / 2, vp.clientHeight / 2);
  };

  const panBy = (dx: number, dy: number) => {
    cancelAnim();
    moving(SETTLE_MS);
    const v = view.current;
    setView({ ...v, x: v.x + dx, y: v.y + dy });
  };

  // Wheel: a native, non-passive listener — React's onWheel is passive, so it
  // can't stop the page scrolling (or Ctrl+wheel zooming the whole app).
  // ScrollHandoff (the app's one document-level wheel listener) sees
  // defaultPrevented and leaves these alone.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      // The overview map and the controls aren't the chart.
      if ((e.target as HTMLElement).closest("[data-no-pan]")) return;
      e.preventDefault();
      cancelAnim();
      moving(SETTLE_MS);
      const r = layoutRatio(vp);
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
  }, [zoomAt, setView, moving, cancelAnim]);

  // ── Drag ───────────────────────────────────────────────────────────────────

  // Drag to pan. The press only becomes a drag past DRAG_THRESHOLD, and only then
  // is the pointer captured — capturing on press would send the release to the
  // viewport and swallow every click on a card.
  const press = useRef<{
    id: number;
    sx: number;
    sy: number;
    vx: number;
    vy: number;
    r: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Leave form fields alone: selecting text in a search box is not a pan.
    if ((e.target as HTMLElement).closest("input, textarea, select, [data-no-pan]")) return;
    cancelAnim();
    const v = view.current;
    press.current = {
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      vx: v.x,
      vy: v.y,
      r: layoutRatio(viewportRef.current!),
      moved: false,
    };
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
    // A drag that started on text would otherwise select it as it goes. Cleared
    // here rather than with user-select on the viewport, which is inherited and
    // would restyle every card (see "Keeping it smooth").
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) sel.removeAllRanges();
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

  // Clicks the chart itself doesn't claim: a summary card zooms in on a click,
  // any card or panel on a double-click.
  const ownClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("button, a, summary, input, select, textarea, label, [data-no-pan]")) return null;
    return contentRef.current?.contains(t) ? t : null;
  };
  const onClick = (e: React.MouseEvent) => {
    const el = ownClick(e)?.closest("[data-canvas-zoom-on-click]");
    if (el) zoomToElement(el, "card");
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const el = ownClick(e)?.closest("[data-canvas-item]");
    if (!el) return;
    document.getSelection()?.removeAllRanges();
    zoomToElement(el, el.getAttribute("data-canvas-item") === "panel" ? "panel" : "card");
  };

  // ── Keyboard and focus ─────────────────────────────────────────────────────

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as HTMLElement).closest("input, textarea, select, [role=listbox], [role=menu]")) return;
    switch (e.key) {
      case "ArrowLeft":
        panBy(KEY_PAN, 0);
        break;
      case "ArrowRight":
        panBy(-KEY_PAN, 0);
        break;
      case "ArrowUp":
        panBy(0, KEY_PAN);
        break;
      case "ArrowDown":
        panBy(0, -KEY_PAN);
        break;
      case "+":
      case "=":
        zoomCentre(BUTTON_STEP);
        break;
      case "-":
      case "_":
        zoomCentre(1 / BUTTON_STEP);
        break;
      case "0":
        fit();
        break;
      case "Escape":
        if (!expanded) return;
        setExpanded(false);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // Keyboard focus landing off-screen: bring it on (the browser can't — clip).
  // Keyboard only: a click focuses what is already under the pointer, and moving
  // the chart mid-click would lose the click.
  const onFocus = (e: React.FocusEvent) => {
    const el = e.target as HTMLElement;
    const content = contentRef.current;
    const vp = viewportRef.current;
    if (!content || !vp || !content.contains(el) || !el.matches(":focus-visible")) return;
    const b = boxIn(content, el);
    const { x, y, scale } = view.current;
    const pad = 40;
    const [left, top] = [x + b.x * scale, y + b.y * scale];
    const [right, bottom] = [left + b.w * scale, top + b.h * scale];
    const dx = left < pad ? pad - left : right > vp.clientWidth - pad ? vp.clientWidth - pad - right : 0;
    const dy = top < pad ? pad - top : bottom > vp.clientHeight - pad ? vp.clientHeight - pad - bottom : 0;
    if (dx || dy) animateTo({ scale, x: x + dx, y: y + dy });
  };

  // ── Search ─────────────────────────────────────────────────────────────────

  const [found, setFound] = useState<{ key: string; count: number; index: number } | null>(null);
  const goToMatch = useCallback(
    (index: number) => {
      const content = contentRef.current;
      const vp = viewportRef.current;
      if (!content || !vp) return;
      content.querySelectorAll("[data-canvas-current]").forEach((el) => el.removeAttribute("data-canvas-current"));
      const els = [...content.querySelectorAll("[data-canvas-match]")];
      if (!els.length) return setFound({ key: matchKey, count: 0, index: 0 });
      const i = ((index % els.length) + els.length) % els.length;
      const el = els[i];
      el.setAttribute("data-canvas-current", "");
      const b = boxIn(content, el);
      const s = clampScale(Math.max(view.current.scale, MATCH_SCALE));
      animateTo({
        scale: s,
        x: vp.clientWidth / 2 - (b.x + b.w / 2) * s,
        y: vp.clientHeight / 3 - (b.y + b.h / 2) * s,
      });
      setFound({ key: matchKey, count: els.length, index: i });
    },
    [animateTo, matchKey],
  );
  // A new search: to its first match, once the rows carrying it are drawn.
  useEffect(() => {
    if (!fitted) return;
    if (matchKey) {
      goToMatch(0);
      return;
    }
    contentRef.current
      ?.querySelectorAll("[data-canvas-current]")
      .forEach((el) => el.removeAttribute("data-canvas-current"));
  }, [matchKey, fitted, goToMatch]);
  const shownFound = matchKey && found?.key === matchKey ? found : null;

  // ── Overview map ───────────────────────────────────────────────────────────

  const [map, setMap] = useState<{ w: number; h: number; m: number; items: (Box & { kind: string })[] } | null>(null);
  useEffect(() => {
    const content = contentRef.current;
    if (!content || !fitted) return;
    const measure = () => {
      const [w, h] = [content.offsetWidth, content.offsetHeight];
      if (!w || !h) return;
      const m = Math.min(MAP_W / w, MAP_MAX_H / h);
      mapScale.current = m;
      const items = [...content.querySelectorAll("[data-canvas-item]")].map((el) => ({
        ...boxIn(content, el),
        kind: el.getAttribute("data-canvas-item") ?? "",
      }));
      setMap({ w, h, m, items });
      draw();
    };
    const ro = new ResizeObserver(measure);
    ro.observe(content);
    return () => ro.disconnect();
  }, [fitted, draw]);

  const mapPress = useRef<number | null>(null);
  const mapMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const vp = viewportRef.current;
    if (!map || !vp || mapPress.current !== e.pointerId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const k = rect.width / (map.w * map.m);
    const [cx, cy] = [(e.clientX - rect.left) / k / map.m, (e.clientY - rect.top) / k / map.m];
    const s = view.current.scale;
    setView({ scale: s, x: vp.clientWidth / 2 - cx * s, y: vp.clientHeight / 2 - cy * s });
  };

  // ── Save as PDF ────────────────────────────────────────────────────────────

  // The chart as drawn now (this detail level, this search), printed from a
  // hidden frame on one page the chart's own size — the browser's print dialog
  // offers Save as PDF. The page's own stylesheets are copied over, so it looks
  // the same; the app's zoom is reset to 1.
  const saveAsPdf = async () => {
    const content = contentRef.current;
    if (!content) return;
    const [w, h] = [content.offsetWidth, content.offsetHeight];
    const frameEl = document.createElement("iframe");
    frameEl.setAttribute("aria-hidden", "true");
    Object.assign(frameEl.style, {
      position: "fixed",
      right: "0",
      bottom: "0",
      width: "0",
      height: "0",
      border: "0",
      visibility: "hidden",
    });
    document.body.appendChild(frameEl);
    const doc = frameEl.contentDocument;
    const win = frameEl.contentWindow;
    if (!doc || !win) return frameEl.remove();
    const styles = [...document.querySelectorAll('link[rel="stylesheet"], style')].map((n) => n.outerHTML).join("");
    // Without the passing highlights (a hover's line and lit cards, the current
    // search match): where the pointer was isn't part of the chart.
    const copy = content.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("path[data-canvas-lit]").forEach((el) => el.remove());
    copy.querySelectorAll("[data-canvas-lit], [data-canvas-current]").forEach((el) => {
      el.removeAttribute("data-canvas-lit");
      el.removeAttribute("data-canvas-current");
    });
    doc.open();
    doc.write(
      `<!doctype html><html class="${escapeHtml(document.documentElement.className)}" style="--app-zoom:1"><head><meta charset="utf-8"><title>${escapeHtml(exportTitle)}</title>${styles}` +
        `<style>@page{size:${w}px ${h}px;margin:0}html{zoom:1!important}body{margin:0;background:#fff}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style>` +
        `</head><body class="${escapeHtml(document.body.className)}"><div style="width:${w}px">${copy.innerHTML}</div></body></html>`,
    );
    doc.close();
    await Promise.all(
      [...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(
        (l) =>
          new Promise((done) =>
            l.sheet ? done(null) : (l.addEventListener("load", done), l.addEventListener("error", done)),
          ),
      ),
    );
    await doc.fonts?.ready;
    const cleanup = () => setTimeout(() => frameEl.remove(), 0);
    win.addEventListener("afterprint", cleanup, { once: true });
    // Some browsers never send afterprint for a frame: don't leave it behind.
    setTimeout(() => frameEl.isConnected && frameEl.remove(), 120_000);
    win.focus();
    win.print();
  };

  // (A button zoom is one step, not a gesture: draw() redraws it crisp at once.)
  const btn =
    "flex h-8 min-w-8 items-center justify-center px-2 text-sm font-semibold text-sdc-gray-600 motion-interactive hover:bg-sdc-gray-50 hover:text-sdc-navy not-first:border-l not-first:border-sdc-border";
  const group = "flex overflow-hidden rounded-lg border border-sdc-border bg-white shadow-sm";

  return (
    <div
      ref={viewportRef}
      tabIndex={0}
      aria-label="Chart canvas: arrow keys move, plus and minus zoom, 0 fits"
      className={`isolate cursor-grab overflow-clip rounded-xl border border-sdc-border bg-sdc-gray-50 touch-none outline-none focus-visible:ring-2 focus-visible:ring-sdc-blue ${
        expanded ? "fixed inset-4 z-40 shadow-2xl" : `relative ${className}`
      }`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onClickCapture={onClickCapture}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
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
        className="absolute left-0 top-0 w-max origin-top-left"
        style={{ visibility: fitted ? undefined : "hidden" }}
      >
        <CompactContext value={compact}>{children}</CompactContext>
      </div>
      {/* Over the content while dragging, so nothing under the pointer hovers. */}
      {dragging && <div aria-hidden className="absolute inset-0 cursor-grabbing" />}

      {matchKey && (
        <div
          className="absolute right-3 top-3 flex items-center gap-2"
          data-no-pan
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className={group}>
            <span className="flex h-8 items-center px-3 text-xs font-medium text-sdc-gray-600 tabular-nums">
              {!shownFound
                ? "Searching…"
                : shownFound.count === 0
                  ? "No one matches"
                  : `${shownFound.index + 1} of ${shownFound.count} matches`}
            </span>
            {shownFound && shownFound.count > 1 && (
              <>
                <button type="button" className={`${btn} text-xs`} onClick={() => goToMatch(shownFound.index - 1)}>
                  Previous
                </button>
                <button type="button" className={`${btn} text-xs`} onClick={() => goToMatch(shownFound.index + 1)}>
                  Next
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {map && (
        <div
          className="absolute bottom-3 left-3 hidden cursor-pointer rounded-lg border border-sdc-border bg-white/90 p-1.5 shadow-sm sm:block"
          data-no-pan
          title="Overview: click or drag to move"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <svg
            width={map.w * map.m}
            height={map.h * map.m}
            className="block"
            onPointerDown={(e) => {
              cancelAnim();
              mapPress.current = e.pointerId;
              e.currentTarget.setPointerCapture(e.pointerId);
              mapMove(e);
            }}
            onPointerMove={mapMove}
            onPointerUp={() => (mapPress.current = null)}
            onPointerCancel={() => (mapPress.current = null)}
          >
            {map.items.map((r, i) => (
              <rect
                key={i}
                x={r.x * map.m}
                y={r.y * map.m}
                width={r.w * map.m}
                height={r.h * map.m}
                rx={r.kind === "panel" ? 3 : 1.5}
                strokeWidth={0.75}
                className={
                  r.kind === "panel" ? "fill-sdc-gray-50 stroke-sdc-border" : "fill-sdc-blue-light stroke-sdc-gray-400"
                }
              />
            ))}
            <rect ref={mapViewRef} rx={2} strokeWidth={1.25} className="fill-sdc-blue/10 stroke-sdc-blue" />
          </svg>
        </div>
      )}

      <div
        className="absolute bottom-3 right-3 flex items-center gap-2"
        data-no-pan
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className="hidden rounded-md bg-white/80 px-2 py-1 text-note text-sdc-muted xl:inline">
          Drag or scroll to move · Ctrl + scroll to zoom · Double-click a card to zoom to it
        </span>
        {toolbar}
        <div className={group}>
          <button type="button" className={`${btn} text-xs`} onClick={saveAsPdf}>
            Save as PDF
          </button>
          <button type="button" className={`${btn} text-xs`} onClick={() => setExpanded((x) => !x)}>
            {expanded ? "Exit full screen" : "Full screen"}
          </button>
        </div>
        <div className={group}>
          <button type="button" className={btn} onClick={() => zoomCentre(1 / BUTTON_STEP)} aria-label="Zoom out">
            −
          </button>
          <button
            ref={labelRef}
            type="button"
            className={`${btn} w-14 text-xs tabular-nums`}
            onClick={() => zoomCentre(1 / view.current.scale)}
            title="Zoom to 100%"
          >
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
