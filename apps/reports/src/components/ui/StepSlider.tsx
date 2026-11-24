"use client";

import type { ReactNode } from "react";

// A slider over a few fixed steps: a drawn track, filled in blue up to the handle, with a
// tick at every step (blue once passed). A native range input sits on top, see-through, so
// dragging, clicking the track, the arrow keys and screen readers all work as usual; its
// handle is styled in globals.css (.step-slider). First used for Open POs' Card size.

const THUMB_HALF = 7; // px: half the 14px handle. Ticks and fill are inset by it to meet the handle's centre.

export function StepSlider({
  value,
  steps,
  onChange,
  label,
  valueText,
  start,
  end,
  width = 176,
}: {
  /** The current step, 0 to steps - 1. */
  value: number;
  steps: number;
  onChange: (step: number) => void;
  /** Accessible name. */
  label: string;
  /** What a screen reader says for a step, e.g. "Size 3 of 5". */
  valueText?: (step: number) => string;
  /** Beside the track's ends: what the lowest and highest steps mean. */
  start?: ReactNode;
  end?: ReactNode;
  /** The track's width in CSS px. */
  width?: number;
}) {
  const frac = steps > 1 ? value / (steps - 1) : 0;
  return (
    <span className="flex items-center gap-2">
      {start}
      <span className="relative block h-5" style={{ width }}>
        {/* The track, then the fill up to the handle's centre: the full track scaled from its
            left end, so it moves by transform like the rest of the app's motion (§36.15). */}
        <span className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-sdc-gray-100" style={{ left: THUMB_HALF, right: THUMB_HALF }} />
        <span
          className="motion-interactive absolute top-1/2 h-1 origin-left -translate-y-1/2 rounded-full bg-sdc-blue"
          style={{ left: THUMB_HALF, right: THUMB_HALF, transform: `scaleX(${frac})` }}
        />
        {/* A tick per step, each centred on where the handle stops. */}
        <span className="pointer-events-none absolute inset-y-0 flex items-center justify-between" style={{ left: THUMB_HALF, right: THUMB_HALF }}>
          {Array.from({ length: steps }, (_, i) => (
            <span key={i} className="relative w-0">
              <span className={`absolute -left-px top-1/2 h-2.5 w-0.5 -translate-y-1/2 rounded-full ${i <= value ? "bg-sdc-blue" : "bg-slate-300"}`} />
            </span>
          ))}
        </span>
        <input
          type="range"
          min={0}
          max={steps - 1}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={label}
          aria-valuetext={valueText?.(value)}
          className="step-slider absolute inset-0 h-full w-full"
        />
      </span>
      {end}
    </span>
  );
}
