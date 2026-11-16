import { hasInvoiceBalance } from "@/lib/left-to-invoice";
import { poDates, stateCounts, vsRequired, type OpenPoRow } from "@/lib/open-pos-rules";

// ── Open POs' Advanced filters: checkboxes by category (2026-11-16) ───────────────────────
//
// Basic is the one Money pick. Advanced splits the same questions, and a few more, into
// categories of checkboxes. Within a category a PO needs ANY ticked box; across categories it
// needs ALL of them (an empty category does not filter). So "Late" + "Partly invoiced" is the
// POs that are late and invoiced in part. (No supplier group: the search finds POs by supplier.)
//
// Every test is on the whole PO, with the same figures the rest of the page uses: the line
// states (lineState via stateCounts), the money measures (moneyOf), and for "Vs required" the
// PO's next line still to arrive against its BOM required date (poDates + vsRequired), the same
// line as the cards' Expected and Vs required columns. Pure, no React: tested on its own.

// Received and invoiced are separate groups, each one question with answers that do not overlap
// (2026-11-16: the mixed options "Received, not invoiced" / "Invoiced, not received" became a
// pick in each, e.g. All here + Not invoiced yet). Timing is what is still to come: late or not.
export type AdvCategory = "received" | "timing" | "invoiced" | "required" | "jobStatus";
export type AdvFilters = Record<AdvCategory, ReadonlySet<string>>;

export const NO_ADV_FILTERS: AdvFilters = {
  received: new Set(),
  timing: new Set(),
  invoiced: new Set(),
  required: new Set(),
  jobStatus: new Set(),
};

export type AdvContext = {
  today: string;
  /** BOM required date per line (`pod:<id>`), for "Vs required". */
  requiredByLine: ReadonlyMap<string, string>;
  /** Job status per job number (Active, HeadStart). */
  jobStatus: ReadonlyMap<string, string>;
};

/** The fixed options of each fixed category, in the order shown, with their hover text. */
export const ADV_OPTIONS: Record<"received" | "timing" | "invoiced" | "required", { id: string; label: string; tip: string }[]> = {
  received: [
    { id: "all", label: "All here", tip: "Every part on the PO has arrived (shipping, fee and tariff charges aside)" },
    { id: "partly", label: "Partly received", tip: "Some of the order has arrived and the rest is still to come" },
    { id: "none", label: "Nothing received yet", tip: "None of the order has arrived" },
  ],
  timing: [
    { id: "late", label: "Late", tip: "Parts past their expected date (the vendor's re-promised date when there is one) and still not here" },
    { id: "coming", label: "Coming", tip: "Parts still expected: today or later, or not dated yet" },
  ],
  invoiced: [
    { id: "none", label: "Not invoiced yet", tip: "Nothing has been invoiced (GL-posted) on the PO" },
    { id: "partly", label: "Partly invoiced", tip: "Some of the PO has been invoiced and some is still to be: Left to invoice is above $0.00" },
    { id: "fully", label: "Fully invoiced", tip: "Invoiced in full: Left to invoice is $0.00" },
    { id: "over", label: "Invoiced more than ordered", tip: "Invoices posted add up to more than the PO's value: Left to invoice is below $0.00" },
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
    case "received": {
      // Part lines at PO price (moneyOf): what has arrived against what was ordered.
      const m = r.money;
      if (!r.receiptsKnown || m.ordered <= 0) return false;
      if (opt === "all") return m.notReceived <= 0;
      if (opt === "partly") return r.partiallyReceived;
      if (opt === "none") return m.received <= 0;
      return false;
    }
    case "timing": {
      const s = stateCounts(r.items, ctx.today);
      if (opt === "late") return s.outstanding > 0;
      if (opt === "coming") return s.coming > 0;
      return false;
    }
    case "invoiced": {
      // Invoiced is GL-posted, the app's one definition; Left to invoice is the shared per-line
      // formula, signed. The four answers do not overlap.
      const posted = Math.abs(r.invoiced) >= 0.005;
      if (opt === "none") return !posted;
      if (opt === "partly") return posted && hasInvoiceBalance(r.leftToInvoice) && r.leftToInvoice > 0;
      if (opt === "fully") return posted && !hasInvoiceBalance(r.leftToInvoice);
      if (opt === "over") return hasInvoiceBalance(r.leftToInvoice) && r.leftToInvoice < 0;
      return false;
    }
    case "required": {
      const d = poDates(r.items, undefined, ctx.requiredByLine);
      if (!d.outstanding) return false;
      if (opt === "noBom") return !d.required;
      const v = vsRequired(d.expected, d.required);
      if (!v) return false;
      return opt === "after" ? !v.onTime : opt === "inTime" ? v.onTime : false;
    }
    case "jobStatus":
      return r.jobIds.some((j) => ctx.jobStatus.get(j) === opt);
  }
}

const CATEGORIES: AdvCategory[] = ["received", "timing", "invoiced", "required", "jobStatus"];

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

export const advActive = (f: AdvFilters) => CATEGORIES.some((c) => f[c].size > 0);

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
