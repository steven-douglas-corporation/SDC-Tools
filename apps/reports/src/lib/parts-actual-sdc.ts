import { isSdcVendor } from "@/lib/vendor-normalize";

// ── Lifetime Parts Actual, split into "SDC billed" and everything else ──────
//
// Pure and free of `server-only` so it can be unit-tested without a database —
// the same reason lib/parts-refund.ts is. The query that feeds it lives in
// sync-totaleto.ts (getPartsActualSdcSplitByJob), beside the GL-posted predicate it
// has to share with getPartsActualByJob.
//
// Used by the Projects export's "excl. SDC" columns (2026-10-02, by request). It is
// deliberately NOT wired into the Projects grid or into Job.costActualHistorical: the
// grid keeps showing the stored GL-posted actual exactly as before.
//
// One definition of "is this SDC": isSdcVendor, the same function the Parts List, the
// T&M report and the Monthly ETC columns use. "SDC Credit Card" and "Steven Douglas
// Corp. Expense Reports" are refused by it on purpose (a payment method and an expense
// channel, not SDC supplying a part), so they stay in `actual` and out of `sdc`.

export type ApVendorTotal = {
  /** Total ETO job number, as a string ("1101"). */
  jobId: string;
  /** tblCompany.CName of the AP document's vendor; null when the document has none. */
  vendor: string | null;
  /** Net GL-posted amount for this job + vendor, credits already netted off. */
  amount: number;
  /**
   * Whether these AP lines sit on a purchase order. Omitted/true = PO-backed. false = a
   * plain AP invoice with no PO, which is never "SDC billing us for a part it made", even
   * when the vendor is Steven Douglas Corp. — job 1106's $209,625 "Adjustment to match
   * Sage" is one, and it has to stay in the normal-expense column to match the ledger.
   */
  hasPo?: boolean;
};

export type PartsActualSdcSplit = {
  /** Everything GL-posted for the job, SDC included — equals getPartsActualByJob's figure. */
  actual: number;
  /** The part of `actual` billed under Steven Douglas Corp. as the supplier. */
  sdc: number;
};

export function splitActualBySdc(rows: readonly ApVendorTotal[]): Map<string, PartsActualSdcSplit> {
  const out = new Map<string, PartsActualSdcSplit>();
  for (const r of rows) {
    // A null/NaN sum is a data problem, not a zero: skipping keeps the job out rather
    // than reporting a confident figure built on a hole (same rule as getPartsActualByJob).
    if (!Number.isFinite(r.amount)) continue;
    const cur = out.get(r.jobId) ?? { actual: 0, sdc: 0 };
    cur.actual += r.amount;
    if (r.hasPo !== false && isSdcVendor(r.vendor)) cur.sdc += r.amount;
    out.set(r.jobId, cur);
  }
  return out;
}
