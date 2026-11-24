"use client";

import { useRef, useState, useSyncExternalStore } from "react";

// The timeline's column of titles, at a width the viewer chooses. The rows inside are drawn on
// the server like the rest of the timeline; this only holds them and the edge that is dragged.
// The width is the viewer's own preference, so it is kept in their browser, not in the address.

const DEFAULT = 320;
const MIN = 160;
const MAX = 720;
const STEP = 24;
const KEY = "tracker.timeline.titles";

const clamp = (n: number) => Math.max(MIN, Math.min(MAX, Math.round(n)));

// The stored width, read the way React reads anything kept outside it. The server cannot know
// it, so it draws the default and the browser corrects it as the page comes alive.
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function stored(): number {
  try {
    const n = Number(window.localStorage.getItem(KEY));
    return Number.isFinite(n) && n > 0 ? clamp(n) : DEFAULT;
  } catch {
    return DEFAULT;
  }
}
function keep(next: number) {
  try {
    window.localStorage.setItem(KEY, String(clamp(next)));
  } catch {
    // Storage can be turned off; the width then cannot be kept.
  }
  for (const listener of listeners) listener();
}

export function TimelineTitles({ children }: { children: React.ReactNode }) {
  const kept = useSyncExternalStore(subscribe, stored, () => DEFAULT);
  // While the edge is being dragged the column follows the pointer; the width is kept on release.
  const [dragging, setDragging] = useState<number | null>(null);
  const drag = useRef<{ x: number; width: number; scale: number } | null>(null);
  const width = dragging ?? kept;

  return (
    <div style={{ width }} className="relative shrink-0 border-r border-sdc-border">
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Width of the titles"
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to change the width of the titles. Double-click to reset."
        className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none hover:bg-sdc-blue/30 focus-visible:bg-sdc-blue/40 focus-visible:outline-none"
        onPointerDown={(e) => {
          // The app can be zoomed (Settings), so a pixel the pointer moves is not always a pixel of
          // width: measure the column as drawn against the width it was given.
          const drawn = e.currentTarget.parentElement?.getBoundingClientRect().width ?? width;
          drag.current = { x: e.clientX, width, scale: drawn > 0 ? drawn / width : 1 };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setDragging(clamp(d.width + (e.clientX - d.x) / d.scale));
        }}
        onPointerUp={(e) => {
          if (!drag.current) return;
          keep(drag.current.width + (e.clientX - drag.current.x) / drag.current.scale);
          drag.current = null;
          setDragging(null);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(null);
        }}
        onDoubleClick={() => keep(DEFAULT)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") keep(width - STEP);
          else if (e.key === "ArrowRight") keep(width + STEP);
          else if (e.key === "Home") keep(DEFAULT);
          else return;
          e.preventDefault();
        }}
      />
    </div>
  );
}
