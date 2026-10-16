"use client";

import { DonutChart } from "@/components/ui/DonutChart";
import { concentrationSlices, type ConcentrationSlice } from "@/lib/customer-concentration";
import type { CustomerSummary } from "@/lib/dashboard-overview";

// ── The customer donut: how concentrated is the active book? ────────────────
//
// Sits above the customer bars, not instead of them. The bars carry the
// per-customer type mix and the whole scrolling list; this answers one question
// they cannot at a glance — how much of the book is a few names. The biggest
// customer's share is the figure in the hole, since that is the headline.
//
// The legend rows are the real controls (see DonutChart): a named customer opens
// the same drill its bar does. "Other" lumps the long tail and opens nothing —
// there is no single customer to show jobs for.

function SliceRow({
  slice,
  open,
  onOpen,
}: {
  slice: ConcentrationSlice;
  open: boolean;
  onOpen: () => void;
}) {
  const body = (
    <>
      <span className={`h-3 w-3 shrink-0 rounded-sm ${slice.swatch}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-sdc-navy">
        {slice.label}
        {slice.isOther && (
          <span className="ml-1.5 text-label font-normal text-sdc-gray-400">
            {slice.customerCount} customer{slice.customerCount === 1 ? "" : "s"}
          </span>
        )}
      </span>
      <span className="w-7 shrink-0 text-right font-heading text-sm font-bold tabular-nums text-sdc-navy">{slice.count}</span>
      <span className="w-11 shrink-0 text-right text-label tabular-nums text-sdc-gray-400">{slice.pct}%</span>
    </>
  );

  if (slice.isOther) {
    return <div className="flex items-center gap-3 bg-white px-4 py-2">{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={open}
      title={`${slice.label}: ${slice.count} active job${slice.count === 1 ? "" : "s"} (${slice.pct}% of the active book)`}
      className={`motion-interactive flex w-full items-center gap-3 px-4 py-2 text-left ${
        open ? "bg-sdc-blue-light" : "bg-white hover:bg-sdc-blue-light/25"
      }`}
    >
      {body}
    </button>
  );
}

export function CustomerConcentration({
  customers,
  activeTotal,
  openCustomerId,
  onOpen,
}: {
  customers: CustomerSummary[];
  activeTotal: number;
  /** The canonical id of the customer whose drill is open, if any. */
  openCustomerId: string | null;
  onOpen: (canonicalCustomerId: string) => void;
}) {
  const slices = concentrationSlices(customers, activeTotal);
  if (slices.length === 0) return null;

  const largest = slices[0];
  return (
    // No overflow-hidden: the donut's hover readout hangs outside the ring and
    // must not be cut off by this card's edge. The card is white and the legend
    // sits clear of its corners, so nothing needs clipping — except the last row
    // when the legend wraps beneath the donut, which rounds itself.
    <div className="flex flex-wrap items-center rounded-xl border border-sdc-border bg-white shadow-sm">
      <div className="px-6 py-5">
        <DonutChart
          slices={slices.map((s) => ({ key: s.key, label: s.label, value: s.count, stroke: s.stroke, selectable: !s.isOther }))}
          centerValue={`${Math.round(largest.pct)}%`}
          centerLabel={largest.label}
          selectedKey={openCustomerId}
          onSelect={onOpen}
        />
      </div>
      {/* Centred against the donut with hairline dividers — not stretched with a
          tinted gap-px background, which would leave a strip of that tint under
          the last row whenever the donut is the taller of the two. */}
      <div className="flex min-w-[240px] flex-1 flex-col divide-y divide-sdc-border-soft self-center [&>:last-child]:rounded-b-[0.7rem]">
        {slices.map((s) => (
          <SliceRow key={s.key} slice={s} open={openCustomerId === s.key} onOpen={() => onOpen(s.key)} />
        ))}
      </div>
    </div>
  );
}
