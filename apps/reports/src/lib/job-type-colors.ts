import { VALID_JOB_TYPES } from "@/lib/job-filters";

// ── One colour per project type (2026-08-28, re-palletted 2026-08-31) ───────
//
// The Dashboard draws project type in three places that must agree: the ranked
// "Active Jobs by Project Type" bars, the per-type segments stacked inside each
// customer's bar in "Active Jobs by Customer", and the Type cell of the
// drill-through those charts open. A reader compares a segment against a bar
// across the two charts and then against the table underneath, so a type has to
// be the same colour in all three — hence one map here rather than a palette in
// each component.
//
// Keyed off VALID_JOB_TYPES (job-filters.ts) rather than a hand-listed set, and
// the tests assert every valid type has an entry: adding a sixth type must not
// silently render as the fallback grey in one chart and something else in the
// other.
//
// ── Every colour is from the SDC Brand Guide 2026, section 04 ───────────────
//
// The palette is closed. BRAND_PALETTE below is the guide's own table expressed
// as this app's tokens, and job-type-colors.test.ts asserts that every fill in
// BY_TYPE comes from it — so a later edit cannot quietly reintroduce an
// off-palette hex the way `bg-sdc-purple` did.
//
// What changed on 2026-08-31: Duplicate was `bg-sdc-purple` (#581C87, which is
// Tailwind's purple-900 and appears nowhere in the brand guide) — the one
// genuinely off-brand colour in these charts. Duplicate takes Dark Navy, which
// it wants anyway: it is routinely the largest type on the book (all 24 First
// Solar jobs today) and Navy is the strongest non-primary in the guide. T&M
// takes Light Blue.
//
// T&M was briefly assigned Lime Green (#BEFA4F), on the reasoning that the guide
// calls lime an accent to "use sparingly" and T&M is the smallest type. Measured
// in the browser, that was wrong and badly so: Lime against Service's Yellow
// (#FFDE51) is 1.07:1 in luminance AND only ~24 degrees apart in hue, and the
// two sit next to each other in both the legend and the stack (VALID_JOB_TYPES
// order is Custom, Duplicate, Hybrid, Service, T&M). Two adjacent segments with
// neither a lightness nor a hue difference read as one segment.
//
// Light Blue is only 1.25:1 against Yellow on luminance too — but it is ~155
// degrees away in hue, and hue is what separates two solid fills of similar
// lightness. It is also already used as a category band elsewhere in this app
// (employee-teams.ts, the ETC phase headers, the quoted phase chips), so it is
// a colour this codebase already treats as a category rather than a tint. Lime
// stays in BRAND_PALETTE, unused by any type, for whoever needs an accent that
// is not sitting beside yellow.
//
// Deliberately NOT a status/severity palette: the guide assigns Yellow to
// "alerts / overrun warnings" and Green to "on-track", and both readings are
// live elsewhere on this page. There is no red in this map at all, and the two
// status-adjacent colours are paired with types that carry no such reading.
// Project type is an IDENTITY, not a judgement — a Duplicate job is not "worse"
// than a Custom one.

/**
 * The SDC Brand Guide 2026 §04 palette, as the Tailwind colour tokens declared
 * in app/globals.css.
 *
 * Values are the full utility class, written out literally: Tailwind v4 finds
 * classes by scanning source text, so a name assembled at runtime
 * (`bg-${token}`) compiles to nothing and the bar renders transparent. Any
 * mapping here has to be a string Tailwind can actually see.
 *
 * The guide's Gray #D9D9D9 is absent because this app has no token for it — see
 * TRACK_CLASS for what the empty part of a bar uses and why.
 */
export const BRAND_PALETTE = {
  /** Primary Blue #1574C4 — CTAs, headlines, key data. */
  blue: "bg-sdc-blue",
  /** Dark Navy #061D39 — dark backgrounds, headers. */
  navy: "bg-sdc-navy",
  /** Light Blue #AACEE8 — supporting tints, card backgrounds. */
  blueLight: "bg-sdc-blue-100",
  /** Yellow #FFDE51 — alerts, callouts, overrun warnings. */
  yellow: "bg-sdc-yellow",
  /** Green #74C415 — success, on-track indicators. */
  green: "bg-sdc-green",
  /**
    * Lime Green #BEFA4F — vibrant accent, "use sparingly" per the guide.
    * Deliberately NOT assigned to a project type: it is 1.07:1 against the
    * Yellow that Service uses, at a similar hue, and the two types are adjacent.
    */
  lime: "bg-sdc-lime",
  /** Black #231F20 — body text. Not a category colour; the unmapped fallback leans on it. */
  black: "bg-sdc-gray-700",
} as const;

export type BrandColorName = keyof typeof BRAND_PALETTE;

export type JobTypeColor = {
  /** Bar / segment fill. */
  bar: string;
  /** Legend swatch. The SAME string as `bar`, by construction — see BUILT. */
  swatch: string;
  /** A small solid dot, for a table cell or chip that names the type in text. */
  dot: string;
  /** Which BRAND_PALETTE entry this type uses, so a chart or a test can check its provenance. */
  brand: BrandColorName;
};

/**
 * The unfilled-track neutral, and the page's one "nothing here" fill.
 *
 * `bg-sdc-gray-100` (#F2F2F2) rather than the guide's Gray #D9D9D9: this is the
 * empty part of a bar sitting on a white card, and it has to read as absence
 * without competing with the fills. The guide's gray is a divider weight and at
 * bar height it looks like a sixth category.
 */
export const TRACK_CLASS = "bg-sdc-gray-100";

// A type present in the database but missing from BY_TYPE. Dark enough to be
// unmistakably "not a real category colour" rather than a faint tint that reads
// as a legitimate one. `bg-sdc-gray-400` is #3D3D3D despite the name.
const FALLBACK: JobTypeColor = {
  bar: "bg-sdc-gray-400",
  swatch: "bg-sdc-gray-400",
  dot: "bg-sdc-gray-400",
  brand: "black",
};

/**
 * Project type -> brand colour. THE mapping — one entry per type, one place.
 *
 * Ordered as VALID_JOB_TYPES declares them, which is also the legend order and
 * the order segments stack inside a customer's bar — so Service and T&M are
 * always neighbours, and their two colours have to be told apart at a 1px
 * boundary. That is the constraint that picked Light Blue over Lime for T&M;
 * job-type-colors.test.ts pins the minimum separation so the next edit cannot
 * quietly reintroduce a same-lightness, same-hue pair.
 */
const BY_TYPE: Record<string, BrandColorName> = {
  // Primary Blue for the default kind of work SDC does.
  Custom: "blue",
  Duplicate: "navy",
  Hybrid: "green",
  Service: "yellow",
  // Light Blue. Distinct from Service's Yellow by hue, which is what a reader
  // actually uses at the boundary between two light fills — see the header.
  "T&M": "blueLight",
};

// bar, swatch and dot are the same string BY CONSTRUCTION, not by convention.
// A legend that has drifted from its bars is worse than no legend, and building
// all three from one lookup makes that drift impossible rather than merely
// something a test has to catch.
const BUILT: Record<string, JobTypeColor> = Object.fromEntries(
  Object.entries(BY_TYPE).map(([type, brand]) => {
    const fill = BRAND_PALETTE[brand];
    return [type, { bar: fill, swatch: fill, dot: fill, brand } satisfies JobTypeColor];
  }),
);

/** Never throws and never returns undefined — an unmapped type renders grey rather than invisible. */
export function jobTypeColor(type: string): JobTypeColor {
  return BUILT[type] ?? FALLBACK;
}

/** Canonical legend order — the declared type order, not whatever a given month ranked. */
export const JOB_TYPE_LEGEND: readonly string[] = VALID_JOB_TYPES;

/**
 * Separates one stacked segment from the next: a 1px inset light edge on every
 * segment except the first.
 *
 * An inset box-shadow, so it costs no layout — the segments still sum to exactly
 * the bar width, which the customer chart's arithmetic depends on. It exists
 * because two of the five category colours are light against the card (Yellow
 * #FFDE51 is 1.33:1 against white and Light Blue #AACEE8 is 1.65:1), and a
 * Service segment running straight into a T&M one wants a boundary even when
 * the hues differ. The same edge keeps a light segment from bleeding into the
 * row background on hover.
 */
export const SEGMENT_EDGE_CLASS = "[&:not(:first-child)]:shadow-[inset_1px_0_0_rgba(255,255,255,0.65)]";

/**
 * Ranked order for a bar chart: count descending, then the canonical type order
 * as a stable tiebreak so two equal counts don't swap places between renders.
 *
 * Zero-count types sort to the end rather than being dropped — the charts
 * de-emphasise them instead of hiding them, so "we have no Service work right
 * now" stays visible as a fact rather than becoming an absence the reader has to
 * notice. Callers that genuinely want them gone can filter after sorting.
 */
export function rankByCount<T extends { type: string; count: number }>(rows: readonly T[]): T[] {
  const canonical = new Map(VALID_JOB_TYPES.map((t, i) => [t as string, i]));
  return [...rows].sort(
    (a, b) =>
      b.count - a.count ||
      (canonical.get(a.type) ?? Number.MAX_SAFE_INTEGER) - (canonical.get(b.type) ?? Number.MAX_SAFE_INTEGER) ||
      a.type.localeCompare(b.type),
  );
}
