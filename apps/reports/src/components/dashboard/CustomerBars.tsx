"use client";

import type { CustomerSummary } from "@/lib/dashboard-overview";
import { jobTypeColor, JOB_TYPE_LEGEND, TRACK_CLASS, SEGMENT_EDGE_CLASS } from "@/lib/job-type-colors";

// ── Active Jobs by Customer, as a ranked bar chart (2026-08-28) ─────────────
//
// Replaces the card grid. Cards put every customer in a box of the same size,
// so a 9-job customer and a 1-job customer looked equally important and the
// only way to rank them was to read all 24 numbers. A ranked bar answers "who
// has the most active work" before you read anything.
//
// The type mix is not lost with the cards' chips — it IS the bar now. Each bar
// is segmented by project type, so a customer's mix is visible in the default
// view without a hover, and the segment colours are the same ones the Project
// Type chart above uses (lib/job-type-colors.ts). Exact per-type counts stay one
// hover away on each segment, and the expand row lists the job numbers.
//
// ── Why bars scale to the LARGEST customer, not to the active total ─────────
//
// Scaling to the total made every bar tiny (the biggest customer is ~15% of the
// book, so the longest bar filled a seventh of the track and the rest were
// slivers) — the exact "not enough width contrast to compare counts quickly"
// problem. Scaling to the largest customer uses the full track and makes the
// comparison the chart exists for legible. The percentage label is still
// percent-of-total, so nothing about the numbers changes; only the bar's scale
// is relative, and the header says so.

// ── Canonical customers, not stored spellings (2026-08-31) ────────────────
//
// Each row is ONE canonical customer (lib/customer-canonical.ts), so the
// ranking, the percentages and the type segments all operate on combined
// totals — First Solar is one 24-job bar rather than seven bars nobody could
// add up by eye.
//
// ── Every customer, always (2026-08-31) ────────────────────────────────────
//
// This had Top 10 / Top 15 / All buttons. They are gone: the full list is the
// only view now, and the card absorbs its own length with an internal scroll
// rather than by hiding rows behind a control. Three consequences the layout
// depends on:
//
//   * The card is a FLEX COLUMN with three parts — a fixed legend, a scrolling
//     row list, a fixed footer. Only the middle one moves.
//   * The card carries its OWN ceiling (.customer-chart-cap in globals.css)
//     rather than inheriting a height from the row. That is what keeps the
//     dashboard from growing with the customer count, and it leaves the Project
//     Type card beside it free to be as short as its six rows.
//   * `min-h-0` is load-bearing on both the card and the list: without it a flex
//     item refuses to shrink below its content, so the list would push the card
//     past its ceiling instead of scrolling inside it.
//   * Under the cap — few enough customers to fit — nothing binds and the card
//     hugs its content like any other.
//
// Nothing is merged silently. A row that combined more than one stored spelling
// says so, on the row, and names them on hover; the drill-through carries the
// stored value per job as its own column. The point is a readable chart AND a
// visible data-quality problem, not a tidy chart that hides one.

function CustomerRow({
  c,
  activeTotal,
  max,
  open,
  onOpen,
}: {
  c: CustomerSummary;
  activeTotal: number;
  max: number;
  /** True when THIS customer's drill-through is the one currently open below the charts. */
  open: boolean;
  onOpen: () => void;
}) {
  const pct = activeTotal === 0 ? 0 : Math.round((c.activeCount / activeTotal) * 1000) / 10;
  // Stored spellings this row combined. One entry means nothing was merged, and
  // the row then looks exactly as it always did.
  const merged = c.rawNames.length > 1 ? c.rawNames : null;
  const mergedTitle = merged
    ? `Combined from ${merged.length} stored customer names: ${merged.map((r) => `${r.name} (${r.count})`).join(", ")}`
    : undefined;
  // Bar track width relative to the biggest customer; segments then divide THAT
  // width by type, so the segments always sum to exactly the bar.
  const trackPct = max === 0 ? 0 : (c.activeCount / max) * 100;

  return (
    // The WHOLE row is one control that opens this customer's jobs in the panel
    // below the charts. It was a <Link> to /jobs, which left the Dashboard and
    // lost the chart you were reading; a <button> both keeps you here and stops
    // the row being middle-clicked into a new tab.
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={open}
      aria-label={
        `Show the ${c.activeCount} active job${c.activeCount === 1 ? "" : "s"} for ${c.name}` +
        (merged ? `, combined from ${merged.length} stored customer names` : "")
      }
      className={`block w-full text-left motion-interactive ${open ? "bg-sdc-blue-light" : "bg-white hover:bg-sdc-blue-light/25"}`}
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span
          title={mergedTitle ?? c.name}
          className="w-40 shrink-0 truncate text-sm font-medium text-sdc-navy sm:w-48"
        >
          {c.name}
          {merged && (
            // Small, and deliberately not hidden behind a hover: somebody
            // reading "24" has to be able to see that it is a combined figure
            // without being told. The hover names every spelling.
            <span
              className="ml-1.5 rounded bg-sdc-gray-100 px-1 py-0.5 text-[0.6rem] font-semibold tabular-nums text-sdc-gray-600"
              title={mergedTitle}
            >
              {merged.length} names
            </span>
          )}
          {c.internal && (
            <span
              className="ml-1.5 rounded bg-sdc-blue-light px-1 py-0.5 text-[0.6rem] font-semibold uppercase text-sdc-blue-dark"
              title="SDC's own internal work, not a customer relationship — counted because these are real active jobs"
            >
              Int
            </span>
          )}
        </span>

        <span className="flex min-w-0 flex-1 items-center gap-2">
          {/* The unfilled track. TRACK_CLASS, not a literal, so the neutral
              behind every bar on the page is defined in one place alongside the
              fills it has to stay subtle against. */}
          <span className={`h-3.5 min-w-0 flex-1 overflow-hidden rounded-sm ${TRACK_CLASS}`}>
            <span className="flex h-full" style={{ width: `${trackPct}%` }}>
              {c.byType.map((t) => (
                <span
                  key={t.type}
                  // The type's brand fill, plus a 1px inset light edge against the
                  // previous segment — Yellow and Lime are both very light, and two
                  // of them touching read as one blob without it. The edge is an
                  // inset shadow, so segment widths still sum to exactly the bar.
                  className={`${jobTypeColor(t.type).bar} ${SEGMENT_EDGE_CLASS}`}
                  style={{ width: `${(t.count / c.activeCount) * 100}%` }}
                  title={`${c.name} — ${t.type}: ${t.count} active job${t.count === 1 ? "" : "s"}`}
                />
              ))}
            </span>
          </span>
          <span className="w-7 shrink-0 text-right font-heading text-sm font-bold tabular-nums text-sdc-navy">
            {c.activeCount}
          </span>
          <span className="w-11 shrink-0 text-right text-label tabular-nums text-sdc-gray-400">{pct}%</span>
        </span>
      </div>
    </button>
  );
}

export function CustomerBars({
  customers,
  activeTotal,
  onOpen,
  isOpen,
}: {
  customers: CustomerSummary[];
  activeTotal: number;
  // Keyed on the CANONICAL CUSTOMER ID, not the label: two canonical customers
  // could in principle end up displaying the same dominant spelling, and the
  // drill-through has to identify the bar unambiguously.
  onOpen: (canonicalCustomerId: string) => void;
  isOpen: (canonicalCustomerId: string) => boolean;
}) {
  // `customers` already arrives sorted by active count descending from
  // dashboard-overview.ts. Not re-sorted here, so there is one ranking
  // definition, not two — and since every row is shown, the first one is the
  // largest and sets the bar scale.
  const max = customers[0]?.activeCount ?? 0;
  // How many rows combined more than one stored spelling — a data-quality
  // signal, stated in the footer rather than left to a hover on each row.
  const mergedRows = customers.filter((c) => c.rawNames.length > 1).length;

  if (customers.length === 0) {
    return (
      <div className="rounded-xl border border-sdc-border bg-white p-5 text-sm text-sdc-gray-400 shadow-sm">
        No active jobs, so no customers to show.
      </div>
    );
  }

  return (
    // customer-chart-cap is the ceiling; min-h-0 is what lets the list shrink
    // under it so the ROWS scroll rather than the page.
    <div className="customer-chart-cap flex min-h-0 flex-col overflow-hidden rounded-xl border border-sdc-border bg-white shadow-sm">
      {/* Legend — fixed. shrink-0 so a long list cannot squeeze it away. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-sdc-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {JOB_TYPE_LEGEND.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 text-label text-sdc-gray-600">
              {/* .swatch is the SAME class as the segment .bar, so the legend cannot
                  drift from the bars. The hairline ring is for the two light brand
                  colours (Yellow, Lime), which would otherwise be near-invisible
                  swatches on the white header band. */}
              <span
                className={`inline-block h-2 w-2 rounded-sm ring-1 ring-inset ring-black/10 ${jobTypeColor(t).swatch}`}
                aria-hidden
              />
              {t}
            </span>
          ))}
        </div>
      </div>

      {/* The ONLY part of the card that scrolls. The card's ceiling is what
          bounds it; `flex-1 min-h-0` is what makes this the child that absorbs
          the overflow rather than the legend or the footer. */}
      <div className="styled-scrollbar min-h-0 flex-1 divide-y divide-sdc-border-soft overflow-y-auto">
        {customers.map((c) => (
          <CustomerRow
            key={c.canonicalCustomerId}
            c={c}
            activeTotal={activeTotal}
            max={max}
            open={isOpen(c.canonicalCustomerId)}
            onOpen={() => onOpen(c.canonicalCustomerId)}
          />
        ))}
      </div>

      {/* Fixed, below the scroll. No Top-N wording left to say: the list is
          always every customer, so the counts are unconditional. */}
      <p className="shrink-0 border-t border-sdc-border px-3 py-1.5 text-label text-sdc-gray-400">
        {`${customers.length} customer${customers.length === 1 ? "" : "s"} · ${activeTotal} active job${activeTotal === 1 ? "" : "s"}`}
        {" · bar length is relative to the largest customer; % is of the active book"}
        {mergedRows > 0 && (
          <>
            {" · "}
            <span title="Rows that combined more than one stored customer name. The Data Quality tab lists them all.">
              {mergedRows} row{mergedRows === 1 ? "" : "s"} combine multiple stored names
            </span>
          </>
        )}
      </p>
    </div>
  );
}
