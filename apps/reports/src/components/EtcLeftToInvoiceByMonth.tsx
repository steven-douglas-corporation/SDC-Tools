import { usd } from "@/components/ui/format";
import { monthName, type LeftToInvoiceOverview } from "@/lib/left-to-invoice-by-month";

// Monthly ETC → every job's Left to Invoice, side by side by expected billing month (2026-10-28).
//
// Collapsed it is one line (total, and how much of it is already overdue); opened, a job-by-month
// table. Every row is the split already behind that job's own Left to Invoice cell, so a row sums
// to its cell and the Total row sums the column of cells in the grid below. No client state: a
// plain <details>, so it costs the page nothing until someone opens it.
//
// The date is each PO line's required date — when the part is due to arrive, so roughly when the
// supplier bills. It is an estimate of billing, NOT a payment due date: nothing here is invoiced.
// "Overdue" means that date has passed and the balance is still not invoiced (not billed, or
// billed and not yet entered) — the rows worth chasing.

const NUM = "px-2 py-1 text-right font-mono tabular-nums";
const money = (n: number) => (Math.abs(n) < 0.5 ? "—" : usd(n));

export function EtcLeftToInvoiceByMonth({
  overview,
  overriddenJobs,
  cutoffLabel,
}: {
  overview: LeftToInvoiceOverview;
  /** Jobs whose cell holds a manual figure instead of this computed one, so their row is not what the cell shows. */
  overriddenJobs: number;
  cutoffLabel: string;
}) {
  const { rows, months, totals } = overview;
  if (rows.length === 0) return null;
  const overduePct = totals.sum > 0 ? Math.round((totals.overdue / totals.sum) * 100) : 0;

  return (
    <details className="mb-3 rounded-md border border-sdc-border bg-white text-xs">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sdc-navy">
        <span className="font-semibold">Parts Left to Invoice — all jobs, by expected billing month</span>
        <span className="font-mono font-bold tabular-nums">{usd(totals.sum)}</span>
        <span className="text-sdc-muted">
          {totals.overdue > 0.5 ? `${usd(totals.overdue)} (${overduePct}%) already past its required date` : "none past its required date"}
          {" · "}
          {rows.length} job{rows.length === 1 ? "" : "s"}
        </span>
      </summary>
      <div className="border-t border-sdc-border">
        <p className="px-4 py-2 text-note leading-relaxed text-sdc-gray-600">
          Each job&apos;s Left to Invoice as of {cutoffLabel}, split by the PO line&apos;s <span className="font-semibold">required date</span> — when the part is
          due to arrive, so roughly when the supplier bills it. It is an estimate of billing, not a payment due date: nothing here is invoiced yet.{" "}
          <span className="font-semibold">Overdue</span> means that date has passed and the balance is still not invoiced — the supplier has not billed it,
          or the bill has not been entered. Overdue is measured against today.
          {overriddenJobs > 0
            ? ` ${overriddenJobs} job${overriddenJobs === 1 ? "" : "s"} carry a manually adjusted figure in the grid; this table shows the computed one.`
            : ""}
        </p>
        <div className="max-h-[28rem] overflow-auto">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-[1] bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
              <tr>
                <th className="px-2 py-1.5">Job</th>
                <th className="px-2 py-1.5 text-right">Overdue</th>
                {months.map((m) => (
                  <th key={m} className="px-2 py-1.5 text-right">
                    {monthName(m)}
                  </th>
                ))}
                <th className="px-2 py-1.5 text-right">No date</th>
                <th className="px-2 py-1.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.jobId} className="border-b border-sdc-border-soft hover:bg-sdc-blue-light/40">
                  <td className="max-w-[18rem] truncate px-2 py-1" title={`${r.jobId} — ${r.jobName}`}>
                    <span className="font-mono">{r.jobId}</span> <span className="text-sdc-muted">{r.jobName}</span>
                  </td>
                  <td className={`${NUM} ${r.buckets.overdue > 0.5 ? "bg-sdc-yellow-bg/50" : ""}`}>{money(r.buckets.overdue)}</td>
                  {months.map((m) => (
                    <td key={m} className={NUM}>
                      {money(r.buckets.months[m] ?? 0)}
                    </td>
                  ))}
                  <td className={NUM}>{money(r.buckets.noDate)}</td>
                  <td className={`${NUM} font-semibold`}>{money(r.sum)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="sticky bottom-0 bg-sdc-navy font-bold text-white">
              <tr>
                <td className="px-2 py-1.5">Total · {rows.length} jobs</td>
                <td className={NUM}>{money(totals.overdue)}</td>
                {months.map((m) => (
                  <td key={m} className={NUM}>
                    {money(totals.months[m] ?? 0)}
                  </td>
                ))}
                <td className={NUM}>{money(totals.noDate)}</td>
                <td className={NUM}>{money(totals.sum)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </details>
  );
}
