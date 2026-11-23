"use client";

import { createContext, use, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";

// A pan-and-zoom viewport (2026-11-16, experimental): whatever is inside is laid
// out once at its natural size, and the viewer drags, scrolls and zooms around
// it — so a layout like the Org chart's Canvas view can be as wide as it likes
// instead of wrapping to the page.
//
//   Drag              pan (a drag that moves never clicks what it started on)
//   Wheel / trackpad  pan — the browser's own scrolling (Shift+wheel sideways)
//   Ctrl/⌘ + wheel    zoom around the pointer (a trackpad pinch sends this too)
//   Click             a [data-canvas-expand-on-click] summary: expand all, zoom to it
//   Double-click      any [data-canvas-item]: zoom to it
//   Keys              arrows / Page keys scroll, + / − zoom, 0 goes home (fits), Esc leaves full screen
//   Buttons           (along the top) Collapse / Expand all, zoom out / in, 100%, Home (fits),
//                     Full screen, Save as PDF
//   Overview map      bottom left: where you are; click or drag in it to move
//
// It is real DOM, not a <canvas>: the cards' clicks, hover notes and dropdowns
// work as they do anywhere else.
//
// Pointer maths use the measured ratio of screen px to layout px rather than the
// app's zoom (html { zoom }): getBoundingClientRect and clientX are screen px,
// offsetWidth, scroll offsets and the transform are layout px, and the ratio
// converts whatever set it.
//
// ── Panning is native scrolling (2026-11-19) ────────────────────────────────
//
// The viewport is a scroll box. Inside it a "sizer" is exactly as big as the
// scroll range the chart is allowed (see "Clamped"), and the chart sits in it at
// (margin, margin), scaled by a CSS transform. A pan is a scroll: the browser runs it on its compositor thread,
// with the system's momentum, and a busy main thread (React, the dev server) can't
// stutter it. Firefox especially: it refuses will-change layers past a size
// budget, so it re-drew the whole chart on every frame of a transform pan.
//
// A zoom can't be a scroll, so it works like a touchpad pinch: during the gesture
// the chart's layer is stretched by its transform (plus a "glide" translation,
// so the point under the pointer stays put) and nothing is laid out or redrawn.
// When the gesture settles, the zoom is committed — the sizer takes the new size,
// the glide moves into the scroll position — and the chart is redrawn sharp once.
//
//   view.x = margin.x − scrollLeft + glide.x   (the chart's left edge on screen)
//
// ── Clamped (2026-11-19) ────────────────────────────────────────────────────
//
// The chart can't be moved off into empty space. Per axis, its edge may travel
// between EDGE_ROOM inside the viewport and flush-plus-EDGE_ROOM at the far side:
//
//   bigger than the view:   x ∈ [view − chart − EDGE_ROOM, EDGE_ROOM]  (scroll to each end)
//   smaller than the view:  x ∈ [EDGE_ROOM, view − chart − EDGE_ROOM] (stays wholly in view)
//
// Vertically the top end is TOP_ROOM instead, so the chart's top stops below the
// controls along the top rather than under them.
//
// The sizer is that range plus one viewport, the chart sits in it at the range's
// high end (margin = hi), so the browser's own scroll limits ARE the clamp — a
// fling stops at the edge with no code running. Zooms and jumps are clamped the
// same way before they are drawn, so a zoom out near an edge eases the chart back
// into view rather than snapping when it settles.
//
// ── What the content can mark (data attributes) ─────────────────────────────
//
//   data-canvas-item="card"|"panel"  drawn on the overview map; double-click zooms
//                                    to it (a panel fits whole, a card fits its width)
//   data-canvas-key="…"              a stable id, so the view can hold a card still
//                                    while the detail level changes its size
//   data-canvas-expand-on-click      a plain click expands all and zooms to it (summary cards)
//   data-canvas-match                a search match: the canvas jumps between these
//                                    and marks the current one data-canvas-current
//
// ── Collapse / Expand all (2026-11-20) ──────────────────────────────────────
//
// A button tells the content to draw every card as a summary or in full
// (useCanvasCompact). Was switched by the zoom (below 60%) from 2026-11-19;
// now it is the viewer's choice, at any zoom. Collapsing fits the (much
// shorter) chart; expanding keeps the card nearest the middle where it was on
// screen, so the chart doesn't jump. Remembered with the view for the session.
// A search shows every card in full (allowCompact) and hides the button: the
// matches are people, and summaries have none.
//
// ── Keeping it smooth ───────────────────────────────────────────────────────
//
//   - The chart is its own GPU layer (will-change) the whole time, so a zoom
//     gesture stretches pixels already drawn. A layer keeps the resolution it was
//     drawn at, so once a zoom settles at a new scale the layer is dropped for one
//     frame and re-made: one redraw, while the viewer is still. (2026-11-19: a
//     layer only during gestures cost a redraw at the start AND end of each one.)
//   - No React render during a gesture: the view is written straight to the DOM,
//     at most once a frame. Scrolling doesn't go through our code at all.
//   - The dot grid is the sizer's background, so it scrolls with the chart; its
//     spacing follows the zoom when a zoom is committed.
//   - While dragging, a clear overlay sits over the chart, so the rows passing
//     under the pointer don't re-style for hover; the grabbing cursor is on it too
//     (`cursor` is inherited: switching it on the viewport restyled every card).
//   - overflow-anchor: none — the browser's scroll anchoring would otherwise
//     "correct" the scroll when the detail level resizes the cards, on top of the
//     correction done here.

const MIN_SCALE = 0.2;
const MAX_SCALE = 1.5;
const BUTTON_STEP = 1.2;
// Movement (screen px) before a press becomes a drag, so a click still clicks.
const DRAG_THRESHOLD = 4;
// Breathing room around the content when fitting (layout px).
const FIT_PADDING = 24;
// How far past its edge the chart can be moved, or how close to the viewport's
// edge a small one can go (layout px; see "Clamped").
const EDGE_ROOM = FIT_PADDING;
// The controls run along the top: the chart's top edge stops below them, and
// Home and zoom-to put the top there (layout px: the bar is 12 + 32, plus room).
const TOP_ROOM = 56;
// The dot grid's spacing at 100% (layout px).
const GRID_STEP = 20;
// How long after the last wheel event a zoom counts as over. Long enough that
// a mouse wheel's separate notches read as one zoom, not a redraw between each.
const SETTLE_MS = 300;
const ANIMATE_MS = 280;
// A search jump lands at least this close in, so the names are readable.
const MATCH_SCALE = 0.9;
// The overview map's largest size (px).
const MAP_W = 180;
const MAP_MAX_H = 140;
// The view is saved this long after the last move.
const SAVE_MS = 250;

type View = { x: number; y: number; scale: number };
type Box = { x: number; y: number; w: number; h: number };

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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

function readSavedView(key: string | undefined): (View & { collapsed: boolean }) | null {
  if (!key) return null;
  try {
    const v = JSON.parse(sessionStorage.getItem(key) ?? "null");
    return v && [v.x, v.y, v.scale].every((n) => typeof n === "number" && Number.isFinite(n))
      ? { x: v.x, y: v.y, scale: clampScale(v.scale), collapsed: v.collapsed === true }
      : null;
  } catch {
    return null;
  }
}

export type PanZoomHandle = {
  /** Jumps to the first element matching `selector` (brings full detail back first if needed). False if there is none. */
  focus: (selector: string) => boolean;
};

const CompactContext = createContext(false);
/** True while the viewer has collapsed the cards: the content should draw summaries. */
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
  sidebar,
  ref,
}: {
  children: React.ReactNode;
  /** A column down the right of the frame (it stays in full screen); the chart's view is what is left. */
  sidebar?: React.ReactNode;
  /** focus(selector): jump to the first element matching it, marked data-canvas-current. */
  ref?: React.Ref<PanZoomHandle>;
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
  const frameRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLButtonElement>(null);
  const mapViewRef = useRef<SVGRectElement>(null);
  const [fitted, setFitted] = useState(false);
  const fittedRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Collapse all: the viewer's choice (see "Collapse / Expand all").
  const [collapsed, setCollapsed] = useState(false);
  const compactRef = useRef(false);
  // The props the frame-by-frame code reads, kept current after each render.
  const allowCompactRef = useRef(allowCompact);
  const storageKeyRef = useRef(storageKey);
  useLayoutEffect(() => {
    allowCompactRef.current = allowCompact;
    storageKeyRef.current = storageKey;
  }, [allowCompact, storageKey]);
  const compact = allowCompact && collapsed;

  // What to do once a change of detail is laid out: hold a card still where it
  // was on screen, fit the new layout, zoom to a card, or put a saved view back.
  const anchor = useRef<{ key: string; px: number; py: number } | null>(null);
  const refitPending = useRef(false);
  const pendingZoom = useRef<string | null>(null);
  const pendingView = useRef<View | null>(null);

  // ── Geometry (see "Panning is native scrolling") ───────────────────────────

  const scale = useRef(1);
  const glide = useRef({ x: 0, y: 0 });
  const margin = useRef({ x: 0, y: 0 });
  // A zoom under way: the transform stretches, nothing is committed yet.
  const gesture = useRef(false);
  // A view waiting for the next frame, and that frame.
  const target = useRef<View | null>(null);
  const frame = useRef(0);
  // The zoom the chart's layer was last drawn at, and the frame re-making it.
  const rasterScale = useRef(1);
  const redrawFrame = useRef(0);
  const mapScale = useRef(0);
  // What was last written, so an unchanged value isn't written (and laid out) again.
  const written = useRef({ size: "", transform: "" });
  // The last view on screen, and whether the canvas is hidden (a workspace tab
  // in the background is display: none). A hidden scroll box loses its offset —
  // the browser keeps none for a box it isn't laying out — so on coming back the
  // view is put back from here, not read from the zeroed scroll. (The app's
  // TabScrollMemory would restore the offset but not the zoom it belongs to, so
  // the scroller opts out of it: data-scroll-own.)
  const committed = useRef<View | null>(null);
  const hidden = useRef(false);

  // The view on screen now.
  const readView = useCallback((): View => {
    const sc = scrollerRef.current;
    const g = glide.current;
    if (!sc) return { x: 0, y: 0, scale: scale.current };
    return { x: margin.current.x - sc.scrollLeft + g.x, y: margin.current.y - sc.scrollTop + g.y, scale: scale.current };
  }, []);
  // …or the one about to be drawn.
  const latest = useCallback(() => target.current ?? readView(), [readView]);

  // The overview map's "you are here" box.
  const updateMap = useCallback(() => {
    const mv = mapViewRef.current;
    const sc = scrollerRef.current;
    const m = mapScale.current;
    if (!mv || !sc || !m) return;
    const { x, y, scale: s } = readView();
    mv.setAttribute("x", String((-x / s) * m));
    mv.setAttribute("y", String((-y / s) * m));
    mv.setAttribute("width", String((sc.clientWidth / s) * m));
    mv.setAttribute("height", String((sc.clientHeight / s) * m));
  }, [readView]);

  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveSoon = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        if (storageKeyRef.current && fittedRef.current)
          sessionStorage.setItem(storageKeyRef.current, JSON.stringify({ ...readView(), collapsed: compactRef.current }));
      } catch {
        // Storage off (private window, blocked): the view just isn't remembered.
      }
    }, SAVE_MS);
  }, [readView]);
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  // The card nearest the middle of the view, and where it is on screen: held
  // there while the detail level changes its size.
  const middleCard = useCallback((v: View) => {
    const content = contentRef.current;
    const sc = scrollerRef.current;
    if (!content || !sc) return null;
    let best: Element | null = null;
    let bestD = Infinity;
    for (const el of content.querySelectorAll('[data-canvas-item="card"][data-canvas-key]')) {
      const b = boxIn(content, el);
      const d = Math.hypot(v.x + (b.x + b.w / 2) * v.scale - sc.clientWidth / 2, v.y + b.y * v.scale - sc.clientHeight / 2);
      if (d < bestD) [best, bestD] = [el, d];
    }
    if (!best) return null;
    const b = boxIn(content, best);
    return { key: best.getAttribute("data-canvas-key")!, px: v.x + b.x * v.scale, py: v.y + b.y * v.scale };
  }, []);

  // Where the chart's top-left may go at zoom `s` (see "Clamped"); null with no
  // size to go by (hidden, or not laid out yet).
  const bounds = useCallback((s: number) => {
    const sc = scrollerRef.current;
    const content = contentRef.current;
    if (!sc || !content || !sc.clientWidth || !content.offsetWidth) return null;
    // `near`: the room at the top/left end (the top keeps clear of the controls).
    const axis = (view: number, size: number, near: number) => {
      const [a, b] = [near, view - size - EDGE_ROOM];
      return { lo: Math.min(a, b), hi: Math.max(a, b) };
    };
    return {
      x: axis(sc.clientWidth, content.offsetWidth * s, EDGE_ROOM),
      y: axis(sc.clientHeight, content.offsetHeight * s, TOP_ROOM),
    };
  }, []);
  const clampView = useCallback(
    (v: View): View => {
      const s = clampScale(v.scale);
      const b = bounds(s);
      return b ? { scale: s, x: clamp(v.x, b.x.lo, b.x.hi), y: clamp(v.y, b.y.lo, b.y.hi) } : { ...v, scale: s };
    },
    [bounds],
  );

  // Puts the view on screen, now. In a zoom gesture only the transform moves;
  // otherwise the sizer, the chart's place in it and the scroll are committed.
  const place = useCallback(
    (raw: View) => {
      const sc = scrollerRef.current;
      const sizer = sizerRef.current;
      const content = contentRef.current;
      if (!sc || !sizer || !content) return;
      const v = clampView(raw);
      const s = v.scale;
      const b = bounds(s);
      if (!gesture.current && !b) return;
      scale.current = s;
      if (gesture.current) {
        glide.current = { x: v.x - (margin.current.x - sc.scrollLeft), y: v.y - (margin.current.y - sc.scrollTop) };
      } else if (b) {
        const [vw, vh] = [sc.clientWidth, sc.clientHeight];
        // The allowed range plus a viewport, the chart at its high end: the
        // browser's scroll limits are then the clamp.
        const [sw, sh] = [b.x.hi - b.x.lo + vw, b.y.hi - b.y.lo + vh];
        margin.current = { x: b.x.hi, y: b.y.hi };
        glide.current = { x: 0, y: 0 };
        const size = `${sw} ${sh} ${b.x.hi} ${b.y.hi} ${s}`;
        if (written.current.size !== size) {
          written.current.size = size;
          sizer.style.width = `${sw}px`;
          sizer.style.height = `${sh}px`;
          content.style.left = `${b.x.hi}px`;
          content.style.top = `${b.y.hi}px`;
          const step = GRID_STEP * s;
          sizer.style.backgroundSize = `${step}px ${step}px`;
          sizer.style.backgroundPosition = `${b.x.hi}px ${b.y.hi}px`;
        }
        sc.scrollLeft = b.x.hi - v.x;
        sc.scrollTop = b.y.hi - v.y;
      }
      const g = glide.current;
      const transform = `translate3d(${g.x}px, ${g.y}px, 0) scale(${s})`;
      if (written.current.transform !== transform) {
        written.current.transform = transform;
        content.style.transform = transform;
      }
      // Zoom committed at a new scale: drop the layer this frame (drawn at the true
      // size) and re-make it the next, so it is sharp and still a layer.
      if (!gesture.current && s !== rasterScale.current) {
        rasterScale.current = s;
        content.style.willChange = "auto";
        cancelAnimationFrame(redrawFrame.current);
        redrawFrame.current = requestAnimationFrame(() => {
          redrawFrame.current = 0;
          content.style.willChange = "transform";
        });
      }
      // Only when it changes: new text means a layout.
      const label = `${Math.round(s * 100)}%`;
      if (labelRef.current && labelRef.current.textContent !== label) labelRef.current.textContent = label;
      updateMap();
      if (!gesture.current) committed.current = readView();
      if (!gesture.current && fittedRef.current) saveSoon();
    },
    [readView, saveSoon, updateMap, clampView, bounds],
  );

  // At most once a frame.
  const draw = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const v = target.current;
      target.current = null;
      if (v) place(v);
    });
  }, [place]);

  const setView = useCallback(
    (next: View) => {
      // Clamped now, so the next wheel step zooms from where the chart really is.
      target.current = clampView(next);
      draw();
    },
    [draw, clampView],
  );

  // The chart is a layer from the start (see "Keeping it smooth").
  useEffect(() => {
    if (contentRef.current) contentRef.current.style.willChange = "transform";
    return () => {
      cancelAnimationFrame(frame.current);
      cancelAnimationFrame(redrawFrame.current);
    };
  }, []);

  // End of a zoom: commit it, now.
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const settle = useCallback(() => {
    clearTimeout(settleTimer.current);
    const v = latest();
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    target.current = null;
    gesture.current = false;
    place(v);
  }, [latest, place]);
  const moving = useCallback(
    (settleAfter: number) => {
      gesture.current = true;
      clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(settle, settleAfter);
    },
    [settle],
  );
  useEffect(() => () => clearTimeout(settleTimer.current), []);

  // ── Animated moves (zoom to a card, jump to a match) ──────────────────────
  //
  // As a gesture: the transform stretches and glides, committed at the end.

  const anim = useRef(0);
  const cancelAnim = useCallback(() => {
    if (!anim.current) return;
    cancelAnimationFrame(anim.current);
    anim.current = 0;
    settle();
  }, [settle]);
  useEffect(() => () => cancelAnimationFrame(anim.current), []);

  const animateTo = useCallback(
    (wanted: View) => {
      // Ends where it will be drawn, so there is no snap when it lands.
      const to = clampView(wanted);
      cancelAnimationFrame(anim.current);
      anim.current = 0;
      clearTimeout(settleTimer.current);
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        gesture.current = false;
        setView(to);
        return;
      }
      const from = latest();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      target.current = null;
      gesture.current = true;
      const t0 = performance.now();
      const step = (t: number) => {
        const p = Math.min(1, (t - t0) / ANIMATE_MS);
        const e = 1 - (1 - p) ** 3;
        if (p < 1) {
          place({
            // Zoom eased by ratio, so zooming in and out feel the same speed.
            scale: from.scale * (to.scale / from.scale) ** e,
            x: from.x + (to.x - from.x) * e,
            y: from.y + (to.y - from.y) * e,
          });
          anim.current = requestAnimationFrame(step);
        } else {
          anim.current = 0;
          gesture.current = false;
          place(to);
        }
      };
      anim.current = requestAnimationFrame(step);
    },
    [latest, place, setView, clampView],
  );

  // Zooms so an element fills the view: a card by its width (it may be taller
  // than the screen), a panel whole. Lands with its top near the top.
  const zoomToElement = useCallback(
    (el: Element, how: "card" | "panel") => {
      const content = contentRef.current;
      const sc = scrollerRef.current;
      if (!content || !sc) return;
      const b = boxIn(content, el);
      const [vw, vh] = [sc.clientWidth, sc.clientHeight];
      const pad = FIT_PADDING * 2;
      let s = Math.min(1, (vw - 2 * pad) / b.w);
      if (how === "panel") s = Math.min(s, (vh - TOP_ROOM - pad) / b.h);
      s = clampScale(s);
      animateTo({ scale: s, x: vw / 2 - (b.x + b.w / 2) * s, y: TOP_ROOM - b.y * s });
    },
    [animateTo],
  );

  // To one element (a search match, a person picked from a list): marked
  // data-canvas-current, a third of the way down, close enough in to read.
  const jumpTo = useCallback(
    (el: Element) => {
      const content = contentRef.current;
      const sc = scrollerRef.current;
      if (!content || !sc) return;
      content.querySelectorAll("[data-canvas-current]").forEach((x) => x.removeAttribute("data-canvas-current"));
      el.setAttribute("data-canvas-current", "");
      const b = boxIn(content, el);
      const s = clampScale(Math.max(latest().scale, MATCH_SCALE));
      animateTo({ scale: s, x: sc.clientWidth / 2 - (b.x + b.w / 2) * s, y: sc.clientHeight / 3 - (b.y + b.h / 2) * s });
    },
    [animateTo, latest],
  );

  // Collapse or expand every card (see "Collapse / Expand all"). Expanding
  // holds the middle card still, or zooms to the card keyed `zoomTo` (a click
  // on a summary). The rest happens once the new layout is in (the detail
  // effect below).
  const setDetail = useCallback(
    (want: boolean, zoomTo?: string | null) => {
      if (want === compactRef.current || !allowCompactRef.current) return;
      cancelAnim();
      compactRef.current = want;
      anchor.current = null;
      refitPending.current = false;
      pendingZoom.current = null;
      pendingView.current = null;
      if (want) refitPending.current = true;
      else if (zoomTo) pendingZoom.current = zoomTo;
      else anchor.current = middleCard(readView());
      setCollapsed(want);
      saveSoon();
    },
    [cancelAnim, middleCard, readView, saveSoon],
  );

  // focus() from outside (the handle): summaries don't draw people, so when
  // they are showing, the cards are expanded first and the jump waits for it
  // (the detail effect below picks it up).
  const pendingFocus = useRef<string | null>(null);
  const focus = useCallback(
    (selector: string) => {
      const content = contentRef.current;
      if (!content) return false;
      if (compactRef.current && allowCompactRef.current) {
        setDetail(false);
        anchor.current = null;
        pendingFocus.current = selector;
        return true;
      }
      const el = content.querySelector(selector);
      if (el) jumpTo(el);
      return !!el;
    },
    [jumpTo, setDetail],
  );
  useImperativeHandle(ref, () => ({ focus }), [focus]);

  // ── Fit ────────────────────────────────────────────────────────────────────

  const fit = useCallback(() => {
    const sc = scrollerRef.current;
    const content = contentRef.current;
    if (!sc || !content) return;
    cancelAnimationFrame(anim.current);
    anim.current = 0;
    clearTimeout(settleTimer.current);
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    target.current = null;
    gesture.current = false;
    const [vw, vh] = [sc.clientWidth, sc.clientHeight];
    const [cw, ch] = [content.offsetWidth, content.offsetHeight];
    if (!cw || !ch) return;
    const s = clampScale(Math.min(1, (vw - 2 * FIT_PADDING) / cw, (vh - TOP_ROOM - FIT_PADDING) / ch));
    // Centred sideways; from the top, so the chart's head is where the eye lands.
    place({ x: (vw - cw * s) / 2, y: TOP_ROOM, scale: s });
  }, [place]);

  // First placement, once there is a size — where the viewer left it this
  // session, else fitted — and after that, a resize of the chart or the viewport
  // keeps the view and re-sizes the scroll area.
  useLayoutEffect(() => {
    const sc = scrollerRef.current;
    const content = contentRef.current;
    if (!sc || !content) return;
    const ro = new ResizeObserver(() => {
      if (!content.offsetWidth || !content.offsetHeight || !sc.clientWidth) {
        // No box: hidden (see `committed`). Keep the last view for the return.
        if (fittedRef.current) hidden.current = true;
        return;
      }
      if (!fittedRef.current) {
        fittedRef.current = true;
        const saved = readSavedView(storageKeyRef.current);
        if (saved) {
          const { collapsed: wasCollapsed, ...view } = saved;
          // Collapsed when the viewer left: collapse again, and put the view
          // back once the summaries are laid out (it was saved against them).
          if (wasCollapsed && allowCompactRef.current) {
            compactRef.current = true;
            pendingView.current = view;
            setCollapsed(true);
          }
          place(view);
        } else fit();
        // After the placement is written, so the content is never shown unplaced.
        requestAnimationFrame(() => setFitted(true));
        return;
      }
      const back = hidden.current;
      hidden.current = false;
      if (!gesture.current && !anim.current) place(back && committed.current ? committed.current : latest());
    });
    ro.observe(content);
    ro.observe(sc);
    return () => ro.disconnect();
  }, [fit, place, latest]);

  // The detail level changed and the new layout is in: do what setDetail (or
  // the first placement) left to do.
  useLayoutEffect(() => {
    const content = contentRef.current;
    const [focusSel, zoomKey, view, refit, a] = [
      pendingFocus.current,
      pendingZoom.current,
      pendingView.current,
      refitPending.current,
      anchor.current,
    ];
    pendingFocus.current = pendingZoom.current = pendingView.current = anchor.current = null;
    refitPending.current = false;
    if (!content) return;
    const byKey = (key: string) => content.querySelector(`[data-canvas-key="${CSS.escape(key)}"]`);
    // A focus() that needed full detail: it is drawn now.
    if (focusSel) {
      const el = content.querySelector(focusSel);
      if (el) jumpTo(el);
    } else if (zoomKey) {
      const el = byKey(zoomKey);
      if (el) zoomToElement(el, "card");
    } else if (view) {
      place(view);
    } else if (refit) {
      fit();
    } else if (a) {
      const el = byKey(a.key);
      if (!el) return;
      const b = boxIn(content, el);
      const v = readView();
      place({ ...v, x: a.px - b.x * v.scale, y: a.py - b.y * v.scale });
    }
  }, [compact, fit, place, readView, jumpTo, zoomToElement]);

  // ── Zoom ───────────────────────────────────────────────────────────────────

  // Zoom keeping the layout point (px, py) in the viewport where it is.
  const zoomAt = useCallback(
    (factor: number, px: number, py: number) => {
      const v = latest();
      const s = clampScale(v.scale * factor);
      const k = s / v.scale;
      setView({ scale: s, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
    },
    [latest, setView],
  );

  const zoomCentre = (factor: number) => {
    const sc = scrollerRef.current;
    cancelAnim();
    if (sc) zoomAt(factor, sc.clientWidth / 2, sc.clientHeight / 2);
  };

  // Wheel: only Ctrl/⌘ (and a pinch) is ours — plain scrolling is the browser's,
  // so it is left alone. Non-passive so a zoom can stop the whole app zooming;
  // browsers block on such a listener only for the first event of a scroll, so
  // plain scrolling still runs on their own thread. ScrollHandoff (the app's
  // document-level wheel listener) sees defaultPrevented and leaves zooms alone.
  //
  // (2026-11-19: tried every wheel as a zoom, drag-only panning, and undid it the
  // same day. A trackpad's two-finger scroll then zoomed too, and no browser API
  // says whether a wheel event came from a trackpad or a mouse. As it is, a
  // trackpad pans with two fingers and zooms with a pinch, which the browser
  // sends as Ctrl+wheel; a mouse zooms with Ctrl held. Figma's default too.)
  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) {
        if (anim.current) cancelAnim();
        return;
      }
      e.preventDefault();
      cancelAnim();
      moving(SETTLE_MS);
      const r = layoutRatio(sc);
      // deltaMode 1 = lines (some mice): roughly 16px a line.
      const unit = e.deltaMode === 1 ? 16 : 1;
      const rect = sc.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * unit * 0.0015), (e.clientX - rect.left) / r, (e.clientY - rect.top) / r);
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    return () => sc.removeEventListener("wheel", onWheel);
  }, [zoomAt, moving, cancelAnim]);

  // A scroll moves the map's box and is remembered; nothing else to do.
  const scrollFrame = useRef(0);
  const onScroll = () => {
    if (!hidden.current && !gesture.current && scrollerRef.current?.clientWidth) committed.current = readView();
    if (!scrollFrame.current) {
      scrollFrame.current = requestAnimationFrame(() => {
        scrollFrame.current = 0;
        updateMap();
      });
    }
    if (!gesture.current) saveSoon();
  };
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);

  // ── Drag ───────────────────────────────────────────────────────────────────

  // Drag to pan: the mouse moves the scroll. (Touch scrolls natively.) The press
  // only becomes a drag past DRAG_THRESHOLD, and only then is the pointer
  // captured — capturing on press would swallow every click on a card.
  const press = useRef<{ id: number; sx: number; sy: number; sl: number; st: number; r: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  // A drag released where no click follows (outside the window) would leave
  // suppressClick armed, and the next real click — on a card, the toolbar, the
  // people list — would be swallowed. Every click starts with a press, so a
  // press disarms it. Capture phase: the toolbars stop their presses bubbling.
  const onPointerDownCapture = () => {
    suppressClick.current = false;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    // Leave form fields alone: selecting text in a search box is not a pan.
    if ((e.target as HTMLElement).closest("input, textarea, select, [data-no-pan]")) return;
    const sc = scrollerRef.current;
    if (!sc) return;
    cancelAnim();
    // A zoom still settling: commit it, so the drag starts from the real scroll.
    if (gesture.current) settle();
    press.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, sl: sc.scrollLeft, st: sc.scrollTop, r: layoutRatio(sc), moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    const sc = scrollerRef.current;
    if (!p || !sc || p.id !== e.pointerId) return;
    const [dx, dy] = [e.clientX - p.sx, e.clientY - p.sy];
    if (!p.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      p.moved = true;
      setDragging(true);
      frameRef.current?.setPointerCapture(e.pointerId);
    }
    sc.scrollLeft = p.sl - dx / p.r;
    sc.scrollTop = p.st - dy / p.r;
  };
  // A mouse press on the chart starts no text selection (2026-11-19). A
  // selection drag that leaves the box makes the browser auto-scroll toward the
  // pointer, which pulled the chart the opposite way to the drag, to the far end
  // of the scroll. (Clearing the selection on each move wasn't enough: the
  // auto-scroll belongs to the press, not to the selection.) Not user-select on
  // the viewport, which is inherited and would restyle every card. The press
  // still focuses the scroll box, so the keys work; clicks are unaffected.
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("input, textarea, select, [data-no-pan]")) return;
    e.preventDefault();
    scrollerRef.current?.focus({ preventScroll: true });
  };
  const endPress = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (p.moved) suppressClick.current = true;
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

  // Clicks the chart itself doesn't claim: a summary card expands all and zooms
  // to itself on a click, any card or panel zooms on a double-click.
  const ownClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("button, a, summary, input, select, textarea, label, [data-no-pan]")) return null;
    return contentRef.current?.contains(t) ? t : null;
  };
  const onClick = (e: React.MouseEvent) => {
    const el = ownClick(e)?.closest("[data-canvas-expand-on-click]");
    if (el) setDetail(false, el.getAttribute("data-canvas-key"));
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const el = ownClick(e)?.closest("[data-canvas-item]");
    if (!el) return;
    document.getSelection()?.removeAllRanges();
    zoomToElement(el, el.getAttribute("data-canvas-item") === "panel" ? "panel" : "card");
  };

  // ── Keyboard ───────────────────────────────────────────────────────────────
  //
  // Arrows, Page Up/Down, Home/End and Space are the scroll box's own. Focus
  // moving to an off-screen row scrolls it into view natively too.

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as HTMLElement).closest("input, textarea, select, [role=listbox], [role=menu]")) return;
    switch (e.key) {
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

  // ── Search ─────────────────────────────────────────────────────────────────

  const [found, setFound] = useState<{ key: string; count: number; index: number } | null>(null);
  const goToMatch = useCallback(
    (index: number) => {
      const content = contentRef.current;
      const sc = scrollerRef.current;
      if (!content || !sc) return;
      const els = [...content.querySelectorAll("[data-canvas-match]")];
      if (!els.length) {
        content.querySelectorAll("[data-canvas-current]").forEach((el) => el.removeAttribute("data-canvas-current"));
        return setFound({ key: matchKey, count: 0, index: 0 });
      }
      const i = ((index % els.length) + els.length) % els.length;
      jumpTo(els[i]);
      setFound({ key: matchKey, count: els.length, index: i });
    },
    [jumpTo, matchKey],
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
      requestAnimationFrame(updateMap);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(content);
    return () => ro.disconnect();
  }, [fitted, updateMap]);

  const mapPress = useRef<number | null>(null);
  const mapMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const sc = scrollerRef.current;
    if (!map || !sc || mapPress.current !== e.pointerId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const k = rect.width / (map.w * map.m);
    const [cx, cy] = [(e.clientX - rect.left) / k / map.m, (e.clientY - rect.top) / k / map.m];
    const s = latest().scale;
    setView({ scale: s, x: sc.clientWidth / 2 - cx * s, y: sc.clientHeight / 2 - cy * s });
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

  // (A button zoom is one step, not a gesture: committed and redrawn sharp at once.)
  const btn =
    "flex h-8 min-w-8 items-center justify-center px-2 text-sm font-semibold text-sdc-gray-600 motion-interactive hover:bg-sdc-gray-50 hover:text-sdc-navy not-first:border-l not-first:border-sdc-border";
  const group = "flex overflow-hidden rounded-lg border border-sdc-border bg-white shadow-sm";

  return (
    <div
      ref={frameRef}
      className={`isolate flex overflow-clip rounded-xl border border-sdc-border bg-sdc-gray-50 ${
        expanded ? "fixed inset-4 z-40 shadow-2xl" : `relative ${className}`
      }`}
      onPointerDownCapture={onPointerDownCapture}
      onPointerDown={onPointerDown}
      onMouseDown={onMouseDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onClickCapture={onClickCapture}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    >
      {/* The chart's own area: the scroll box and everything floating over it. */}
      <div className="relative min-w-0 flex-1">
        {/* The scroll box. Scrollbars hidden: the map, drag and wheel do their job. */}
        <div
          ref={scrollerRef}
          data-scroll-own=""
          tabIndex={0}
          aria-label="Chart canvas: scroll or drag to move, plus and minus zoom, 0 goes home"
          className="absolute inset-0 cursor-grab touch-pan-x touch-pan-y overflow-auto outline-none [overflow-anchor:none] [scrollbar-width:none] focus-visible:ring-2 focus-visible:ring-sdc-blue focus-visible:ring-inset [&::-webkit-scrollbar]:hidden"
          onScroll={onScroll}
        >
          {/* The sizer: the scroll range the chart is allowed (see "Clamped").
              Doesn't clip: it is only a little bigger than the chart, so a zoom-in
              gesture stretches past it, and clipping would cut the chart off. The
              stretch only grows the (hidden) scroll range until the zoom commits. */}
          <div
            ref={sizerRef}
            className="relative bg-sdc-gray-50"
            style={{ backgroundImage: "radial-gradient(circle, var(--color-sdc-border) 1px, transparent 1px)" }}
          >
            <div
              ref={contentRef}
              className="absolute left-0 top-0 w-max origin-top-left"
              style={{ visibility: fitted ? undefined : "hidden" }}
            >
              <CompactContext value={compact}>{children}</CompactContext>
            </div>
          </div>
        </div>
        {/* Over the content while dragging, so nothing under the pointer hovers. */}
        {dragging && <div aria-hidden className="absolute inset-0 cursor-grabbing" />}

        {/* The controls, along the top (2026-11-19; were along the bottom). The row
            itself lets presses through, so its empty stretch still drags the chart. */}
        <div
          className="pointer-events-none absolute left-3 right-3 top-3 flex flex-wrap items-center justify-end gap-2 *:pointer-events-auto"
          data-no-pan
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="hidden rounded-md bg-white/80 px-2 py-1 text-note text-sdc-muted xl:inline">
            Drag or scroll to move · Ctrl + scroll or pinch to zoom · Double-click a card to zoom to it
          </span>
          {matchKey && (
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
          )}
          {allowCompact && (
            <div className={group}>
              <button
                type="button"
                className={`${btn} text-xs`}
                onClick={() => setDetail(!collapsed)}
                title={
                  collapsed
                    ? "Show every card in full, with its people"
                    : "Show every card as a summary: name, head count and hiring"
                }
              >
                {collapsed ? "Expand all" : "Collapse all"}
              </button>
            </div>
          )}
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
              onClick={() => zoomCentre(1 / latest().scale)}
              title="Zoom to 100%"
            >
              100%
            </button>
            <button type="button" className={btn} onClick={() => zoomCentre(BUTTON_STEP)} aria-label="Zoom in">
              +
            </button>
            {/* Home: the whole chart in view, from the top (what Fit did; the 0 key too). */}
            <button type="button" className={`${btn} gap-1 text-xs`} onClick={fit} title="Back to the whole chart (0)">
              <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round">
                <path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3V9.5h2V13h3V6.5" />
              </svg>
              Home
            </button>
          </div>
        </div>

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
      </div>
      {sidebar}
    </div>
  );
}
