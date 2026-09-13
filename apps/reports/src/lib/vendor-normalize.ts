// ── One canonical spelling of Steven Douglas Corp ────────────────────────────
//
// Requested 2026-09-03: the Parts List showed SDC under several names, so the
// supplier and manufacturer filters each offered more than one SDC option and
// picking one returned a subset of the job's SDC parts.
//
// This is the single mapping every consumer of Parts List vendor data calls. It
// normalizes for DISPLAY and GROUPING only — nothing here writes to Total ETO, and
// the raw value stays available on the line for anyone who needs to reconcile
// against the source system.

/** The one spelling. Used as the display value, the filter option, and the group key. */
export const SDC_CANONICAL = "Steven Douglas Corp (SDC)";

// ── What was actually in the data ───────────────────────────────────────────
//
// Measured over 7,582 parts lines across 41 jobs, every value matching
// /sdc|steven|douglas/i:
//
//   MANUFACTURER   2174x  "SDC"
//                    14x  "SDC ASSY"
//   SUPPLIER        275x  "Steven Douglas Corp."
//                    33x  "SDC Credit Card (Approved)"          <- NOT merged, see below
//                    11x  "Steven Douglas Corp. Expense Reports [Concord] (Unapproved)"
//                                                               <- NOT merged, see below
//
// The request also listed "Steven Douglas", "Steven Douglas Corp",
// "Steven Douglas Corporation" and "any other clear spelling/case/spacing
// variation". None of those three appear in the data today, so they are matched by
// PATTERN rather than enumerated — a new spelling should be absorbed without a code
// change, which is the point of having one function.
//
// ── The two that are deliberately NOT merged ────────────────────────────────
//
// The request is explicit: "do not accidentally combine unrelated suppliers /
// manufacturers; only aliases that clearly represent Steven Douglas Corp should be
// mapped." These two carry SDC's name but are not SDC supplying a part:
//
//   "SDC Credit Card (Approved)"
//       A PAYMENT METHOD. The actual vendor on these lines is in the manufacturer
//       field — Mersen, Amazon, and so on. Folding it into SDC-as-supplier would
//       assert that SDC supplied a part it merely paid for.
//
//   "Steven Douglas Corp. Expense Reports [Concord] (Unapproved)"
//       An expense-report conduit, same shape of thing.
//
// There is a concrete consequence beyond labelling, which is the reason this is a
// considered decision rather than caution. `isInHouseSdc` (lib/parts-projection.ts)
// classifies in-house work so it can be EXCLUDED from external invoice exposure. It
// keys on the manufacturer for exactly this reason: merging the card conduit into SDC
// would reclassify 33 lines of genuine outside spend as in-house work SDC never
// invoices, and quietly remove it from the projection.
//
// If they should be merged after all, that is a business call — say so and it is two
// entries in ALIAS_EXACT plus a re-check of isInHouseSdc's exclusion.
const ALIAS_EXACT = new Set(["SDC", "SDC ASSY", "SDCASSY"]);

/**
 * Values that carry SDC's name but are a payment or expense channel rather than SDC
 * as a vendor. Checked BEFORE the patterns, because "Steven Douglas Corp. Expense
 * Reports…" would otherwise match the "steven douglas" pattern below.
 */
const NOT_SDC_AS_VENDOR = [/credit\s*card/i, /expense\s*report/i, /reconcil/i, /\bsage\b/i];

/** Case, spacing, punctuation and legal-suffix differences removed, so one rule covers many spellings. */
function fold(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when this vendor string is Steven Douglas Corp under any of its spellings.
 *
 * Deliberately narrow on the "SDC" acronym: it matches SDC as a whole word or as the
 * first word, so "SDC" and "SDC ASSY" are caught while a hypothetical outside vendor
 * like "SDCO Inc" or "MSDC Ltd" is not. An unanchored substring match on three letters
 * across 356 distinct manufacturers is how unrelated vendors get merged.
 */
export function isSdcVendor(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (NOT_SDC_AS_VENDOR.some((rx) => rx.test(trimmed))) return false;

  const f = fold(trimmed);
  if (ALIAS_EXACT.has(f)) return true;
  if (f === SDC_CANONICAL.toUpperCase() || f === fold(SDC_CANONICAL)) return true;
  // "SDC" as its own leading word: "SDC", "SDC ASSY", "SDC ASSEMBLY".
  if (/^SDC(\s|$)/.test(f)) return true;
  // The written-out name, with or without a legal suffix: "STEVEN DOUGLAS",
  // "STEVEN DOUGLAS CORP", "STEVEN DOUGLAS CORPORATION", "STEVEN DOUGLAS CO".
  if (/^STEVEN\s+DOUGLAS(\s+(CORP|CORPORATION|CO|INC|LLC))?$/.test(f)) return true;
  return false;
}

/**
 * The value to display, filter on, group by and export.
 *
 * Anything that is not SDC comes back trimmed but otherwise untouched — this function
 * is not a general vendor cleaner, and widening it into one would be how unrelated
 * names start collapsing together.
 */
export function normalizeVendor(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return isSdcVendor(trimmed) ? SDC_CANONICAL : trimmed;
}

/**
 * The distinct, normalized, sorted options for a filter dropdown.
 *
 * Built here rather than at each call site so a filter list can never disagree with
 * the values the table shows — the specific bug reported, where two SDC options each
 * returned a subset of the job's SDC parts.
 */
export function normalizedVendorOptions(raws: Iterable<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const r of raws) {
    const v = normalizeVendor(r);
    if (v) set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
