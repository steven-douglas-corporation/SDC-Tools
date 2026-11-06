import { usd } from "@/components/ui/format";
import type { EtcAnalysisData } from "@/lib/etc-analysis";

// Job Details → "Analysis": every active job with just two figures, Left to Invoice and Money
// Spent Month (2026-11-06, by request). Both are the numbers each job's own Parts Cost card and
// drill-through show on this page (see lib/etc-analysis.ts), so nothing here is a second formula.
// A plain <details>: no client state, costs nothing until opened.

const NUM = "px-3 py-1 text-right font-mono tabular-nums";

function monthLabel(m: string): string {
  return new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}

export function EtcAnalysis({ data }: { data: EtcAnalysisData }) {
  if (data.unavailable) {
    return (
      <p className="mb-5 rounded-md border border-sdc-border bg-sdc-gray-50 px-4 py-2.5 text-xs text-sdc-gray-600">
        Analysis is unavailable right now: Total ETO could not be reached. Reload in a moment.
      </p>
    );
  }
  const { rows } = data;
  if (rows.length === 0) return null;
  const totalLti = rows.reduce((a, r) => a + r.leftToInvoice, 0);
  const totalSpent = rows.reduce((a, r) => a + r.moneySpent, 0);
  // One month label when every job is on the same ETC month (the normal case).
  const months = [...new Set(rows.map((r) => r.month).filter((m): m is string => !!m))].sort();
  const heading = months.length === 1 ? monthLabel(months[0]) : months.length > 1 ? `${monthLabel(months[0])} – ${monthLabel(months[months.length - 1])}` : "no ETC month yet";

  return (
    <details className="mb-5 rounded-md border border-sdc-border bg-white text-xs">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sdc-navy">
        <span className="font-semibold">Analysis — all active jobs</span>
        <span className="text-sdc-muted">
          Left to Invoice <span className="font-mono font-bold tabular-nums text-sdc-navy">{usd(totalLti)}</span>
        </span>
        <span className="text-sdc-muted">
          Money Spent Month <span className="font-mono font-bold tabular-nums text-sdc-navy">{usd(totalSpent)}</span>
        </span>
        <span className="text-sdc-muted">
          {rows.length} job{rows.length === 1 ? "" : "s"} · {heading}
        </span>
      </summary>
      <div className="border-t border-sdc-border">
        <p className="px-4 py-2 text-note leading-relaxed text-sdc-gray-600">
          The same <span className="font-semibold">Left to Invoice</span> and <span className="font-semibold">Money Spent Month</span> each job shows in its own
          Parts Cost card here, for every active job at once. Money Spent Month is for the job&apos;s latest Monthly ETC month ({heading}); Left to Invoice is
          the live balance on purchase orders not yet invoiced. The job picker does not change this table.
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
                  <td className={NUM}>{usd(r.leftToInvoice)}</td>
                  <td className={NUM}>{r.month ? usd(r.moneySpent) : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="sticky bottom-0 bg-sdc-navy font-bold text-white">
              <tr>
                <td className="px-3 py-1.5">Total · {rows.length} jobs</td>
                <td className={NUM}>{usd(totalLti)}</td>
                <td className={NUM}>{usd(totalSpent)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </details>
  );
}
