import { hasInvoiceBalance } from "@/lib/left-to-invoice";
import { poDates, stateCounts, vsRequired, type OpenPoRow } from "@/lib/open-pos-rules";

// ── Open POs' Advanced filters: checkboxes by category (2026-11-16) ───────────────────────
//
// Basic is the one Money pick. Advanced splits the same questions, and a few more, into
// categories of checkboxes. Within a category a PO needs ANY ticked box; across categories it
// needs ALL of them (an empty category does not filter). So "Late" + "Not yet invoiced" +
// supplier "Acme" is Acme's POs that are late and not fully invoiced.
//
// Every test is on the whole PO, with the same figures the rest of the page uses: the line
// states (lineState via stateCounts), the money measures (moneyOf), and for "Vs required" the
// PO's next line still to arrive against its BOM required date (poDates + vsRequired), the same
// line as the cards' Expected and Vs required columns. Pure, no React: tested on its own.

export type AdvCategory = "status" | "delivery" | "invoicing" | "required" | "supplier" | "jobStatus";
export type AdvFilters = Record<AdvCategory, ReadonlySet<string>>;

export const NO_ADV_FILTERS: AdvFilters = {
  status: new Set(),
  delivery: new Set(),
  invoicing: new Set(),
  required: new Set(),
  supplier: new Set(),
  jobStatus: new Set(),
};

/**
 * Where Advanced starts, and what Clear filters goes back to: open POs only. Closed POs (fully
 * received and invoiced, from the Here list) come in when Closed is ticked.
 */
export const DEFAULT_ADV_FILTERS: AdvFilters = { ...NO_ADV_FILTERS, status: new Set(["open"]) };

export type AdvContext = {
  today: string;
  /** BOM required date per line (`pod:<id>`), for "Vs required". */
  requiredByLine: ReadonlyMap<string, string>;
  /** Job status per job number (Active, HeadStart). */
  jobStatus: ReadonlyMap<string, string>;
};

/** The fixed options of each fixed category, in the order shown, with their hover text. */
export const ADV_OPTIONS: Record<"status" | "delivery" | "invoicing" | "required", { id: string; label: string; tip: string }[]> = {
  status: [
    { id: "open", label: "Open", tip: "Still owing a delivery or an invoice" },
    { id: "closed", label: "Closed", tip: "Fully received and fully invoiced, with at least one part received (as on the Here list)" },
  ],
  delivery: [
    { id: "late", label: "Late", tip: "Parts past their expected date (the vendor's re-promised date when there is one) and still not here" },
    { id: "coming", label: "Coming", tip: "Parts still expected: today or later, or not dated yet" },
    { id: "partial", label: "Partly received", tip: "Some of the order has arrived and the rest is still to come" },
    { id: "none", label: "Nothing received yet", tip: "None of the order has arrived" },
  ],
  invoicing: [
    { id: "notInvoiced", label: "Not yet invoiced", tip: "Left to invoice is not $0.00. The same as Money's Not yet invoiced and Job Details' Left to Invoice" },
    { id: "receivedNotInvoiced", label: "Received, not invoiced", tip: "Parts have arrived that the vendor's invoice does not cover yet" },
    { id: "invoicedNotReceived", label: "Invoiced, not received", tip: "Invoiced beyond what has arrived, on parts still to come: paid for, not here yet" },
    { id: "over", label: "Invoiced more than ordered", tip: "Invoices posted add up to more than the PO's value" },
  ],
  required: [
    { id: "after", label: "Arrives after it's required", tip: "The next part to arrive is expected after the BOM's required date for it" },
    { id: "inTime", label: "Arrives in time", tip: "The next part to arrive is expected on or before the BOM's required date for it" },
    { id: "noBom", label: "Not on the BOM", tip: "The next part to arrive has no required date: it is not on the job's BOM" },
  ],
};

/** Does one PO pass one option of one category? */
export function matchesOption(r: OpenPoRow, cat: AdvCategory, opt: string, ctx: AdvContext): boolean {
  switch (cat) {
    case "status":
      return opt === "open" ? r.open : opt === "closed" ? !r.open : false;
    case "delivery": {
      const s = stateCounts(r.items, ctx.today);
      if (opt === "late") return s.outstanding > 0;
      if (opt === "coming") return s.coming > 0;
      if (opt === "partial") return r.partiallyReceived;
      if (opt === "none") return r.receiptsKnown && r.money.ordered > 0 && r.money.received <= 0;
      return false;
    }
    case "invoicing":
      if (opt === "notInvoiced") return hasInvoiceBalance(r.leftToInvoice);
      if (opt === "receivedNotInvoiced") return r.money.receivedNotInvoiced > 0;
      if (opt === "invoicedNotReceived") return r.money.invoicedNotReceived > 0;
      if (opt === "over") return r.leftToInvoice < 0;
      return false;
    case "required": {
      const d = poDates(r.items, undefined, ctx.requiredByLine);
      if (!d.outstanding) return false;
      if (opt === "noBom") return !d.required;
      const v = vsRequired(d.expected, d.required);
      if (!v) return false;
      return opt === "after" ? !v.onTime : opt === "inTime" ? v.onTime : false;
    }
    case "supplier":
      return (r.suppliers.length ? r.suppliers : ["No supplier"]).includes(opt);
    case "jobStatus":
      return r.jobIds.some((j) => ctx.jobStatus.get(j) === opt);
  }
}

const CATEGORIES: AdvCategory[] = ["status", "delivery", "invoicing", "required", "supplier", "jobStatus"];

/** A PO passes when, in every category with something ticked, it matches one of the ticks. */
export function advMatch(r: OpenPoRow, f: AdvFilters, ctx: AdvContext, skip?: AdvCategory): boolean {
  for (const cat of CATEGORIES) {
    if (cat === skip || f[cat].size === 0) continue;
    let any = false;
    for (const opt of f[cat]) if ((any = matchesOption(r, cat, opt, ctx))) break;
    if (!any) return false;
  }
  return true;
}

/** Anything picked beyond where Advanced starts (open POs only, nothing else ticked). */
export const advActive = (f: AdvFilters) =>
  CATEGORIES.some((c) => (c === "status" ? !(f.status.size === 1 && f.status.has("open")) : f[c].size > 0));

/**
 * How many POs each option would leave: those passing every OTHER category's ticks that match
 * this option. So a count reads as "tick this (too) and you get N", within its own category's
 * any-of and on top of the rest.
 */
export function advCounts(rows: readonly OpenPoRow[], f: AdvFilters, ctx: AdvContext, options: Record<AdvCategory, readonly string[]>): Record<AdvCategory, Record<string, number>> {
  const out = {} as Record<AdvCategory, Record<string, number>>;
  for (const cat of CATEGORIES) {
    const base = rows.filter((r) => advMatch(r, f, ctx, cat));
    out[cat] = Object.fromEntries(options[cat].map((opt) => [opt, base.filter((r) => matchesOption(r, cat, opt, ctx)).length]));
  }
  return out;
}
