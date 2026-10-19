// ── "Still to purchase": the part of the projection that is not yet ordered (2026-10-19) ──
//
// The Parts Cost card's projection has always been
//
//     Projection = Invoiced + the LARGER of (Adjusted ETC, open POs not yet invoiced)
//
// with  Adjusted ETC = last month's New ETC − invoiced this month.
//
// That reads as "invoiced plus a forecast", and it hid what the forecast is made of: the ETC means
// "all cost still to come", so it already contains the open POs (ordered, not yet invoiced) PLUS
// whatever has not been ordered yet. Splitting it out gives the same total in plainer words:
//
//     Projected total = Purchased to date + Still to purchase
//
//     Still to purchase = Adjusted ETC − open POs          (never below $0)
//
// The two are the same number, not an approximation — `Invoiced + max(ETC, open)` and
// `Invoiced + open + max(0, ETC − open)` are one identity, checked on every active job with parts
// activity (48 of 48, 2026-10-19). Only the grouping changes.
//
// ── The same figure, worked the other way ───────────────────────────────────
//
// A manager thinks in purchases, not invoices: what was still to be bought last month, less what
// was bought this month. That is the same quantity:
//
//     still to purchase last month  =  last month's ETC − open POs at last month's end
//     still to purchase now         ≈  that − purchased this month
//
// It is shown beside the first as a check ("two ways, same answer"). The two can differ by a little:
// money that moved without being "a purchase this month" or "an invoice this month" — an invoice SDC
// billed itself (left out of invoiced-this-month), a PO revised after it was placed, a credit — has
// no place in the second route. On job 1160 (October 2026) that is $33, exactly the SDC invoice.
//
// Only meaningful for the CURRENT month: both routes read today's lines, so for a past month the
// lines include later activity and the second route would not describe that month. It is left out
// then rather than shown wrong.

import type { PartsCostLine } from "@/lib/sync-totaleto";
import { monthEndCutoff, rawLeftToInvoice, rewindLines } from "@/lib/left-to-invoice";

export type StillToPurchaseInput = {
  priorEtc: number | null;
  /** Invoiced (booked) this month — the Monthly ETC's "Money Spent Month". */
  partsSpentThisMonth: number;
  adjustedEtc: number;
  openBalance: number;
  purchased: number;
  projection: number;
  etcUnknown: boolean;
  /** The ETC month the figures describe, `YYYY-MM`. */
  etcMonth: string | null;
  lines: readonly PartsCostLine[];
  /** `YYYY-MM` of today, so the second route can tell whether the ETC month is the current one. */
  todayMonth: string;
};

export type StillToPurchase = {
  /** Adjusted ETC less open POs, floored at $0 — the middle line of the card. */
  stillToPurchase: number;
  /** The forecast sits below what is already ordered, so nothing more is expected to be bought. */
  floored: boolean;
  /** No prior-month ETC on file: nothing is forecast beyond what is already ordered. */
  etcUnknown: boolean;
  // The second route. All null when it does not apply (see the header).
  lastMonthEnd: string | null;
  openAtLastMonthEnd: number | null;
  stillToPurchaseLastMonth: number | null;
  purchasedThisMonth: number | null;
  /** still to purchase last month − purchased this month, floored at $0. */
  secondRoute: number | null;
  /** stillToPurchase − secondRoute: money that was neither "a purchase" nor "an invoice" this month. */
  difference: number | null;
};

function previousMonthKey(month: string): string | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
}

export function computeStillToPurchase(i: StillToPurchaseInput): StillToPurchase {
  const stillToPurchase = Math.max(0, i.adjustedEtc - i.openBalance);
  const floored = !i.etcUnknown && i.adjustedEtc < i.openBalance;
  const none = {
    lastMonthEnd: null, openAtLastMonthEnd: null, stillToPurchaseLastMonth: null,
    purchasedThisMonth: null, secondRoute: null, difference: null,
  };
  const base = { stillToPurchase, floored, etcUnknown: i.etcUnknown };
  if (i.etcUnknown || i.priorEtc == null || !i.etcMonth || i.etcMonth !== i.todayMonth) return { ...base, ...none };

  const prev = previousMonthKey(i.etcMonth);
  const lastMonthEnd = prev ? monthEndCutoff(prev) : null;
  if (!lastMonthEnd) return { ...base, ...none };

  // Open POs as they stood at the end of last month — the app's own "Rewind to" logic.
  const openAtLastMonthEnd = Math.max(0, rawLeftToInvoice(rewindLines(i.lines, lastMonthEnd)));
  const stillToPurchaseLastMonth = Math.max(0, i.priorEtc - openAtLastMonthEnd);
  const monthStart = `${i.etcMonth}-01`;
  const nextMonth = (() => {
    const [y, mo] = i.etcMonth.split("-").map(Number);
    return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
  })();
  const purchasedThisMonth = i.lines
    .filter((l) => (l.purchaseDate ?? "").slice(0, 10) >= monthStart && (l.purchaseDate ?? "").slice(0, 10) < nextMonth)
    .reduce((s, l) => s + l.totalPrice, 0);
  const secondRoute = Math.max(0, stillToPurchaseLastMonth - purchasedThisMonth);
  return {
    ...base,
    lastMonthEnd,
    openAtLastMonthEnd,
    stillToPurchaseLastMonth,
    purchasedThisMonth,
    secondRoute,
    difference: stillToPurchase - secondRoute,
  };
}

/**
 * What the BOM says is still to be ordered: BOM rows nothing has been bought for AND nothing covers
 * (no PO, no stock, not in process, not on hold). A cross-check on the manager's estimate, not a
 * replacement for it — freight, fees and change orders are not on the BOM.
 */
export function bomUncoveredEstimate(
  rows: readonly { nonBom: boolean; matchReason: string; totalPrice: number; status: string; hold: boolean }[],
): { amount: number; parts: number } {
  let amount = 0;
  let parts = 0;
  for (const r of rows) {
    if (r.nonBom || r.matchReason !== "no-purchase") continue;
    if (!(r.status === "noPO" && !r.hold)) continue; // same test as isUncoveredPart
    amount += r.totalPrice;
    parts++;
  }
  return { amount: Math.round(amount * 100) / 100, parts };
}
