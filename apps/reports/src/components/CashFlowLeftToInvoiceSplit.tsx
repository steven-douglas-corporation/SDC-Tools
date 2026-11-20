import { LeftToInvoiceCutoffPicker } from "@/components/LeftToInvoiceCutoffPicker";
import { usd } from "@/components/ui/format";
import { NET_TERMS_DAYS, monthName, type LeftToInvoiceOverview } from "@/lib/left-to-invoice-by-month";

// Cash Flow Forecast → "Monthly ETC - Left to Invoice Split". Moved here from the Monthly ETC page
// (2026-11-12) and now read live: the Monthly ETC jobs' Left to Invoice as of today, by expected
// payment month (required date + net terms). The earlier by-billing-month table was dropped
// (2026-11-20) as a duplicate of this one.
//
// Every row is the split already behind that job's own Left to Invoice figure
// (lib/parts-etc-breakout.ts), so a row sums to that figure and the Total row sums the column.
// No client state: a plain <details>, open by default.
//
// The date is each PO line's required date — when the part is due to arrive, so roughly when the
// supplier bills. It is an estimate of billing, NOT a payment due date: nothing here is invoiced.
// "Overdue" means that date has passed and the balance is still not invoiced (not billed, or
// billed and not yet entered) — the rows worth chasing.

const NUM = "px-2 py-1 text-right font-mono tabular-nums";
const money = (n: number) => (Math.abs(n) < 0.5 ? "—" : usd(n));

export function CashFlowLeftToInvoiceSplit({
  payOverview,
  asOfLabel,
  cutoffMonth,
  overrides = 0,
  status,
  month,
  hasColumn,
}: {
  /** Every job's Left to Invoice with each month moved NET_TERMS_DAYS after the required date (expected payment month). */
  payOverview: LeftToInvoiceOverview;
  /** The day the figures are as of, written for a human (today). */
  asOfLabel: string;
  /** `YYYY-MM` when a month-end cutoff is chosen; null = today (live). */
  cutoffMonth: string | null;
  /** Jobs whose Monthly ETC Left to Invoice cell holds a manager's figure instead of Total ETO's. */
  overrides?: number;
  /** "failed": Total ETO could not be read. "no-jobs": Monthly ETC has no jobs for `month`. Neither is "nothing left to invoice". */
  status: "ok" | "failed" | "no-jobs";
  /** The Monthly ETC month whose jobs are listed. */
  month: string;
  /** Does Monthly ETC have a Left to Invoice column for `month`? (August 2026 on.) */
  hasColumn: boolean;
}) {
  const { rows, totals } = payOverview;
  const overduePct = totals.sum > 0 ? Math.round((totals.overdue / totals.sum) * 100) : 0;

  return (
    <details open className="mb-6 rounded-md border border-sdc-border bg-white text-xs">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sdc-navy">
        <span className="text-sm font-semibold">Monthly ETC - Left to Invoice Split</span>
        <span className="font-mono font-bold tabular-nums">{usd(totals.sum)}</span>
        <span className="text-sdc-muted">
          {totals.overdue > 0.5 ? `${usd(totals.overdue)} (${overduePct}%) already past its required date` : "none past its required date"}
          {" · "}
          {rows.length} job{rows.length === 1 ? "" : "s"}
        </span>
      </summary>
      <div className="border-t border-sdc-border">
        <LeftToInvoiceCutoffPicker month={cutoffMonth} />
        {status === "failed" ? (
          <p className="border-t border-sdc-border px-4 py-3 text-sdc-muted">
            Left to Invoice could not be read from Total ETO just now, so nothing is shown here. This is not a $0 balance — refresh to try again.
          </p>
        ) : status === "no-jobs" ? (
          <p className="border-t border-sdc-border px-4 py-3 text-sdc-muted">
            Monthly ETC has no jobs for {monthName(month)} (that month has not been started, or it is before ETC history), so there is nothing to split.
            Pick another month.
          </p>
        ) : rows.length === 0 ? (
          <p className="border-t border-sdc-border px-4 py-3 text-sdc-muted">Nothing left to invoice as of {asOfLabel}.</p>
        ) : (
          <>
            <h3 className="border-t border-sdc-border px-4 pb-1 pt-2.5 text-xs font-semibold text-sdc-navy">
              Parts Left to Invoice — Monthly ETC jobs, by expected payment month (required date + {NET_TERMS_DAYS} days)
            </h3>
            <p className="px-4 pb-2 text-note leading-relaxed text-sdc-gray-600">
              The same jobs, in the same order, as the Monthly ETC grid for {monthName(month)}.{" "}
              {hasColumn
                ? "The Total ties to that grid's Parts Cost Left to Invoice column, as long as its Billable filter is off."
                : "Monthly ETC has no Left to Invoice column for that month, so there is nothing to tie to."}
              {overrides > 0 &&
                ` ${overrides} job${overrides === 1 ? " has" : "s have"} a manually typed Left to Invoice on Monthly ETC; this table shows Total ETO's figure for ${overrides === 1 ? "it" : "them"}, so those rows can differ.`}
            </p>
            <p className="px-4 pb-2 text-note leading-relaxed text-sdc-gray-600">
              Each job&apos;s Left to Invoice as of {asOfLabel}, with each month set {NET_TERMS_DAYS} days after the PO line&apos;s{" "}
              <span className="font-semibold">required date</span> (when the part is due to arrive), assuming net {NET_TERMS_DAYS} supplier terms. A flat
              estimate: many suppliers bill with shorter terms, and net terms run from the invoice date, which can be after the required date. Nothing here is
              invoiced yet. <span className="font-semibold">Overdue</span> stays on the required date itself: that date has passed and the balance is still not
              invoiced — the supplier has not billed it, or the bill has not been entered. Overdue is measured against today, whatever date the figures are as of.
            </p>
            <OverviewTable overview={payOverview} />
          </>
        )}
      </div>
    </details>
  );
}

function OverviewTable({ overview }: { overview: LeftToInvoiceOverview }) {
  const { rows, months, totals } = overview;
  return (
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
  );
}
