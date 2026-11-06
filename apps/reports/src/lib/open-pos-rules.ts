import type { PartsCostLine } from "@/lib/sync-totaleto";
import { dayOf, hasInvoiceBalance, lineLeftToInvoice } from "@/lib/left-to-invoice";

// ── Open POs: purchase orders that still owe an invoice, today ───────────────
//
// For procurement / supply chain. Every other screen that shows PO money is organised
// around something else (a part, a job-month, a delivery date, a cash month); this one
// is organised around the purchase order.
//
// ── No second formula ────────────────────────────────────────────────────────
//
// Built from the SAME PartsCostLine rows the Parts List, Monthly ETC and PO-across-jobs
// read (getPartsCostForJobs), and the money is the same per-line `lineLeftToInvoice`.
// "Open" is the Parts List's "Left to invoice" filter applied per PO: the PO's signed
// balance is not $0.00 at cent precision (`hasInvoiceBalance`), so an over-invoiced PO
// shows up next to the ones still owed, as it does on the Parts List since 2026-10-08.
//
// Deliberately NOT part of "open": receipts. A PO invoiced in full but not fully logged as
// received (a prepayment, or a receipt nobody logged) is not listed. Receipt status only
// decides the Status column of a PO that is already open on money. Widening it would make
// this page disagree with every Left to Invoice figure in the app.
//
// Extra Costs (`ec:` lines: freight, fees, tariffs) are AP documents, not purchase orders,
// so they are left out. That is the one reason a job's "Open PO value" here can differ
// from its Left to Invoice on Job Details: a billed-but-never-posted extra cost counts
// there and not here. The aggregate floor at 0 is the other (Job Details floors a job's
// total; a PO row here is signed, like the Parts List column).

export type OpenPoStatus = "past-due" | "awaiting-delivery" | "awaiting-invoice" | "over-invoiced" | "open";

/** Plain-language labels, one place, so the grid, the filter and the KPI cards agree. */
export const OPEN_PO_STATUS_LABEL: Record<OpenPoStatus, string> = {
  "past-due": "Past due",
  "awaiting-delivery": "Awaiting delivery",
  "awaiting-invoice": "Received, awaiting invoice",
  "over-invoiced": "Invoiced more than ordered",
  open: "Open",
};

export type OpenPoJob = { jobId: string; jobName: string; status: string };

export type OpenPoRow = {
  poNumber: string;
  /** Every job (of the ones loaded) this PO charges, ascending. */
  jobIds: string[];
  suppliers: string[];
  /** Earliest purchase date on the PO, `YYYY-MM-DD`. */
  purchaseDate: string | null;
  /**
   * Earliest EXPECTED date among lines not yet fully received (re-promised date when a buyer
   * entered one, see `lineDue`); null when none are outstanding or none carry a date.
   */
  nextDue: string | null;
  /** Earliest ORIGINAL required date among the same lines, before any re-promise. */
  originalDue: string | null;
  /** True when any outstanding line's expected date differs from its original one (shown as ↻). */
  revised: boolean;
  lines: number;
  /** Lines with a positive quantity that are fully received. */
  linesReceived: number;
  /** Lines with a positive quantity (the ones that can be received at all). */
  linesReceivable: number;
  /** Lines not fully received whose expected date is before today. */
  linesPastDue: number;
  /** False when the feed carried no receipt data for this PO; Status then reads "Open". */
  receiptsKnown: boolean;
  purchased: number;
  /** GL-posted: the app's one definition of invoiced. */
  invoiced: number;
  /** Signed, NOT floored: an over-invoiced PO reads negative. */
  leftToInvoice: number;
  status: OpenPoStatus;
};

export type OpenPoJobSummary = {
  jobId: string;
  jobName: string;
  jobStatus: string;
  openPos: number;
  pastDuePos: number;
  /** Sum of this job's share of its open POs' balances (signed). */
  openValue: number;
  /** This job's share of open POs' still-unreceived lines, at PO price. */
  awaitingDeliveryValue: number;
  /** Oldest purchase date among this job's open POs. */
  oldestOpen: string | null;
};

export type OpenPosResult = {
  asOf: string;
  rows: OpenPoRow[];
  jobs: OpenPoJobSummary[];
  totals: { openPos: number; openValue: number; pastDuePos: number; awaitingDeliveryValue: number; suppliers: number };
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A line that can be received: a real PO line with a positive quantity. */
const receivable = (l: PartsCostLine) => l.lineId.startsWith("pod:") && l.quantity > 0;
const receiptKnown = (l: PartsCostLine) => typeof l.receivedQty === "number";
const fullyReceived = (l: PartsCostLine) => receiptKnown(l) && (l.receivedQty as number) >= l.quantity;

/**
 * When a line is due, for "late" and "next due": the re-promised date when Total ETO has one,
 * else the original required date. Matches the Scheduler's Vendor POs ETA order, so a PO the
 * vendor has re-promised for next week is not called late here while the Scheduler says on time.
 */
export const lineDue = (l: PartsCostLine): string | null => dayOf(l.expectedDate ?? l.requiredDate ?? null);

function minDay(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

/**
 * Status for an open PO. Order matters: money first (an over-invoiced PO is a finance
 * problem whatever its deliveries say), then lateness, then what it is waiting on.
 */
export function poStatus(x: { leftToInvoice: number; receiptsKnown: boolean; linesPastDue: number; linesReceived: number; linesReceivable: number }): OpenPoStatus {
  if (x.leftToInvoice < 0) return "over-invoiced";
  if (!x.receiptsKnown) return "open";
  if (x.linesPastDue > 0) return "past-due";
  if (x.linesReceived < x.linesReceivable) return "awaiting-delivery";
  return "awaiting-invoice";
}

/**
 * Group every job's lines into POs and keep the open ones.
 *
 * `today` is a `YYYY-MM-DD` string, compared lexically like every other date in the
 * parts path (left-to-invoice.ts: no Date is built from a feed value).
 */
export function buildOpenPos(linesByJob: ReadonlyMap<string, readonly PartsCostLine[]>, jobs: readonly OpenPoJob[], today: string): OpenPosResult {
  type Acc = { lines: { job: string; line: PartsCostLine }[] };
  const byPo = new Map<string, Acc>();
  for (const job of jobs) {
    for (const line of linesByJob.get(job.jobId) ?? []) {
      if (!line.lineId.startsWith("pod:")) continue; // Extra Costs are not purchase orders
      const po = (line.poNumber ?? "").trim();
      if (!po) continue;
      const acc = byPo.get(po) ?? { lines: [] };
      acc.lines.push({ job: job.jobId, line });
      byPo.set(po, acc);
    }
  }

  const rows: OpenPoRow[] = [];
  // Per job: [openValue, awaitingDeliveryValue, pastDue?, oldest] for each open PO it carries.
  const jobAcc = new Map<string, { openPos: number; pastDuePos: number; openValue: number; awaiting: number; oldest: string | null }>();

  for (const [poNumber, acc] of byPo) {
    const lines = acc.lines.map((x) => x.line);
    const leftToInvoice = lines.reduce((s, l) => s + lineLeftToInvoice(l), 0);
    if (!hasInvoiceBalance(leftToInvoice)) continue;

    let nextDue: string | null = null;
    let originalDue: string | null = null;
    let revised = false;
    let linesReceived = 0;
    let linesReceivable = 0;
    let linesPastDue = 0;
    let purchaseDate: string | null = null;
    for (const l of lines) {
      purchaseDate = minDay(purchaseDate, dayOf(l.purchaseDate));
      if (!receivable(l)) continue;
      linesReceivable++;
      if (fullyReceived(l)) {
        linesReceived++;
        continue;
      }
      const due = lineDue(l);
      const original = dayOf(l.requiredDate ?? null);
      nextDue = minDay(nextDue, due);
      originalDue = minDay(originalDue, original);
      if (due && original && due !== original) revised = true;
      if (due && due < today && receiptKnown(l)) linesPastDue++;
    }
    const receiptsKnown = lines.some((l) => receivable(l) && receiptKnown(l)) || linesReceivable === 0;

    const row: OpenPoRow = {
      poNumber,
      jobIds: [...new Set(acc.lines.map((x) => x.job))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      suppliers: [...new Set(lines.map((l) => l.supplier).filter((s): s is string => !!s))],
      purchaseDate,
      nextDue,
      originalDue,
      revised,
      lines: lines.length,
      linesReceived,
      linesReceivable,
      linesPastDue,
      receiptsKnown,
      purchased: r2(lines.reduce((s, l) => s + l.totalPrice, 0)),
      invoiced: r2(lines.reduce((s, l) => s + l.actualAmount, 0)),
      leftToInvoice: r2(leftToInvoice),
      status: "open",
    };
    row.status = poStatus(row);
    rows.push(row);

    // Each job's share of this PO: its own lines only, so a PO split across jobs is not
    // counted in full against every one of them.
    for (const jobId of row.jobIds) {
      const mine = acc.lines.filter((x) => x.job === jobId).map((x) => x.line);
      const a = jobAcc.get(jobId) ?? { openPos: 0, pastDuePos: 0, openValue: 0, awaiting: 0, oldest: null };
      a.openPos++;
      if (row.status === "past-due") a.pastDuePos++;
      a.openValue += mine.reduce((s, l) => s + lineLeftToInvoice(l), 0);
      a.awaiting += mine
        .filter((l) => receivable(l) && receiptKnown(l) && !fullyReceived(l))
        .reduce((s, l) => s + (l.quantity - (l.receivedQty as number)) * l.unitPrice, 0);
      for (const l of mine) a.oldest = minDay(a.oldest, dayOf(l.purchaseDate));
      jobAcc.set(jobId, a);
    }
  }

  // Past due first, then the largest balance: the order someone working the list wants.
  const rank: Record<OpenPoStatus, number> = { "past-due": 0, "over-invoiced": 1, "awaiting-delivery": 2, open: 3, "awaiting-invoice": 4 };
  rows.sort((a, b) => rank[a.status] - rank[b.status] || Math.abs(b.leftToInvoice) - Math.abs(a.leftToInvoice));

  const jobSummaries: OpenPoJobSummary[] = jobs
    .filter((j) => jobAcc.has(j.jobId))
    .map((j) => {
      const a = jobAcc.get(j.jobId)!;
      return {
        jobId: j.jobId,
        jobName: j.jobName,
        jobStatus: j.status,
        openPos: a.openPos,
        pastDuePos: a.pastDuePos,
        openValue: r2(a.openValue),
        awaitingDeliveryValue: r2(a.awaiting),
        oldestOpen: a.oldest,
      };
    })
    .sort((a, b) => b.openValue - a.openValue);

  return {
    asOf: today,
    rows,
    jobs: jobSummaries,
    totals: {
      openPos: rows.length,
      // Summed from the job shares, so the KPI equals the job table's column total.
      openValue: r2(jobSummaries.reduce((s, j) => s + j.openValue, 0)),
      pastDuePos: rows.filter((r) => r.status === "past-due").length,
      awaitingDeliveryValue: r2(jobSummaries.reduce((s, j) => s + j.awaitingDeliveryValue, 0)),
      suppliers: new Set(rows.flatMap((r) => r.suppliers)).size,
    },
  };
}
