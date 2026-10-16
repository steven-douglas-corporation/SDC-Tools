"use client";

import { useEffect, useRef, useState } from "react";

// ── A donut chart ───────────────────────────────────────────────────────────
//
// Colour-agnostic and data-agnostic: the caller hands it labelled values and a
// stroke class for each, so the same ring draws project types (type colours) and
// customers (a rank ramp) without either leaking into the other. The Dashboard's
// two donuts are the callers.
//
// Each slice is a stroked circle drawn with a dash — not an arc path — so a
// slice that is the WHOLE ring (one slice, 100%) needs no special case: a
// full-circle arc has coincident endpoints and renders as nothing.
// `pathLength={100}` makes the dash units percentages, so a slice is just
// `share` long. The stroke class has to be a literal string in the caller's
// source: Tailwind finds classes by scanning text, and an assembled name
// compiles to nothing.
//
// The ring is a pointer shortcut, not a second control: the caller's legend rows
// are the real buttons (keyboard, aria-pressed, the figures), and the ring is
// aria-hidden. A slice does what its legend row does.
//
// Slices run clockwise from 12 o'clock in the order given, and zero-value
// slices are skipped — the caller's legend decides whether to still list them.

const SIZE = 180;
const CENTER = SIZE / 2;
const RADIUS = 68;
const THICKNESS = 26;
// A white gap between neighbours, in percent of the ring. Light slices sit side
// by side (Yellow and Light Blue; the lighter steps of a ramp), and a gap
// separates them where a shared edge would not.
const GAP = 0.8;
// How far outside the ring's outer edge the hover readout sits, in px.
const READOUT_OFFSET = 6;
// How far behind the pointer the readout trails: the time constant of its
// exponential ease, in ms. It covers ~63% of the remaining angle in this long.
const FOLLOW_MS = 90;
// Grace before the readout starts fading out. Crossing the 0.8% gap between two
// slices is a leave followed at once by an enter; without this the readout would
// flash out and snap back in.
const HIDE_DELAY_MS = 40;

export type DonutSlice = {
  key: string;
  label: string;
  value: number;
  /** An SVG stroke class, written out literally (e.g. "stroke-sdc-blue"). */
  stroke: string;
  /** False for a slice that is shown but opens nothing (a lumped "Other"). Default true. */
  selectable?: boolean;
};

export function DonutChart({
  slices,
  centerValue,
  centerLabel,
  selectedKey,
  onSelect,
}: {
  slices: DonutSlice[];
  /** The big figure in the hole. */
  centerValue: string;
  /** The small line under it. Truncated if it will not fit the hole. */
  centerLabel: string;
  /** When set, every other slice steps back so the chosen one stays the one that reads. */
  selectedKey: string | null;
  onSelect?: (key: string) => void;
}) {
  // `shown` is the LAST slice hovered and is never cleared on leave, so the
  // readout keeps its text while it fades out; `visible` is what fades it.
  const [shown, setShown] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  const svgRef = useRef<SVGSVGElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  // The readout's position is driven straight onto the element each animation
  // frame rather than through state: re-rendering the donut 60 times a second to
  // move one box would be the expensive way to do this.
  const target = useRef(0); // pointer angle, radians clockwise from 12 o'clock
  const current = useRef(0); // where the readout actually is, easing toward target
  const frame = useRef(0);
  const lastTick = useRef(0);
  const visibleRef = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The readout is anchored just outside the ring at `angle`, and shifted so the
  // edge of the box nearest the ring is the one touching the anchor: 3 o'clock
  // puts it to the right, 9 o'clock to the left, 6 o'clock below, and anything
  // between slides smoothly across — the two translate fractions are just
  // sin/cos of the angle, no breakpoints.
  const place = (angle: number) => {
    const el = readoutRef.current;
    if (!el) return;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const reach = RADIUS + THICKNESS / 2 + READOUT_OFFSET;
    el.style.left = `${CENTER + reach * sin}px`;
    el.style.top = `${CENTER - reach * cos}px`;
    el.style.transform = `translate(${-50 + 50 * sin}%, ${-50 - 50 * cos}%)`;
  };

  // Ease the readout's angle toward the pointer's. The step is taken the SHORT
  // way round the circle, so crossing 6 o'clock (where the angle jumps from +π
  // to −π) glides across instead of swinging all the way round the other side —
  // and it travels the ring's edge rather than cutting through the hole.
  const step = (now: number) => {
    const dt = lastTick.current ? now - lastTick.current : 16;
    lastTick.current = now;
    const gap = target.current - current.current;
    const diff = Math.atan2(Math.sin(gap), Math.cos(gap));
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const k = reduced ? 1 : 1 - Math.exp(-dt / FOLLOW_MS);
    current.current += diff * k;
    place(current.current);
    if (Math.abs(diff * (1 - k)) > 0.0005) {
      frame.current = requestAnimationFrame(step);
    } else {
      frame.current = 0;
      lastTick.current = 0;
    }
  };

  // Called on enter AND move, so the readout never appears at a stale angle.
  const track = (key: string, e: React.MouseEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Read off the pointer against the svg's own centre, so it is right at any
    // zoom or layout — only the direction matters, never the distance.
    target.current = Math.atan2(e.clientX - (rect.left + rect.width / 2), -(e.clientY - (rect.top + rect.height / 2)));
    clearTimeout(hideTimer.current);
    if (!visibleRef.current) {
      // Fading in from nothing: appear AT the pointer's angle, not gliding in
      // from wherever it was last left.
      current.current = target.current;
      place(target.current);
      visibleRef.current = true;
      setVisible(true);
    } else if (!frame.current) {
      lastTick.current = 0;
      frame.current = requestAnimationFrame(step);
    }
    setShown(key);
  };

  const leave = () => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      visibleRef.current = false;
      setVisible(false);
    }, HIDE_DELAY_MS);
  };

  useEffect(
    () => () => {
      clearTimeout(hideTimer.current);
      cancelAnimationFrame(frame.current);
    },
    [],
  );

  const drawn = slices.filter((s) => s.value > 0);
  const sum = drawn.reduce((n, s) => n + s.value, 0);
  const gap = drawn.length > 1 ? GAP : 0;

  // Where each slice begins = the share of everything ordered before it.
  const placed = drawn.map((slice, i) => ({
    slice,
    share: (slice.value / sum) * 100,
    start: (drawn.slice(0, i).reduce((n, s) => n + s.value, 0) / sum) * 100,
  }));
  const active = placed.find((p) => p.slice.key === shown)?.slice;

  return (
    <div className="relative mx-auto shrink-0" style={{ width: SIZE, height: SIZE }}>
      <svg ref={svgRef} viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} aria-hidden="true" className="-rotate-90">
        <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="none" strokeWidth={THICKNESS} pathLength={100} className="stroke-sdc-gray-100" />
        {placed.map(({ slice, share, start }) => {
          const len = Math.max(share - gap, 0.1);
          const selectable = slice.selectable !== false && onSelect !== undefined;
          const dim = selectedKey !== null && selectedKey !== slice.key;
          return (
            <circle
              key={slice.key}
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              strokeWidth={THICKNESS}
              pathLength={100}
              strokeDasharray={`${len} ${100 - len}`}
              strokeDashoffset={-(start + gap / 2)}
              className={`${slice.stroke} motion-interactive ${selectable ? "cursor-pointer" : ""} ${dim ? "opacity-30" : selectable ? "hover:opacity-85" : ""}`}
              onClick={selectable ? () => onSelect(slice.key) : undefined}
              onMouseEnter={(e) => track(slice.key, e)}
              onMouseMove={(e) => track(slice.key, e)}
              onMouseLeave={leave}
            />
          );
        })}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-heading text-4xl font-bold leading-none tabular-nums text-sdc-navy">{centerValue}</span>
        <span className="mt-1 max-w-[88px] truncate text-label text-sdc-gray-400">{centerLabel}</span>
      </div>
      {/* Always mounted: its position is written by place() before `visible`
          flips, so it fades in where it belongs. Only the opacity changes.
          pointer-events-none + select-none: it is a readout, never a target. The
          mouse passes through it, so it can never trap the hover it belongs to,
          and its text cannot be selected or dragged. aria-hidden because the
          legend row carries the same figures for assistive tech. */}
      <div
        ref={readoutRef}
        aria-hidden="true"
        className={`pointer-events-none absolute z-10 flex select-none items-baseline gap-1.5 whitespace-nowrap rounded-md border border-sdc-border bg-white px-2 py-1 shadow-md motion-fade-state ${
          visible && active ? "opacity-100" : "opacity-0"
        }`}
      >
        {active && (
          <>
            <span className="text-label text-sdc-gray-400">{active.label}</span>
            <span className="font-heading text-sm font-bold tabular-nums text-sdc-navy">{active.value}</span>
          </>
        )}
      </div>
    </div>
  );
}
