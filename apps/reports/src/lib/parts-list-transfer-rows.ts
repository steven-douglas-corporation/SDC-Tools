// ── Parts moved between jobs, as rows of the Parts List (2026-10-14) ─────────
//
// The Parts List is the job's PO lines grouped by BOM part. A transfer is not a PO line —
// Total ETO books it as inventory pulls, because it cannot re-code an invoice to another
// job — so the table could never show it, and its footer disagreed with the Parts Cost
// card, which already nets the same transfers (lib/parts-transfer-netting.ts).
//
// Each counterpart job becomes ONE row under the real rows:
//
//     TRANSFER   Parts moved to job 1160 — 126 item movements (inventory pulls)   −$20,463.08
//
// It adds the same amount to Total $ and Invoiced $ and nothing to Left to Invoice, exactly as
// the card does, so the footer ties to the card and "Total − Invoiced" is unchanged.
//
// ── Why a pinned row and not a rewritten part row ───────────────────────────
//
// Zeroing each moved part's own row was measured on job 1155: 108 of 136 items would go to
// $0, 11 would keep a remainder, 3 would turn slightly negative (pulls are valued at pull
// cost, invoices at invoice cost) and 4 moved items have no row to take the amount at all.
// Each row also unfolds into its real PO lines, which would still show the real prices
// beneath a $0 parent. A transfer is rare; one clearly-labelled row is exact and explains
// itself.
//
// ── When it shows ───────────────────────────────────────────────────────────
//
// A transfer has no supplier, status, category, invoice date or BOM membership, so it cannot
// honestly satisfy any filter. It shows only in the plain whole-job view and hides the moment
// anything narrows the table; the strip under the table says so.

import type { JobTransferEntry } from "@/lib/parts-transfer-netting";

export type TransferRow = {
  /** Stable React key. */
  key: string;
  direction: "in" | "out";
  otherJob: string;
  /** Signed as it moves this job: negative left, positive arrived. */
  amount: number;
  /** How many item movements it is made of. */
  movements: number;
  /** The latest day any of them completed, YYYY-MM-DD ("" when unknown). */
  lastDay: string;
  /** The Desc cell. */
  description: string;
};

/** One row per counterpart job and direction, largest first (the entries already are). */
export function buildTransferRows(entries: readonly JobTransferEntry[]): TransferRow[] {
  return entries.map((e) => ({
    key: `transfer:${e.direction}:${e.otherJob}`,
    direction: e.direction,
    otherJob: e.otherJob,
    amount: e.amount,
    movements: e.transfers,
    lastDay: e.lastDay,
    description:
      `Parts moved ${e.direction === "out" ? "to" : "in from"} job ${e.otherJob} — ` +
      `${e.transfers} item movement${e.transfers === 1 ? "" : "s"} (inventory pulls)`,
  }));
}

/**
 * Whether the transfer rows belong in the table right now. Only the plain whole-job view:
 * `filtersActive` is the Parts List's own flag for every narrowing control (status, category,
 * manufacturer, supplier, search, date type and range, left-to-invoice only, rewind) and the
 * scope chip must be on "all" — a transfer is not a BOM part, and "non-BOM only" is the
 * freight/fee rows, which it is not either.
 */
export function transferRowsShown(view: {
  filtersActive: boolean;
  scope: "all" | "bom" | "nonbom";
  hasTransfers: boolean;
}): boolean {
  return view.hasTransfers && !view.filtersActive && view.scope === "all";
}

/** What the rows add to the footer: the same figure to Total $ and Invoiced $, nothing to Left to Invoice. */
export function transferFooterAdd(rows: readonly TransferRow[]): { total: number; invoiced: number; left: number } {
  const sum = Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  return { total: sum, invoiced: sum, left: 0 };
}

/**
 * One cell of a transfer row, for the Excel/CSV export, keyed by the Parts List's column key
 * and typed like that column's own sort value (numbers for money, ISO text for dates, null
 * for everything a transfer has no value for). The on-screen cells render from the same rows.
 */
export function transferExportValue(colKey: string, row: TransferRow): string | number | null {
  switch (colKey) {
    case "pn": return "TRANSFER";
    case "desc": return row.description;
    case "invoiceddate": return row.lastDay || null;
    case "total": return row.amount;
    case "invoiced": return row.amount;
    case "leftspend": return 0;
    case "status": return "Transfer";
    default: return null; // qty, parent, category, mfr, supplier, po, purchased, req, exp, delivered, lead, due, unit, purchqty, pctinv
  }
}

/** The one line the strip shows when the rows are hidden by a filter. */
export function hiddenTransfersNote(rows: readonly TransferRow[]): string {
  const net = rows.reduce((s, r) => s + r.amount, 0);
  const abs = `$${Math.abs(Math.round(net)).toLocaleString("en-US")}`;
  return `Parts moved between jobs (${net < 0 ? "−" : "+"}${abs}) are hidden while a filter is on`;
}
