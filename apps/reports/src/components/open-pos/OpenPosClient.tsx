"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { SupplierAvatar } from "@/components/procurement/PoDetailPanel";
import { ListCard, ListCardGrid, type ListCardColumn, type ListCardSort } from "@/components/ui/ListCard";
import { Segmented } from "@/components/ui/Segmented";
import { searchRows, type SortDir, type TableColumnLogic } from "@/lib/data-table";
import { OpenPoDetail } from "@/components/open-pos/OpenPoDetail";
import { PoTimeline, type DotsBy, type RequiredState, type TimelinePo, type TimelineRow } from "@/components/open-pos/PoTimeline";
import { loadOpenPoRequiredDates } from "@/lib/open-pos-actions";
import { card, TOOLBAR_BTN_COMPACT, TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_NEUTRAL } from "@/components/ui/classnames";
import { usd, usdExact } from "@/components/ui/format";
import { fmtDate } from "@/lib/po-detail";
import {
  addCounts,
  addDays,
  lineCounts,
  nextUpcoming,
  poDates,
  weekRange,
  type LineCounts,
  type OpenPoMoney,
  type OpenPoRow,
  type OpenPosResult,
  type OpenPoWeek,
} from "@/lib/open-pos-rules";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";

// For managers first (the Scheduler's Vendor POs page is the buyers' worklist).
//
// Five tiles, one per money measure. Clicking a tile lists the POs that carry that measure
// and sorts by it; the project table shows all five as columns, the chosen one tinted, and
// its Total row always equals the chosen tile. "Left to invoice" is every open PO, so it is
// the default and the "show all" state. All client-side: the server sent every open PO.

type MetricId = "late" | "notReceived" | "next4Weeks" | "receivedNotInvoiced" | "leftToInvoice";
// Three separate choices, each with its own control, so no button does two jobs:
//   Filter   WHICH POs: the five totals (one at a time) and "Only partially received".
//   View     HOW they are drawn: cards, the timeline, or one table.
//   Group by WHAT a card or timeline group is: a project or a supplier. Not for the table,
//            which is one flat list of POs.
// Sorting belongs to the view it sorts and sits in that view's own bar.
type View = "cards" | "timeline" | "table";
type GroupBy = "projects" | "suppliers";
type CardSort = "amount" | "name" | "late" | "soonest";

const NO_COUNTS: LineCounts = { lines: 0, received: 0, pieces: 0, piecesReceived: 0 };
const countsText = (c: LineCounts) => `${c.received} of ${c.lines} ${c.lines === 1 ? "line" : "lines"} received`;
const countsTip = (c: LineCounts) =>
  `${c.received} of ${c.lines} PO lines fully received (${c.piecesReceived} of ${c.pieces} pieces). A line counts once all of it has arrived`;

const METRICS: { id: MetricId; label: string; short: string; hint: string }[] = [
  { id: "late", label: "Late", short: "Late", hint: "Not yet received, on lines past their expected date" },
  { id: "notReceived", label: "Not yet received", short: "Not yet received", hint: "Ordered quantity not yet received, at PO price" },
  { id: "next4Weeks", label: "Expected in the next 4 weeks", short: "Next 4 weeks", hint: "Not yet received, expected from today through the next 28 days" },
  { id: "receivedNotInvoiced", label: "Received, not invoiced", short: "Received, not invoiced", hint: "Received at PO price, less what has been invoiced on that line" },
  { id: "leftToInvoice", label: "Left to invoice", short: "Left to invoice", hint: "Every open PO. Same figure as Job Details' Left to Invoice" },
];

const inMetric = (r: OpenPoRow, id: MetricId) => (id === "leftToInvoice" ? true : r.money[id] > 0);
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

// The Table view: every shown PO, whole-PO amounts.
const LIST_COLUMNS: DataTableColumn<OpenPoRow>[] = [
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

/** One PO on a card. `upcoming`: its next delivery from today on (see nextUpcoming). */
type CardPo = { row: OpenPoRow; money: OpenPoMoney; counts: LineCounts; upcoming: string | null };

// "Order cards by" (Cards) / "Order projects by" (Timeline) orders the cards or groups; the POs
// inside the cards have their own order ("Order POs by", or a click on a column header).
// Ties fall back to the selected tile's amount, biggest first.
const SORTS: { id: CardSort; label: string; tip: string }[] = [
  { id: "amount", label: "Amount", tip: "Biggest first, by the selected tile" },
  { id: "name", label: "Job number / name", tip: "Projects by job number, suppliers by name" },
  { id: "late", label: "Most late", tip: "The card with the oldest late line first" },
  { id: "soonest", label: "Soonest expected", tip: "The card whose next delivery (today or later) is soonest first. Late lines don't count here; use Most late for those" },
];
type CardOrderable = { totals: Record<MetricId, number>; oldestLate: number; soonest: string | null };
const byDay = (a: string | null, b: string | null) => (a ?? "9999").localeCompare(b ?? "9999");

function cardOrder(sort: CardSort, metric: MetricId, a: CardOrderable, b: CardOrderable, byName: () => number): number {
  const amount = b.totals[metric] - a.totals[metric];
  if (sort === "name") return byName();
  if (sort === "late") return b.oldestLate - a.oldestLate || amount;
  if (sort === "soonest") return byDay(a.soonest, b.soonest) || amount;
  return amount;
}

// A card's figures from its POs (each PO's money and line counts already cut to the card).
// POs keep the selected tile's order (biggest first) until a column header is clicked.
function groupCard(pos: CardPo[], metric: MetricId) {
  const ms = pos.map((p) => p.money);
  const due = pos.map((p) => p.upcoming).filter((d): d is string => !!d);
  return {
    pos: [...pos].sort((a, b) => b.money[metric] - a.money[metric]),
    ordered: ms.reduce((s, m) => s + m.ordered, 0),
    received: ms.reduce((s, m) => s + m.received, 0),
    totals: Object.fromEntries(METRICS.map((m) => [m.id, sumMoney(ms, m.id)])) as Record<MetricId, number>,
    oldestLate: Math.max(0, ...pos.filter((p) => p.money.late > 0).map((p) => p.row.daysLate ?? 0)),
    soonest: due.length ? due.reduce((a, b) => (a <= b ? a : b)) : null,
    counts: pos.reduce((c, p) => addCounts(c, p.counts), NO_COUNTS),
  };
}

// The PO columns' sort. The first click sorts text and dates A→Z / soonest first, and
// amounts and counts biggest first; the second click reverses.
const PO_SORT_FIRST: Record<string, SortDir> = { po: "asc", supplier: "asc", lines: "desc", expected: "asc", status: "asc" };
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
  { id: "expected", label: "Expected date", asc: "Soonest first", desc: "Latest first" },
  { id: "status", label: "Status", asc: "Late first", desc: "Received first" },
];

// A card's height in px, near enough to cut the columns level (ListCardGrid `weights`): its
// header and column titles, a row per PO, and a row per supplier heading when split.
const cardWeight = (pos: CardPo[], split: boolean) => 112 + 28 * pos.length + (split ? 26 * new Set(pos.map((p) => p.row.suppliers.join(", "))).size : 0);

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
  next4Weeks: "expected in 4 weeks",
  receivedNotInvoiced: "received, not invoiced",
  leftToInvoice: "left to invoice",
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
}: {
  title: ReactNode;
  titleTip: string;
  /** What comes before the item count, e.g. "8 POs" or "3 POs · 2 jobs". */
  subtitle: string;
  avatar?: ReactNode;
  metric: (typeof METRICS)[number];
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
      // With a Supplier column, that column takes the leftover width and the PO # fits its text.
      width: supplierColumn ? "auto" : undefined,
      sortValue: ({ row }) => row.poNumber,
      render: ({ row }) => (
        <span className="block truncate font-mono text-note font-semibold text-sdc-blue underline decoration-dotted underline-offset-2" title={`${poTip(row)}. Click to open`}>
          {row.poNumber}
        </span>
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
      sortValue: ({ row, money: m }) => (m.notReceived > 0 ? row.nextDue : null),
      render: ({ row, money: m }) => (
        <span className={`font-mono text-label ${m.late > 0 ? "text-sdc-red-text" : "text-sdc-gray-600"}`} title={expectedTip(row, m.notReceived)}>
          {row.nextDue ? fmtDate(row.nextDue) : m.notReceived > 0 ? "No date" : "Here"}
          {row.revised && <span className="text-sdc-blue"> ↻</span>}
        </span>
      ),
    },
    {
      id: "status",
      header: "",
      headerTitle: "Status: red late, yellow partly received, blue on schedule, green all received",
      sortValue: ({ row, money: m }) => poDot(row, m).rank,
      render: ({ row, money: m }) => {
        const dot = poDot(row, m);
        return <span title={dot.tip} className={`inline-block h-2 w-2 rounded-full ${dot.cls}`} />;
      },
    },
  ];
  const chip = cardChip(money.late, oldestLate, p);
  return (
    <ListCard
      title={title}
      titleTip={titleTip}
      subtitle={
        <span title={`${countsTip(counts)}. ${metric.label}: ${usdExact(money[metric.id])}, the selected tile`}>
          {subtitle} · {counts.lines} {counts.lines === 1 ? "item" : "items"} · {usd(money[metric.id])} {METRIC_PHRASE[metric.id]}
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
      rows={pos}
      rowKey={({ row }) => row.poNumber}
      onRowClick={({ row }) => onOpenPo(row)}
      rowTitle={() => "Open PO details"}
      fullHeight
      sort={poSort}
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

export function OpenPosClient({ data, schedulerVendorPosUrl }: { data: OpenPosResult; schedulerVendorPosUrl?: string }) {
  const [metric, setMetric] = useState<MetricId>("leftToInvoice");
  const [partialOnly, setPartialOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("cards");
  const [groupBy, setGroupBy] = useState<GroupBy>("projects");
  // The PO open in the panel, and which of its jobs' BOM the panel shows (the card's job on a
  // project card or timeline row, otherwise the PO's first job).
  const [openPo, setOpenPo] = useState<{ row: OpenPoRow; jobId: string } | null>(null);
  const openRow = (row: OpenPoRow, jobId?: string) => setOpenPo({ row, jobId: jobId ?? row.jobIds[0] });
  const [sort, setSort] = useState<CardSort>("amount");
  // One PO order for every card: clicking a column header in any card sorts them all.
  const [poSort, setPoSort] = useState<ListCardSort | null>(null);
  const [bySupplier, setBySupplier] = useState(false);
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

  // The BOM's required dates, for the timeline's lines. Read the first time the Timeline is
  // opened (not with the page: the cards don't need them), for every line still to arrive.
  const [required, setRequired] = useState<{ state: RequiredState | "idle"; byLine: ReadonlyMap<string, string> }>({ state: "idle", byLine: new Map() });
  const loadRequired = () => {
    if (required.state !== "idle" && required.state !== "failed") return;
    setRequired((r) => ({ ...r, state: "loading" }));
    const ids = data.rows.flatMap((r) => r.items.filter((l) => l.quantity > 0 && !(l.receivedQty != null && l.receivedQty >= l.quantity)).map((l) => l.lineId));
    loadOpenPoRequiredDates(ids)
      .then((res) => setRequired(res.ok ? { state: "ok", byLine: new Map(Object.entries(res.byLine)) } : { state: "failed", byLine: new Map() }))
      .catch(() => setRequired({ state: "failed", byLine: new Map() }));
  };
  const showView = (v: View) => {
    setView(v);
    if (v === "timeline") loadRequired();
  };

  const cur = METRICS.find((m) => m.id === metric)!;
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

  const shown = useMemo(
    () =>
      searchRows(
        data.rows.filter((r) => inMetric(r, metric) && (!partialOnly || r.partiallyReceived)),
        searchIn,
        query,
      ),
    [data.rows, metric, partialOnly, searchIn, query],
  );

  const tiles = useMemo(
    () =>
      METRICS.map((m) => {
        const rows = data.rows.filter((r) => inMetric(r, m.id));
        return { ...m, value: sumMoney(rows.map((r) => r.money), m.id), pos: rows.length, jobs: new Set(rows.flatMap((r) => r.jobIds)).size };
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
          { row, money: s.money, counts: lineCounts(row.items, s.jobId), upcoming: nextUpcoming(row.items, data.asOf, s.jobId) },
        ]);
    return [...by]
      .map(([jobId, pos]) => ({ jobId, name: jobName.get(jobId) ?? "", ...groupCard(pos, metric) }))
      .sort((a, b) => cardOrder(sort, metric, a, b, () => a.jobId.localeCompare(b.jobId, undefined, { numeric: true })));
  }, [shown, metric, sort, jobName, data.asOf]);

  // One card per vendor, whole-PO amounts (a vendor's PO is the vendor's, whichever jobs it charges).
  const suppliers = useMemo(() => {
    const by = new Map<string, CardPo[]>();
    for (const row of shown) {
      const k = row.suppliers.join(", ") || "No supplier";
      by.set(k, [...(by.get(k) ?? []), { row, money: row.money, counts: lineCounts(row.items), upcoming: nextUpcoming(row.items, data.asOf) }]);
    }
    return [...by]
      .map(([name, pos]) => ({ name, jobs: new Set(pos.flatMap((p) => p.row.jobIds)).size, ...groupCard(pos, metric) }))
      .sort((a, b) => cardOrder(sort, metric, a, b, () => a.name.localeCompare(b.name)));
  }, [shown, metric, sort, data.asOf]);

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
              .map((c) => ({ row: c.row, money: c.money, dates: poDates(c.row.items, p.jobId, required.byLine), other: c.row.suppliers.join(", ") || "No supplier", jobId: p.jobId }))
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
              .map((c) => ({ row: c.row, money: c.money, dates: poDates(c.row.items, undefined, required.byLine), other: `Job ${c.row.jobIds.join(", ")}` }))
              .filter((x) => x.dates.outstanding);
            return { key: s.name, label: s.name, sublabel: sub(pos), title: s.name, pos };
          });
    return rows.filter((r) => r.pos.length > 0);
  }, [groupBy, projects, suppliers, data.asOf, required.byLine]);


  if (data.rows.length === 0) {
    return <div className={card()}>No open purchase orders on Active or HeadStart projects as of {fmtDate(data.asOf)}.</div>;
  }

  const searching = query.trim() !== "";
  const filtered = metric !== "leftToInvoice" || partialOnly || searching;
  const shownJobs = new Set(shown.flatMap((r) => r.jobIds)).size;
  const cardCount = groupBy === "projects" ? projects.length : suppliers.length;
  const poSortDef = PO_SORTS.find((s) => s.id === poSort?.id);
  // The order of the cards (Cards) or of the groups (Timeline): one setting, labelled for
  // whichever it is moving, in that view's own bar.
  const groupSortSelect = (label: string) => (
    <label className="flex items-center gap-2" title={`${label.replace(/ by$/, "")}: ${SORTS.find((s) => s.id === sort)!.tip}`}>
      <span className={CONTROL_LABEL}>{label}</span>
      <select value={sort} onChange={(e) => setSort(e.target.value as CardSort)} className={selectCls(sort !== "amount")}>
        {SORTS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.id === "name" ? (groupBy === "projects" ? "Job number" : "Supplier name") : s.id === "amount" ? `Amount (${cur.short})` : s.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="flex flex-col gap-5">
      {/* The timeline leads: when the value still to arrive lands, before the totals that
          filter the cards. */}
      <WeekChart weeks={data.weeks} />

      {/* ── Filter: WHICH POs ───────────────────────────────────────────────────────
          The five totals and "Only partially received" sit under one label, with one line
          saying what they leave on screen and one button that clears them all. */}
      <section aria-labelledby="op-filter" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h2 id="op-filter" className={CONTROL_LABEL}>
            Filter
          </h2>
          <span className="text-note text-sdc-gray-400">Pick a total to list the POs behind it. Left to invoice is every open PO.</span>
        </div>
        <div role="group" aria-label="Filter by total. Choose one to list those POs" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {tiles.map((t) => {
            const on = t.id === metric;
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={on}
                onClick={() => setMetric(t.id)}
                title={`${t.hint}. ${usdExact(t.value)}. Click to list only these POs`}
                className={`flex flex-col gap-0.5 rounded-xl p-4 text-left motion-interactive ${
                  on ? "border-2 border-sdc-navy bg-sdc-blue-light/50" : "border border-sdc-border bg-white hover:border-sdc-gray-400"
                }`}
              >
                <span className="text-note font-semibold text-sdc-gray-600">{t.label}</span>
                <span className={`font-heading text-xl font-bold tabular-nums ${t.id === "late" ? "text-red-700" : "text-sdc-navy"}`}>{usd(t.value)}</span>
                <span className="text-note text-sdc-gray-400">
                  {t.pos} POs · {t.jobs} jobs
                </span>
                <span className={`mt-1 text-note font-semibold ${on ? "text-sdc-navy" : "text-sdc-blue"}`}>{on ? "Showing these" : "Show these"}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* Search: a third filter, over every view. The same box as Job Details' Parts List. */}
          <label
            className={`flex h-8 w-72 max-w-full items-center gap-2 rounded-md border bg-white px-2.5 ${searching ? "border-sdc-blue" : "border-sdc-border"}`}
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
              aria-label="Search open POs"
              className="w-full border-none bg-transparent text-xs text-sdc-navy outline-none placeholder:text-sdc-gray-400"
            />
          </label>
          <button
            type="button"
            aria-pressed={partialOnly}
            onClick={() => setPartialOnly((v) => !v)}
            title="A second filter, on top of the total chosen above: only POs where some of the order has arrived and the rest is still expected"
            className={`${TOOLBAR_BTN_COMPACT} ${partialOnly ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL}`}
          >
            {partialOnly ? "☑" : "☐"} Only partially received ({data.rows.filter((r) => inMetric(r, metric) && r.partiallyReceived).length})
          </button>
          <span role="status" className="text-sm text-sdc-gray-600" title={`${cur.hint}. Open POs shown below, and the jobs they charge`}>
            Showing{" "}
            <span className="font-bold text-sdc-navy">
              {shown.length} {shown.length === 1 ? "PO" : "POs"}
            </span>{" "}
            on {shownJobs} {shownJobs === 1 ? "job" : "jobs"}: {cur.label}
            {partialOnly ? ", partially received only" : ""}
            {searching ? `, matching "${query.trim()}"` : ""}
            {filtered ? ` · ${data.rows.length - shown.length} other open POs hidden` : ""}
          </span>
          {filtered && (
            <button
              type="button"
              onClick={() => {
                setMetric("leftToInvoice");
                setPartialOnly(false);
                setQuery("");
              }}
              title="Back to Left to invoice with nothing else filtered and the search emptied: every PO still owing an invoice"
              className={`${TOOLBAR_BTN_COMPACT} ${TOOLBAR_BTN_NEUTRAL}`}
            >
              Clear filters
            </button>
          )}
        </div>
      </section>

      {/* ── View and Group by: HOW they are drawn ───────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <span className={CONTROL_LABEL}>View</span>
          <Segmented
            label="View"
            value={view}
            onChange={showView}
            options={[
              { value: "cards", label: "Cards", title: "One card per project or supplier, with its POs listed inside" },
              { value: "timeline", label: "Timeline", title: "When each PO is expected against when the BOM needs it, grouped by project or supplier" },
              { value: "table", label: "Table", title: "Every PO in one searchable, sortable list" },
            ]}
          />
        </div>
        {view !== "table" && (
          <div className="flex items-center gap-2">
            <span className={CONTROL_LABEL}>Group by</span>
            <Segmented
              label="Group by"
              value={groupBy}
              onChange={chooseGroupBy}
              options={[
                { value: "projects", label: "Project", title: `One ${view === "cards" ? "card" : "group"} per job. Amounts are each job's own share of a PO split across jobs` },
                { value: "suppliers", label: "Supplier", title: `One ${view === "cards" ? "card" : "group"} per vendor, whole POs` },
              ]}
            />
          </div>
        )}
      </div>

      {view === "cards" && (
        <section aria-label={groupBy === "projects" ? "Project cards" : "Supplier cards"} className="flex flex-col gap-3">
          {/* The cards' own bar. Two orders, named for what each one moves: the cards
              themselves, and the POs listed inside every card. */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-sdc-border bg-white px-3 py-2">
            <span className="text-sm font-bold text-sdc-navy">
              {cardCount} {groupBy === "projects" ? "project" : "supplier"} {cardCount === 1 ? "card" : "cards"}
            </span>
            {groupSortSelect("Order cards by")}
            <span aria-hidden className="hidden h-6 w-px bg-sdc-border sm:block" />
            <span className="text-sm font-bold text-sdc-navy">Inside each card</span>
            <span className="flex items-center gap-1.5">
              <label className="flex items-center gap-2" title="The order of the POs listed inside every card. The same as clicking a column header in any card">
                <span className={CONTROL_LABEL}>Order POs by</span>
                <select
                  value={poSort?.id ?? ""}
                  onChange={(e) => setPoSort(e.target.value ? { id: e.target.value, dir: PO_SORT_FIRST[e.target.value] ?? "asc" } : null)}
                  className={selectCls(poSort != null)}
                >
                  <option value="">Amount ({cur.short}), biggest first</option>
                  {PO_SORTS.filter((s) => s.id !== "supplier" || supplierColumn).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              {poSort && poSortDef && (
                <button
                  type="button"
                  onClick={() => setPoSort((s) => (s ? { ...s, dir: s.dir === "asc" ? "desc" : "asc" } : s))}
                  title="Click to reverse the order"
                  className={`${TOOLBAR_BTN_COMPACT} ${TOOLBAR_BTN_NEUTRAL}`}
                >
                  {poSort.dir === "asc" ? poSortDef.asc : poSortDef.desc}
                </button>
              )}
            </span>
            {groupBy === "projects" && (
              <button
                type="button"
                aria-pressed={bySupplier}
                onClick={toggleBySupplier}
                title="Inside each project card, list its POs under their supplier. Click a supplier to hide or show its POs. The cards stay one per project"
                className={`${TOOLBAR_BTN_COMPACT} ${bySupplier ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL}`}
              >
                {bySupplier ? "☑" : "☐"} Split by supplier
              </button>
            )}
          </div>

          {cardCount === 0 && <p className={card("text-center text-sm text-sdc-gray-400")}>No POs match these filters. Try Clear filters.</p>}
          {/* Every card shows all its POs, so cards differ in height: they run down each
              column and continue at the top of the next (ListCardGrid flow="columns"). */}
          {/* scrollMargin: room for the cards' own bar above, when a column's button scrolls back up. */}
          <ListCardGrid min={340} flow="columns" scrollMargin={68} weights={(groupBy === "projects" ? projects : suppliers).map((c) => cardWeight(c.pos, groupBy === "projects" && bySupplier))}>
            {groupBy === "projects"
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
                  />
                ))}
          </ListCardGrid>
        </section>
      )}

      {view === "timeline" && (
        <PoTimeline
          rows={timelineRows}
          asOf={data.asOf}
          onOpenPo={openRow}
          emptyText="Nothing still to arrive among the POs shown. Try Clear filters."
          dotsBy={dotsBy}
          requiredState={required.state === "idle" ? "loading" : required.state}
          controls={
            <>
              {groupSortSelect(`Order ${groupBy === "projects" ? "projects" : "suppliers"} by`)}
              <span className="flex items-center gap-2">
                <span className={CONTROL_LABEL}>Dot colour</span>
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
            </>
          }
        />
      )}

      {view === "table" && (
        <section className="flex flex-col gap-2" aria-label="Table of POs">
          <p className="text-note text-sdc-gray-400" title="Cards and the Timeline, grouped by project, show each job's own share instead">
            One row per PO. Amounts are the whole PO; a PO split across jobs lists every job it charges. Click a column header to sort.
          </p>
          <DataTable
            rows={shown}
            columns={LIST_COLUMNS}
            rowKey={(r) => r.poNumber}
            label="Open POs"
            defaultSort={{ id: metric === "leftToInvoice" ? "lti" : "notReceived", dir: "desc" }}
            paging="pages"
            // The page's own search (in Filter) covers every view, so the table has none of its own.
            search={false}
            emptyText="No POs match. Try Clear filters."
            onRowClick={(r) => openRow(r)}
          />
        </section>
      )}

      <p className="text-note text-sdc-gray-400">
        This page shows where the money stands. To chase a PO, add tracking or notes, use{" "}
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
        .
      </p>

      {/* Bottom-left of the content area, opposite the Flag button. Sticky rather than
          fixed so it never lands under the sidebar, whose width the user can drag. Not
          sticky on the Timeline, which reaches the bottom of the window: pinned there it
          would cover the timeline's last PO labels, so it stays in the page below it. */}
      <span
        tabIndex={0}
        title="This page is new. Its layout and figures may change. Use Flag (bottom right) to report anything that looks wrong."
        className={`${view === "timeline" ? "" : "sticky bottom-4"} self-start rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-note font-semibold text-amber-800 shadow-sm`}
      >
        Experimental, may change
      </span>

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
    </div>
  );
}
