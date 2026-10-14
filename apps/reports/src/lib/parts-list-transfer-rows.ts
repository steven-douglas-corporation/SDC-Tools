// ── Parts moved between jobs, as rows of the Parts List (2026-10-14) ─────────
//
// The Parts List is a job's PO lines grouped by BOM part. A transfer is not a PO line —
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
// ── "Hide parts moved to other jobs" (2026-10-14) ───────────────────────────
//
// After a transfer, the rows of parts that LEFT a job say little about the job as it stands.
// They are still the only record of the PO, supplier and invoice, so they are hidden by a
// toggle (on by default), never removed.
//
// Hiding a row takes its Total $ and Invoiced $ out of the footer, so the TRANSFER row must
// stop subtracting what the hidden rows already took out. It becomes the RESIDUAL: its amount
// plus the hidden rows' own figures. The footer is therefore identical with the toggle on or
// off, and always equals the Parts Cost card:
//
//     footer = Σ visible rows + (transfer − Σ hidden rows)  =  Σ all rows + transfer
//
// Only BOM rows whose item was moved out for at least their whole cost are hidden. A partly
// moved part stays (its remainder is real), freight/fees/card charges (non-BOM rows) never
// hide, and a BOM part nothing was bought for has nothing to hide.
//
// ── When anything shows ─────────────────────────────────────────────────────
//
// A transfer has no supplier, status, category, invoice date or BOM membership, so it cannot
// honestly satisfy any filter. The TRANSFER rows show only in the plain whole-job view and hide
// the moment anything narrows the table; the strip under the table says so. The hide toggle is
// a row preference, not a filter: it applies in the lifetime view and stands down in a date
// range or a rewound month, where each row has been re-summed and "fully moved" no longer
// means what it was measured as.

import type { JobTransferEntry, JobTransferItem } from "@/lib/parts-transfer-netting";

export type TransferRow = {
  /** Stable React key. */
  key: string;
  direction: "in" | "out";
  otherJob: string;
  /** Signed as it moves this job, whole: negative left, positive arrived. */
  amount: number;
  /** What this row adds to Total $ — `amount`, plus whatever hidden rows already took out of the footer. */
  total: number;
  /** What this row adds to Invoiced $ — `amount`, plus whatever hidden rows already took out of the footer. */
  invoiced: number;
  /**
   * What this row adds to Left to Invoice: 0 for a transfer on its own (the parts that moved were
   * bought AND received), but the open PO balance of every hidden row — those rows still owe it,
   * and it must stay in the footer or the footer stops matching the Parts Cost card.
   */
  left: number;
  /** How many item movements it is made of. */
  movements: number;
  /** How many fully-moved parts of this counterpart are hidden above it (0 when none). */
  hiddenParts: number;
  /** The latest day any of them completed, YYYY-MM-DD ("" when unknown). */
  lastDay: string;
  /** The Desc cell. */
  description: string;
};

// ── Which parts moved completely ────────────────────────────────────────────

/** Cost moved OUT of this job, per item, and where it went. */
export type MovedOutIndex = Map<number, { total: number; byJob: Map<string, number> }>;

/** Indexes the card's item movements: the dollars that left, per item, split by destination job. */
export function indexMovedOut(items: readonly JobTransferItem[]): MovedOutIndex {
  const idx: MovedOutIndex = new Map();
  for (const it of items) {
    if (it.direction !== "out") continue;
    const cost = Math.abs(it.amount);
    const e = idx.get(it.itemId) ?? { total: 0, byJob: new Map<string, number>() };
    e.total += cost;
    e.byJob.set(it.otherJob, (e.byJob.get(it.otherJob) ?? 0) + cost);
    idx.set(it.itemId, e);
  }
  return idx;
}

/** The part of a Parts List row the rule needs — `FlatPart` has all of it. */
export type HideCandidate = {
  /** A BOM row's id IS the Total ETO item id (po-detail.ts). */
  id: number;
  nonBom: boolean;
  matchReason: string;
  totalPrice: number;
  invoicedAmount: number;
  /** The row's open PO balance (null in a windowed view, where the toggle stands down anyway). */
  leftToSpend: number | null;
};

/** Half a dollar: below any real money, above float noise and sub-dollar costing drift. */
const FULLY_MOVED_SLACK = 0.5;

/**
 * Whether a row's part left this job for at least its whole cost. BOM rows only; a part
 * nothing was bought for (its total is a BOM estimate, not spend) is never hidden.
 */
export function isFullyMoved(row: HideCandidate, moved: MovedOutIndex): boolean {
  if (row.nonBom || row.matchReason === "no-purchase") return false;
  const m = moved.get(row.id);
  if (!m || row.totalPrice <= FULLY_MOVED_SLACK) return false;
  return m.total >= row.totalPrice - FULLY_MOVED_SLACK;
}

// ── The rows ────────────────────────────────────────────────────────────────

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * One row per counterpart job and direction, largest first (the entries already are).
 *
 * `hidden` are the rows the "hide moved parts" toggle removed from the table. Each takes its
 * own Total $ and Invoiced $ out of the footer, so each counterpart's row carries only the
 * RESIDUAL: its amount plus its share of the hidden rows' figures (a part moved to two jobs is
 * split by the dollars it sent to each). Nothing hidden = the whole amount, as before.
 */
export function buildTransferRows(
  entries: readonly JobTransferEntry[],
  hidden: { rows: readonly HideCandidate[]; moved: MovedOutIndex } = { rows: [], moved: new Map() },
): TransferRow[] {
  return entries.map((e) => {
    let total = e.amount;
    let invoiced = e.amount;
    let left = 0;
    let hiddenParts = 0;
    if (e.direction === "out") {
      for (const r of hidden.rows) {
        const m = hidden.moved.get(r.id);
        const sent = m?.byJob.get(e.otherJob) ?? 0;
        if (!m || m.total <= 0 || sent <= 0) continue;
        const share = sent / m.total;
        total += r.totalPrice * share;
        invoiced += r.invoicedAmount * share;
        left += (r.leftToSpend ?? 0) * share;
        hiddenParts++;
      }
    }
    const description =
      `Parts moved ${e.direction === "out" ? "to" : "in from"} job ${e.otherJob} — ` +
      `${e.transfers} item movement${e.transfers === 1 ? "" : "s"} (inventory pulls)` +
      (hiddenParts > 0
        ? `; ${hiddenParts} fully moved part${hiddenParts === 1 ? " is" : "s are"} hidden above, this is the rest`
        : "");
    return {
      key: `transfer:${e.direction}:${e.otherJob}`,
      direction: e.direction,
      otherJob: e.otherJob,
      amount: e.amount,
      total: cents(total),
      invoiced: cents(invoiced),
      left: cents(left),
      movements: e.transfers,
      hiddenParts,
      lastDay: e.lastDay,
      description,
    };
  });
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

/**
 * What the rows add to the footer: their own Total $ and Invoiced $, and the open PO balance of
 * any rows the hide toggle removed (0 when none are hidden — a transfer alone adds nothing to it).
 */
export function transferFooterAdd(rows: readonly TransferRow[]): { total: number; invoiced: number; left: number } {
  return {
    total: cents(rows.reduce((s, r) => s + r.total, 0)),
    invoiced: cents(rows.reduce((s, r) => s + r.invoiced, 0)),
    left: cents(rows.reduce((s, r) => s + r.left, 0)),
  };
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
    case "total": return row.total;
    case "invoiced": return row.invoiced;
    case "leftspend": return row.left;
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

/** The strip line while the hide toggle is removing rows, or null when it removed none. */
export function hiddenMovedNote(hiddenRowCount: number, destinations: readonly string[]): string | null {
  if (hiddenRowCount <= 0) return null;
  const where = destinations.length === 0 ? "other jobs" : destinations.length === 1 ? `job ${destinations[0]}` : `jobs ${destinations.join(", ")}`;
  return `${hiddenRowCount} part${hiddenRowCount === 1 ? "" : "s"} moved to ${where} ${hiddenRowCount === 1 ? "is" : "are"} hidden`;
}
