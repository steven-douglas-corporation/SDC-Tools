"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  activeSectionIndex,
  mapAcross,
  scrollLeftForCenter,
  scrollLeftForSection,
  visibleWindow,
  type Span,
} from "@/lib/etc-quick-nav";

// A strip above the Monthly ETC grid that is two things at once:
//
//   - a row of buttons, one per main block (Complete Design and Build, Testing, Teardown
//     and Install, Total (New ETC), Parts Cost) — click one and the grid scrolls to centre
//     that block (or, if it is wider than the screen, to show its first column);
//   - a scrollbar for the grid's width — the outlined thumb is the part of the grid you
//     are looking at; drag anywhere on the strip to scroll.
//
// ── Where the blocks come from ──────────────────────────────────────────────
//
// The grid's own header cells. page.tsx marks the top-row cell of each main block with
// `data-etc-nav="<label>"`, and this reads their positions out of the DOM. That is the
// whole reason it is not a list in this file: the grid already decides which blocks exist
// (a block whose every column is hidden is display:none, so it measures zero wide and
// drops out of the strip), and a second list here would drift from it. The strip
// re-measures whenever the scroller or the table changes size, which covers the View
// menu hiding a column, the Job Name resize handle, and the sidebar Zoom.
//
// ── Why the segments are not simply proportional ────────────────────────────
//
// Parts Cost is 7 narrow columns out of several hundred; at true scale its button would
// be too small to hold its own label. So each segment grows in proportion to the block's
// real width but never below its label (min-width: max-content), and the thumb is mapped
// through each segment's own edges (lib/etc-quick-nav.ts mapAcross) so it still tracks
// the grid exactly, just not on a uniform ruler.

type Item = { label: string; weight: number };

const DRAG_THRESHOLD_PX = 4;

function sameItems(a: Item[], b: Item[]): boolean {
  return a.length === b.length && a.every((x, i) => x.label === b[i].label && Math.abs(x.weight - b[i].weight) < 1);
}

export function EtcQuickNav() {
  const rootRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const scrollerRef = useRef<HTMLElement | null>(null);
  // Content-x spans of each block, and the width of the frozen columns, as last measured.
  const geo = useRef<{ content: Span[]; stickyWidth: number }>({ content: [], stickyWidth: 0 });
  // Set for the click that ends a drag so it does not also trigger a jump.
  const justDragged = useRef(false);
  const press = useRef<{ startX: number; dragging: boolean; grabOffset: number; pointerId: number } | null>(null);

  const [items, setItems] = useState<Item[]>([]);
  const [active, setActive] = useState(-1);

  const barSpans = useCallback((): Span[] => {
    const n = geo.current.content.length;
    const out: Span[] = [];
    for (let i = 0; i < n; i++) {
      const b = buttonRefs.current[i];
      if (!b) return [];
      out.push({ start: b.offsetLeft, end: b.offsetLeft + b.offsetWidth });
    }
    return out;
  }, []);

  // Moves the thumb and the highlighted block to match the grid's scroll position.
  // Cheap enough to run on every scroll event: a few offset reads and two style writes;
  // setActive bails out when the block has not changed.
  const sync = useCallback(() => {
    const scroller = scrollerRef.current;
    const thumb = thumbRef.current;
    const { content, stickyWidth } = geo.current;
    const bar = barSpans();
    if (!scroller || !thumb || content.length === 0 || bar.length !== content.length) return;
    const view = visibleWindow(scroller.scrollLeft, scroller.clientWidth, stickyWidth);
    const a = mapAcross(view.start, content, bar);
    const b = mapAcross(view.end, content, bar);
    thumb.style.left = `${a}px`;
    thumb.style.width = `${Math.max(b - a, 8)}px`;
    setActive(activeSectionIndex(content, view));
  }, [barSpans]);

  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const sr = scroller.getBoundingClientRect();
    // Content x = viewport x - this, for anything inside the scroller.
    const origin = sr.left + scroller.clientLeft - scroller.scrollLeft;
    const heads = Array.from(scroller.querySelectorAll<HTMLElement>("thead [data-etc-nav]")).filter((el) => el.offsetWidth > 0);
    // The frozen columns sit at a fixed screen position, so their right edge is the width
    // they take from the left of the scroller at any scroll position.
    const stickyWidth = Array.from(
      scroller.querySelectorAll<HTMLElement>('thead tr:first-child > th[class*="sticky"]'),
    )
      .filter((el) => el.offsetWidth > 0)
      .reduce((m, el) => Math.max(m, el.getBoundingClientRect().right - sr.left - scroller.clientLeft), 0);

    const starts = heads.map((el) => el.getBoundingClientRect().left - origin);
    const content: Span[] = starts.map((start, i) => ({
      start,
      // Each block runs to the next one's start; the last runs to the end of the content
      // (that includes the Standard Sheet block when it is shown).
      end: i + 1 < starts.length ? starts[i + 1] : scroller.scrollWidth,
    }));
    geo.current = { content, stickyWidth };
    const next = heads.map((el, i) => ({ label: el.dataset.etcNav ?? "", weight: content[i].end - content[i].start }));
    setItems((prev) => (sameItems(prev, next) ? prev : next));
    sync();
  }, [sync]);

  useEffect(() => {
    const scroller =
      rootRef.current?.closest("form")?.querySelector<HTMLElement>('[data-scroll-key="etc-grid"]') ?? null;
    scrollerRef.current = scroller;
    if (!scroller) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(scroller);
    const table = scroller.querySelector("table");
    if (table) ro.observe(table);
    scroller.addEventListener("scroll", sync, { passive: true });
    return () => {
      ro.disconnect();
      scroller.removeEventListener("scroll", sync);
    };
  }, [measure, sync]);

  // The buttons only exist after `items` renders, so the thumb is placed after that.
  useEffect(() => {
    const raf = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(raf);
  }, [items, sync]);

  function jumpTo(i: number) {
    const scroller = scrollerRef.current;
    const span = geo.current.content[i];
    if (!scroller || !span) return;
    scroller.scrollTo({
      left: scrollLeftForSection(
        span,
        geo.current.stickyWidth,
        scroller.clientWidth,
        scroller.scrollWidth - scroller.clientWidth,
      ),
      behavior: "smooth",
    });
  }

  // Bar x of a pointer event, relative to the track's own padding box (the origin the
  // buttons' offsetLeft and the thumb's `left` both use).
  function barX(e: React.PointerEvent): number {
    const track = trackRef.current;
    if (!track) return 0;
    return e.clientX - track.getBoundingClientRect().left - track.clientLeft;
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // If the press lands on the thumb, remember where in it, so the thumb moves with the
    // pointer rather than re-centring on it. Off the thumb, the thumb will centre on the
    // pointer once a drag starts.
    let grabOffset = 0;
    const thumb = thumbRef.current;
    const x = barX(e);
    if (thumb && x >= thumb.offsetLeft && x <= thumb.offsetLeft + thumb.offsetWidth) {
      const view = visibleWindow(scroller.scrollLeft, scroller.clientWidth, geo.current.stickyWidth);
      const content = mapAcross(x, barSpans(), geo.current.content);
      grabOffset = content - (view.start + view.end) / 2;
    }
    press.current = { startX: e.clientX, dragging: false, grabOffset, pointerId: e.pointerId };
  }

  function onPointerMove(e: React.PointerEvent) {
    const p = press.current;
    const scroller = scrollerRef.current;
    if (!p || !scroller) return;
    if (!p.dragging) {
      if (Math.abs(e.clientX - p.startX) < DRAG_THRESHOLD_PX) return;
      p.dragging = true;
      // Capture only once it is a drag: capturing on press would retarget the click, and
      // the segment buttons would never see theirs.
      trackRef.current?.setPointerCapture(p.pointerId);
    }
    const bar = barSpans();
    if (bar.length === 0) return;
    scroller.scrollTo({
      left: scrollLeftForCenter({
        contentX: mapAcross(barX(e), bar, geo.current.content),
        grabOffset: p.grabOffset,
        clientWidth: scroller.clientWidth,
        stickyWidth: geo.current.stickyWidth,
        maxScroll: scroller.scrollWidth - scroller.clientWidth,
      }),
      behavior: "instant",
    });
  }

  function endPress() {
    const p = press.current;
    press.current = null;
    if (!p?.dragging) return;
    justDragged.current = true;
    setTimeout(() => {
      justDragged.current = false;
    }, 0);
  }

  return (
    <nav
      ref={rootRef}
      aria-label="Jump to a section of the grid"
      className="mb-1.5 h-[28px] select-none"
    >
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPress}
        onPointerCancel={endPress}
        onClickCapture={(e) => {
          if (justDragged.current) {
            e.stopPropagation();
            e.preventDefault();
          }
        }}
        className="relative flex h-full touch-none overflow-hidden rounded border border-sdc-border bg-sdc-gray-100"
      >
        {items.map((item, i) => (
          <button
            key={item.label}
            ref={(el) => {
              buttonRefs.current[i] = el;
            }}
            type="button"
            onClick={() => jumpTo(i)}
            title={`Jump to ${item.label}`}
            aria-current={i === active ? "true" : undefined}
            style={{ flexGrow: item.weight, flexBasis: 0, minWidth: "max-content" }}
            className={`${i === 0 ? "" : "border-l border-sdc-border"} cursor-pointer px-3 text-center text-note whitespace-nowrap ${
              i === active ? "font-semibold text-sdc-navy" : "text-sdc-gray-700 hover:bg-sdc-blue-light"
            }`}
          >
            {item.label}
          </button>
        ))}
        {/* The part of the grid currently on screen. Not interactive itself: the track
            handles the press so a drag that starts on it and one that starts beside it
            share one code path. */}
        <div
          ref={thumbRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 rounded-sm border-2 border-sdc-blue bg-sdc-blue/10"
          style={{ left: 0, width: 0 }}
        />
      </div>
    </nav>
  );
}
