import { PARTS_COST_SECTION } from "@/lib/sections";

// ── When the Parts Cost breakout columns exist ───────────────────────────────
//
// "Left to Invoice" and "Left to Purchase" split the Parts Cost New ETC into the two
// things it is made of. They were added 2026-09-03, and the instruction with them was
// explicit: they start at August 2026 and must not appear on any earlier month.
//
// ── Why a month rule and not just "show them everywhere" ────────────────────
//
// Because the columns would be empty and misleading on every closed month, in a way
// that reads as data loss rather than as a feature that did not exist yet. Nothing
// backfills them: they are manager-entered figures stored per EtcEntry, so every month
// before August has NULL in both, and NULL renders as "—". A manager opening June
// would see two new columns of dashes beside a New ETC that was in fact submitted and
// signed off — inviting them to "fix" a month that is already closed.
//
// The same reasoning applies to the upstream cost. Left to Invoice is seeded from Total
// ETO, and that is the only upstream call the Monthly ETC page makes; there is no
// reason to spend it on a month that cannot show the result.
//
// ── Why a constant and not a "does any row have a value" check ──────────────
//
// A data-driven test would make the columns appear and disappear depending on whether
// anyone had typed in them yet — so August itself would show no columns until the first
// manager filled one in, and could not be filled in because the columns were not there.
// The rule is a date because the decision was a date.

/**
 * The first month that has these columns, `YYYY-MM`.
 *
 * August 2026, by request. Month strings in this app are zero-padded `YYYY-MM`
 * throughout, which is why a plain string comparison below is sound.
 */
export const PARTS_BREAKOUT_FIRST_MONTH = "2026-08";

/**
 * Whether the Monthly ETC grid shows Left to Invoice / Left to Purchase for `month`.
 *
 * Anything unparseable answers false — the columns are additive, so the safe direction
 * for a month string we do not understand is the layout every month had before this
 * feature existed.
 */
export function showsPartsBreakout(month: string | null | undefined): boolean {
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return false;
  return month >= PARTS_BREAKOUT_FIRST_MONTH;
}

// ── Whose figure is this row's newEtcDraft? ──────────────────────────────────
//
// On a breakout month the Parts Cost `newEtcDraft` stopped being a number anybody
// types. It is DERIVED — `leftToInvoice + leftToPurchase`, written only by
// handlePartsBreakoutEntry (lib/etc-actions.ts), which is what makes the stored New
// ETC the sum of the two figures stored beside it.
//
// That invariant has to hold against every OTHER writer too, and it did not. Both
// background redrives — derivePriorEtcForMonth and syncPartsCost — pass the draft
// through `redrivenDraft`, which rewrites a draft that exactly equals the suggestion
// from the OLD Prior ETC when Prior ETC moves. That rule is right for a typed New
// ETC and wrong for a derived one, and the collision is not exotic: it fires
// precisely when a manager entered halves that add up to the figure the grid
// suggested, which is the common case.
//
// The damage is silent and downstream. The grid keeps rendering
// `leftToInvoice + leftToPurchase`, so the cell still reads $3,000 — while the
// submission, the export and next month's Prior ETC all read `newEtcDraft` and see
// the redriven number. On a row still carrying a pre-breakout hand-typed New ETC
// (both halves NULL) it is worse: that figure IS what Left to Invoice displays, so
// a sync quietly changes a number a manager typed.
//
// SKIPPING is the fix rather than recomputing, and the distinction matters. There is
// nothing to recompute from: on a derived row the halves are the truth and the draft
// is only their sum, so a redrive would be inventing a figure for a cell whose whole
// contract is that it is entered. Leave it exactly as stored and the two stay equal.
export function isDerivedPartsDraft(month: string | null | undefined, section: string): boolean {
  return section === PARTS_COST_SECTION && showsPartsBreakout(month);
}
