import type { CustomerSummary } from "@/lib/dashboard-overview";

// ── How concentrated is the active book? (the customer donut) ───────────────
//
// The Dashboard's customer BARS answer "who has what, and of which type". This
// answers a different question — "how much of the book sits with a few names" —
// so it shows the biggest customers by name and lumps the long tail into one
// slice. A donut stops being readable past ~6 slices, and the customer list is
// long enough to scroll.
//
// `customers` arrives ranked by active count from dashboard-overview.ts and is
// NOT re-sorted here: there is one ranking definition, not two.
//
// ── Colour is RANK, not identity ────────────────────────────────────────────
//
// Every project-type colour already means a project type on this same card, so
// customers must not borrow them ("blue = Custom" and "blue = Acme" at once).
// A customer is not a fixed category either — the set changes month to month —
// so there is no stable colour to give one. Instead the slices take a single-hue
// ramp, darkest for the biggest customer, and the lumped tail is the brand's
// neutral Gray. Strings are literal for the same reason BRAND_PALETTE's are:
// Tailwind finds classes by scanning source text.

/** How many customers get a slice of their own before the rest are lumped. */
export const TOP_CUSTOMERS = 5;

/** The lumped slice's key. Not a canonical customer id, and never selectable. */
export const OTHER_KEY = "__other__";

type RampColor = { stroke: string; swatch: string };

/** Biggest customer first. Navy → Dark Blue → Primary Blue → a Primary Blue tint → Light Blue. */
const RANK_RAMP: readonly RampColor[] = [
  { stroke: "stroke-sdc-navy", swatch: "bg-sdc-navy" },
  { stroke: "stroke-sdc-blue-dark", swatch: "bg-sdc-blue-dark" },
  { stroke: "stroke-sdc-blue", swatch: "bg-sdc-blue" },
  { stroke: "stroke-sdc-blue/55", swatch: "bg-sdc-blue/55" },
  { stroke: "stroke-sdc-blue-100", swatch: "bg-sdc-blue-100" },
];

/** The brand guide's Gray #D9D9D9 (`sdc-border`) — the neutral for "everyone else". */
const OTHER_COLOR: RampColor = { stroke: "stroke-sdc-border", swatch: "bg-sdc-border" };

export type ConcentrationSlice = {
  /** Canonical customer id, or OTHER_KEY. */
  key: string;
  label: string;
  count: number;
  /** Percent of the active book, one decimal — the same rounding the bars use. */
  pct: number;
  /** How many customers this slice stands for: 1, or the size of the lumped tail. */
  customerCount: number;
  isOther: boolean;
  stroke: string;
  swatch: string;
};

/**
 * The top `top` customers by name, then the rest lumped as "Other".
 *
 * A tail of exactly ONE customer is named rather than lumped: "Other (1
 * customer)" hides a name for no saving, so the ring may show `top + 1` named
 * slices. Customers with no active jobs are dropped.
 */
export function concentrationSlices(
  customers: readonly CustomerSummary[],
  activeTotal: number,
  top: number = TOP_CUSTOMERS,
): ConcentrationSlice[] {
  const live = customers.filter((c) => c.activeCount > 0);
  const lump = live.length > top + 1;
  const named = lump ? live.slice(0, top) : live;
  const tail = lump ? live.slice(top) : [];
  const pct = (n: number) => (activeTotal === 0 ? 0 : Math.round((n / activeTotal) * 1000) / 10);

  const slices: ConcentrationSlice[] = named.map((c, i) => ({
    key: c.canonicalCustomerId,
    label: c.name,
    count: c.activeCount,
    pct: pct(c.activeCount),
    customerCount: 1,
    isOther: false,
    ...RANK_RAMP[Math.min(i, RANK_RAMP.length - 1)],
  }));

  if (tail.length > 0) {
    const count = tail.reduce((n, c) => n + c.activeCount, 0);
    slices.push({
      key: OTHER_KEY,
      label: "Other",
      count,
      pct: pct(count),
      customerCount: tail.length,
      isOther: true,
      ...OTHER_COLOR,
    });
  }
  return slices;
}
