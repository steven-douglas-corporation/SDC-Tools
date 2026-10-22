"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Panel, PanelHead, KpiStrip } from "@/components/dashboard/DashboardLayout";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usd } from "@/components/ui/format";
import {
  BANDS,
  BASIS_LABEL,
  DEFAULT_SORT,
  FOCUS_LABEL,
  FOCUS_SORT,
  bandOf,
  bandTotals,
  filterRows,
  signedPct,
  signedUsd,
  sortRows,
  statusMatches,
  summarize,
  type BandKey,
  type Focus,
  type PartsBudgetRow,
  type SortKey,
  type SortState,
  type StatusFilter,
} from "@/lib/parts-budget-bands";

// ── Parts cost vs budget, every job (2026-10-22) ────────────────────────────────────────────────
//
// What the Finances tab shows under "This month": which jobs are heading over their parts budget, and
// by how much. Top to bottom —
//
//   chips + search + export     Active / Complete / Both narrows everything below it, and the export file
//   summary strip               how many are over, the total overrun, the worst job by % and by $
//   band chart                  jobs per band; a click opens that band's jobs underneath
//   job table                   sortable; a job id opens it in Job Details
//
// Every figure is computed by lib/parts-budget-analysis.ts through the same function the Job Details card
// uses, and every filter, total and sort goes through lib/parts-budget-bands.ts — the same functions the
// Excel export runs — so what is on screen and what is in the file cannot differ.

const STATUS_CHIPS: { key: StatusFilter; label: string }[] = [
  { key: "both", label: "Both" },
  { key: "active", label: "Active" },
  { key: "complete", label: "Complete" },
];

const COLUMNS: { key: SortKey; label: string; align: "left" | "right"; hint?: string }[] = [
  { key: "jobId", label: "Job ID", align: "left" },
  { key: "jobName", label: "Job", align: "left" },
  { key: "customer", label: "Customer", align: "left" },
  { key: "type", label: "Type", align: "left" },
  { key: "status", label: "Status", align: "left" },
  { key: "budget", label: "Budget", align: "right" },
  { key: "projected", label: "Projected", align: "right", hint: "Purchased to date + still to purchase; a completed job with no live data shows its final actual" },
  { key: "delta", label: "Over / under", align: "right", hint: "Projected − Budget" },
  { key: "pct", label: "%", align: "right" },
  { key: "stillToPurchase", label: "Still to purchase", align: "right" },
  { key: "excess", label: "Excess", align: "right", hint: "Bought this month beyond last month's Left to Purchase" },
];

function Kpi({
  label,
  value,
  sub,
  tone,
  onClick,
  active = false,
  hint,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "red";
  /** Makes the card a button that opens the jobs behind its figure. */
  onClick?: () => void;
  active?: boolean;
  hint?: string;
}) {
  const body = (
    <div
      className={`flex h-full flex-col justify-center gap-1 px-4 py-3 text-left ${
        onClick ? (active ? "bg-sdc-blue-light/50" : "bg-white hover:bg-sdc-blue-light/25") : "bg-white"
      }`}
    >
      <p className="flex items-center justify-between gap-2 text-label font-semibold uppercase tracking-[0.06em] text-sdc-gray-600">
        <span className="truncate">{label}</span>
        {onClick && (
          <span aria-hidden className="shrink-0 normal-case tracking-normal text-sdc-blue">
            {active ? "Showing ↓" : "View →"}
          </span>
        )}
      </p>
      <p className={`font-heading text-2xl leading-none font-bold tracking-tight tabular-nums ${tone === "red" ? "text-sdc-red-text" : "text-sdc-navy"}`}>
        {value}
      </p>
      {sub && <p className="truncate text-label leading-tight text-sdc-gray-400">{sub}</p>}
    </div>
  );
  return (
    <div className="min-w-0 flex-1 basis-[11rem]">
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-pressed={active}
          title={hint}
          className={`motion-interactive block h-full w-full ${active ? "ring-2 ring-inset ring-sdc-blue" : ""}`}
        >
          {body}
        </button>
      ) : (
        body
      )}
    </div>
  );
}

function JobLink({ jobId, children }: { jobId: string; children: React.ReactNode }) {
  return (
    <Link href={`/job-hours?jobs=${encodeURIComponent(jobId)}`} className="font-semibold text-sdc-blue hover:underline">
      {children}
    </Link>
  );
}

/** Projected against budget on one scale: the tick is 100% of budget, the bar runs to 200%. */
function Gauge({ row }: { row: PartsBudgetRow }) {
  if (row.budget == null || row.budget <= 0 || row.pct == null) return <span className="text-sdc-gray-400">—</span>;
  const ratio = Math.min(row.projected / row.budget, 2);
  const color = BANDS.find((b) => b.key === bandOf(row.pct as number))!.color;
  return (
    <div
      className="relative h-2 w-20 rounded-full bg-sdc-gray-100"
      title={`${usd(Math.round(row.projected))} projected against a ${usd(Math.round(row.budget))} budget`}
    >
      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(ratio / 2) * 100}%`, background: color }} />
      <div className="absolute -inset-y-0.5 left-1/2 w-px bg-sdc-navy/60" aria-hidden />
    </div>
  );
}

export function PartsBudgetAnalysis({
  rows,
  notStarted,
  asOf,
}: {
  rows: PartsBudgetRow[];
  notStarted: number;
  asOf: string;
}) {
  const [status, setStatus] = useState<StatusFilter>("both");
  const [band, setBand] = useState<BandKey | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);

  // The status chip narrows the summary, the chart AND the table; the band narrows only the table, because
  // the chart is where a band is chosen.
  const inStatus = useMemo(() => rows.filter((r) => statusMatches(r.status, status)), [rows, status]);
  const summary = useMemo(() => summarize(inStatus), [inStatus]);
  const totals = useMemo(() => bandTotals(inStatus), [inStatus]);
  const shown = useMemo(() => sortRows(filterRows(rows, { status, band, q, focus }), sort), [rows, status, band, q, focus, sort]);
  const counts = useMemo(
    () => ({
      both: rows.length,
      active: rows.filter((r) => r.status === "Active").length,
      complete: rows.filter((r) => r.status === "Complete").length,
    }),
    [rows],
  );

  const maxJobs = Math.max(1, ...totals.map((t) => t.jobs));
  const tableOpen = band != null || focus != null || showAll;
  const bandDef = band ? BANDS.find((b) => b.key === band)! : null;

  const exportHref = (format: "xlsx" | "csv") => {
    const p = new URLSearchParams({ format, status, sort: sort.key, dir: sort.dir });
    if (focus) p.set("focus", focus);
    else if (band) p.set("band", band);
    if (q.trim()) p.set("q", q.trim());
    return `/api/export/parts-budget?${p.toString()}`;
  };

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "jobId" || key === "jobName" || key === "customer" || key === "type" || key === "status" ? "asc" : "desc" }));

  // One thing is chosen at a time: a band, a card's job list, or the whole list.
  const pickBand = (key: BandKey) => {
    setBand((b) => (b === key ? null : key));
    setFocus(null);
    setShowAll(false);
  };

  // A card opens the jobs behind its figure, sorted by it so the job the card names is the first row.
  const pickFocus = (f: Focus) => {
    if (focus === f) {
      setFocus(null);
      return;
    }
    setFocus(f);
    setBand(null);
    setShowAll(false);
    setSort(FOCUS_SORT[f]);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Controls: the status chips scope everything; the export follows the table. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div role="group" aria-label="Job status" className="inline-flex overflow-hidden rounded-lg border border-sdc-border bg-white text-sm shadow-sm">
          {STATUS_CHIPS.map((c) => (
            <button
              key={c.key}
              type="button"
              aria-pressed={status === c.key}
              onClick={() => setStatus(c.key)}
              className={`motion-interactive px-3.5 py-1.5 font-medium ${
                status === c.key ? "bg-sdc-blue text-white" : "text-sdc-gray-600 hover:bg-sdc-gray-50"
              }`}
            >
              {c.label} <span className={status === c.key ? "text-white/80" : "text-sdc-gray-400"}>{counts[c.key]}</span>
            </button>
          ))}
        </div>
        <p className="text-label text-sdc-gray-400">
          Live as of{" "}
          <time dateTime={asOf} suppressHydrationWarning>
            {new Date(asOf).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </time>
          {" · refreshed every few minutes · not tied to the month above"}
        </p>
      </div>

      <KpiStrip>
        <Kpi
          label="Jobs over budget"
          value={`${summary.jobsOver} of ${summary.withBudget}`}
          sub={summary.noBudget > 0 ? `${summary.noBudget} job${summary.noBudget === 1 ? "" : "s"} with no budget on file` : "jobs with a budget"}
        />
        <Kpi label="Total over budget" value={usd(Math.round(summary.totalOver))} sub="overruns, added up" tone={summary.totalOver > 0 ? "red" : undefined} />
        <Kpi
          label="Highest overrun %"
          value={summary.worstByPct ? signedPct(summary.worstByPct.pct as number) : "—"}
          sub={summary.worstByPct ? `Job ${summary.worstByPct.jobId} · ${summary.worstByPct.jobName}` : "nothing over budget"}
          tone={summary.worstByPct ? "red" : undefined}
          onClick={summary.worstByPct ? () => pickFocus("pct") : undefined}
          active={focus === "pct"}
          hint="List the over-budget jobs, highest overrun % first"
        />
        <Kpi
          label="Largest overrun $"
          value={summary.worstByDollars ? signedUsd(summary.worstByDollars.delta as number, usd) : "—"}
          sub={summary.worstByDollars ? `Job ${summary.worstByDollars.jobId} · ${summary.worstByDollars.jobName}` : "nothing over budget"}
          tone={summary.worstByDollars ? "red" : undefined}
          onClick={summary.worstByDollars ? () => pickFocus("dollars") : undefined}
          active={focus === "dollars"}
          hint="List the over-budget jobs, largest overrun $ first"
        />
        <Kpi
          label="Excess this month"
          value={`${summary.withExcess} job${summary.withExcess === 1 ? "" : "s"}`}
          sub="bought beyond last month's plan"
          onClick={summary.withExcess > 0 ? () => pickFocus("excess") : undefined}
          active={focus === "excess"}
          hint="List the jobs that bought more this month than last month's Left to Purchase allowed"
        />
      </KpiStrip>

      <Panel>
        <PanelHead
          title="Jobs by projection vs budget"
          note="Projected = purchased to date + still to purchase, against the job's parts budget. Click a band to list its jobs."
          action={
            <button
              type="button"
              onClick={() => {
                setShowAll((v) => !v);
                setBand(null);
                setFocus(null);
              }}
              className="text-xs font-semibold text-sdc-blue hover:underline"
            >
              {showAll && band == null && focus == null ? "Hide job list" : "Show all jobs"}
            </button>
          }
        />
        <ul className="mt-3 flex flex-col gap-1.5">
          {totals.map((t) => {
            const selected = band === t.band.key;
            const isUnder = t.band.key === "under";
            return (
              <li key={t.band.key}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => pickBand(t.band.key)}
                  className={`motion-interactive grid w-full grid-cols-[7.5rem_1fr_auto] items-center gap-3 rounded-lg px-2 py-1.5 text-left sm:grid-cols-[8.5rem_1fr_13rem] ${
                    selected ? "bg-sdc-blue-light/50 ring-1 ring-sdc-blue" : "hover:bg-sdc-gray-50"
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-sdc-navy">
                    <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: t.band.color }} />
                    {t.band.label}
                  </span>
                  <span className="relative h-5 min-w-0 rounded bg-sdc-gray-50">
                    <span
                      className="absolute inset-y-0 left-0 rounded"
                      style={{ width: t.jobs === 0 ? "0" : `${Math.max(2, (t.jobs / maxJobs) * 100)}%`, background: t.band.color }}
                    />
                  </span>
                  <span className="flex items-baseline justify-end gap-3 whitespace-nowrap text-sm tabular-nums">
                    <span className="font-bold text-sdc-navy">
                      {t.jobs} job{t.jobs === 1 ? "" : "s"}
                    </span>
                    <span className={`w-28 text-right text-xs ${isUnder ? "text-sdc-green-text" : "text-sdc-red-text"}`}>
                      {t.jobs === 0 ? "" : isUnder ? `${usd(Math.round(t.under))} under` : `${usd(Math.round(t.over))} over`}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {(summary.noBudget > 0 || notStarted > 0) && (
          <p className="mt-3 text-label text-sdc-gray-400">
            {summary.noBudget > 0 && (
              <>
                {summary.noBudget} job{summary.noBudget === 1 ? " has" : "s have"} no parts budget on file, so{" "}
                {summary.noBudget === 1 ? "it is" : "they are"} not in a band (still listed under &ldquo;Show all jobs&rdquo;).{" "}
              </>
            )}
            {notStarted > 0 && (
              <>
                {notStarted} job{notStarted === 1 ? " has" : "s have"} a Parts Cost row but no purchasing yet, so nothing is projected.
              </>
            )}
          </p>
        )}
      </Panel>

      {tableOpen && (
        <Panel flush>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-sdc-border px-4 py-3">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-sdc-navy">
                {bandDef && <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ background: bandDef.color }} />}
                {focus ? FOCUS_LABEL[focus] : bandDef ? bandDef.label : "All jobs"}
                <span className="font-normal text-sdc-gray-400">
                  · {shown.length} job{shown.length === 1 ? "" : "s"}
                </span>
              </h3>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search job, customer, type"
                aria-label="Search jobs"
                className="w-56 rounded-lg border border-sdc-border bg-white px-3 py-1.5 text-sm placeholder:text-sdc-gray-400 focus:border-sdc-blue focus:outline-none"
              />
              <a
                href={exportHref("xlsx")}
                download
                className="motion-interactive rounded-lg border border-sdc-border bg-white px-3 py-1.5 text-sm font-medium text-sdc-navy hover:bg-sdc-gray-50"
                title="Download the jobs shown here as an Excel file"
              >
                Export Excel
              </a>
              <a
                href={exportHref("csv")}
                download
                className="motion-interactive rounded-lg border border-sdc-border bg-white px-3 py-1.5 text-sm font-medium text-sdc-gray-600 hover:bg-sdc-gray-50"
                title="Download the jobs shown here as a CSV file"
              >
                CSV
              </a>
              <button
                type="button"
                onClick={() => {
                  setBand(null);
                  setFocus(null);
                  setShowAll(false);
                  setQ("");
                }}
                className="text-xs font-semibold text-sdc-blue hover:underline"
              >
                Close
              </button>
            </div>
          </div>

          <div className="max-h-[32rem] overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-sdc-gray-50 text-label uppercase tracking-wide text-sdc-gray-600">
                <tr>
                  {COLUMNS.map((c) => {
                    const active = sort.key === c.key;
                    return (
                      <th
                        key={c.key}
                        scope="col"
                        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                        title={c.hint}
                        className={`whitespace-nowrap border-b border-sdc-border px-3 py-2 font-semibold ${c.align === "right" ? "text-right" : "text-left"}`}
                      >
                        <button type="button" onClick={() => toggleSort(c.key)} className="inline-flex items-center gap-1 uppercase hover:text-sdc-navy">
                          {c.label}
                          <span aria-hidden className={active ? "text-sdc-blue" : "text-sdc-border"}>
                            {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
                          </span>
                        </button>
                      </th>
                    );
                  })}
                  <th scope="col" className="whitespace-nowrap border-b border-sdc-border px-3 py-2 text-left font-semibold" title="Projected against budget; the tick is 100% of budget">
                    vs budget
                  </th>
                  <th scope="col" className="whitespace-nowrap border-b border-sdc-border px-3 py-2 text-left font-semibold">
                    Basis
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={COLUMNS.length + 2} className="px-4 py-8 text-center text-sdc-muted">
                      No jobs match.
                    </td>
                  </tr>
                ) : (
                  shown.map((r) => {
                    const over = r.delta != null && r.delta > 0.5;
                    const under = r.delta != null && r.delta < -0.5;
                    const tone = over ? "text-sdc-red-text" : under ? "text-sdc-green-text" : "text-sdc-gray-600";
                    return (
                      <tr key={r.id} className="border-b border-sdc-border-soft align-middle hover:bg-sdc-gray-50/60">
                        <td className="whitespace-nowrap px-3 py-1.5">
                          <JobLink jobId={r.jobId}>{r.jobId}</JobLink>
                        </td>
                        <td className="max-w-[18rem] truncate px-3 py-1.5 text-sdc-navy" title={r.jobName}>
                          {r.jobName}
                        </td>
                        <td className="max-w-[12rem] truncate px-3 py-1.5 text-sdc-gray-600" title={r.customer ?? undefined}>
                          {r.customer ?? "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-sdc-gray-600">{r.type ?? "—"}</td>
                        <td className="whitespace-nowrap px-3 py-1.5">
                          <StatusBadge variant={r.status === "Complete" ? "complete" : "active"}>{r.status}</StatusBadge>
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums">{r.budget != null ? usd(Math.round(r.budget)) : "—"}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono font-semibold tabular-nums text-sdc-navy">{usd(Math.round(r.projected))}</td>
                        <td className={`whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums ${tone}`}>
                          {r.delta != null ? signedUsd(r.delta, usd) : "—"}
                        </td>
                        <td className={`whitespace-nowrap px-3 py-1.5 text-right font-mono font-semibold tabular-nums ${tone}`}>
                          {r.pct != null ? signedPct(r.pct) : "—"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums text-sdc-gray-600">
                          {r.basis === "final" ? "—" : r.stillToPurchase > 0.5 ? usd(Math.round(r.stillToPurchase)) : usd(0)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums">
                          {r.excess > 0.5 ? (
                            <span className="rounded bg-sdc-red-bg px-1.5 py-0.5 font-semibold text-sdc-red-text" title="Bought this month beyond last month's Left to Purchase; already inside the projection">
                              {usd(Math.round(r.excess))}
                            </span>
                          ) : (
                            <span className="text-sdc-border">—</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5">
                          <Gauge row={r} />
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-label text-sdc-gray-400">{BASIS_LABEL[r.basis]}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <p className="border-t border-sdc-border px-4 py-2 text-label text-sdc-gray-400">
            A job id opens that job in Job Details. Over is red, under is green; the % is Projected against Budget. &ldquo;Final
            actual&rdquo; is a completed job&apos;s Parts Cost Actual from the Projects tab, used where Total ETO holds no live parts for it.
          </p>
        </Panel>
      )}
    </div>
  );
}
