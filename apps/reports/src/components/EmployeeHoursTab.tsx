"use client";

import { useEffect, useMemo, useState } from "react";
import { BUCKET_TONE } from "@/components/dashboard/EmployeePunchDrill";
import { loadEmployeeMonthPunches } from "@/lib/employee-punch-actions";
import type { EmployeeMonthPunches } from "@/lib/employee-punch-drill";
import { hoursByJob } from "@/lib/employee-panel-view";
import { currentMonthKey, formatMonthLabel, shiftMonth } from "@/lib/cash-flow-view";

// The Hours tab of the employee panel (2026-10-26): where one person's month
// went, by job. It reads the same month punch list the Department Utilization
// drill does (loadEmployeeMonthPunches), so the totals here are that drill's
// totals; the per-punch list stays on the Dashboard. Loaded on demand, one month
// at a time, because nobody opens every person's hours.

const hrs = (n: number) => (Math.round(n * 100) / 100).toLocaleString("en-US");

type Loaded = { key: string; result: EmployeeMonthPunches | null; error: string | null };

export function EmployeeHoursTab({ paylocityId, name }: { paylocityId: string; name: string }) {
  const [month, setMonth] = useState(() => currentMonthKey(new Date()));
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const key = `${paylocityId}::${month}`;

  useEffect(() => {
    let stale = false;
    loadEmployeeMonthPunches(paylocityId, month)
      .then((result) => !stale && setLoaded({ key, result, error: null }))
      .catch((e: unknown) => !stale && setLoaded({ key, result: null, error: e instanceof Error ? e.message : "Could not load these hours." }));
    return () => {
      stale = true;
    };
  }, [paylocityId, month, key]);

  // Loading is "what is on screen is not for this month yet", so paging never
  // shows the previous month's numbers under the new month's heading.
  const current = loaded?.key === key ? loaded : null;
  const result = current?.result ?? null;
  const jobs = useMemo(() => (result ? hoursByJob(result.rows) : []), [result]);
  const isThisMonth = month === currentMonthKey(new Date());

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-sdc-border-soft px-4 py-2.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
            aria-label="Previous month"
            className="rounded-md border border-sdc-border bg-white px-2 py-1 text-sm text-sdc-navy hover:bg-sdc-gray-50"
          >
            ←
          </button>
          <span className="min-w-[6.5rem] text-center text-sm font-semibold text-sdc-navy">{formatMonthLabel(month)}</span>
          <button
            type="button"
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
            disabled={isThisMonth}
            aria-label="Next month"
            className="rounded-md border border-sdc-border bg-white px-2 py-1 text-sm text-sdc-navy hover:bg-sdc-gray-50 disabled:opacity-40"
          >
            →
          </button>
        </div>
        {result && result.rows.length > 0 && (
          <span className="text-note text-sdc-muted">
            {hrs(result.totalHours)}h total · {hrs(result.billableHours)}h billable
          </span>
        )}
      </div>

      {current?.error ? (
        <p className="px-4 py-6 text-sm text-sdc-red-text">{current.error}</p>
      ) : !current ? (
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-sdc-muted">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-sdc-border border-t-sdc-blue" aria-hidden />
          Loading hours…
        </div>
      ) : !result || result.rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-sdc-muted">
          No hours for {name} in {formatMonthLabel(month)}.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-sdc-border-soft bg-sdc-gray-50 px-4 py-2">
            {result.byBucket.map((b) => (
              <span key={b.bucket} className={`rounded px-1.5 py-0.5 text-label font-semibold ${BUCKET_TONE[b.bucket]}`}>
                {b.label} {hrs(b.hours)}h
              </span>
            ))}
          </div>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-sdc-muted">
                <th className="border-b border-sdc-border px-4 py-2 text-left font-semibold">Job</th>
                <th className="border-b border-sdc-border px-3 py-2 text-right font-semibold">Billable</th>
                <th className="border-b border-sdc-border px-4 py-2 text-right font-semibold">Hours</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.jobId} className="border-b border-sdc-border-soft hover:bg-sdc-blue-light/25">
                  <td className="max-w-[20rem] truncate px-4 py-1.5 text-sdc-gray-700" title={`${j.jobId} ${j.jobName}`}>
                    <span className="font-medium text-sdc-navy">{j.jobId}</span> {j.jobName}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-sdc-gray-600">{hrs(j.billableHours)}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums text-sdc-navy">{hrs(j.hours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-3 text-label text-sdc-muted">
            Same hours as the Dashboard&apos;s Department Utilization drill, which lists each punch.
          </p>
        </>
      )}
    </div>
  );
}
