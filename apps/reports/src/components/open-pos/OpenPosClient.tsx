"use client";

import { Fragment, useMemo, useState } from "react";
import { card, TOOLBAR_BTN_COMPACT, TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_NEUTRAL } from "@/components/ui/classnames";
import { usd, usdExact } from "@/components/ui/format";
import { fmtDate } from "@/lib/po-detail";
import type { OpenPoMoney, OpenPoRow, OpenPosResult, OpenPoWeek } from "@/lib/open-pos-rules";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";

// For managers first (the Scheduler's Vendor POs page is the buyers' worklist).
//
// Five tiles, one per money measure. Clicking a tile lists the POs that carry that measure
// and sorts by it; the project table shows all five as columns, the chosen one tinted, and
// its Total row always equals the chosen tile. "Left to invoice" is every open PO, so it is
// the default and the "show all" state. All client-side: the server sent every open PO.

type MetricId = "late" | "notReceived" | "next4Weeks" | "receivedNotInvoiced" | "leftToInvoice";
type View = "projects" | "suppliers" | "list";

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
  wasExpected: "The date the oldest late line was expected. ↻ means the vendor re-promised a new date",
  daysLate: "Days since the oldest late line's expected date",
  status: "Where the PO stands: late, partly received, received and waiting on an invoice, or on schedule",
  notReceived: "Value still to arrive, at PO price",
  lti: "PO value still to be invoiced. Same figure as Job Details' Left to Invoice",
  lateValue: "Value not yet received on this PO's late lines",
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
  const label = (k: string) => (k === "late" ? "Late" : k === "later" ? "Later" : `Wk of ${dayLabel(k)}`);
  const axisTip = (k: string) =>
    k === "late"
      ? "Expected before today and still not here"
      : k === "later"
        ? "Expected after the weeks shown"
        : `Expected in the week starting ${dayLabel(k)}`;
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

// "All POs": every shown PO, whole-PO amounts. Same measures as the project table.
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

export function OpenPosClient({ data, schedulerVendorPosUrl }: { data: OpenPosResult; schedulerVendorPosUrl?: string }) {
  const [metric, setMetric] = useState<MetricId>("leftToInvoice");
  const [partialOnly, setPartialOnly] = useState(false);
  const [view, setView] = useState<View>("projects");
  const [lateOpen, setLateOpen] = useState(false);
  const [openJob, setOpenJob] = useState<string | null>(null);

  const cur = METRICS.find((m) => m.id === metric)!;
  const jobName = useMemo(() => new Map(data.jobs.map((j) => [j.jobId, j.jobName])), [data.jobs]);

  const shown = useMemo(
    () => data.rows.filter((r) => inMetric(r, metric) && (!partialOnly || r.partiallyReceived)),
    [data.rows, metric, partialOnly],
  );

  const tiles = useMemo(
    () =>
      METRICS.map((m) => {
        const rows = data.rows.filter((r) => inMetric(r, m.id));
        return { ...m, value: sumMoney(rows.map((r) => r.money), m.id), pos: rows.length, jobs: new Set(rows.flatMap((r) => r.jobIds)).size };
      }),
    [data.rows],
  );

  // One row per job: its own share of each shown PO.
  const projects = useMemo(() => {
    const by = new Map<string, { pos: { row: OpenPoRow; money: OpenPoMoney }[] }>();
    for (const row of shown)
      for (const s of row.shares) {
        const e = by.get(s.jobId) ?? { pos: [] };
        e.pos.push({ row, money: s.money });
        by.set(s.jobId, e);
      }
    return [...by]
      .map(([jobId, e]) => {
        const ms = e.pos.map((p) => p.money);
        return {
          jobId,
          name: jobName.get(jobId) ?? "",
          pos: e.pos.sort((a, b) => b.money[metric] - a.money[metric]),
          ordered: ms.reduce((s, m) => s + m.ordered, 0),
          received: ms.reduce((s, m) => s + m.received, 0),
          totals: Object.fromEntries(METRICS.map((m) => [m.id, sumMoney(ms, m.id)])) as Record<MetricId, number>,
        };
      })
      .sort((a, b) => b.totals[metric] - a.totals[metric]);
  }, [shown, metric, jobName]);

  const suppliers = useMemo(() => {
    const by = new Map<string, OpenPoRow[]>();
    for (const r of shown) {
      const k = r.suppliers.join(", ") || "No supplier";
      by.set(k, [...(by.get(k) ?? []), r]);
    }
    const list = [...by].map(([name, rows]) => ({
      name,
      pos: rows.length,
      jobs: new Set(rows.flatMap((r) => r.jobIds)).size,
      value: sumMoney(rows.map((r) => r.money), metric),
      oldestLate: Math.max(0, ...rows.map((r) => r.daysLate ?? 0)),
    }));
    return list.sort((a, b) => b.value - a.value);
  }, [shown, metric]);

  const lateRows = useMemo(() => data.rows.filter((r) => r.money.late > 0).sort((a, b) => (b.daysLate ?? 0) - (a.daysLate ?? 0)), [data.rows]);
  const lateTile = tiles[0];

  if (data.rows.length === 0) {
    return <div className={card()}>No open purchase orders on Active or HeadStart projects as of {fmtDate(data.asOf)}.</div>;
  }

  const filtered = metric !== "leftToInvoice" || partialOnly;
  const shownJobs = new Set(shown.flatMap((r) => r.jobIds)).size;
  const supplierMax = Math.max(1, ...suppliers.map((s) => s.value));
  const totalsRow = Object.fromEntries(METRICS.map((m) => [m.id, sumMoney(shown.map((r) => r.money), m.id)])) as Record<MetricId, number>;
  const gridCols = "24px minmax(0,1.6fr) minmax(0,0.4fr) minmax(0,1.6fr) repeat(5, minmax(0,1fr))";

  return (
    <div className="flex flex-col gap-5">
      <section aria-label="Totals. Choose one to list those POs" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {tiles.map((t) => {
          const on = t.id === metric;
          return (
            <button
              key={t.id}
              type="button"
              aria-pressed={on}
              onClick={() => setMetric(t.id)}
              title={`${t.hint}. ${usdExact(t.value)}`}
              className={`flex flex-col gap-0.5 rounded-xl p-4 text-left motion-interactive ${
                on ? "border-2 border-sdc-navy bg-sdc-blue-light/50" : "border border-sdc-border bg-white hover:border-sdc-gray-400"
              }`}
            >
              <span className="text-note font-semibold text-sdc-gray-600">{t.label}</span>
              <span className={`font-heading text-xl font-bold tabular-nums ${t.id === "late" ? "text-red-700" : "text-sdc-navy"}`}>{usd(t.value)}</span>
              <span className="text-note text-sdc-gray-400">
                {t.pos} POs · {t.jobs} jobs
              </span>
              <span className={`mt-1 text-note font-semibold ${on ? "text-sdc-navy" : "text-sdc-blue"}`}>{on ? "Showing below" : "Show these"}</span>
            </button>
          );
        })}
      </section>

      <WeekChart weeks={data.weeks} />

      <section className="overflow-hidden rounded-xl border border-sdc-border bg-white">
        <h2>
          <button
            type="button"
            onClick={() => setLateOpen((v) => !v)}
            aria-expanded={lateOpen}
            title={`${lateOpen ? "Hide" : "Show"} every PO with a line past its expected date, oldest first`}
            className="flex min-h-12 w-full flex-wrap items-center gap-2.5 bg-sdc-navy px-4 py-2.5 text-left text-white"
          >
            <span className="w-3">{lateOpen ? "▾" : "▸"}</span>
            <span className="font-heading font-bold">Late POs</span>
            <span className="rounded-full bg-white px-2 text-note font-bold text-sdc-navy">{lateRows.length}</span>
            <span className="text-sm text-slate-300">
              {usd(lateTile.value)} not received · {lateTile.jobs} jobs · oldest {days(lateRows[0]?.daysLate ?? 0)}
            </span>
          </button>
        </h2>
        {lateOpen && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-slate-100 text-left text-note text-sdc-gray-600">
                <tr>
                  <th className="px-4 py-2 text-right font-semibold" title={`${TIP.daysLate}. Most late first`}>
                    Days late ▼
                  </th>
                  <th className="px-3 py-2 font-semibold" title={TIP.po}>
                    PO #
                  </th>
                  <th className="px-3 py-2 font-semibold" title={TIP.supplier}>
                    Supplier
                  </th>
                  <th className="px-3 py-2 font-semibold" title="Every job this PO charges">
                    Job
                  </th>
                  <th className="px-3 py-2 font-semibold" title={TIP.wasExpected}>
                    Was expected
                  </th>
                  <th className="px-3 py-2 font-semibold" title={TIP.received}>
                    Received (by value)
                  </th>
                  <th className="px-4 py-2 text-right font-semibold" title={TIP.lateValue}>
                    Late, not received
                  </th>
                </tr>
              </thead>
              <tbody>
                {lateRows.map((r) => (
                  <tr key={r.poNumber} className="border-t border-sdc-border">
                    <td className="px-4 py-1.5 text-right font-bold tabular-nums text-red-700" title={`Late since ${fmtDate(r.lateSince)}`}>
                      {r.daysLate}
                    </td>
                    <td className="px-3 py-1.5 font-semibold" title={poTip(r)}>
                      {r.poNumber}
                    </td>
                    <td className="px-3 py-1.5" title={r.suppliers.join(", ")}>
                      {r.suppliers.join(", ")}
                    </td>
                    <td className="px-3 py-1.5">
                      <JobLinks jobIds={r.jobIds} />
                    </td>
                    <td className="px-3 py-1.5" title={r.revised && r.originalDue ? TIP.revised(r.originalDue) : TIP.wasExpected}>
                      {fmtDate(r.lateSince)}
                      {r.revised && <span className="text-sdc-blue"> ↻</span>}
                    </td>
                    <td className="px-3 py-1.5">
                      <ReceivedBar received={r.money.received} ordered={r.money.ordered} late />
                    </td>
                    <td className="px-4 py-1.5 text-right font-semibold tabular-nums" title={usdExact(r.money.late)}>
                      {usd(r.money.late)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <div role="status" className="flex min-h-10 flex-1 flex-wrap items-center gap-2.5 text-sm">
          <span className="font-bold text-sdc-navy" title={`${cur.hint}. Choose another tile above to switch`}>
            Showing: {cur.label}
            {partialOnly ? ", partially received only" : ""}
          </span>
          <span className="text-sdc-gray-600" title="Open POs in the table below, and the jobs they charge">
            {shown.length} POs on {shownJobs} jobs{filtered ? ` · ${data.rows.length - shown.length} other open POs hidden` : ""}
          </span>
          {filtered && (
            <button
              type="button"
              onClick={() => {
                setMetric("leftToInvoice");
                setPartialOnly(false);
              }}
              title="Clear the filters and list every PO still owing an invoice"
              className={`${TOOLBAR_BTN_COMPACT} ${TOOLBAR_BTN_NEUTRAL}`}
            >
              Show all open POs
            </button>
          )}
        </div>
        <button
          type="button"
          aria-pressed={partialOnly}
          onClick={() => setPartialOnly((v) => !v)}
          title="Only POs where some of the order has arrived and the rest is still expected"
          className={`${TOOLBAR_BTN_COMPACT} ${partialOnly ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL}`}
        >
          {partialOnly ? "☑" : "☐"} Only partially received ({data.rows.filter((r) => inMetric(r, metric) && r.partiallyReceived).length})
        </button>
        <div role="group" aria-label="Group by" className="flex gap-1">
          {(
            [
              ["projects", "By project", "One row per job, with all five totals. Click a job to see its POs"],
              ["suppliers", "By supplier", "One row per vendor, ranked by the selected total"],
              ["list", "All POs", "Every PO in one searchable, sortable list"],
            ] as [View, string, string][]
          ).map(([id, label, tip]) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              onClick={() => setView(id)}
              title={tip}
              className={`${TOOLBAR_BTN_COMPACT} ${view === id ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {view === "projects" && (
        <section className="overflow-x-auto rounded-xl border border-sdc-border bg-white" aria-label="By project">
          <div className="min-w-[1100px] text-sm">
            <div className="grid gap-2.5 bg-slate-100 px-4 text-note font-semibold text-sdc-gray-600" style={{ gridTemplateColumns: gridCols }}>
              <span />
              <span className="py-2" title={TIP.jobCol}>
                Job
              </span>
              <span className="py-2 text-right" title={TIP.pos}>
                POs
              </span>
              <span className="py-2" title={TIP.received}>
                Received (by value)
              </span>
              {METRICS.map((m) => (
                <span
                  key={m.id}
                  title={m.id === metric ? `${m.hint}. The selected total` : `${m.hint}. Click its tile above to list these POs`}
                  className={`px-1.5 py-2 text-right ${m.id === metric ? "border-b-2 border-sdc-navy bg-sdc-blue-light text-sdc-navy" : ""}`}
                >
                  {m.short}
                </span>
              ))}
            </div>
            {projects.map((p) => {
              const expanded = openJob === p.jobId;
              return (
                <div key={p.jobId} className="border-t border-sdc-border">
                  <button
                    type="button"
                    onClick={() => setOpenJob(expanded ? null : p.jobId)}
                    aria-expanded={expanded}
                    title={`${expanded ? "Hide" : "Show"} ${p.jobId}'s POs`}
                    className={`grid w-full items-stretch gap-2.5 px-4 text-left ${expanded ? "bg-sdc-blue-light/40" : "bg-white hover:bg-slate-50"}`}
                    style={{ gridTemplateColumns: gridCols }}
                  >
                    <span className="py-2.5 text-sdc-gray-400">{expanded ? "▾" : "▸"}</span>
                    <span className="flex flex-col py-2.5 leading-tight">
                      <span className="font-bold text-sdc-navy">{p.jobId}</span>
                      <span className="text-note text-sdc-gray-600">{p.name}</span>
                    </span>
                    <span className="py-2.5 text-right tabular-nums">{p.pos.length}</span>
                    <span className="flex items-center py-2.5">
                      <ReceivedBar received={p.received} ordered={p.ordered} />
                    </span>
                    {METRICS.map((m) => {
                      const v = p.totals[m.id];
                      return (
                        <span
                          key={m.id}
                          title={`${m.label}: ${usdExact(v)}`}
                          className={`flex items-center justify-end px-1.5 py-2.5 tabular-nums ${m.id === metric ? "bg-sdc-blue-light/40 font-bold" : ""} ${
                            v === 0 ? "text-sdc-gray-400" : m.id === "late" ? "text-red-700" : "text-sdc-navy"
                          }`}
                        >
                          {v === 0 ? "–" : usd(v)}
                        </span>
                      );
                    })}
                  </button>
                  {expanded && (
                    <div className="flex flex-col bg-sdc-blue-light/20 py-2 pl-12 pr-4">
                      <table className="w-full text-sm">
                        <thead className="text-left text-note text-sdc-gray-400">
                          <tr>
                            <th className="py-1 font-semibold" title={TIP.status}>
                              Status
                            </th>
                            <th className="py-1 font-semibold" title={TIP.po}>
                              PO #
                            </th>
                            <th className="py-1 font-semibold" title={TIP.supplier}>
                              Supplier
                            </th>
                            <th className="py-1 font-semibold" title={TIP.expected}>
                              Expected
                            </th>
                            <th className="py-1 font-semibold" title={TIP.received}>
                              Received (by value)
                            </th>
                            <th className="py-1 text-right font-semibold" title={TIP.notReceived}>
                              Not received
                            </th>
                            <th className="py-1 text-right font-semibold" title={TIP.lti}>
                              Left to invoice
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {p.pos.map(({ row, money }) => {
                            return (
                              <tr key={row.poNumber} className="border-t border-sdc-border/60">
                                <td className="py-1.5">
                                  <StatusChip row={row} small />
                                </td>
                                <td className="py-1.5 font-semibold" title={poTip(row)}>
                                  {row.poNumber}
                                  {row.jobIds.length > 1 && (
                                    <span
                                      className="ml-1 text-note font-normal text-sdc-gray-400"
                                      title={`This PO also charges ${row.jobIds.filter((j) => j !== p.jobId).join(", ")}. Amounts here are only ${p.jobId}'s lines`}
                                    >
                                      (this job&apos;s share)
                                    </span>
                                  )}
                                </td>
                                <td className="py-1.5" title={row.suppliers.join(", ")}>
                                  {row.suppliers.join(", ")}
                                </td>
                                <td className="py-1.5" title={expectedTip(row, money.notReceived)}>
                                  {row.nextDue ? fmtDate(row.nextDue) : money.notReceived > 0 ? "No date" : "Received"}
                                  {row.revised && <span className="text-sdc-blue"> ↻</span>}
                                </td>
                                <td className="py-1.5">
                                  <ReceivedBar received={money.received} ordered={money.ordered} late={money.late > 0} />
                                </td>
                                <td className="py-1.5 text-right tabular-nums" title={usdExact(money.notReceived)}>
                                  {money.notReceived ? usd(money.notReceived) : "–"}
                                </td>
                                <td className="py-1.5 text-right font-semibold tabular-nums" title={usdExact(money.leftToInvoice)}>
                                  {usd(money.leftToInvoice)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <a href={jobHref(p.jobId)} title={`Open ${p.jobId} in Job Details, with the full Parts List`} className={`${TOOLBAR_BTN_COMPACT} ${TOOLBAR_BTN_NEUTRAL}`}>
                          Open in Job Details
                        </a>
                        {schedulerVendorPosUrl && (
                          <a
                            href={schedulerVendorPosUrl}
                            target="_blank"
                            rel="noreferrer"
                            title="Opens the Scheduler's Vendor POs page in a new tab, where buyers set ETAs, tracking and notes"
                            className={`${TOOLBAR_BTN_COMPACT} ${TOOLBAR_BTN_NEUTRAL}`}
                          >
                            Chase in Scheduler › Vendor POs ↗
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="grid gap-2.5 border-t-2 border-sdc-border bg-slate-50 px-4 font-bold" style={{ gridTemplateColumns: gridCols }}>
              <span />
              <span className="py-2.5" title="All jobs shown. The selected column equals its tile above">
                Total
              </span>
              <span className="py-2.5 text-right tabular-nums" title="Open POs shown. A PO split across jobs counts once">
                {shown.length}
              </span>
              <span />
              {METRICS.map((m) => (
                <span key={m.id} title={`${m.label}, all jobs: ${usdExact(totalsRow[m.id])}`} className={`px-1.5 py-2.5 text-right tabular-nums ${m.id === metric ? "bg-sdc-blue-light" : ""}`}>
                  {usd(totalsRow[m.id])}
                </span>
              ))}
            </div>
          </div>
        </section>
      )}

      {view === "suppliers" && (
        <section className="overflow-x-auto rounded-xl border border-sdc-border bg-white" aria-label="By supplier">
          <table className="w-full min-w-[800px] text-sm">
            <thead className="bg-slate-100 text-left text-note text-sdc-gray-600">
              <tr>
                <th className="px-4 py-2 font-semibold" title={TIP.supplier}>
                  Supplier
                </th>
                <th className="px-3 py-2 text-right font-semibold" title="Open POs with this vendor">
                  POs
                </th>
                <th className="px-3 py-2 text-right font-semibold" title="Jobs those POs charge">
                  Jobs
                </th>
                <th className="w-80 bg-sdc-blue-light px-3 py-2 font-semibold text-sdc-navy" title={`${cur.hint}. Click another tile above to switch`}>
                  {cur.label}
                </th>
                <th className="px-4 py-2 text-right font-semibold" title="Days late on this vendor's oldest late line">
                  Oldest late
                </th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) => (
                <tr key={s.name} className="border-t border-sdc-border">
                  <td className="px-4 py-2 font-semibold" title={s.name}>
                    {s.name}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums" title={`${s.pos} open ${s.pos === 1 ? "PO" : "POs"} with ${s.name}`}>
                    {s.pos}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums" title={`Charged to ${s.jobs} ${s.jobs === 1 ? "job" : "jobs"}`}>
                    {s.jobs}
                  </td>
                  <td className="bg-sdc-blue-light/30 px-3 py-2">
                    <span className="flex items-center gap-2" title={`${cur.label}: ${usdExact(s.value)}. The bar is relative to the largest vendor`}>
                      <span className="block h-2 flex-1 overflow-hidden rounded bg-sdc-border">
                        <span className={`block h-full ${metric === "late" ? "bg-sdc-navy" : "bg-sdc-blue"}`} style={{ width: `${pct(Math.max(0, s.value), supplierMax)}%` }} />
                      </span>
                      <span className="min-w-20 text-right font-bold tabular-nums">
                        {usd(s.value)}
                      </span>
                    </span>
                  </td>
                  <td
                    className="px-4 py-2 text-right font-semibold text-red-700"
                    title={s.oldestLate ? `This vendor's oldest late line is ${days(s.oldestLate)} past its expected date` : "Nothing late from this vendor"}
                  >
                    {s.oldestLate ? days(s.oldestLate) : "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {view === "list" && (
        <section className="flex flex-col gap-2" aria-label="All POs">
          <p className="text-note text-sdc-gray-400" title="By project shows each job's own share instead">
            Amounts are the whole PO. A PO split across jobs lists every job it charges.
          </p>
          <DataTable
            rows={shown}
            columns={LIST_COLUMNS}
            rowKey={(r) => r.poNumber}
            label="Open POs"
            defaultSort={{ id: metric === "leftToInvoice" ? "lti" : "notReceived", dir: "desc" }}
            paging="pages"
            searchPlaceholder="Search PO, supplier or job…"
            emptyText="No POs match."
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
          fixed so it never lands under the sidebar, whose width the user can drag. */}
      <span
        tabIndex={0}
        title="This page is new. Its layout and figures may change. Use Flag (bottom right) to report anything that looks wrong."
        className="sticky bottom-4 self-start rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-note font-semibold text-amber-800 shadow-sm"
      >
        Experimental, may change
      </span>
    </div>
  );
}
