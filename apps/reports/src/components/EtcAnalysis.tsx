import { usd } from "@/components/ui/format";

// Job Details → "Analysis": every active job on one screen with just the two month-end figures
// (2026-11-06, by request): Left to Invoice and Money Spent Month, for the previous month.
//
// Nothing here is computed separately. The page hands in the SAME two values each row of the
// Job Details grid renders for its Parts Cost block — Left to Invoice as resolved for the selected
// month's cutoff (resolveLeftToInvoice), and the Parts Cost entry's `hoursWorked` (Money Spent
// Month, i.e. what was invoiced/booked inside that month, 1st to last day). The rows are the
// grid's visible rows, so a figure that changes in the grid changes here on the same render and
// the Total row matches the grid's footer.
//
// A plain <details>: no client state, costs nothing until opened.

import type { EtcAnalysisRow } from "@/lib/etc-analysis";

const NUM = "px-3 py-1 text-right font-mono tabular-nums";
const fmt = (n: number | null) => (n == null ? "—" : usd(n));

export function EtcAnalysis({
  rows,
  monthLabel,
  rangeLabel,
  cutoffLabel,
  hasLeftToInvoice,
}: {
  rows: EtcAnalysisRow[];
  /** e.g. "October 2026" */
  monthLabel: string;
  /** e.g. "Oct 1 – Oct 31, 2026" */
  rangeLabel: string;
  /** e.g. "Oct 31, 2026" */
  cutoffLabel: string;
  /** false on months that predate the Left to Invoice column. */
  hasLeftToInvoice: boolean;
}) {
  if (rows.length === 0) return null;
  const totalLti = rows.reduce((a, r) => a + (r.leftToInvoice ?? 0), 0);
  const totalSpent = rows.reduce((a, r) => a + (r.moneySpent ?? 0), 0);

  return (
    <details className="mb-5 rounded-md border border-sdc-border bg-white text-xs">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sdc-navy">
        <span className="font-semibold">Analysis — all active jobs, {monthLabel}</span>
        {hasLeftToInvoice && (
          <span className="text-sdc-muted">
            Left to Invoice <span className="font-mono font-bold tabular-nums text-sdc-navy">{usd(totalLti)}</span>
          </span>
        )}
        <span className="text-sdc-muted">
          Money Spent Month <span className="font-mono font-bold tabular-nums text-sdc-navy">{usd(totalSpent)}</span>
        </span>
        <span className="text-sdc-muted">
          {rows.length} job{rows.length === 1 ? "" : "s"}
        </span>
      </summary>
      <div className="border-t border-sdc-border">
        <p className="px-4 py-2 text-note leading-relaxed text-sdc-gray-600">
          Both figures are for <span className="font-semibold">{monthLabel}</span> and are the same numbers the Monthly ETC grid shows for the Parts Cost
          columns. <span className="font-semibold">Left to Invoice</span> is what is on purchase orders and not yet invoiced as of {cutoffLabel}.{" "}
          <span className="font-semibold">Money Spent Month</span> is what was invoiced from {rangeLabel}. It always shows the previous month, and is not affected by the job picker.
        </p>
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-[1] bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
              <tr>
                <th className="px-3 py-1.5">Job ID</th>
                <th className="px-3 py-1.5 text-right">Left to Invoice</th>
                <th className="px-3 py-1.5 text-right">Money Spent Month</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.jobId} className="border-b border-sdc-border-soft hover:bg-sdc-blue-light/40">
                  <td className="max-w-[24rem] truncate px-3 py-1" title={`${r.jobId} — ${r.jobName}`}>
                    <span className="font-mono">{r.jobId}</span> <span className="text-sdc-muted">{r.jobName}</span>
                  </td>
                  <td className={NUM}>{hasLeftToInvoice ? fmt(r.leftToInvoice) : "—"}</td>
                  <td className={NUM}>{fmt(r.moneySpent)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="sticky bottom-0 bg-sdc-navy font-bold text-white">
              <tr>
                <td className="px-3 py-1.5">Total · {rows.length} jobs</td>
                <td className={NUM}>{hasLeftToInvoice ? usd(totalLti) : "—"}</td>
                <td className={NUM}>{usd(totalSpent)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </details>
  );
}
