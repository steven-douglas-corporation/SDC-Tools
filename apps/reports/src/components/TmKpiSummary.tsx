"use client";

import { useState } from "react";
import { KPI_GRID_CLASS } from "@/lib/etc-kpi-strip";
import { MemoKpiRow, type KpiRowData } from "@/components/ui/KpiRow";

// ── The T&M KPI summary, built from the same pieces as Monthly ETC's (§37) ──
//
// Same container chrome (one outer rounded card, hairline row dividers via
// gap-px, a collapsible "Hide/Show summary" link) and the identical KpiRow
// for every line — see EtcMonthKpiCards.tsx for the original, and
// components/ui/KpiRow.tsx for the row this and that card both render now.
//
// A plain block in the page's normal top-to-bottom flow — NOT Monthly ETC's
// side-by-side "card beside an open drill" layout. That layout puts the drill
// in its own flex column that only exists while a drill is open, which reads
// fine on the ETC page (a full grid fills the rest of the page either way)
// but on T&M — a page with nothing else below the summary — left the drill
// column's width reserved in the row's wrap calculation and read as a giant
// blank gap next to a narrow, easy-to-miss card. The drill-through itself is
// a fixed overlay now instead (see TmReportClient.tsx), which is what "must
// not reserve page space while closed" actually requires: removed from
// normal flow entirely, not just conditionally sized within it.
//
// No persisted open/closed preference (unlike Monthly ETC's
// lib/kpi-strip-pref.ts localStorage flag) — starts open, and nothing here
// claims a T&M-specific reason to remember a hidden state across visits.

export function TmKpiSummary<TDrill extends string>({
  title,
  rows,
  drill,
  detailState,
  onDrill,
  onRetry,
}: {
  title: string;
  rows: KpiRowData<TDrill>[];
  /** The currently open drill, or null. */
  drill: TDrill | null;
  /** The open drill's own fetch state — every other row is always "idle" (only one drill fetches at a time). */
  detailState: "idle" | "loading" | "error";
  onDrill: (scope: TDrill) => void;
  onRetry: (scope: TDrill) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div>
      <div className={`mb-1.5 flex items-center justify-end ${open ? "hidden" : ""}`}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={open}
          className="motion-interactive min-w-[6.5rem] text-right text-label font-medium text-sdc-muted underline decoration-dotted underline-offset-2 hover:text-sdc-navy"
        >
          Show summary
        </button>
      </div>
      {open && (
        <section
          aria-label={`${title} summary`}
          className="@container motion-fade w-full max-w-[34rem] shrink-0 overflow-hidden rounded-xl border border-sdc-border bg-sdc-border-soft shadow-sm"
        >
          <div className="flex items-baseline justify-between gap-3 border-b border-sdc-border bg-white px-3 py-2">
            <h2 className="text-label font-semibold uppercase tracking-wide text-sdc-muted">{title}</h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-expanded
              className="motion-interactive shrink-0 text-label font-medium text-sdc-muted underline decoration-dotted underline-offset-2 hover:text-sdc-navy"
            >
              Hide summary
            </button>
          </div>
          <div className={KPI_GRID_CLASS}>
            {rows.map((row) => (
              <MemoKpiRow
                key={row.id}
                {...row}
                drillOpen={row.drill != null && drill === row.drill}
                detailState={row.drill != null && row.drill === drill ? detailState : "idle"}
                onDrill={onDrill}
                onRetry={onRetry}
                // T&M's own requirement (unlike Monthly ETC's Detail-only rows):
                // clicking the row or its value opens the drill too, not just Detail.
                rowOpensDetail
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
