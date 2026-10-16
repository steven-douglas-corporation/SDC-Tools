"use client";

import Link from "next/link";
import { SectionTitle } from "@/components/ui/Typography";
import { CustomerBars } from "@/components/dashboard/CustomerBars";
import { JobDrillPanel, useJobDrill } from "@/components/dashboard/JobDrillPanel";
import { CustomerConcentration } from "@/components/dashboard/CustomerConcentration";
import { DonutChart } from "@/components/ui/DonutChart";
import { jobTypeColor, rankByCount } from "@/lib/job-type-colors";
import type { CustomerSummary, JobTypeBreakdown } from "@/lib/dashboard-overview";

// ── The two Active Jobs charts and the drill they share (2026-08-28) ────────
//
// Its own CLIENT component, split out of DashboardOverview.tsx, which is a
// server component. The drill's state lives in useJobDrill(), and a hook cannot
// be called from a server component — doing exactly that shipped and took the
// whole Dashboard down at request time:
//
//   Attempted to call useJobDrill() from the server but useJobDrill is on the
//   client.
//
// Note it did NOT fail the build: the Dashboard is a dynamic route, so nothing
// prerendered it and the boundary was only crossed on a real request. See
// tests/client-boundary.test.ts, which now catches this statically.
//
// Only this section moved across the boundary, not the whole overview: the KPI
// strip, the FAT list and the workforce cards stay server-rendered. Everything
// this needs arrives as plain serializable props.

// A legend row for the donut: swatch, name, count, share. The colour comes from
// the same jobTypeColor() the ring slice uses, so the two cannot disagree.
function TypeRow({
  row,
  onOpen,
  open,
}: {
  row: JobTypeBreakdown;
  onOpen: () => void;
  open: boolean;
}) {
  const empty = row.count === 0;
  const color = jobTypeColor(row.type);
  return (
    // A <button>, not a <Link>: it changes what this page shows rather than
    // going somewhere, so it must not be middle-clickable into a new tab or
    // followed by a crawler, and it announces its state with aria-pressed.
    <button
      type="button"
      onClick={onOpen}
      disabled={empty}
      aria-pressed={open}
      title={`${row.type}: ${row.count} active job${row.count === 1 ? "" : "s"} (${row.pct}% of the active book)`}
      className={`flex w-full items-center gap-3 px-4 py-2 text-left ${
        empty ? "cursor-default bg-white opacity-40" : `motion-interactive ${open ? "bg-sdc-blue-light" : "bg-white hover:bg-sdc-blue-light/25"}`
      }`}
    >
      <span className={`h-3 w-3 shrink-0 rounded-sm ${color.swatch}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-sdc-navy">{row.type}</span>
      <span className="w-7 shrink-0 text-right font-heading text-sm font-bold tabular-nums text-sdc-navy">{row.count}</span>
      <span className="w-11 shrink-0 text-right text-label tabular-nums text-sdc-gray-400">{row.pct}%</span>
    </button>
  );
}

// ── The card shell, sized to its CONTENT (2026-08-31) ───────────────────────
//
// A flex column with no height of its own, so the card is exactly as tall as
// the rows inside it and stops.
//
// It briefly stretched to match the customer card beside it, with a white
// filler absorbing the difference. That is what put a third of a card of blank
// space under Head Start — six rows do not fill 510px, and no amount of filler
// makes empty space look intentional. The two cards align at the TOP now and
// size independently.
//
// Still flex rather than grid: a grid with auto rows distributes any spare
// height across them (align-content defaults to stretch), so if this card is
// ever given a height again the rows would silently stretch instead of the card
// simply being too tall — a subtler bug than the one it replaced. The gap-px
// over a border-soft background is what draws the hairlines between rows.
function Frame({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      // No overflow-hidden: the donut's hover readout hangs outside the ring and
      // must not be cut off by this card's edge. The rounded corners are done by
      // the first and last child instead, below.
      className={`flex flex-col gap-px rounded-xl border border-sdc-border bg-sdc-border-soft shadow-sm [&>:first-child]:rounded-t-[0.7rem] [&>:last-child]:rounded-b-[0.7rem] ${className}`}
    >
      {children}
    </div>
  );
}

function SectionHead({ title, note }: { title: string; note?: React.ReactNode }) {
  return (
    <div className="mb-2.5 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <SectionTitle>{title}</SectionTitle>
        {note && <p className="mt-0.5 text-label text-sdc-gray-400">{note}</p>}
      </div>
    </div>
  );
}

export function ActiveJobsSection({
  byType,
  customers,
  activeTotal,
  headStartTotal,
}: {
  byType: JobTypeBreakdown[];
  customers: CustomerSummary[];
  activeTotal: number;
  headStartTotal: number;
}) {
  // ONE drill for both charts — clicking a type after a customer replaces the
  // table rather than opening a second one.
  const drill = useJobDrill();

  // Ranked by count, with the declared type order as a stable tiebreak
  // (rankByCount). The donut and its legend share this one order.
  const ranked = rankByCount(byType);
  const openType = drill.filter?.kind === "type" ? drill.filter.value : null;
  const openCustomerId = drill.filter?.kind === "customer" ? drill.filter.value : null;

  return (
    <>
      {/* ── Aligned at the top, sized independently (2026-08-31) ───────────
          `items-start`, not the default `items-stretch`. Stretch made both
          sections as tall as the taller one, which is how the type card ended
          up with blank space under Head Start: it has six rows, the customer
          card has a capped scrolling list, and there is no reason for the
          shorter one to pretend otherwise. Each section is now its own height
          and they share a top edge. */}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(320px,0.85fr)_minmax(0,1.6fr)]">
        <section className="flex min-w-0 flex-col">
          <SectionHead
            title="Active Jobs by Project Type"
            note={
              <>
                {activeTotal} active job{activeTotal === 1 ? "" : "s"} · current status, not month-scoped
              </>
            }
          />
          <Frame>
            {/* The ring has no slice for a zero-count type, so the legend is where
                "no Service work right now" stays visible: those rows sort last and
                dimmed rather than disappearing. */}
            <div className="bg-white px-4 py-5">
              <DonutChart
                slices={ranked.map((row) => ({
                  key: row.type,
                  label: row.type,
                  value: row.count,
                  stroke: jobTypeColor(row.type).stroke,
                }))}
                centerValue={String(activeTotal)}
                centerLabel={`active job${activeTotal === 1 ? "" : "s"}`}
                selectedKey={openType}
                onSelect={(type) => drill.toggle({ kind: "type", value: type })}
              />
            </div>
            {ranked.map((row) => (
              <TypeRow
                key={row.type}
                row={row}
                open={drill.isOpen({ kind: "type", value: row.type })}
                onOpen={() => drill.toggle({ kind: "type", value: row.type })}
              />
            ))}
            {/* Head Start is a STATUS, not a type — a Head Start job is also a
                Custom or a Duplicate. It sits below the bars rather than among
                them so the rows above still sum to exactly the Active Jobs KPI,
                which is what makes the two reconcile. It keeps its link to the
                filtered job list: there is no Head Start drill, because these
                jobs are outside the active book this panel is about. */}
            <Link
              href="/jobs?status=HeadStart"
              className="flex items-center justify-between gap-3 bg-sdc-yellow-bg/40 px-4 py-2.5 motion-interactive hover:bg-sdc-yellow-bg/70"
            >
              <span className="text-sm font-semibold text-sdc-yellow-text">Head Start (status, separate from Active)</span>
              <span className="font-heading text-base font-bold tabular-nums text-sdc-yellow-text">{headStartTotal}</span>
            </Link>
          </Frame>
        </section>

        <section className="flex min-w-0 flex-col">
          <SectionHead
            title="Active Jobs by Customer"
            note={`${customers.length} customers with active work · one row per customer, spelling variants combined`}
          />
          {/* The concentration donut sits above the bars and shares their drill:
              a named customer opens the same panel its bar does. */}
          <div className="mb-3">
            <CustomerConcentration
              customers={customers}
              activeTotal={activeTotal}
              openCustomerId={openCustomerId}
              onOpen={(id) => drill.toggle({ kind: "customer", value: id })}
            />
          </div>
          {/* No wrapper height: the card carries its own ceiling
              (.customer-chart-cap) and scrolls inside it. */}
          <CustomerBars
            customers={customers}
            activeTotal={activeTotal}
            // The CANONICAL CUSTOMER ID, which is what the chart grouped by — so
            // the drill narrows on the same key rather than trying to re-derive a
            // bar's identity from its label.
            onOpen={(id) => drill.toggle({ kind: "customer", value: id })}
            isOpen={(id) => drill.isOpen({ kind: "customer", value: id })}
          />
        </section>
      </div>

      {/* The drill sits BELOW both charts, full content width, so whichever bar
          you clicked is still on screen above it. Rendered outside the two-column
          grid on purpose: inside it, the table would be squeezed into one column. */}
      {drill.filter && (
        <JobDrillPanel
          filter={drill.filter}
          result={drill.result}
          loading={drill.loading}
          error={drill.error}
          onClose={drill.close}
          expectedCount={
            drill.filter.kind === "type"
              ? (byType.find((t) => t.type === drill.filter!.value)?.count ?? 0)
              : (customers.find((c) => c.canonicalCustomerId === drill.filter!.value)?.activeCount ?? 0)
          }
          // `filter.value` is a canonical customer id, which is not a label — the
          // heading takes the name off the very row that was clicked, so the
          // panel's title and the bar's label are the same string by
          // construction.
          label={
            drill.filter.kind === "type"
              ? drill.filter.value
              : (customers.find((c) => c.canonicalCustomerId === drill.filter!.value)?.name ??
                drill.filter.value)
          }
        />
      )}
    </>
  );
}
