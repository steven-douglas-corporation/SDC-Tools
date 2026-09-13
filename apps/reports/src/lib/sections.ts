import type { Permission } from "@/lib/permissions";
import { canonicalDepartmentFor, canonicalSectionFor } from "@/lib/paylocity-canonical";

// Fixed section-code column order, confirmed directly against the "Estimated
// Hours" tab of Project Planner Data Control.xlsx (rows 2-7: phase, section id,
// Function Group, Function Name, function id, full code). `group` is that
// sheet's "Function Group" department band — a header level between phase and
// section name. Shared by the Quoted page and the Monthly ETC grid so both use
// the identical column layout.
//
// `name`/`group` wording is DERIVED from the centralized canonical vocabulary
// (paylocity-canonical.ts, by request 2026-08-20) rather than typed here a
// second time — "ME Gen"/"HMI"/"Database & Device" and their like used to be a
// hand-typed abbreviation existing only in this file, disagreeing with the
// Hours tab's own copy of the same codes (hours-operational-grouping.ts) and
// with the Monthly ETC/Quoted pages' own hardcoded full-name tables. None of
// that changes what column a code belongs to, what it totals, or which phase
// combines with which — only the WORDS shown for it. See the module comment on
// paylocity-canonical.ts for why the underlying phase-aware structure (which
// codes split, merge, or land off-grid) stays exactly as measured/signed-off.
const _PHASE_10_FUNCTIONS = ["111", "211", "312", "313", "515", "516", "517", "518", "411", "412", "413"] as const;
// The Machine Testing/Teardown/Warranty phases fold several canonical Function
// IDs onto one shared column each (see SECTION_ALIASES below) — a genuine
// merge the flat canonical table has no opinion about at all (it is keyed on
// a bare Function ID, not on "several Function IDs sharing one column"). Kept
// as their own short, hand-typed labels rather than derived — a first attempt
// at joining the merged functions' canonical department names (2026-08-20)
// broke two ways at once, found live by an adversarial review before this
// shipped: joining 211/311/312/313 produced "Mechanical Engineering &
// Controls Engineering", 44 characters wide with no override table to catch
// it on the Quoted page's narrow leaf-column header (unlike the ETC page,
// which has its own SUBGROUP_DISPLAY); and joining 411/412 collapsed to just
// "Shop" — both canonically the same department — silently losing which two
// trades the merged column represents. "ME & CE" / "MB & EB" say more in
// less space than either canonical answer would, so they stay exactly as
// they were.
function phase10Section(functionId: (typeof _PHASE_10_FUNCTIONS)[number]): { name: string; group: string } {
  const group = canonicalDepartmentFor(functionId);
  const name = canonicalSectionFor(functionId);
  if (!group || !name) throw new Error(`sections.ts: Function ${functionId} has no canonical department/section — check paylocity-canonical.ts`);
  return { name, group };
}

// Named rather than a bare literal so callers that need to single out this one
// phase (JobHoursDashboard's default-hidden phases, e.g.) reference the same
// string SECTIONS does instead of retyping "Warranty" and risking drift.
export const WARRANTY_PHASE = "Warranty";

export const SECTIONS: { code: string; name: string; phase: string; group: string }[] = [
  { code: "10-111", ...phase10Section("111"), phase: "Complete Design & Build" },
  { code: "10-211", ...phase10Section("211"), phase: "Complete Design & Build" },
  { code: "10-312", ...phase10Section("312"), phase: "Complete Design & Build" },
  { code: "10-313", ...phase10Section("313"), phase: "Complete Design & Build" },
  { code: "10-515", ...phase10Section("515"), phase: "Complete Design & Build" },
  { code: "10-516", ...phase10Section("516"), phase: "Complete Design & Build" },
  { code: "10-517", ...phase10Section("517"), phase: "Complete Design & Build" },
  { code: "10-518", ...phase10Section("518"), phase: "Complete Design & Build" },
  { code: "10-411", ...phase10Section("411"), phase: "Complete Design & Build" },
  { code: "10-412", ...phase10Section("412"), phase: "Complete Design & Build" },
  { code: "10-413", ...phase10Section("413"), phase: "Complete Design & Build" },
  { code: "40-211", name: "ME & CE", phase: "Machine Testing", group: "Engineering" },
  { code: "40-411", name: "MB & EB", phase: "Machine Testing", group: "Shop" },
  { code: "50-211", name: "ME & CE", phase: "Teardown & Install", group: "Engineering" },
  { code: "50-411", name: "MB & EB", phase: "Teardown & Install", group: "Shop" },
  { code: "70-211", name: "ME & CE", phase: WARRANTY_PHASE, group: "Engineering" },
  { code: "70-411", name: "MB & EB", phase: WARRANTY_PHASE, group: "Shop" },
];

// Consecutive runs of the same phase, for a grouped header row's colSpans.
export const PHASE_GROUPS = SECTIONS.reduce<{ phase: string; count: number }[]>((groups, s) => {
  const last = groups[groups.length - 1];
  if (last && last.phase === s.phase) {
    last.count += 1;
  } else {
    groups.push({ phase: s.phase, count: 1 });
  }
  return groups;
}, []);

// The Monthly ETC grid tracks a narrower set than Quoted/Estimated Hours —
// confirmed by decoding the real "Managers Fill Out" sheet's header rows
// (End Of Month ETC Sheet.xlsx): it has no PM (10-111) or Manufacturing
// (10-413) column, and no Warranty phase at all. Quoted/EstimatedHours keep
// using the full SECTIONS/PHASE_GROUPS above; only the ETC page uses this.
const ETC_EXCLUDED_CODES = new Set(["10-111", "10-413", "70-211", "70-411"]);

// Billing group per section — matches the sheet's own "Total (New ETC)"
// rollup, which is a pure formula (SUM of the Engineering blocks' columns,
// separately SUM of the Shop blocks') rather than a manager-entered value.
const ENGINEERING_CODES = new Set(["10-211", "10-312", "10-313", "10-515", "10-516", "10-517", "10-518", "40-211", "50-211"]);

// The DEPARTMENTS (SECTIONS[].group, from paylocity-canonical.ts) that bill as
// Engineering. `group` is a department name, one level finer than a billing
// group — "Mechanical Engineering", "Controls Engineering" and "General
// Engineering" all bill as Engineering, and phases 40/50/70 carry the already-
// collapsed "Engineering" label.
const ENGINEERING_DEPARTMENT_GROUPS = new Set([
  "Engineering",
  "Mechanical Engineering",
  "Controls Engineering",
  "General Engineering",
]);

const SECTION_BY_CODE = new Map(SECTIONS.map((s) => [s.code, s]));

/**
 * Engineering / Shop for ANY section code — the app-wide equivalent of Power
 * BI's `'Function Hierarchy'[Billing Group]`, which its own `Engineering Hours`
 * / `Shop Hours` / `Other Hours` measures are defined on.
 *
 * Null for a code that belongs to NEITHER billing group: Management (10-111),
 * and any code with no SECTIONS row at all (Service 80-*, Spare Parts 90-*,
 * Engineering "Other" 10-112/118/119/120, and anything unmapped). Those are
 * real hours; they are just not Engineering or Shop, and a caller has to decide
 * what to do with them rather than being handed a wrong bucket by default.
 *
 * Added 2026-09-01. Callers previously had to reach for ETC_SECTIONS'
 * `billingGroup`, which answers this question only for the 13 codes the ETC
 * sheet happens to have a column for — see the T&M audit note in
 * tm-hours-classify.ts for what that silently cost.
 */
export function billingGroupForSection(code: string): "Engineering" | "Shop" | null {
  const section = SECTION_BY_CODE.get(code);
  if (!section) return null;
  if (ENGINEERING_DEPARTMENT_GROUPS.has(section.group)) return "Engineering";
  if (section.group === "Shop") return "Shop";
  return null; // Management (10-111)
}

export const ETC_SECTIONS: { code: string; name: string; phase: string; billingGroup: "Engineering" | "Shop" }[] =
  SECTIONS.filter((s) => !ETC_EXCLUDED_CODES.has(s.code)).map((s) => ({
    ...s,
    // Was `ENGINEERING_CODES.has(s.code) ? "Engineering" : "Shop"` — a
    // defaulting ternary that produced the right answer for these 13 codes only
    // because 70-211 (Warranty ME & CE, an ENGINEERING department) is excluded
    // above; un-exclude it and it would have been labelled Shop. Same result
    // for every code this list contains, from the general rule instead.
    billingGroup: billingGroupForSection(s.code) ?? (ENGINEERING_CODES.has(s.code) ? "Engineering" : "Shop"),
  }));

export const ETC_TRACKED_CODES = new Set(ETC_SECTIONS.map((s) => s.code));

// Codes whose PUNCHES the app imports — a wider set than the ETC grid displays.
//
// The two were the same set until 2026-07-31, which meant manufacturing time
// (function 414, ~834h in July) was not merely absent from the ETC grid, where it
// belongs by design, but discarded at the door: it reached no job's actual hours,
// no punch drill, nothing. A section being off the ETC sheet is a statement about
// that sheet, not about whether the hours happened.
//
// Kept OUT of ETC_TRACKED_CODES on purpose, so the Monthly ETC grid, its totals
// and its KPI cards are untouched — those are the fixed 9-code / 4-code formulas
// the team confirmed.
//
// ── PM (10-111) and Warranty (70-211/70-411) joined 2026-08-17, same reasoning ──
//
// These three were the other outstanding gap of the same shape as Manufacturing above:
// dropped at the door, present only as a company-wide Standard Fees pool figure
// (poolCategoryForPunch below), invisible to JobHoursDetail/the Hours tab and to
// JobMonthlyActualHours (Job detail's "Actual Hours by Month", the Job Hour Details
// dashboard's Engineering/Shop totals, and the Projects grid's PM/Warranty column
// coloring when unlocked). By explicit request, this mirrors the Manufacturing fix
// exactly rather than adding new isolation machinery: these three now flow into every
// place actual hours already show up, the same as 10-413 already does. The pools are
// unaffected — poolCategoryForPunch is keyed off the raw punch code independently of
// this set, so PM/Warranty keep being pool-tracked exactly as before, in addition to
// now also being per-job attributed.
export const PM_AND_WARRANTY_CODES = new Set(["10-111", "70-211", "70-411"]);

// ── Service (80-*) and Spare Parts (90-*), 2026-08-17 ───────────────────────────
//
// The two phases `mapPunchToColumns`'s own comment already named as "phases the app
// doesn't model" — no SECTIONS entry, no ETC/Quoted column, no pool, nothing. Real
// codes below are read directly off the live Current_Job_Hours.xlsx (not guessed —
// guessing risks under- or over-counting real hours), covering every MachineSec-
// Function combination actually observed under phase 80/90:
//   80: 112, 211, 311, 313, 411, 412, 414, 516
//   90: 211, 311, 411, 412, 414
//
// Kept OUT of PM_AND_WARRANTY_CODES's "everywhere" treatment on purpose. Unlike PM/
// Warranty/Manufacturing, these have no existing SECTIONS row, so JobMonthlyActualHours
// (a raw sum over every captured code) would grow while the Job Hour Details dashboard
// and Projects grid — which only ever iterate the 17 SECTIONS codes — stayed blind to
// why, a NEW reconciliation gap this app has no tolerance for. sync-actuals.ts
// excludes this exact set from the JobMonthlyActualHours rollup so only JobHoursDetail
// (and therefore the Hours tab) sees them. No aliasing/folding: each stays its own
// column here, and hours-operational-grouping.ts is what rolls several of them into
// one Function Group/Task label for display.
export const SERVICE_AND_SPARE_PARTS_CODES = new Set([
  "80-112",
  "80-211",
  "80-311",
  "80-313",
  "80-411",
  "80-412",
  "80-414",
  "80-516",
  "90-211",
  "90-311",
  "90-411",
  "90-412",
  "90-414",
]);

// ── Engineering "Other" (112, 118, 119, 120), 2026-08-20 ────────────────────
//
// The centralized Paylocity mapping audit found these four Function IDs had NO
// mapping anywhere in the app — no SECTIONS row, no alias, no
// hours-operational-grouping.ts entry — so a punch on any of them failed
// HOURS_IMPORT_CODES and was silently discarded by mapPunchToColumns: not
// flagged, not counted, not shown as a data-quality finding, just gone. Real
// occurrences were found in the live export (10-112, 10-118, 10-119; see
// docs/UNMAPPED-HOURS.md). Given the same treatment as Manufacturing/PM/
// Warranty above rather than SERVICE_AND_SPARE_PARTS_CODES's: like those, they
// have no SECTIONS row and no ETC/Quoted column (they are not part of the
// grid's team-confirmed 9/4-code formulas), so they are excluded from
// JobMonthlyActualHours exactly the way Service/Spare Parts already are (see
// sync-actuals.ts) — captured by JobHoursDetail/the Hours tab, invisible to
// nothing any more, but adding no new column to a signed-off grid.
export const ENGINEERING_OTHER_CODES = new Set(["10-112", "10-118", "10-119", "10-120"]);

export const HOURS_IMPORT_CODES = new Set([
  ...ETC_TRACKED_CODES,
  "10-413",
  ...PM_AND_WARRANTY_CODES,
  ...SERVICE_AND_SPARE_PARTS_CODES,
  ...ENGINEERING_OTHER_CODES,
]);

// ── The narrower set behind job-level ACTUAL HOURS figures (2026-08-21) ─────
//
// JobMonthlyActualHours (Job detail's "Actual Hours by Month"), the Job Hour
// Details dashboard and the Projects grid's PM/Mfg/Warranty coloring only ever
// iterate the app's SECTIONS/ETC_TRACKED_CODES columns plus the PM/Warranty pool
// codes — never Service, Spare Parts or Engineering "Other", which have no column
// on any of those three. That exclusion was previously written as "not
// SERVICE_AND_SPARE_PARTS_CODES and not ENGINEERING_OTHER_CODES", which was
// correct only because those were the only two ways a code could be outside this
// set. Now that mapPunchToColumns (above) never drops a genuinely unmapped raw
// code either, that same two-Set complement would have silently let every future
// unmapped code inflate a signed-off, job-level figure none of those three pages
// has a column to explain. Written instead as its own explicit allow-list, so
// the job-level rollups stay exactly as narrow as they were — see
// syncActualHours in sync-actuals.ts, the only place this is used.
export const JOB_DASHBOARD_HOURS_CODES: ReadonlySet<string> = new Set([...ETC_TRACKED_CODES, "10-413", ...PM_AND_WARRANTY_CODES]);

// ── Punch code -> app column ────────────────────────────────────────────────
//
// Punch codes the ETC grid has no column for, mapped onto the column they belong
// to. Derived from Power BI's OWN bucketing, probed measure by measure against
// every code in the July export (2026-07-31) rather than assumed:
//
//   [Engineering Hours]   counts functions 211, 311, 312, 313, 515-518
//   [Shop Hours]          counts functions 411, 412
//   [Manufacturing Hours] counts function  414
//   [PM Hours]            counts function  111
//
// Power BI buckets by FUNCTION regardless of phase; this app has a fixed column
// per MachineSec-Function pair. So an engineering punch in the Testing phase
// (40-311) matched no column and silently vanished — 795h in July alone, on top
// of 834h of manufacturing time booked to 10-414 while the app's Mfg column is
// coded 10-413, a code that appears nowhere in the punch data at all.
//
// Verified against the report job by job: for 1101 in July, Power BI shows
// Engineering 91 = the app's 73.62 + 40-311 (12.50) + 70-311 (5.00, warranty),
// and Manufacturing 18 = 10-414 (17.90).
//
// Warranty (70-*) is deliberately NOT aliased. Power BI folds it into
// Engineering/Shop, but the ETC grid's totals are a fixed formula over 9
// engineering and 4 shop codes that excludes the Warranty phase entirely —
// confirmed with the team 2026-07-31. Aliasing it in would silently change a
// total whose definition they had just signed off.
//
// Lives here rather than in the reader that used to own it (the now-deleted
// sharepoint-hours.ts), because it is not a property of any one FILE or feed —
// it is how a Paylocity function code becomes an app column, and every reader
// must get the same answer. A second copy is how two sources drift, which is
// exactly what happened on 2026-08-03 when a Power BI backfill wrote raw codes
// and left 27,553h stored but columnless.
// ── Materialized 2026-08-21: this table is now COMPLETE and Power BI is gone ─
//
// Until now this held nine hand-written entries and the REAL mapping came from
// Power BI's `Function Hierarchy` table at runtime (job-hours-source.ts's
// buildColumnResolver), which "won" over this table whenever the call succeeded.
// That was a correctness problem, not just a dependency:
//
//   - The resolver knew 28 fold rules; this table had 9. So whether a punch on
//     12-211 folded onto 10-211 depended on whether a network call to Power BI had
//     succeeded moments earlier. On failure the code silently fell back here and
//     bucketed hours DIFFERENTLY, with nothing in the output saying so.
//   - That made hours non-deterministic across runs, and made two refreshes of the
//     same file legitimately disagree.
//
// Hours must come only from the Paylocity Excel files, so the resolver was removed
// and its mapping materialized here — read out of production data on 2026-08-21 by
// grouping JobHoursDetail on (rawSection, rawFunction) -> section across all 12,260
// rows that carried raw identity. So these are not guesses about what the model
// meant: they are what it actually did, now frozen, explicit and reviewable.
//
// The mapping is genuinely irregular, which is why it has to be a table and cannot
// be a rule. Note in particular:
//
//   40-311 -> 40-211   but   80-311 -> 80-311   (phase 80 keeps its own -311 column)
//   12-313 -> 10-313   but   12-311 -> 12-311   (only some of phase 12 folds)
//   40-412 -> 40-411   but   80-412 -> 80-412
//   70-412 -> 70-411   but   70-413/70-414 stay themselves
//
// Anything absent from this table maps to ITSELF (see mapPunchToColumns), which is
// the safe default: the punch keeps its raw code and surfaces honestly as unmapped
// rather than being misfiled into a column it does not belong to.
export const SECTION_ALIASES: Record<string, string> = {
  // Manufacturing: the punch data uses 414, the app's column is 413.
  "10-414": "10-413",
  // ── Phases 11-18 and 25: engineering/build work booked to a phase that has no
  // column of its own, folding onto the phase-10 column for the same function.
  // Observed in production data; 11-414 lands on 10-413 for the same reason
  // 10-414 does.
  "11-211": "10-211",
  "11-414": "10-413",
  "12-211": "10-211",
  "12-312": "10-312",
  "12-313": "10-313",
  "13-211": "10-211",
  "14-211": "10-211",
  "15-211": "10-211",
  "16-211": "10-211",
  "17-211": "10-211",
  "18-211": "10-211",
  "25-211": "10-211",
  // Phase 40's engineering functions all collapse onto its single -211 column —
  // including 515/516/518, which have their own columns in phase 10 but not here.
  "40-515": "40-211",
  "40-516": "40-211",
  "40-518": "40-211",
  // Phase 70 likewise. 70-413 and 70-414 are deliberately absent: they keep their
  // own columns, unlike 10-414.
  "70-311": "70-211",
  "70-313": "70-211",
  "70-412": "70-411",
  "70-516": "70-211",
  // Defensive-only (2026-08-17): no confirmed occurrence of 315 in real data, but the
  // Database & Device row's own function list (315, 518) named it, so it's aliased here
  // rather than left to silently drop if it ever does appear — zero cost while it never
  // occurs, captures it under Database & Device the moment it does.
  "10-315": "10-518",
  // Engineering functions inside a phase whose engineering column is the -211
  // one. (10-311 is NOT here: it keeps its documented 30/70 split into
  // 10-312/10-313, which exist as their own columns.)
  "40-311": "40-211",
  "40-312": "40-211",
  "40-313": "40-211",
  "50-311": "50-211",
  "50-312": "50-211",
  "50-313": "50-211",
  // Shop functions likewise, onto the phase's -411 column.
  "40-412": "40-411",
  "50-412": "50-411",
};

// One punch's hours, resolved to the app column(s) that should carry them.
//
// ── Never drops a row for being unmapped (2026-08-21 fix) ───────────────────
//
// This used to return [] — silently discarding the hours — for any code outside
// HOURS_IMPORT_CODES (phases the app doesn't model, function 417, odd MachineSec
// values), on the reasoning that "this phase is deliberately not modelled." That
// reasoning was sound for what the ETC grid, the Job Hour Details dashboard and
// the Projects grid show (job-level, phase-scoped figures with real signed-off
// formulas), but it was being applied one level too early: mapPunchToColumns is
// also what decides whether the Hours tab's JobHoursDetail ever SEES a punch at
// all, and standardization must never gate existence. A live audit against the
// team's own Excel found this dropping real, job-attributed hours (e.g. `80-311`,
// `90-211`, and anything on a MachineSec the app has no phase for) that a manager
// could see in Paylocity but not in this app — exactly the class of bug this fix
// closes.
//
// Every recognized alias/split rule still applies exactly as before (the codes
// that split, merge, or land on a shared column are unchanged); what changed is
// only the LAST line: a code that resolves to something outside
// HOURS_IMPORT_CODES is now returned AS ITSELF — its raw, unresolved
// `${MachineSec}-${Function}` — rather than discarded. The caller (JobHoursDetail)
// stores that raw code verbatim, and hours-operational-grouping.ts already falls
// back to "Undefined / Unmapped" for any code it doesn't recognize, so an unmapped
// punch surfaces honestly instead of vanishing. Scoped, narrower consumers
// (JobMonthlyActualHours, the ETC grid's Hours Worked) filter back down to their
// own signed-off code sets themselves (see JOB_DASHBOARD_HOURS_CODES below and
// syncHoursWorked's ETC_TRACKED_CODES check) — this function's job is only to
// decide WHERE a punch's hours belong, never whether they exist.
//
// Function 417 is no longer special-cased either: Power BI also treats it as
// invalid, but that is Power BI's own scoping decision, not evidence the punch
// itself isn't real — it gets the same "keep it, mark it unmapped if it truly is"
// treatment as everything else. It essentially never carries real hours in
// practice, so this costs nothing measurable and removes one more silent-drop path.
//
// Splitting returns a LIST because 10-311 becomes two rows: design (312) takes
// 30% and software (313) 70%, per Power BI. Both halves keep the punch's
// employee, so the Hours Detail drill shows one punch as two attributed lines
// that still sum to what was booked.
// `resolve` — the model-derived code->column map (buildColumnResolver in
// job-hours-source.ts). When given, it WINS over SECTION_ALIASES below, because it
// is read from the model's own Function Hierarchy rather than reverse-engineered
// from its measures. SECTION_ALIASES stays as the fallback for when the hierarchy
// can't be fetched, and as the record of what was known before it was.
//
// The nine aliases and the resolver agree everywhere the aliases had an opinion;
// the resolver simply knows about many more codes (the 11-211..20-211 band above
// all). Verified 2026-08-03 against job 1101, where the aliases produced 149h of ME
// Gen and the report showed 634h.
export function mapPunchToColumns(
  rawSection: string,
  hours: number,
  resolve?: (rawSection: string) => string | null,
): { section: string; hours: number }[] {
  const section = resolve?.(rawSection) ?? SECTION_ALIASES[rawSection] ?? rawSection;
  if (section === "10-311") {
    return [
      { section: "10-312", hours: hours * 0.3 },
      { section: "10-313", hours: hours * 0.7 },
    ];
  }
  return [{ section, hours }];
}

// ── The inverse of mapPunchToColumns ── which RAW codes fold onto a given column? ─
//
// Needed because JobHoursDetail.section now STORES the raw pair (2026-08-21), while
// several existing filters/drill-downs are built from STANDARDIZED codes (the Hours
// page's "Sections" filter, and the reverse lookups behind the Section Name/Function
// Group/Task Description/Department Group By tiers — codesInSection/codesInTask/etc.
// in hours-operational-grouping.ts). A filter built as `section IN (these standardized
// codes)` would miss every raw pair that only reaches that code THROUGH the fold —
// raw 10-414 filtered out of a "10-413" filter, raw 12-211 filtered out of a "10-211"
// filter, raw 10-311 filtered out of a "10-312"/"10-313" filter entirely.
//
// This walks SECTION_ALIASES and the 10-311 split backwards: given the standardized
// codes a caller wants, it returns every RAW code (including the targets themselves)
// that ends up there. Built once at module load — the alias table is static.
const RAW_CODES_FOLDING_INTO = (() => {
  const inverse = new Map<string, string[]>();
  const add = (target: string, raw: string) => {
    const list = inverse.get(target);
    if (list) list.push(raw);
    else inverse.set(target, [raw]);
  };
  for (const [raw, target] of Object.entries(SECTION_ALIASES)) add(target, raw);
  add("10-312", "10-311");
  add("10-313", "10-311");
  return inverse;
})();

/**
 * Widen a list of STANDARDIZED codes to every RAW code that folds onto one of them,
 * including the codes themselves. Use this wherever a filter or drill-down narrows
 * by a standardized code list and must match against `JobHoursDetail.section`, which
 * is raw.
 */
export function rawCodesFoldingInto(standardizedCodes: readonly string[]): string[] {
  const out = new Set<string>();
  for (const code of standardizedCodes) {
    out.add(code);
    for (const raw of RAW_CODES_FOLDING_INTO.get(code) ?? []) out.add(raw);
  }
  return [...out];
}

// ── The four company-wide Standard Fees pools ──────────────────────────────
//
// The pools are not a separate universe from the sections above: they ARE the
// four sections ETC_EXCLUDED_CODES leaves off the Monthly ETC grid. PM,
// Manufacturing and both Warranty phases are planned company-wide in one pot
// rather than job by job, which is exactly why the grid has no column for them.
export type PoolCategory = "ENGINEERING_PM" | "ENGINEERING_WARRANTY" | "SHOP_MANUFACTURING" | "SHOP_WARRANTY";

export const POOL_CATEGORIES: PoolCategory[] = [
  "ENGINEERING_PM",
  "ENGINEERING_WARRANTY",
  "SHOP_MANUFACTURING",
  "SHOP_WARRANTY",
];

// The quoted-hours section each pool draws its "New Hours Added" from.
export const POOL_QUOTED_SECTION: Record<PoolCategory, string> = {
  ENGINEERING_PM: "10-111",
  ENGINEERING_WARRANTY: "70-211",
  SHOP_MANUFACTURING: "10-413",
  SHOP_WARRANTY: "70-411",
};

// The sections the Projects grid hides from anyone without the matching
// Standard Fees permission: PM, Manufacturing, Warranty Engineering and
// Warranty Shop. They appear neither as columns nor in the Sections picker
// for a role that lacks them.
//
// DERIVED from POOL_QUOTED_SECTION rather than listed again, because these are
// the same four sections that drive the Standard Fees pools — that is precisely
// why they're restricted, and a second hand-written list of the same codes is
// one that eventually disagrees with the first.
export const RESTRICTED_SECTION_CODES: ReadonlySet<string> = new Set(Object.values(POOL_QUOTED_SECTION));

// Which permission (lib/permissions.ts) governs a restricted pool's columns.
// Engineering Warranty and Shop Warranty share one permission — the spec
// names exactly three category grants (PM, Mfg, Warranty), not four — while
// PM and Manufacturing each get their own, so a future role could be given
// one without the others.
export const POOL_PERMISSION: Record<PoolCategory, Permission> = {
  ENGINEERING_PM: "standards:pm",
  SHOP_MANUFACTURING: "standards:mfg",
  ENGINEERING_WARRANTY: "standards:warranty",
  SHOP_WARRANTY: "standards:warranty",
};

const CATEGORY_BY_SECTION_CODE = new Map<string, PoolCategory>(
  Object.entries(POOL_QUOTED_SECTION).map(([category, code]) => [code, category as PoolCategory]),
);

/** The permission that gates a restricted section code, or null for a code that isn't restricted. */
export function restrictedSectionPermission(code: string): Permission | null {
  const category = CATEGORY_BY_SECTION_CODE.get(code);
  return category ? POOL_PERMISSION[category] : null;
}

// Which pool a raw punch belongs to, by MachineSec (phase) + Function.
//
// Deliberately keyed off the RAW punch codes rather than the aliased section,
// because the aliases above exist to feed the ETC grid's fixed columns and drop
// warranty entirely ("Warranty (70-*) is deliberately NOT aliased"). The pools
// need the opposite: warranty is the whole point of two of them.
//
// The buckets follow Power BI's own measure definitions as recorded above
// SECTION_ALIASES just above — [PM Hours] counts function 111,
// [Manufacturing Hours] counts 414, [Engineering Hours] counts 211/311/312/313
// and [Shop Hours] counts 411/412 — with the last two restricted to the
// Warranty phase, since that is the only phase the pools cover.
export function poolCategoryForPunch(machineSec: string, fn: string): PoolCategory | null {
  // Phase 10 only, for the two Design & Build pools. Counting function 414 in
  // every phase ran ~40h/month above the archived Manufacturing figure (measured
  // 2026-07-31 across 2026-02..2026-05), and matches the app's existing alias,
  // which maps "10-414" -> "10-413" and no other phase's 414.
  if (machineSec === "10") {
    if (fn === "111") return "ENGINEERING_PM";
    // The punch data books manufacturing to 414; 413 is the app's own column code.
    if (fn === "413" || fn === "414") return "SHOP_MANUFACTURING";
  }
  if (machineSec === "70") {
    if (fn === "211" || fn === "311" || fn === "312" || fn === "313") return "ENGINEERING_WARRANTY";
    if (fn === "411" || fn === "412") return "SHOP_WARRANTY";
  }
  return null;
}

// "Parts Cost" is a real block in the real sheet — same 5-column shape
// (Prior ETC / Money Spent Month / Money Left / New ETC / Diff) as every
// department, just in dollars instead of hours, and with no Engineering/Shop
// split (a single "Total"). Modeled as an EtcEntry row with this sentinel
// section value rather than a new table, since the shape is identical.
export const PARTS_COST_SECTION = "PARTS_COST";

/** Phase band for punch codes with no ETC/Quoted column of their own. */
export const OFF_GRID_PHASE = "Service & Spare Parts";
// Phase band for codes the approved rule book has no entry for at all — in
// practice malformed Section-Function pairs from the Paylocity export. Separate
// from OFF_GRID_PHASE because "we do not know what this is" and "this is Service
// work" are different statements, and only one of them is true here.
//
// These two live here, not in job-hours-dashboard.ts, because the client
// component JobHoursDashboard.tsx needs them as runtime values. Importing them
// from job-hours-dashboard.ts pulled that module's server data layer (prisma ->
// actual-hours -> "server-only") into the client bundle and broke `next build`.
export const UNMAPPED_PHASE = "Unmapped";
