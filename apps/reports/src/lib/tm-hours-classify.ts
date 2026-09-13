import { SECTIONS, POOL_QUOTED_SECTION, billingGroupForSection } from "@/lib/sections";

// ── The T&M Hours code->card classifier, split out on purpose ───────────────
//
// Pure and dependency-free (no Prisma, no "server-only") so it's importable
// from a plain node:test file without a database — `tm-hours.ts` itself has
// `import "server-only"`, which throws unconditionally under this project's
// test runner (tsx) the moment anything VALUE-imports it, so the one thing
// worth testing without a live database (the code->card mapping itself) has
// to live somewhere that import doesn't reach. Same reasoning as
// tm-drill-reconcile.ts's own split from tm-report.ts.
//
// getTmHoursTotals (an aggregate) and getTmHoursDrillRows (row detail) in
// tm-hours.ts both run every JobHoursDetail row through this SAME function —
// so a card's KPI total and its own drill-through can only ever disagree if
// this function disagreed with itself between two calls, which it can't
// (pure, depends on nothing but its argument).
//
// ── AUDIT, 2026-09-01: Engineering/Shop were missing the Warranty phase ─────
//
// These four sets used to be derived from ETC_SECTIONS' `billingGroup`. That
// was wrong, and it under-reported two of the four cards on every selection.
//
// ETC_SECTIONS deliberately excludes four codes (ETC_EXCLUDED_CODES): PM
// (10-111), Manufacturing (10-413), and BOTH Warranty codes — 70-211 (ME & CE)
// and 70-411 (MB & EB). That exclusion is a statement about the "Managers Fill
// Out" spreadsheet, which has no Warranty column. It says nothing whatsoever
// about whether warranty hours are Engineering or Shop work, and T&M inherited
// it purely because `billingGroup` happened to be the field that named a
// billing group.
//
// Measured on 2026-05-31..2026-07-31, all jobs: 394.77h of Warranty ENGINEERING
// (70-211 plus 70-311/70-313/70-516, which alias onto it) and 435.29h of
// Warranty SHOP (70-411 plus 70-412) were counted in NO card at all —
// Engineering read 7,004 instead of 7,426 and Shop read 5,870 instead of 6,306.
//
// The authority for the fix is the Power BI report this page recreates, whose
// own measures are:
//
//   Engineering Hours = CALCULATE(SUM('Hours Actual'[Hours Actual]),
//                                 'Function Hierarchy'[Billing Group] = "Engineering")
//   Shop Hours        = ... [Billing Group] = "Shop"
//   Other Hours       = ... NOT([Billing Group] IN {"Engineering","Shop"})
//
// No phase exclusion anywhere — billing group and nothing else. So these sets
// now come from billingGroupForSection() (sections.ts), which answers that same
// question for EVERY section code rather than only the 13 the ETC sheet has a
// column for.
//
// ── PM and Manufacturing are CARVED OUT, deliberately ──────────────────────
//
// 10-111 (Management) and 10-413 (Manufacturing) are checked FIRST and removed
// from the Engineering/Shop sets, so a punch lands in exactly one card and the
// five cards partition the hours. Power BI does NOT do this — it has no PM or
// Manufacturing measure at all, so those hours appear inside Engineering/Shop
// there. The carve-out is the app's own behavior and is kept on explicit
// request ("a punch must not accidentally count in both Shop Hours and
// Manufacturing Hours"). It is the ONE intentional difference from the measures
// quoted above, and the reason Engineering here is 10-111's 8h lighter than
// Power BI's would be.
//
// Manufacturing stays the single canonical 10-413 rather than
// hours-operational-grouping.ts's broader "Manufacturing" task tier (which also
// folds in Spare Parts' 90-414) — sections.ts's own comment on SECTION_ALIASES
// documents that counting 414 outside phase 10 runs ~40h/month above the figure
// the team actually signed off on.
//
// ── "Other" exists so nothing is dropped in silence ────────────────────────
//
// classifyTmHoursSection used to return null for any code outside the four
// buckets, and tm-hours.ts skipped those rows. On the range above that hid
// 589.66h — Service (80-*) 163.51h, Spare Parts (90-*) 38.76h, an entirely
// unmapped 10-400 at 323.99h, Engineering Other (10-118) 0.18h, phase-70
// leftovers, and 14.50h of malformed codes ("-311", "1-312", "5-111") whose
// phase prefix is missing or garbled in the source export.
//
// Those hours are real and they were invisible: the four cards summed to
// 14,205.63 against 15,625.41 actually punched in the range, and the page said
// nothing about the difference. `otherHours` is Power BI's own `Other Hours`
// measure by another name, and it is what makes the cards reconcile to the
// source. A number worth investigating is now on the screen instead of missing
// from it.

export type TmHoursDrillKey = "engineeringHours" | "shopHours" | "pmHours" | "manufacturingHours" | "otherHours";

export const PM_HOURS_CODE = POOL_QUOTED_SECTION.ENGINEERING_PM;
export const MANUFACTURING_HOURS_CODE = POOL_QUOTED_SECTION.SHOP_MANUFACTURING;

/** Every section code that bills as Engineering, minus PM — see the carve-out note. */
export const ENGINEERING_HOURS_CODES = new Set(
  SECTIONS.filter((s) => s.code !== PM_HOURS_CODE && billingGroupForSection(s.code) === "Engineering").map((s) => s.code),
);

/** Every section code that bills as Shop, minus Manufacturing. */
export const SHOP_HOURS_CODES = new Set(
  SECTIONS.filter((s) => s.code !== MANUFACTURING_HOURS_CODE && billingGroupForSection(s.code) === "Shop").map((s) => s.code),
);

export const ALL_TM_HOURS_CODES: readonly string[] = [
  ...ENGINEERING_HOURS_CODES,
  ...SHOP_HOURS_CODES,
  PM_HOURS_CODE,
  MANUFACTURING_HOURS_CODE,
];

/**
 * Which card a folded section code belongs to. TOTAL — every code answers
 * exactly one of the five keys, never null, which is what lets the five cards
 * add up to every hour in range.
 *
 * Order matters: PM and Manufacturing are tested before the Engineering/Shop
 * sets so the carve-out holds even if a future edit puts them back in those
 * sets.
 */
export function classifyTmHoursSection(section: string): TmHoursDrillKey {
  if (section === PM_HOURS_CODE) return "pmHours";
  if (section === MANUFACTURING_HOURS_CODE) return "manufacturingHours";
  if (ENGINEERING_HOURS_CODES.has(section)) return "engineeringHours";
  if (SHOP_HOURS_CODES.has(section)) return "shopHours";
  return "otherHours";
}

export const TM_HOURS_KEYS: readonly TmHoursDrillKey[] = [
  "engineeringHours",
  "shopHours",
  "pmHours",
  "manufacturingHours",
  "otherHours",
];

export const TM_HOURS_LABELS: Record<TmHoursDrillKey, string> = {
  engineeringHours: "Engineering Hours",
  shopHours: "Shop Hours",
  pmHours: "PM Hours",
  manufacturingHours: "Manufacturing Hours",
  otherHours: "Other Hours",
};
