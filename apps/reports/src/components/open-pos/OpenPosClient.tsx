"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { OpenPoGroupDetail, STATE_CLS, STATE_LABEL, STATE_TIP } from "@/components/open-pos/OpenPoGroupDetail";
import { SupplierAvatar } from "@/components/procurement/PoDetailPanel";
import { ListCard, ListCardGrid, type ListCardColumn, type ListCardSort } from "@/components/ui/ListCard";
import { Segmented } from "@/components/ui/Segmented";
import { searchRows, type SortDir, type TableColumnLogic } from "@/lib/data-table";
import { OpenPoDetail } from "@/components/open-pos/OpenPoDetail";
import { PoTimeline, useFillHeight, type DotsBy, type RequiredState, type TimelinePo, type TimelineRow } from "@/components/open-pos/PoTimeline";
import { loadOpenPoRequiredDates } from "@/lib/open-pos-actions";
import { card, TOOLBAR_BTN_COMPACT, TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_NEUTRAL } from "@/components/ui/classnames";
import { usd, usdExact } from "@/components/ui/format";
import { fmtDate } from "@/lib/po-detail";
import { hasInvoiceBalance } from "@/lib/left-to-invoice";
import {
  addCounts,
  addDays,
  isChargeLine,
  lineCounts,
  lineState,
  nextUpcoming,
  poDates,
  stateCounts,
  vsRequired,
  weekRange,
  type LineCounts,
  type PoDates,
  type OpenPoMoney,
  type OpenPoRow,
  type OpenPosResult,
  type OpenPoWeek,
} from "@/lib/open-pos-rules";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";

// For managers first (the Scheduler's Vendor POs page is the buyers' worklist).
//
// Six tiles, one question each. "All open" is the default and the "show all" state: a PO is
// open while it owes a delivery or an invoice (open-pos-rules.ts). Then the delivery side
// (Late, Not yet received), the two mirrors side by side (Invoiced, not received / Received,
// not invoiced), and the invoice side (Not yet invoiced). Each tile but All open shows the
// money behind it and lists the POs that carry that money; All open shows its PO count, and
// its cards are ordered by Left to invoice. All client-side: the server sent every open PO.

/** The money measures a tile can be about (keys of OpenPoMoney). `received` is the Here list's. */
type MetricId = "late" | "notReceived" | "invoicedNotReceived" | "receivedNotInvoiced" | "leftToInvoice" | "received";
type TileId = "all" | MetricId;
// Four separate choices, each with its own control, so no button does two jobs:
//   Show     WHAT the page is about: what is still open, or what is here (received).
//   Filter   WHICH POs: the six tiles (one at a time), Deliveries (coming / outstanding)
//            and "Only partially received". Open only.
//   View     HOW they are drawn: cards, the timeline (Open only), or one table.
//   Group by WHAT a card or timeline group is: a project or a supplier. Not for the table,
//            which is one flat list of POs.
// Sorting belongs to the view it sorts and sits in that view's own bar.
type Mode = "open" | "here";
type Delivery = "all" | "coming" | "outstanding";
type View = "cards" | "timeline" | "table";
type GroupBy = "projects" | "suppliers";
type CardSort = "amount" | "name" | "late" | "soonest" | "next";

const NO_COUNTS: LineCounts = { lines: 0, received: 0, pieces: 0, piecesReceived: 0 };
const countsText = (c: LineCounts) => `${c.received} of ${c.lines} ${c.lines === 1 ? "line" : "lines"} received`;
const countsTip = (c: LineCounts) =>
  `${c.received} of ${c.lines} PO lines fully received (${c.piecesReceived} of ${c.pieces} pieces). A line counts once all of it has arrived`;

const METRIC_IDS: MetricId[] = ["late", "notReceived", "invoicedNotReceived", "receivedNotInvoiced", "leftToInvoice", "received"];

/** `metric`: the money a tile's cards show and sort by. All open has none of its own. */
const TILES: { id: TileId; metric: MetricId; label: string; short: string; hint: string }[] = [
  { id: "all", metric: "leftToInvoice", label: "All open", short: "Left to invoice", hint: "Every PO still owing a delivery or an invoice" },
  { id: "late", metric: "late", label: "Late", short: "Late", hint: "Not yet received, on lines past their expected date" },
  { id: "notReceived", metric: "notReceived", label: "Not yet received", short: "Not yet received", hint: "Ordered quantity not yet received, at PO price" },
  {
    id: "invoicedNotReceived",
    metric: "invoicedNotReceived",
    label: "Invoiced, not received",
    short: "Invoiced, not received",
    hint: "Invoiced beyond what has arrived, on part lines still to come: paid for, not here yet",
  },
  { id: "receivedNotInvoiced", metric: "receivedNotInvoiced", label: "Received, not invoiced", short: "Received, not invoiced", hint: "Received at PO price, less what has been invoiced on that line" },
  {
    id: "leftToInvoice",
    metric: "leftToInvoice",
    label: "Not yet invoiced",
    short: "Left to invoice",
    hint: "Left to invoice is not $0.00, including any invoiced more than ordered. Same figure as Job Details' Left to Invoice",
  },
];

/** Show: Here. Not a tile: it stands in for one, so the cards and the status line read the same way. */
const HERE_TILE = { id: "received" as TileId, metric: "received" as MetricId, label: "Here", short: "Received", hint: "POs with parts that have arrived, open or closed" };

const inTile = (r: OpenPoRow, id: TileId) => (id === "all" ? true : id === "leftToInvoice" ? hasInvoiceBalance(r.leftToInvoice) : r.money[id] > 0);
const sumMoney = (ms: OpenPoMoney[], id: MetricId) => Math.round(ms.reduce((s, m) => s + m[id], 0) * 100) / 100;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
// Hover text, one place for the words each column and control uses everywhere on the page.
const TIP = {
  po: "Purchase order number in Total ETO",
  supplier: "The vendor on the PO",
  job: "Opens the job in Job Details",
  jobCol: "Job number and name. Click a row to see its POs",
  pos: "Open POs charged to this job",
  received: "How much of the order has arrived, by value at PO price. The bar turns green when everything has arrived",
  expected: "Earliest date still expected on lines not yet received. ↻ means the vendor re-promised a new date",
  status: "Where the PO stands: late, partly received, received and waiting on an invoice, or on schedule",
  notReceived: "Value still to arrive, at PO price",
  lti: "PO value still to be invoiced. Same figure as Job Details' Left to Invoice",
  needed:
    "When the job's BOM needs the next part still to arrive (the same line as Expected). Green: it arrives on or before that day. Red: after, by the days shown",
  revised: (original: string) => `Re-promised by the vendor. Originally due ${fmtDate(original)}`,
};

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
const expectedTip = (r: OpenPoRow, notReceived: number) =>
  r.revised && r.originalDue
    ? TIP.revised(r.originalDue)
    : r.nextDue
      ? `The earliest line not yet received is expected ${fmtDate(r.nextDue)}`
      : notReceived > 0
        ? "Total ETO has no date for the lines not yet received"
        : "Everything on this PO has arrived";
const poTip = (r: OpenPoRow) => `PO ${r.poNumber}, ordered ${fmtDate(r.purchaseDate)}. ${usdExact(r.money.ordered)} at PO price`;

function ReceivedBar({ received, ordered, late }: { received: number; ordered: number; late?: boolean }) {
  const p = pct(received, ordered);
  return (
    <span className="flex items-center gap-2" title={`${p}% of the PO's value has arrived: ${usdExact(received)} of ${usdExact(ordered)}, at PO price`}>
      <span role="img" aria-label={`${p}% of PO value received`} className="block h-1.5 w-20 shrink-0 overflow-hidden rounded bg-sdc-border">
        <span className={`block h-full ${p >= 100 ? "bg-green-600" : late ? "bg-sdc-navy" : "bg-sdc-blue"}`} style={{ width: `${p}%` }} />
      </span>
      <span className="whitespace-nowrap text-note text-sdc-gray-600">
        {p}% · {usd(received)} of {usd(ordered)}
      </span>
    </span>
  );
}

function statusChip(r: OpenPoRow): { text: string; cls: string; tip: string } {
  if (r.status === "closed") return { text: "Received and invoiced", cls: "bg-green-100 text-green-900", tip: "Everything has arrived and been invoiced: the PO is closed" };
  if (r.status === "over-invoiced")
    return { text: "Invoiced more than ordered", cls: "bg-amber-100 text-amber-900", tip: "Invoices posted add up to more than the PO's value, so Left to invoice is negative" };
  if (r.money.late > 0)
    return {
      text: `Late ${days(r.daysLate ?? 0)}`,
      cls: "bg-sdc-navy text-white",
      tip: `Lines past their expected date have not arrived. The oldest was expected ${fmtDate(r.lateSince)}`,
    };
  if (r.money.ordered > 0 && r.money.notReceived <= 0)
    return { text: "Received, not invoiced", cls: "bg-green-100 text-green-900", tip: "Everything has arrived; the vendor's invoice is not fully posted yet" };
  if (r.partiallyReceived) return { text: "Partly received", cls: "bg-sdc-blue-light text-sdc-blue-dark", tip: "Some of the order has arrived; the rest is still expected" };
  if (!r.receiptsKnown) return { text: "Open", cls: "bg-slate-100 text-slate-600", tip: "Total ETO has no receiving data for this PO, so delivery status is unknown" };
  return { text: "On schedule", cls: "bg-slate-100 text-slate-600", tip: "Nothing has arrived yet, and no line is past its expected date" };
}

function StatusChip({ row, small }: { row: OpenPoRow; small?: boolean }) {
  const chip = statusChip(row);
  return (
    <span title={chip.tip} className={`rounded-full px-2 py-0.5 font-semibold ${small ? "text-note" : ""} ${chip.cls}`}>
      {chip.text}
    </span>
  );
}

function WeekChart({ weeks }: { weeks: OpenPoWeek[] }) {
  const bars = weeks.filter((w) => w.key !== "no-date");
  const noDate = weeks.find((w) => w.key === "no-date")?.notReceived ?? 0;
  const max = Math.max(...bars.map((w) => w.notReceived), 1);
  const label = (k: string) => (k === "late" ? "Late" : k === "later" ? "Later" : weekRange(k));
  const axisTip = (k: string) =>
    k === "late"
      ? "Expected before today and still not here"
      : k === "later"
        ? "Expected after the weeks shown"
        : `Expected ${dayLabel(k)} to ${dayLabel(addDays(k, 6))} (Monday to Sunday)`;
  return (
    <section className={card("p-4")} aria-labelledby="op-weeks">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="op-weeks"
          className="text-sm font-bold text-sdc-navy"
          title="Value still to arrive at PO price, grouped by the week each line is expected. Uses the vendor's re-promised date when there is one"
        >
          Value not yet received, by week expected
        </h2>
        <span className="flex gap-4 text-note text-sdc-gray-600">
          <span className="inline-flex items-center gap-1.5" title="Expected before today and still not here">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-sdc-navy" />
            Late
          </span>
          <span className="inline-flex items-center gap-1.5" title="Expected today or later">
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-sdc-blue" />
            Expected
          </span>
        </span>
      </div>
      <div className="mt-3 grid h-36 items-end gap-2" style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }}>
        {bars.map((w) => (
          <div key={w.key} className="flex h-full flex-col justify-end gap-1" title={`${label(w.key)}: ${usdExact(w.notReceived)} not yet received`}>
            <span className="text-center text-note font-semibold tabular-nums text-sdc-navy">{w.notReceived ? usd(w.notReceived) : "–"}</span>
            <div
              className={`rounded-t ${w.key === "late" ? "bg-sdc-navy" : "bg-sdc-blue"}`}
              style={{ height: `${Math.round((w.notReceived / max) * 100)}px`, minHeight: 2 }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 grid gap-2 border-t border-sdc-border pt-1" style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }}>
        {bars.map((w) => (
          <span key={w.key} title={axisTip(w.key)} className={`text-center text-note ${w.key === "late" ? "font-bold text-red-700" : "text-sdc-gray-600"}`}>
            {label(w.key)}
          </span>
        ))}
      </div>
      {noDate > 0 && (
        <p className="mt-2 text-note text-sdc-gray-400" title="No required or re-promised date on these lines in Total ETO, so they cannot be placed in a week">
          Plus {usd(noDate)} on lines Total ETO has no date for.
        </p>
      )}
    </section>
  );
}

const jobHref = (jobId: string) => `/job-hours?jobs=${encodeURIComponent(jobId)}`;

function JobLinks({ jobIds }: { jobIds: string[] }) {
  return (
    <>
      {jobIds.map((j, i) => (
        <Fragment key={j}>
          {i > 0 && ", "}
          <a href={jobHref(j)} onClick={(e) => e.stopPropagation()} title={TIP.job} className="text-sdc-blue hover:underline">
            {j}
          </a>
        </Fragment>
      ))}
    </>
  );
}

// When the BOM needs the PO's next part to arrive, against when it is expected: green on or
// before, red after with "+Nd". The same line as the Expected column (poDates), so the two agree.
function NeededCell({ dates, state }: { dates: PoDates; state: RequiredState }) {
  const muted = "font-mono text-label text-sdc-gray-400";
  if (!dates.outstanding) return <span className={muted} title="Nothing still to arrive">–</span>;
  if (state === "loading") return <span className={muted} title="Reading required dates from the BOM">…</span>;
  if (state === "failed") return <span className={muted} title="Required dates couldn't be read from the BOM">?</span>;
  if (!dates.required) return <span className={muted} title="Not on the job's BOM, so there is no required date">–</span>;
  const v = vsRequired(dates.expected, dates.required);
  const tip = !v
    ? `Needed ${fmtDate(dates.required)}. No expected date to compare it with`
    : v.days === 0
      ? `Needed ${fmtDate(dates.required)}: arrives the day it's needed`
      : `Needed ${fmtDate(dates.required)}: arrives ${days(v.days)} ${v.onTime ? "before" : "after"} it's needed`;
  return (
    <span className={`whitespace-nowrap font-mono text-label ${!v ? "text-sdc-gray-600" : v.onTime ? "text-green-700" : "font-semibold text-red-700"}`} title={tip}>
      {fmtDate(dates.required)}
      {v && !v.onTime && v.days > 0 && <span> +{v.days}d</span>}
    </span>
  );
}

// ── Expected against needed, as one figure (2026-11-16) ─────────────────────────────────
// On the cards and in their part lists the two dates sat side by side and read as one blur.
// There the row shows only the expected date, and this says how it compares with when the
// BOM needs the part: "4d early" (green), "on the day" (green), "12d late" (red). The needed
// date itself is on hover, and in full in the table and the card's details panel.
type Gap = { text: string; cls: string; tip: string; sort: number | null };
function gapOf(expected: string | null, required: string | null, state: RequiredState = "ok"): Gap {
  const muted = "text-sdc-gray-400";
  if (state === "loading") return { text: "…", cls: muted, tip: "Reading required dates from the BOM", sort: null };
  if (state === "failed") return { text: "?", cls: muted, tip: "Required dates couldn't be read from the BOM", sort: null };
  if (!required) return { text: "–", cls: muted, tip: "Not on the job's BOM, so there is no required date", sort: null };
  const v = vsRequired(expected, required);
  if (!v) return { text: "–", cls: muted, tip: `Needed ${fmtDate(required)}. No expected date to compare it with`, sort: null };
  const needed = `Needed ${fmtDate(required)}`;
  if (v.days === 0) return { text: "on the day", cls: "text-green-700", tip: `${needed}: arrives the day it's needed`, sort: 0 };
  return v.onTime
    ? { text: `${v.days}d early`, cls: "text-green-700", tip: `${needed}: arrives ${days(v.days)} before it's needed`, sort: -v.days }
    : { text: `${v.days}d late`, cls: "font-semibold text-red-700", tip: `${needed}: arrives ${days(v.days)} after it's needed`, sort: v.days };
}

function GapCell({ gap }: { gap: Gap }) {
  return (
    <span className={`whitespace-nowrap font-mono text-label ${gap.cls}`} title={gap.tip}>
      {gap.text}
    </span>
  );
}

// The Table view: every shown PO, whole-PO amounts. `needed` reads the BOM's required dates.
const listColumns = (needed: (r: OpenPoRow) => PoDates, state: RequiredState): DataTableColumn<OpenPoRow>[] => [
  { id: "po", header: "PO #", value: (r) => r.poNumber, width: "150px", className: "font-semibold", headerTitle: TIP.po, title: poTip },
  {
    id: "status",
    header: "Status",
    value: (r) => statusChip(r).text,
    width: "190px",
    headerTitle: TIP.status,
    title: (r) => statusChip(r).tip,
    render: (r) => <StatusChip row={r} />,
  },
  {
    id: "jobs",
    header: "Job",
    value: (r) => r.jobIds.join(", "),
    width: "110px",
    headerTitle: "Every job this PO charges",
    title: () => TIP.job,
    render: (r) => <JobLinks jobIds={r.jobIds} />,
  },
  { id: "supplier", header: "Supplier", value: (r) => r.suppliers.join(", "), headerTitle: TIP.supplier, title: (r) => r.suppliers.join(", ") },
  {
    id: "ordered",
    header: "Ordered",
    value: (r) => r.purchaseDate,
    width: "110px",
    render: (r) => fmtDate(r.purchaseDate),
    searchable: false,
    headerTitle: "The date the PO was placed",
    title: (r) => `PO placed ${fmtDate(r.purchaseDate)}`,
  },
  {
    id: "expected",
    header: "Expected",
    value: (r) => r.nextDue,
    width: "120px",
    searchable: false,
    headerTitle: TIP.expected,
    title: (r) => expectedTip(r, r.money.notReceived),
    render: (r) => (
      <>
        {r.nextDue ? fmtDate(r.nextDue) : r.money.notReceived > 0 ? "No date" : "Received"}
        {r.revised && <span className="text-sdc-blue"> ↻</span>}
      </>
    ),
  },
  {
    id: "needed",
    header: "Needed",
    value: (r) => needed(r).required,
    width: "130px",
    searchable: false,
    headerTitle: TIP.needed,
    render: (r) => <NeededCell dates={needed(r)} state={state} />,
  },
  {
    id: "received",
    header: "Received (by value)",
    value: (r) => (r.money.ordered > 0 ? r.money.received / r.money.ordered : null),
    width: "250px",
    searchable: false,
    headerTitle: TIP.received,
    title: (r) => `${pct(r.money.received, r.money.ordered)}% of the PO's value has arrived: ${usdExact(r.money.received)} of ${usdExact(r.money.ordered)}, at PO price`,
    render: (r) => <ReceivedBar received={r.money.received} ordered={r.money.ordered} late={r.money.late > 0} />,
  },
  {
    id: "notReceived",
    header: "Not received",
    value: (r) => r.money.notReceived,
    align: "right",
    width: "120px",
    searchable: false,
    headerTitle: TIP.notReceived,
    title: (r) => usdExact(r.money.notReceived),
    render: (r) => usd(r.money.notReceived),
  },
  {
    id: "lti",
    header: "Left to invoice",
    value: (r) => r.money.leftToInvoice,
    align: "right",
    width: "130px",
    searchable: false,
    headerTitle: TIP.lti,
    title: (r) => usdExact(r.money.leftToInvoice),
    render: (r) => usd(r.money.leftToInvoice),
  },
];

/**
 * One PO on a card. `upcoming`: its next delivery from today on (see nextUpcoming). `dates`: its
 * next line to arrive, expected and required (poDates), cut to the card's job on a project card.
 */
type CardPo = { row: OpenPoRow; money: OpenPoMoney; counts: LineCounts; upcoming: string | null; dates: PoDates; jobId?: string };

// A PO's parts, opened under its row on a card: one line each, most urgent first. Only the
// card's job's lines on a project card. Description on hover, to keep each part to one line.
const STATE_RANK: Record<string, number> = { outstanding: 0, coming: 1, here: 2 };
function PoParts({ po, today, requiredByLine }: { po: CardPo; today: string; requiredByLine: ReadonlyMap<string, string> }) {
  const lines = po.row.items
    .filter((l) => po.jobId == null || l.jobId === po.jobId)
    .map((l) => ({ l, s: lineState(l, today) }))
    .sort((a, b) => (STATE_RANK[a.s ?? ""] ?? 3) - (STATE_RANK[b.s ?? ""] ?? 3) || (a.l.expected ?? "9").localeCompare(b.l.expected ?? "9"));
  if (!lines.length) return <p className="text-label text-sdc-gray-400">No lines on this PO for this job.</p>;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] items-center gap-x-2.5 gap-y-1 pl-4 text-label">
      {lines.map(({ l, s }) => {
        const required = s && s !== "here" ? (requiredByLine.get(l.lineId) ?? null) : null;
        const repromised = !!s && s !== "here" && !!l.original && !!l.expected && l.original !== l.expected;
        return (
          <Fragment key={l.lineId}>
            <span className="truncate font-mono font-semibold text-sdc-navy" title={`${l.partNumber ?? "No part number"}${l.description ? `: ${l.description}` : ""}`}>
              {l.partNumber ?? "–"}
            </span>
            <span className="text-right font-mono tabular-nums text-sdc-gray-600" title={l.receivedQty == null ? "No receiving data" : `${Math.min(l.receivedQty, l.quantity)} of ${l.quantity} received`}>
              {l.quantity <= 0 ? "Credit" : isChargeLine(l) ? "Charge" : `${l.receivedQty == null ? "?" : Math.min(l.receivedQty, l.quantity)}/${l.quantity}`}
            </span>
            <span
              className={`whitespace-nowrap font-mono ${s === "outstanding" ? "font-semibold text-sdc-red-text" : "text-sdc-gray-600"}`}
              title={repromised ? TIP.revised(l.original as string) : s === "outstanding" ? "Past its expected date and not all here" : undefined}
            >
              {!s ? "–" : s === "here" ? "Here" : l.expected ? fmtDate(l.expected) : "No date"}
              {repromised && <span className="text-sdc-blue"> ↻</span>}
            </span>
            {/* How it compares with when it is needed, not a second date beside the first. */}
            {s && s !== "here" ? <GapCell gap={gapOf(l.expected, required)} /> : <span className="text-sdc-gray-400">–</span>}
            {s ? (
              <span title={STATE_TIP[s]} className={`rounded-full px-1.5 text-micro font-bold ${STATE_CLS[s]}`}>
                {STATE_LABEL[s]}
              </span>
            ) : (
              <span className="text-sdc-gray-400" title="A credit, a shipping / fee / tariff charge, or no receiving data">
                –
              </span>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

// "Order cards by" (Cards) / "Order projects by" (Timeline) orders the cards or groups; the POs
// inside the cards have their own order ("Order POs by", or a click on a column header).
// Ties fall back to the selected tile's amount, biggest first.
const SORTS: { id: CardSort; label: string; tip: string }[] = [
  { id: "next", label: "Next due", tip: "The card whose next line to arrive is due soonest first, late lines included (so the most overdue lead)" },
  { id: "amount", label: "Amount", tip: "Biggest first, by the selected tile" },
  { id: "name", label: "Job number / name", tip: "Projects by job number, suppliers by name" },
  { id: "late", label: "Most late", tip: "The card with the oldest late line first" },
  { id: "soonest", label: "Soonest expected", tip: "The card whose next delivery (today or later) is soonest first. Late lines don't count here; use Most late for those" },
];
type CardOrderable = { totals: Record<MetricId, number>; oldestLate: number; soonest: string | null; next: string | null };
const byDay = (a: string | null, b: string | null) => (a ?? "9999").localeCompare(b ?? "9999");

function cardOrder(sort: CardSort, metric: MetricId, a: CardOrderable, b: CardOrderable, byName: () => number): number {
  const amount = b.totals[metric] - a.totals[metric];
  if (sort === "name") return byName();
  if (sort === "late") return b.oldestLate - a.oldestLate || amount;
  if (sort === "soonest") return byDay(a.soonest, b.soonest) || amount;
  if (sort === "next") return byDay(a.next, b.next) || amount;
  return amount;
}

// A card's figures from its POs (each PO's money and line counts already cut to the card).
// POs keep the selected tile's order (biggest first) until a column header is clicked.
function groupCard(pos: CardPo[], metric: MetricId) {
  const ms = pos.map((p) => p.money);
  const due = pos.map((p) => p.upcoming).filter((d): d is string => !!d);
  const next = pos.map((p) => p.dates.expected).filter((d): d is string => !!d);
  return {
    next: next.length ? next.reduce((a, b) => (a <= b ? a : b)) : null,
    pos: [...pos].sort((a, b) => b.money[metric] - a.money[metric]),
    ordered: ms.reduce((s, m) => s + m.ordered, 0),
    received: ms.reduce((s, m) => s + m.received, 0),
    totals: Object.fromEntries(METRIC_IDS.map((id) => [id, sumMoney(ms, id)])) as Record<MetricId, number>,
    oldestLate: Math.max(0, ...pos.filter((p) => p.money.late > 0).map((p) => p.row.daysLate ?? 0)),
    soonest: due.length ? due.reduce((a, b) => (a <= b ? a : b)) : null,
    counts: pos.reduce((c, p) => addCounts(c, p.counts), NO_COUNTS),
  };
}

// The PO columns' sort. The first click sorts text and dates A→Z / soonest first, and
// amounts and counts biggest first; the second click reverses.
const PO_SORT_FIRST: Record<string, SortDir> = { po: "asc", supplier: "asc", lines: "desc", expected: "asc", needed: "desc", status: "asc", flow: "asc" };
function nextPoSort(cur: ListCardSort | null, id: string): ListCardSort {
  if (cur?.id === id) return { id, dir: cur.dir === "asc" ? "desc" : "asc" };
  return { id, dir: PO_SORT_FIRST[id] ?? "asc" };
}

// The same PO order as a menu, in the cards' bar: the column headers still sort on click, and
// the two stay in step (one state). Each direction is named in words, per column.
const PO_SORTS: { id: string; label: string; asc: string; desc: string }[] = [
  { id: "po", label: "PO number", asc: "A to Z", desc: "Z to A" },
  { id: "supplier", label: "Supplier", asc: "A to Z", desc: "Z to A" },
  { id: "lines", label: "Lines received", asc: "Least received first", desc: "Most received first" },
  { id: "expected", label: "Next due", asc: "Soonest first", desc: "Latest first" },
  { id: "flow", label: "Here, coming, then late", asc: "Here first", desc: "Late first" },
  { id: "needed", label: "Vs needed", asc: "Most early first", desc: "Most late first" },
  { id: "status", label: "Status", asc: "Late first", desc: "Received first" },
];
const DEFAULT_PO_SORT: ListCardSort = { id: "expected", dir: "asc" };

// "Here, coming, then late": all here first, then still coming (soonest first), then late
// (most recently due first, so the longest overdue end the list). Not a column, so the card
// sorts by it itself.
function flowOrder(today: string) {
  const rank = (p: CardPo) => (p.money.notReceived <= 0 ? 0 : p.dates.expected && p.dates.expected < today ? 2 : 1);
  return (a: CardPo, b: CardPo) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    if (rank(a) === 2) return byDay(b.dates.expected, a.dates.expected);
    return byDay(a.dates.expected, b.dates.expected);
  };
}

const CONTROL_LABEL ="text-xs font-semibold uppercase tracking-wide text-sdc-muted";
const selectCls = (active: boolean) =>
  `h-8 rounded-md border bg-white px-2 text-xs font-medium outline-none focus:border-sdc-blue ${active ? "border-sdc-blue text-sdc-blue-dark" : "border-sdc-border text-sdc-gray-600"}`;

// Dot per PO. Red only for late, so "not here yet" is never painted as a problem.
const DOT_RANK = { late: 0, over: 1, partial: 2, open: 3, received: 4 } as const;
function poDot(r: OpenPoRow, m: OpenPoMoney): { cls: string; tip: string; rank: number } {
  const chip = statusChip(r);
  const [cls, rank] =
    m.late > 0
      ? ["bg-sdc-red", DOT_RANK.late]
      : r.status === "over-invoiced"
        ? ["bg-amber-500", DOT_RANK.over]
        : m.ordered > 0 && m.notReceived <= 0
          ? ["bg-sdc-green", DOT_RANK.received]
          : r.partiallyReceived
            ? ["bg-sdc-yellow", DOT_RANK.partial]
            : ["bg-sdc-blue", DOT_RANK.open];
  return { cls, rank, tip: `${chip.text}. ${chip.tip}` };
}

// The card header, the same as Job Details' parts cards (PartsCardView): badge, bar colour and
// "64%" all go by the share of PO lines received; past due wins over any progress.
function cardChip(late: number, oldestLate: number, linesPct: number): { text: string; cls: string; tip: string } {
  if (late > 0)
    return { text: "PAST DUE", cls: "bg-sdc-red-bg text-sdc-red-text", tip: `${usdExact(late)} not received on lines past their expected date. The oldest is ${days(oldestLate)} late` };
  if (linesPct >= 90) return { text: "RECEIVED", cls: "bg-sdc-green-bg text-sdc-green-text", tip: `${linesPct}% of the PO lines have arrived, and nothing is past due` };
  if (linesPct >= 60) return { text: "PARTIAL", cls: "bg-sdc-yellow-bg text-sdc-yellow-text", tip: `${linesPct}% of the PO lines have arrived, and nothing is past due` };
  return { text: "PENDING", cls: "bg-sdc-blue-light text-sdc-blue-dark", tip: `${linesPct}% of the PO lines have arrived, and nothing is past due` };
}
const linesBar = (p: number) => (p >= 90 ? "bg-sdc-green" : p >= 60 ? "bg-sdc-yellow" : "bg-sdc-blue");
const linesText = (p: number) => (p >= 90 ? "text-sdc-green-text" : p >= 60 ? "text-sdc-yellow-text" : "text-sdc-blue-dark");

/** The selected tile's figure, as the card subtitle says it: "$180,928 left to invoice". */
const METRIC_PHRASE: Record<MetricId, string> = {
  late: "late",
  notReceived: "not yet received",
  invoicedNotReceived: "invoiced, not received",
  receivedNotInvoiced: "received, not invoiced",
  leftToInvoice: "left to invoice",
  received: "here",
};

// One card per job or vendor, on the shared ListCard (the same card as Job Details' Parts
// card view), with the same header: who it is, one status badge, the share of PO lines
// received as a bar and "%", and the selected tile's figure in the subtitle; then its POs: PO #, supplier (project cards), lines received, expected,
// status. Value received is on the bar's hover, not a column.
// The PO columns sort on click, one order shared by every card; project cards can group
// their POs under each supplier.
function OpenPoCard({
  title,
  titleTip,
  subtitle,
  avatar,
  metric,
  money,
  counts,
  oldestLate,
  pos,
  onOpenPo,
  poSort,
  onPoSort,
  bySupplier,
  supplierColumn,
  today,
  requiredState,
  requiredByLine,
  onOpenCard,
}: {
  /** BOM required dates by line, for the parts shown when a PO row is opened. */
  requiredByLine: ReadonlyMap<string, string>;
  title: ReactNode;
  titleTip: string;
  /** What comes before the item count, e.g. "8 POs" or "3 POs · 2 jobs". */
  subtitle: string;
  avatar?: ReactNode;
  /** The selected tile; its `metric` is the money the subtitle shows. */
  metric: (typeof TILES)[number] | typeof HERE_TILE;
  today: string;
  requiredState: RequiredState;
  /** A click anywhere on the card (not a row): the card's details, every PO line by line. */
  onOpenCard: () => void;
  money: Record<MetricId, number> & { ordered: number; received: number };
  counts: LineCounts;
  oldestLate: number;
  pos: CardPo[];
  onOpenPo: (row: OpenPoRow) => void;
  poSort: ListCardSort | null;
  onPoSort: (id: string) => void;
  bySupplier?: boolean;
  /** Project cards, ungrouped: a Supplier column. Supplier cards are the supplier already. */
  supplierColumn?: boolean;
}) {
  const p = pct(counts.received, counts.lines);
  const valuePct = pct(money.received, money.ordered);
  const supplierOf = ({ row }: CardPo) => row.suppliers.join(", ") || "No supplier";
  const columns: ListCardColumn<CardPo>[] = [
    {
      id: "po",
      header: "PO #",
      headerTitle: TIP.po,
      // Fits its text. With a Supplier column, that column takes the leftover width; without
      // one, the leftover is shared evenly by PO #, Received, Expected and Needed (all "auto"),
      // instead of all of it opening a gap after the PO number.
      width: "auto",
      sortValue: ({ row }) => row.poNumber,
      // The PO number opens the PO panel; the rest of the row opens its parts in place.
      render: ({ row }) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenPo(row);
          }}
          className="block max-w-full truncate font-mono text-note font-semibold text-sdc-blue underline decoration-dotted underline-offset-2 hover:text-sdc-navy"
          title={`${poTip(row)}. Click to open the PO`}
        >
          {row.poNumber}
        </button>
      ),
    },
    ...(supplierColumn
      ? [
          {
            id: "supplier",
            header: "Supplier",
            headerTitle: TIP.supplier,
            width: "minmax(0, 1fr)",
            sortValue: supplierOf,
            render: (po: CardPo) => (
              <span className="block truncate text-label text-sdc-gray-600" title={supplierOf(po)}>
                {supplierOf(po)}
              </span>
            ),
          } satisfies ListCardColumn<CardPo>,
        ]
      : []),
    {
      id: "lines",
      header: "Received",
      headerTitle: "PO lines fully received, of the part lines on the PO. Shipping, fee and tariff charges are not counted, as on Job Details",
      align: "right",
      sortValue: ({ counts: c }) => (c.lines ? c.received / c.lines : null),
      render: ({ counts: c }) => (
        <span className="text-label tabular-nums text-sdc-gray-600" title={countsTip(c)}>
          {c.lines ? `${c.received}/${c.lines} rcvd` : "–"}
        </span>
      ),
    },
    {
      id: "expected",
      header: "Expected",
      headerTitle: TIP.expected,
      align: "right",
      // The card's own lines (poDates): on a project card, this job's share of a split PO.
      sortValue: ({ dates }) => (dates.outstanding ? dates.expected : null),
      render: ({ row, money: m, dates }) => (
        <span
          className={`whitespace-nowrap font-mono text-label ${m.late > 0 ? "text-sdc-red-text" : "text-sdc-gray-600"}`}
          title={dates.revised && dates.original ? TIP.revised(dates.original) : expectedTip(row, m.notReceived)}
        >
          {dates.expected ? fmtDate(dates.expected) : dates.outstanding ? "No date" : "Here"}
          {dates.revised && <span className="text-sdc-blue"> ↻</span>}
        </span>
      ),
    },
    {
      id: "needed",
      header: "Vs needed",
      headerTitle:
        "How the expected date compares with when the job's BOM needs that same part: days early (green) or late (red). Hover for the needed date",
      align: "right",
      // Days late (negative when early), so the latest against the BOM can lead.
      sortValue: ({ dates }) => (dates.outstanding ? gapOf(dates.expected, dates.required).sort : null),
      render: ({ dates }) => (dates.outstanding ? <GapCell gap={gapOf(dates.expected, dates.required, requiredState)} /> : <span className="text-sdc-gray-400">–</span>),
    },
    {
      id: "status",
      header: "",
      width: "min-content",
      headerTitle: "Status: red late, yellow partly received, blue on schedule, green all received",
      sortValue: ({ row, money: m }) => poDot(row, m).rank,
      render: ({ row, money: m }) => {
        const dot = poDot(row, m);
        return <span title={dot.tip} className={`inline-block h-2 w-2 rounded-full ${dot.cls}`} />;
      },
    },
  ];
  const chip = cardChip(money.late, oldestLate, p);
  // "Here, coming, then late" is not a column: sort here and hand the card no column order.
  const flow = poSort?.id === "flow";
  const rows = flow ? [...pos].sort(flowOrder(today)) : pos;
  if (flow && poSort.dir === "desc") rows.reverse();
  return (
    <ListCard
      fixedHeight
      onCardClick={onOpenCard}
      detailsTitle="Every PO on this card, line by line: what is here, coming and outstanding. Clicking anywhere on the card does the same"
      title={title}
      titleTip={titleTip}
      subtitle={
        <span title={`${countsTip(counts)}. ${METRIC_PHRASE[metric.metric]}: ${usdExact(money[metric.metric])}, for the selected tile (${metric.label})`}>
          {subtitle} · {counts.lines} {counts.lines === 1 ? "item" : "items"} · {usd(money[metric.metric])} {METRIC_PHRASE[metric.metric]}
        </span>
      }
      avatar={avatar}
      badge={{ text: chip.text, className: chip.cls, title: chip.tip }}
      progress={{
        pct: p,
        barClassName: linesBar(p),
        label: `${p}%`,
        labelClassName: `w-9 ${linesText(p)}`,
        title: `${p}% received: ${countsText(counts)}. By value, ${valuePct}% has arrived (${usdExact(money.received)} of ${usdExact(money.ordered)})`,
      }}
      columns={columns}
      rows={rows}
      rowKey={({ row }) => row.poNumber}
      expand={{
        render: (po) => <PoParts po={po} today={today} requiredByLine={requiredByLine} />,
        title: (_, open) => (open ? "Click to hide the parts" : "Click to show this PO's parts. The PO number opens the full PO"),
      }}
      sort={flow ? null : poSort}
      onSort={onPoSort}
      groupBy={
        bySupplier
          ? {
              key: supplierOf,
              label: (name, rows) => {
                const c = rows.reduce((acc, r) => addCounts(acc, r.counts), NO_COUNTS);
                return (
                  <>
                    {name}
                    <span className="font-normal text-sdc-gray-400">
                      {" "}
                      · {rows.length} {rows.length === 1 ? "PO" : "POs"} · {c.received}/{c.lines} lines
                    </span>
                  </>
                );
              },
              title: (name, rows) => `${name}: ${rows.length} ${rows.length === 1 ? "PO" : "POs"} on this job. Click to show or hide them`,
            }
          : undefined
      }
    />
  );
}

// ── The left column's pieces ─────────────────────────────────────────────────────────────
// A titled block, and a vertical list of choices (one at a time) with a figure on the right:
// the six totals and Deliveries, which no longer fit across a row beside the cards.
function SideGroup({ title, tip, children }: { title: string; tip: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className={CONTROL_LABEL} title={tip}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function OptionList<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; detail?: ReactNode; tone?: "danger"; title?: string }[];
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-0.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            title={o.title}
            className={`flex items-baseline justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs motion-interactive ${
              on ? "border-sdc-navy bg-sdc-blue-light/50 font-semibold text-sdc-navy" : "border-transparent text-sdc-gray-600 hover:border-sdc-border hover:bg-white"
            }`}
          >
            <span className="min-w-0 truncate">{o.label}</span>
            {o.detail != null && <span className={`shrink-0 tabular-nums ${o.tone === "danger" ? "font-semibold text-red-700" : ""}`}>{o.detail}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function OpenPosClient({ data, schedulerVendorPosUrl }: { data: OpenPosResult; schedulerVendorPosUrl?: string }) {
  const [mode, setMode] = useState<Mode>("open");
  const [tile, setTile] = useState<TileId>("all");
  const [delivery, setDelivery] = useState<Delivery>("all");
  const [partialOnly, setPartialOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("cards");
  const [groupBy, setGroupBy] = useState<GroupBy>("projects");
  // The PO open in the panel, and which of its jobs' BOM the panel shows (the card's job on a
  // project card or timeline row, otherwise the PO's first job).
  const [openPo, setOpenPo] = useState<{ row: OpenPoRow; jobId: string } | null>(null);
  const openRow = (row: OpenPoRow, jobId?: string) => setOpenPo({ row, jobId: jobId ?? row.jobIds[0] });
  // The card open in the details panel, by its key (job number or supplier name). Looked up in
  // the current cards each render, so it follows the filters. Hidden while a PO panel is open
  // on top of it (two drawers would both close on Escape), and back when that one closes.
  const [openCard, setOpenCard] = useState<{ kind: GroupBy; key: string } | null>(null);
  const [sort, setSort] = useState<CardSort>("next");
  // One PO order for every card: clicking a column header in any card sorts them all.
  const [poSort, setPoSort] = useState<ListCardSort | null>(DEFAULT_PO_SORT);
  // On by default (2026-11-16, by request): a project's POs under their supplier.
  const [bySupplier, setBySupplier] = useState(true);
  const [dotsBy, setDotsBy] = useState<DotsBy>("status");
  const onPoSort = (id: string) => setPoSort((s) => nextPoSort(s, id));
  // Project cards have a Supplier column unless they are split by supplier; supplier cards
  // never do. An order by a column that just went away falls back to the default.
  const supplierColumn = groupBy === "projects" && !bySupplier;
  const dropSupplierSort = () => setPoSort((s) => (s?.id === "supplier" ? null : s));
  const chooseGroupBy = (g: GroupBy) => {
    setGroupBy(g);
    if (g === "suppliers") dropSupplierSort();
  };
  const toggleBySupplier = () => {
    setBySupplier((v) => !v);
    dropSupplierSort();
  };

  // The BOM's required dates, for every line still to arrive: the cards' and table's Needed
  // column and the timeline's lines. Read once the page is up (the cards show them now, so no
  // longer only when the Timeline is opened); the page draws first and they fill in.
  const [required, setRequired] = useState<{ state: RequiredState; byLine: ReadonlyMap<string, string> }>({ state: "loading", byLine: new Map() });
  useEffect(() => {
    let live = true;
    const ids = data.rows.flatMap((r) => r.items.filter((l) => l.quantity > 0 && !(l.receivedQty != null && l.receivedQty >= l.quantity)).map((l) => l.lineId));
    loadOpenPoRequiredDates(ids)
      .then((res) => live && setRequired(res.ok ? { state: "ok", byLine: new Map(Object.entries(res.byLine)) } : { state: "failed", byLine: new Map() }))
      .catch(() => live && setRequired({ state: "failed", byLine: new Map() }));
    return () => {
      live = false;
    };
  }, [data.rows]);

  // Here has no timeline (nothing to place on it): its view falls back to the cards.
  const shownView: View = mode === "here" && view === "timeline" ? "cards" : view;
  // The left column: down to the window's bottom, scrolling on its own when it is longer.
  // Beside the Timeline (which fits the window) it stops above the page's bottom padding too,
  // so the page does not scroll; in Cards and Table the page scrolls anyway and the column
  // stays in view as it does.
  const sideRef = useRef<HTMLElement>(null);
  const sideHeight = useFillHeight(sideRef, true, shownView === "timeline");
  const cur = mode === "here" ? HERE_TILE : TILES.find((t) => t.id === tile)!;
  const metric = cur.metric;
  const jobName = useMemo(() => new Map(data.jobs.map((j) => [j.jobId, j.jobName])), [data.jobs]);

  // What the search box looks through, per PO: its number, supplier, the jobs it charges
  // (number and name) and the parts on its lines. The app's table search rule (searchRows):
  // a PO shows when it contains every word typed, in any of these, in any order.
  const searchIn = useMemo(
    (): TableColumnLogic<OpenPoRow>[] => [
      { id: "po", value: (r) => r.poNumber },
      { id: "supplier", value: (r) => r.suppliers.join(" ") },
      { id: "jobs", value: (r) => r.jobIds.map((j) => `${j} ${jobName.get(j) ?? ""}`).join(" ") },
      { id: "parts", value: (r) => r.items.map((l) => `${l.partNumber ?? ""} ${l.description ?? ""}`).join(" ") },
    ],
    [jobName],
  );

  // Deliveries: a PO is Coming while any of its part lines is still expected (today on, or no
  // date), Outstanding while any is past its expected date. A PO can be both.
  const inDelivery = (r: OpenPoRow, d: Delivery) => d === "all" || stateCounts(r.items, data.asOf)[d] > 0;
  const deliveryCounts = useMemo(() => {
    const base = data.rows.filter((r) => inTile(r, tile) && (!partialOnly || r.partiallyReceived));
    return { all: base.length, coming: base.filter((r) => inDelivery(r, "coming")).length, outstanding: base.filter((r) => inDelivery(r, "outstanding")).length };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inDelivery only reads data.asOf
  }, [data.rows, data.asOf, tile, partialOnly]);

  const shown = useMemo(
    () =>
      searchRows(
        mode === "here" ? data.here : data.rows.filter((r) => inTile(r, tile) && inDelivery(r, delivery) && (!partialOnly || r.partiallyReceived)),
        searchIn,
        query,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- inDelivery only reads data.asOf
    [mode, data.rows, data.here, data.asOf, tile, delivery, partialOnly, searchIn, query],
  );

  const tiles = useMemo(
    () =>
      TILES.map((t) => {
        const rows = data.rows.filter((r) => inTile(r, t.id));
        return { ...t, value: sumMoney(rows.map((r) => r.money), t.metric), pos: rows.length, jobs: new Set(rows.flatMap((r) => r.jobIds)).size };
      }),
    [data.rows],
  );

  // One card per job: its own share of each shown PO, its own lines' counts.
  const projects = useMemo(() => {
    const by = new Map<string, CardPo[]>();
    for (const row of shown)
      for (const s of row.shares)
        by.set(s.jobId, [
          ...(by.get(s.jobId) ?? []),
          {
            row,
            money: s.money,
            counts: lineCounts(row.items, s.jobId),
            upcoming: nextUpcoming(row.items, data.asOf, s.jobId),
            dates: poDates(row.items, s.jobId, required.byLine),
            jobId: s.jobId,
          },
        ]);
    return [...by]
      .map(([jobId, pos]) => ({ jobId, name: jobName.get(jobId) ?? "", ...groupCard(pos, metric) }))
      .sort((a, b) => cardOrder(sort, metric, a, b, () => a.jobId.localeCompare(b.jobId, undefined, { numeric: true })));
  }, [shown, metric, sort, jobName, data.asOf, required.byLine]);

  // One card per vendor, whole-PO amounts (a vendor's PO is the vendor's, whichever jobs it charges).
  const suppliers = useMemo(() => {
    const by = new Map<string, CardPo[]>();
    for (const row of shown) {
      const k = row.suppliers.join(", ") || "No supplier";
      by.set(k, [
        ...(by.get(k) ?? []),
        { row, money: row.money, counts: lineCounts(row.items), upcoming: nextUpcoming(row.items, data.asOf), dates: poDates(row.items, undefined, required.byLine) },
      ]);
    }
    return [...by]
      .map(([name, pos]) => ({ name, jobs: new Set(pos.flatMap((p) => p.row.jobIds)).size, ...groupCard(pos, metric) }))
      .sort((a, b) => cardOrder(sort, metric, a, b, () => a.name.localeCompare(b.name)));
  }, [shown, metric, sort, data.asOf, required.byLine]);

  const tableColumns = useMemo(() => listColumns((r) => poDates(r.items, undefined, required.byLine), required.state), [required]);

  // Timeline rows: the same groups and order as the cards, keeping only POs with something
  // still to arrive. Project rows date each PO by that job's own lines.
  const timelineRows = useMemo((): TimelineRow[] => {
    const sub = (pos: TimelinePo[]) => {
      const late = pos.filter((p) => p.dates.expected && p.dates.expected < data.asOf).length;
      return `${pos.length} ${pos.length === 1 ? "PO" : "POs"} to arrive${late ? ` · ${late} late` : ""}`;
    };
    const rows: TimelineRow[] =
      groupBy === "projects"
        ? projects.map((p) => {
            const pos = p.pos
              .map((c) => {
                const supplier = c.row.suppliers.join(", ") || "No supplier";
                return { row: c.row, money: c.money, dates: c.dates, other: supplier, group: supplier, jobId: p.jobId };
              })
              .filter((x) => x.dates.outstanding);
            return {
              key: p.jobId,
              label: (
                <a href={jobHref(p.jobId)} className="hover:underline">
                  {p.jobId}
                  {p.name && <span className="font-semibold text-sdc-gray-600"> — {p.name}</span>}
                </a>
              ),
              sublabel: sub(pos),
              title: `Open ${p.jobId}${p.name ? ` (${p.name})` : ""} in Job Details`,
              pos,
            };
          })
        : suppliers.map((s) => {
            const pos = s.pos
              .map((c) => ({ row: c.row, money: c.money, dates: c.dates, other: `Job ${c.row.jobIds.join(", ")}` }))
              .filter((x) => x.dates.outstanding);
            return { key: s.name, label: s.name, sublabel: sub(pos), title: s.name, pos };
          });
    return rows.filter((r) => r.pos.length > 0);
  }, [groupBy, projects, suppliers, data.asOf]);


  if (data.rows.length === 0 && data.here.length === 0) {
    return <div className={card()}>No open purchase orders on Active or HeadStart projects as of {fmtDate(data.asOf)}.</div>;
  }

  const searching = query.trim() !== "";
  const filtered = searching || (mode === "open" && (tile !== "all" || delivery !== "all" || partialOnly));
  const total = mode === "here" ? data.here.length : data.rows.length;
  const shownJobs = new Set(shown.flatMap((r) => r.jobIds)).size;
  const clearFilters = () => {
    setTile("all");
    setDelivery("all");
    setPartialOnly(false);
    setQuery("");
  };
  // The card open in the details panel, as the cards stand now (filters applied).
  const cardDetail = (() => {
    if (!openCard || openPo) return null;
    if (openCard.kind === "projects") {
      const p = projects.find((x) => x.jobId === openCard.key);
      return p ? { title: `${p.jobId}${p.name ? ` — ${p.name}` : ""}`, pos: p.pos, jobId: p.jobId, subtitle: `${p.pos.length} ${p.pos.length === 1 ? "PO" : "POs"}` } : null;
    }
    const s = suppliers.find((x) => x.name === openCard.key);
    return s ? { title: s.name, pos: s.pos, jobId: undefined, subtitle: `${s.pos.length} ${s.pos.length === 1 ? "PO" : "POs"} · ${s.jobs} ${s.jobs === 1 ? "job" : "jobs"}` } : null;
  })();
  const cardCount = groupBy === "projects" ? projects.length : suppliers.length;
  const poSortDef = PO_SORTS.find((s) => s.id === poSort?.id);
  // The cards, one per project or supplier.
  const cardEls =
    groupBy === "projects"
      ? projects.map((p) => (
          <OpenPoCard
            key={p.jobId}
            title={
              <a href={jobHref(p.jobId)} className="hover:underline">
                {p.jobId}
                {p.name && <span className="font-semibold text-sdc-gray-600"> — {p.name}</span>}
              </a>
            }
            titleTip={`Open ${p.jobId}${p.name ? ` (${p.name})` : ""} in Job Details`}
            subtitle={`${p.pos.length} ${p.pos.length === 1 ? "PO" : "POs"}`}
            metric={cur}
            money={{ ...p.totals, ordered: p.ordered, received: p.received }}
            counts={p.counts}
            oldestLate={p.oldestLate}
            pos={p.pos}
            bySupplier={bySupplier}
            supplierColumn={supplierColumn}
            onOpenPo={(r) => openRow(r, p.jobId)}
            poSort={poSort}
            onPoSort={onPoSort}
            today={data.asOf}
            requiredState={required.state}
            requiredByLine={required.byLine}
            onOpenCard={() => setOpenCard({ kind: "projects", key: p.jobId })}
          />
        ))
      : suppliers.map((s) => (
          <OpenPoCard
            key={s.name}
            title={s.name}
            titleTip={s.name}
            subtitle={`${s.pos.length} ${s.pos.length === 1 ? "PO" : "POs"} · ${s.jobs} ${s.jobs === 1 ? "job" : "jobs"}`}
            avatar={<SupplierAvatar supplier={s.name} size={30} />}
            metric={cur}
            money={{ ...s.totals, ordered: s.ordered, received: s.received }}
            counts={s.counts}
            oldestLate={s.oldestLate}
            pos={s.pos}
            onOpenPo={openRow}
            poSort={poSort}
            onPoSort={onPoSort}
            today={data.asOf}
            requiredState={required.state}
            requiredByLine={required.byLine}
            onOpenCard={() => setOpenCard({ kind: "suppliers", key: s.name })}
          />
        ));
  const timeline = (
    <PoTimeline
      rows={timelineRows}
      asOf={data.asOf}
      onOpenPo={openRow}
      emptyText="Nothing still to arrive among the POs shown. Try Clear filters."
      dotsBy={dotsBy}
      requiredState={required.state}
      subgroups={groupBy === "projects" && bySupplier}
      // The timeline's own setting, in its own bar, next to what it changes.
      controls={
        <span className="flex items-center gap-2">
          <span className={CONTROL_LABEL}>Dots</span>
          <Segmented
            label="Dot colour"
            value={dotsBy}
            onChange={setDotsBy}
            options={[
              { value: "status", label: "Status", title: "Late, partly received or on schedule. The line's colour says whether it arrives before the BOM needs it" },
              { value: "required", label: "Required date", title: "The same as the line: green if it arrives on or before the day the BOM needs it, red if after" },
            ]}
          />
        </span>
      }
    />
  );
  const noCards = cardCount === 0 && shownView !== "table" && shownView !== "timeline";

  return (
    <div className="flex flex-col gap-5">
      {/* The chart leads in Open: when the value still to arrive lands, by week. */}
      {mode === "open" && <WeekChart weeks={data.weeks} />}

      {/* ── View: HOW the POs below are drawn, right above them ─────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <span className={CONTROL_LABEL}>View</span>
        <Segmented
          label="View"
          value={shownView}
          onChange={setView}
          options={[
            { value: "cards" as const, label: "Cards", title: "The cards only, several to a row" },
            ...(mode === "open" ? [{ value: "timeline" as const, label: "Timeline", title: "When each PO is expected against when the BOM needs it, grouped by project or supplier" }] : []),
            { value: "table" as const, label: "Table", title: "Every PO in one sortable list" },
          ]}
        />
        {/* Moved up from below the views (2026-11-16) so the page fits the window without
            scrolling: the cards and timeline reach the bottom, and nothing sits under them. */}
        <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-note text-sdc-gray-400">
            To chase a PO, add tracking or notes:{" "}
            {schedulerVendorPosUrl ? (
              <a
                href={schedulerVendorPosUrl}
                target="_blank"
                rel="noreferrer"
                title="Opens the Scheduler's Vendor POs page in a new tab, where buyers set ETAs, tracking and notes"
                className="text-sdc-blue hover:underline"
              >
                Scheduler › Vendor POs ↗
              </a>
            ) : (
              "the Scheduler's Vendor POs page"
            )}
          </span>
          <span
            tabIndex={0}
            title="This page is new. Its layout and figures may change. Use Flag (bottom right) to report anything that looks wrong."
            className="rounded-full border border-amber-300 bg-amber-50 px-3 py-0.5 text-note font-semibold text-amber-800"
          >
            Experimental, may change
          </span>
        </span>
      </div>

      {/* ── Every control down a column on the left, the chosen view beside it ──────────
          (2026-11-16. The cards-beside-timeline trial is on branch trial/open-pos-split-layout.) */}
      <div className="grid items-start gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
        {/* The controls: search, then how the cards are grouped and ordered, then what to show
            and narrow it down to (Show, the totals, Deliveries). As tall as the cards and timeline beside it (down to the
            window's bottom), scrolling on its own when it is longer; it stays in place while
            the page scrolls. */}
        <aside
          ref={sideRef}
          aria-label="Filter and order"
          style={{ "--side-h": sideHeight ? `${sideHeight}px` : "auto" } as CSSProperties}
          className="styled-scrollbar flex flex-col gap-4 lg:sticky lg:top-4 lg:h-[var(--side-h)] lg:overflow-y-auto lg:pr-1 [&>*]:shrink-0"
        >
          <div className="flex flex-col gap-1.5">
            {/* Search: over every view. The same box as Job Details' Parts List. */}
            <label
              className={`flex h-8 w-full shrink-0 items-center gap-2 rounded-md border bg-white px-2.5 ${searching ? "border-sdc-blue" : "border-sdc-border"}`}
              title="Type one or more words; a PO shows when it contains every word. Looks in the PO number, supplier, job number and name, and the part numbers and descriptions on its lines"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-sdc-gray-400" aria-hidden>
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search PO, supplier, job or part…"
                aria-label="Search POs"
                className="w-full border-none bg-transparent text-xs text-sdc-navy outline-none placeholder:text-sdc-gray-400"
              />
            </label>
            {/* What the filters leave, right under the search, with the way back. */}
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span role="status" className="text-note text-sdc-gray-600" title={`${cur.hint}. POs shown, and the jobs they charge`}>
                Showing{" "}
                <span className="font-bold text-sdc-navy">
                  {shown.length} {shown.length === 1 ? "PO" : "POs"}
                </span>{" "}
                on {shownJobs} {shownJobs === 1 ? "job" : "jobs"}
                {filtered ? ` · ${total - shown.length} hidden` : ""}
              </span>
              {filtered && (
                <button type="button" onClick={clearFilters} title="Nothing filtered and the search emptied" className="text-note font-semibold text-sdc-blue hover:underline">
                  Clear filters
                </button>
              )}
            </span>
          </div>

          {shownView !== "table" && (
            <SideGroup title="Group by" tip="What a card or timeline group is">
              <Segmented
                label="Group by"
                value={groupBy}
                onChange={chooseGroupBy}
                options={[
                  { value: "projects", label: "Project", title: "One per job. Amounts are each job's own share of a PO split across jobs" },
                  { value: "suppliers", label: "Supplier", title: "One per vendor, whole POs" },
                ]}
              />
              <span className="text-note text-sdc-gray-400">
                {cardCount} {groupBy === "projects" ? "project" : "supplier"} {cardCount === 1 ? "card" : "cards"}
              </span>
              {groupBy === "projects" && (
                <button
                  type="button"
                  aria-pressed={bySupplier}
                  onClick={toggleBySupplier}
                  title="Inside each project, list its POs under their supplier. The same for the cards and the timeline"
                  className={`${TOOLBAR_BTN_COMPACT} ${bySupplier ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL} justify-start`}
                >
                  {bySupplier ? "☑" : "☐"} Split by supplier
                </button>
              )}
            </SideGroup>
          )}

          {shownView !== "table" && (
            <SideGroup title="Order" tip="The order of the cards (and the timeline's groups), and of the POs inside each card">
              <label className="flex flex-col gap-1" title={SORTS.find((s) => s.id === sort)!.tip}>
                <span className="text-note text-sdc-gray-600">{groupBy === "projects" ? "Projects" : "Suppliers"} by</span>
                <select value={sort} onChange={(e) => setSort(e.target.value as CardSort)} className={`${selectCls(sort !== "next")} w-full`}>
                  {SORTS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id === "name" ? (groupBy === "projects" ? "Job number" : "Supplier name") : s.id === "amount" ? `Amount (${cur.short})` : s.label}
                    </option>
                  ))}
                </select>
              </label>
              {shownView !== "timeline" && (
                <label className="flex flex-col gap-1" title="The order of the POs listed inside every card. The same as clicking a column header in any card">
                  <span className="text-note text-sdc-gray-600">POs inside each card by</span>
                  <span className="flex items-center gap-1.5">
                    <select
                      value={poSort?.id ?? ""}
                      onChange={(e) => setPoSort(e.target.value ? { id: e.target.value, dir: PO_SORT_FIRST[e.target.value] ?? "asc" } : null)}
                      className={`${selectCls(poSort != null)} min-w-0 flex-1`}
                    >
                      <option value="">Amount ({cur.short}), biggest first</option>
                      {PO_SORTS.filter((s) => s.id !== "supplier" || supplierColumn).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                    {poSort && poSortDef && (
                      <button
                        type="button"
                        onClick={() => setPoSort((s) => (s ? { ...s, dir: s.dir === "asc" ? "desc" : "asc" } : s))}
                        title={`${poSort.dir === "asc" ? poSortDef.asc : poSortDef.desc}. Click to reverse the order`}
                        aria-label="Reverse the order"
                        className={`${TOOLBAR_BTN_COMPACT} ${TOOLBAR_BTN_NEUTRAL} shrink-0`}
                      >
                        {poSort.dir === "asc" ? "↑" : "↓"}
                      </button>
                    )}
                  </span>
                </label>
              )}
            </SideGroup>
          )}

          <div aria-hidden className="h-px shrink-0 bg-sdc-border" />

          <SideGroup
            title="Show"
            tip={mode === "open" ? "A PO is open until it is both received and invoiced" : "Every PO on these jobs with at least one part line fully received, including closed ones"}
          >
            <OptionList
              label="Show"
              value={mode}
              onChange={setMode}
              options={[
                { value: "open", label: "Open", detail: data.rows.length, title: "POs still owing a delivery or an invoice" },
                { value: "here", label: "Here", detail: data.here.length, title: "POs with parts that have arrived, open or closed (received and invoiced)" },
              ]}
            />
          </SideGroup>

          {mode === "open" && (
            <>
              <SideGroup title="Filter" tip="Which POs: one total at a time. All open is every PO still owing a delivery or an invoice">
                <OptionList
                  label="Filter by total"
                  value={tile}
                  onChange={setTile}
                  options={tiles.map((t) => ({
                    value: t.id,
                    label: t.label,
                    detail: t.id === "all" ? `${t.pos} POs` : usd(t.value),
                    tone: t.id === "late" ? ("danger" as const) : undefined,
                    title: `${t.hint}. ${t.id === "all" ? `${t.pos} POs` : `${usdExact(t.value)} on ${t.pos} POs`}, ${t.jobs} jobs`,
                  }))}
                />
              </SideGroup>
              <SideGroup title="Deliveries" tip="On top of the total above: POs with parts still coming, or past their expected date (outstanding). A PO can be both">
                <OptionList
                  label="Deliveries"
                  value={delivery}
                  onChange={setDelivery}
                  options={[
                    { value: "all", label: "Any", detail: deliveryCounts.all, title: "Every PO the total above lists, whatever its deliveries" },
                    { value: "coming", label: "Coming", detail: deliveryCounts.coming, title: "POs with parts still expected: today or later, or not dated yet" },
                    {
                      value: "outstanding",
                      label: "Outstanding",
                      detail: deliveryCounts.outstanding,
                      tone: "danger" as const,
                      title: "POs with parts past their expected date (the vendor's re-promised date when there is one) and still not here",
                    },
                  ]}
                />
                <button
                  type="button"
                  aria-pressed={partialOnly}
                  onClick={() => setPartialOnly((v) => !v)}
                  title="Another filter, on top of the ones above: only POs where some of the order has arrived and the rest is still expected"
                  className={`${TOOLBAR_BTN_COMPACT} ${partialOnly ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL} mt-1 shrink-0 justify-start`}
                >
                  {partialOnly ? "☑" : "☐"} Only partially received ({data.rows.filter((r) => inTile(r, tile) && r.partiallyReceived).length})
                </button>
              </SideGroup>
            </>
          )}
        </aside>

        <div className="min-w-0">
          {noCards && <p className={card("text-center text-sm text-sdc-gray-400")}>No POs match these filters. Try Clear filters.</p>}

          {/* One height for every card (its list scrolls inside), so a plain grid: left to right. */}
          {shownView === "cards" && !noCards && (
            <section aria-label={groupBy === "projects" ? "Project cards" : "Supplier cards"}>
              <ListCardGrid min={380}>{cardEls}</ListCardGrid>
            </section>
          )}

          {shownView === "timeline" && timeline}

          {shownView === "table" && (
            <section className="flex flex-col gap-2" aria-label="Table of POs">
              <p className="text-note text-sdc-gray-400" title="Cards and the Timeline, grouped by project, show each job's own share instead">
                One row per PO. Amounts are the whole PO; a PO split across jobs lists every job it charges. Click a column header to sort.
              </p>
              <DataTable
                key={mode}
                rows={shown}
                columns={tableColumns}
                rowKey={(r) => r.poNumber}
                label={mode === "here" ? "POs with parts here" : "Open POs"}
                defaultSort={
                  mode === "here"
                    ? { id: "ordered", dir: "desc" }
                    : { id: metric === "leftToInvoice" || metric === "receivedNotInvoiced" ? "lti" : "notReceived", dir: "desc" }
                }
                paging="pages"
                // The page's own search (in the left column) covers every view, so the table has none of its own.
                search={false}
                emptyText="No POs match. Try Clear filters."
                onRowClick={(r) => openRow(r)}
              />
            </section>
          )}
        </div>
      </div>

      {openPo && (
        <OpenPoDetail
          key={`${openPo.row.poNumber}::${openPo.jobId}`}
          row={openPo.row}
          jobId={openPo.jobId}
          badge={(() => {
            const c = statusChip(openPo.row);
            return { label: c.text, cls: c.cls };
          })()}
          jobName={(j) => jobName.get(j) ?? ""}
          schedulerVendorPosUrl={schedulerVendorPosUrl}
          onClose={() => setOpenPo(null)}
        />
      )}

      {cardDetail && (
        <OpenPoGroupDetail
          title={cardDetail.title}
          subtitle={cardDetail.subtitle}
          pos={cardDetail.pos}
          jobId={cardDetail.jobId}
          today={data.asOf}
          requiredByLine={required.byLine}
          bySupplier={openCard?.kind === "projects" && bySupplier}
          onOpenPo={(r) => openRow(r, cardDetail.jobId)}
          onClose={() => setOpenCard(null)}
        />
      )}
    </div>
  );
}
