"use client";

import { useState, useTransition } from "react";
import { loadJobAnalysis } from "@/lib/job-analysis-actions";
import type { JobAnalysis } from "@/lib/job-analysis";
import { card, TABLE_CARD, TABLE_GRID, TABLE_HEADER_ROW } from "@/components/ui/classnames";
import { usdExact } from "@/components/ui/format";

// Job Details → Analysis: a collapsible panel above the page body. The figures are
// fetched on first open (one batched Total ETO read for every active job), not on every
// page load. See lib/job-analysis.ts for exactly what each column means.

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

const money = (n: number | null) => (n === null ? "—" : usdExact(n));

export function JobAnalysisDropdown() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<JobAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = () => {
    setError(null);
    startTransition(async () => {
      try {
        setData(await loadJobAnalysis());
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the analysis.");
      }
    });
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !data && !pending) load();
  };

  const totals = data
    ? {
        lti: data.rows.reduce((s, r) => s + (r.leftToInvoice ?? 0), 0),
        spent: data.rows.reduce((s, r) => s + (r.moneySpent ?? 0), 0),
      }
    : null;

  return (
    <div className={`${card("p-0")} mb-5 overflow-hidden`}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-sdc-blue-light/40"
      >
        <span className="font-heading text-base font-bold tracking-tight text-sdc-navy">
          Analysis
          <span className="ml-2 text-xs font-normal text-sdc-muted">All active jobs · last month&apos;s Left to Invoice and Money Spent</span>
        </span>
        <span className={`text-sdc-gray-400 ${open ? "rotate-180" : ""}`} aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="border-t border-sdc-border-soft p-4">
          {pending && !data && <p className="text-sm text-sdc-muted">Loading all active jobs from Total ETO…</p>}
          {error && (
            <p className="text-sm text-sdc-red-text">
              {error}{" "}
              <button type="button" onClick={load} className="underline">
                Retry
              </button>
            </p>
          )}
          {data && totals && (
            <>
              <p className="mb-3 text-xs text-sdc-muted">
                Both figures are for <strong className="text-sdc-navy">{monthLabel(data.month)}</strong>. Left to Invoice is the Parts List
                rewound to {monthLabel(data.month)}&apos;s end (the PM view); Money Spent is the Parts List Invoiced $ for{" "}
                {monthLabel(data.month)} 1 – end of month (Invoiced date range).
              </p>
              {(data.leftToInvoiceFailed || data.moneySpentFailed) && (
                <p className="mb-3 rounded-md border border-sdc-yellow bg-sdc-yellow-bg/40 px-3 py-2 text-xs text-sdc-yellow-text">
                  Total ETO could not be read for {data.leftToInvoiceFailed && data.moneySpentFailed ? "either figure" : data.leftToInvoiceFailed ? "Left to Invoice" : "Money Spent"}; that
                  column shows “—” rather than $0.{" "}
                  <button type="button" onClick={load} className="underline">
                    Retry
                  </button>
                </p>
              )}
              <div className={`${TABLE_CARD} max-h-[420px] overflow-auto`}>
                <table className={`w-full text-sm ${TABLE_GRID}`}>
                  <thead className="sticky top-0 z-10 bg-white">
                    <tr className={TABLE_HEADER_ROW}>
                      <th className="px-4 py-2">Job ID</th>
                      <th className="px-4 py-2">Left to Invoice ({monthLabel(data.month)})</th>
                      <th className="px-4 py-2">Money Spent Month ({monthLabel(data.month)})</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r, i) => (
                      <tr key={r.jobId} className={i % 2 === 1 ? "bg-sdc-gray-50/60" : ""}>
                        <td className="px-4 py-1.5 text-center text-label font-medium text-sdc-navy" title={r.jobName}>
                          {r.jobId}
                        </td>
                        <td className="px-4 py-1.5 text-center text-label">{money(r.leftToInvoice)}</td>
                        <td className="px-4 py-1.5 text-center text-label">{money(r.moneySpent)}</td>
                      </tr>
                    ))}
                    {data.rows.length === 0 && (
                      <tr>
                        <td colSpan={3} className="px-4 py-5 text-center text-label text-sdc-gray-400">
                          No active jobs.
                        </td>
                      </tr>
                    )}
                  </tbody>
                  {data.rows.length > 0 && (
                    <tfoot className="sticky bottom-0 bg-white">
                      <tr>
                        <td className="px-4 py-2 text-center text-label font-bold text-sdc-navy">Total ({data.rows.length} jobs)</td>
                        <td className="px-4 py-2 text-center text-label font-bold text-sdc-navy">{money(totals.lti)}</td>
                        <td className="px-4 py-2 text-center text-label font-bold text-sdc-navy">{money(totals.spent)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
