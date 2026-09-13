// ── The standard Section Name -> Function Group -> Task hierarchy ──────────────
//
// A second, presentation-facing classification of the same codes `sections.ts`
// already owns (SECTIONS/HOURS_IMPORT_CODES) — but that file's `SECTIONS` table
// exists to drive the Quoted/ETC grid's actual columns, and adding phase 80/90 or
// PM/Warranty rows to it would add real columns to those grids. This module is
// the Hours tab's own reporting hierarchy, kept as a separate no-I/O table so
// touching it can never move a Quoted/ETC column, and so any Hours-adjacent
// component that later wants the same hierarchy (the ETC page's KPI drills, the
// Job Hour Details dashboard drill, Data Quality) has exactly one place to import
// it from instead of re-deriving it.
//
// One entry per code the app can now import (sections.ts's expanded
// HOURS_IMPORT_CODES, 34 codes as of 2026-08-20). A code missing from this table
// resolves to UNDEFINED_LABEL at every tier — the defensive fallback the Hours
// tab's grouping needs so a future code drift lands somewhere visible instead of
// silently joining another group's total.
//
// ── Wording sourced from the centralized canonical vocabulary (2026-08-20) ──
//
// For every SECTION-10, single-Function-ID row (the ones the user's canonical
// table names directly), `functionGroup`/`task` are now DERIVED from
// paylocity-canonical.ts rather than typed here a second time — this is exactly
// the table that used to call the same code "PM"/"Project Management" here,
// "PM" in sections.ts, and "Management" nowhere, or 10-412's `task` "Panel
// Build" while its own `department` field on the very same line called it
// "Electrical Build". `department`'s VALUES change to match (same canonical
// words), but its SHAPE does not: it still splits Section 10's Shop three ways
// and still equals `functionGroup` everywhere else, exactly as before —
// see each field's own comment below for why.
//
// Phases 40/50/70/80/90 are OUT OF SCOPE for that rename on purpose: those rows
// represent several canonical Function IDs MERGED onto one shared bucket (see
// sections.ts's SECTION_ALIASES), which the flat canonical table has no opinion
// about at all — changing their wording here would be inventing an answer, not
// applying one that was given. They keep their exact existing strings.
import { canonicalDepartmentFor, canonicalSectionFor } from "@/lib/paylocity-canonical";
import { SECTIONS } from "@/lib/sections";

function phase10Entry(sectionName: string, functionId: string, departmentOverride?: string): OperationalEntry {
  const functionGroup = canonicalDepartmentFor(functionId);
  const task = canonicalSectionFor(functionId);
  if (!functionGroup || !task) {
    throw new Error(`hours-operational-grouping.ts: Function ${functionId} has no canonical department/section`);
  }
  return { sectionNumber: "10", sectionName, functionGroup, task, department: departmentOverride ?? functionGroup };
}

export type OperationalEntry = {
  sectionNumber: string;
  sectionName: string;
  functionGroup: string;
  task: string;
  // The Hours tab's "Group By: Department" tier (2026-08-17, fix — see the
  // module header's "Department means operational" note). Deliberately its
  // OWN naming, not a re-render of `functionGroup`: for Section 10 it splits
  // Shop into Mechanical Build / Electrical Build / Manufacturing — the
  // canonical SECTION words (functionGroup collapses all three into one
  // "Shop", the canonical DEPARTMENT word) — and for Sections 40/50/70/80/90
  // it's "<Section Name> — <Engineering|Shop>" rather than the bare
  // "Engineering"/"Shop" functionGroup uses — a different, coarser-in-some-
  // places/finer-in-others cut of the same codes, by request.
  department: string;
};

export const UNDEFINED_LABEL = "Undefined / Unmapped";

// "Complete Design and Build" (Section 10) rows below are built with
// phase10Entry() rather than typed literals — see the module header. The
// SHOP rows pass a `department` override because that tier deliberately stays
// finer than `functionGroup` there (Mechanical Build / Electrical Build /
// Manufacturing, canonical's SECTION words — not "Shop" three times over).
export const OPERATIONAL_GROUPING: Record<string, OperationalEntry> = {
  // ── Complete Design and Build (10) ──────────────────────────────────────────
  "10-111": phase10Entry("Complete Design and Build", "111"),
  "10-211": phase10Entry("Complete Design and Build", "211"),
  "10-312": phase10Entry("Complete Design and Build", "312"),
  "10-313": phase10Entry("Complete Design and Build", "313"),
  "10-515": phase10Entry("Complete Design and Build", "515"),
  "10-516": phase10Entry("Complete Design and Build", "516"),
  "10-517": phase10Entry("Complete Design and Build", "517"),
  "10-518": phase10Entry("Complete Design and Build", "518"),
  "10-411": phase10Entry("Complete Design and Build", "411", canonicalSectionFor("411")!),
  "10-412": phase10Entry("Complete Design and Build", "412", canonicalSectionFor("412")!),
  "10-413": phase10Entry("Complete Design and Build", "413", canonicalSectionFor("413")!),
  // ── Engineering "Other" (112, 118, 119, 120), 2026-08-20 ────────────────────
  // Previously unmapped anywhere — see sections.ts's ENGINEERING_OTHER_CODES for
  // why they went entirely uncounted before. One consistent bucket, not a per-
  // code guess at which specific engineering discipline each belongs to.
  "10-112": phase10Entry("Complete Design and Build", "112"),
  "10-118": phase10Entry("Complete Design and Build", "118"),
  "10-119": phase10Entry("Complete Design and Build", "119"),
  "10-120": phase10Entry("Complete Design and Build", "120"),

  // ── Machine Testing (40) ─────────────────────────────────────────────────────
  "40-211": { sectionNumber: "40", sectionName: "Machine Testing", functionGroup: "Engineering", task: "ME and CE", department: "Machine Testing — Engineering" },
  "40-411": { sectionNumber: "40", sectionName: "Machine Testing", functionGroup: "Shop", task: "Builder and Electricians", department: "Machine Testing — Shop" },

  // ── Teardown and Install (50) ────────────────────────────────────────────────
  "50-211": { sectionNumber: "50", sectionName: "Teardown and Install", functionGroup: "Engineering", task: "ME and CE", department: "Teardown & Install — Engineering" },
  "50-411": { sectionNumber: "50", sectionName: "Teardown and Install", functionGroup: "Shop", task: "Builder and Electricians", department: "Teardown & Install — Shop" },

  // ── Warranty (70) ────────────────────────────────────────────────────────────
  "70-211": { sectionNumber: "70", sectionName: "Warranty", functionGroup: "Engineering", task: "ME and CE", department: "Warranty — Engineering" },
  "70-411": { sectionNumber: "70", sectionName: "Warranty", functionGroup: "Shop", task: "Builder and Electricians", department: "Warranty — Shop" },

  // ── Service (80) — real codes read off the live Paylocity export, 2026-08-17 ─
  // 112/211/311/313/516 are all engineering-shaped functions with no per-function
  // breakout requested for this phase, so they roll onto one Engineering/"ME and
  // CE" task, the same many-to-one shape 10-413/10-414 already uses for
  // Manufacturing. 411/412/414 roll onto Shop/"Builder and Electricians" likewise.
  "80-112": { sectionNumber: "80", sectionName: "Service", functionGroup: "Engineering", task: "ME and CE", department: "Service — Engineering" },
  "80-211": { sectionNumber: "80", sectionName: "Service", functionGroup: "Engineering", task: "ME and CE", department: "Service — Engineering" },
  "80-311": { sectionNumber: "80", sectionName: "Service", functionGroup: "Engineering", task: "ME and CE", department: "Service — Engineering" },
  "80-313": { sectionNumber: "80", sectionName: "Service", functionGroup: "Engineering", task: "ME and CE", department: "Service — Engineering" },
  "80-516": { sectionNumber: "80", sectionName: "Service", functionGroup: "Engineering", task: "ME and CE", department: "Service — Engineering" },
  "80-411": { sectionNumber: "80", sectionName: "Service", functionGroup: "Shop", task: "Builder and Electricians", department: "Service — Shop" },
  "80-412": { sectionNumber: "80", sectionName: "Service", functionGroup: "Shop", task: "Builder and Electricians", department: "Service — Shop" },
  "80-414": { sectionNumber: "80", sectionName: "Service", functionGroup: "Shop", task: "Builder and Electricians", department: "Service — Shop" },

  // ── Spare Parts (90) ─────────────────────────────────────────────────────────
  // sectionName/functionGroup stay flat here (no Engineering/Shop split), per
  // the original request for this section. `department` DOES split it —
  // 2026-08-17, by explicit request ("apply the same standard structure for
  // Sections 70, 80 and 90") — so this is the one tier where Spare Parts reads
  // differently depending on which dimension you picked; that's intentional,
  // not a drift between the two.
  "90-211": { sectionNumber: "90", sectionName: "Spare parts", functionGroup: "Spare parts", task: "ME and CE", department: "Spare Parts — Engineering" },
  "90-311": { sectionNumber: "90", sectionName: "Spare parts", functionGroup: "Spare parts", task: "ME and CE", department: "Spare Parts — Engineering" },
  "90-411": { sectionNumber: "90", sectionName: "Spare parts", functionGroup: "Spare parts", task: "Builder and Electricians", department: "Spare Parts — Shop" },
  "90-412": { sectionNumber: "90", sectionName: "Spare parts", functionGroup: "Spare parts", task: "Builder and Electricians", department: "Spare Parts — Shop" },
  "90-414": { sectionNumber: "90", sectionName: "Spare parts", functionGroup: "Spare parts", task: "Manufacturing", department: "Spare Parts — Shop" },
};

export function sectionNumberAndName(code: string): { sectionNumber: string; sectionName: string } {
  const e = OPERATIONAL_GROUPING[code];
  return e ? { sectionNumber: e.sectionNumber, sectionName: e.sectionName } : { sectionNumber: UNDEFINED_LABEL, sectionName: UNDEFINED_LABEL };
}

// sectionNumber -> its standard name, e.g. "10" -> "Complete Design and Build" —
// derived once from every phase OPERATIONAL_GROUPING already defines.
const SECTION_NUMBER_NAME = new Map<string, string>();
for (const e of Object.values(OPERATIONAL_GROUPING)) {
  if (!SECTION_NUMBER_NAME.has(e.sectionNumber)) SECTION_NUMBER_NAME.set(e.sectionNumber, e.sectionName);
}

// ── The Hours tab's "Group By: Section" (raw-preserving) ───────────────────
//
// Deliberately a SEPARATE function from sectionNumberAndName above, not a shared
// helper with an extra flag: that one backs "Group By: Section Name" (and the
// filter menu's/export's section-name lookups), which — signed off 2026-08-17 and
// pinned by its own tests — collapses every code the standard mapping has never
// seen into one shared "Undefined / Unmapped" bucket. That collapsing is correct
// for a coarse, named-group tier where several raw codes always shared one bucket
// by design anyway. "Group By: Section" is different: the ticket that added it
// requires an unrecognized SECTION NUMBER to keep its own raw identity ("25 —
// Unmapped Section"), not merge with every other unrecognized section number into
// one indistinguishable row — so this reads the section number straight off the
// raw code's own shape (`${sectionNumber}-${functionId}`) rather than off
// OPERATIONAL_GROUPING, and only consults the lookup above for the DISPLAY NAME of
// a section number that turns out to be one of the standard ones.
export function rawSectionNumberAndName(code: string): { sectionNumber: string; sectionName: string } {
  const sectionNumber = code.split("-")[0]?.trim();
  if (!sectionNumber) return { sectionNumber: UNDEFINED_LABEL, sectionName: UNDEFINED_LABEL };
  return { sectionNumber, sectionName: SECTION_NUMBER_NAME.get(sectionNumber) ?? "Unmapped Section" };
}

export function functionGroupFor(code: string): string {
  return OPERATIONAL_GROUPING[code]?.functionGroup ?? UNDEFINED_LABEL;
}

export function taskFor(code: string): string {
  return OPERATIONAL_GROUPING[code]?.task ?? UNDEFINED_LABEL;
}

// ── The one section-code -> display-name lookup (2026-08-20) ───────────────
//
// Five files each hand-copied `new Map(SECTIONS.map(s => [s.code, s.name]))` —
// off-grid-hours.ts, tm-hours.ts, data-quality-actions.ts, job-hours-detail.ts,
// jobs/[id]/page.tsx — plus hours-explorer.ts's own slightly fuller version
// (SECTIONS name, else this module's `task` for a code SECTIONS doesn't cover).
// This is that fuller version, exported once so every one of those reads THE
// same name for a raw section code instead of a raw code or a blank cell for
// anything off the 17-column ETC/Quoted grid.
export function sectionDisplayName(code: string): string {
  return SECTIONS.find((s) => s.code === code)?.name ?? taskFor(code);
}

// The Hours tab's "Group By: Department" — see OperationalEntry.department's
// own comment for why this is a distinct tier from `functionGroup`, not an
// alias for it. This is the ONLY thing "Department" is allowed to mean for
// that Group By dimension — never `Employee.department` (the HR/Paylocity
// field), which stays available as its own, separate FILTER
// (HoursFilters.departments / getHoursFilterOptions) and nothing else. A
// second grouping path built on that field is exactly how this regressed
// once already (2026-08-17).
export function departmentFor(code: string): string {
  return OPERATIONAL_GROUPING[code]?.department ?? UNDEFINED_LABEL;
}

// ── "Group By: Function" does NOT live here (removed 2026-08-21) ───────────
//
// This module held `functionIdFor(code)` and `functionLabelFor(code)`, which read a
// Function ID off a `${section}-${function}` string. They were deleted along with their
// only caller.
//
// The problem was not the functions — it was what they were being GIVEN. Every caller
// passed `JobHoursDetail.section`, the STANDARDIZED column, in which 10-414 has been
// folded onto 10-413 (and 12/13/14-211 onto 10-211). So "Group By: Function" produced a
// group keyed and labelled `413` whose detail rows carried raw Function 414 — parent and
// children disagreeing, which looks like a data bug and cannot be diagnosed from the UI.
//
// Function and Section grouping now read the dedicated `rawFunction`/`rawSection`
// columns, via rollupByRawTier in hours-filters.ts. These two helpers are gone rather
// than merely left unused, because a helper that accepts either a raw or a standardized
// code and cannot tell them apart is a trap: the next caller has no way to know which
// one it is holding. If you need a Function ID, read `rawFunction`.
//
// The standardized tiers that remain in this module (Section Name, Function Group, Task
// Description, Department) are reporting categories and are MEANT to combine many raw
// values — they legitimately read the standardized code.

// ── Reverse lookups, for narrowing a group-by tree node ─────────────────────────
//
// Built once at module load. "sectionName" narrows on sectionNumber (the stable
// key — two sections could in principle share a display name; numbers can't
// collide), "functionGroup"/"task"/"department" narrow on the label itself,
// deliberately spanning every section that uses it (e.g. "Engineering" rolls up
// Machine Testing + Teardown + Warranty + Service together when Function Group
// is picked with nothing narrower above it) — which is exactly what lets "how
// many total Engineering hours across every phase" be answered by picking one
// dimension alone.
function buildReverseIndex<K extends keyof OperationalEntry>(key: K): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [code, entry] of Object.entries(OPERATIONAL_GROUPING)) {
    const value = entry[key];
    const codes = index.get(value) ?? [];
    codes.push(code);
    index.set(value, codes);
  }
  return index;
}

const CODES_BY_SECTION_NUMBER = buildReverseIndex("sectionNumber");
const CODES_BY_FUNCTION_GROUP = buildReverseIndex("functionGroup");
const CODES_BY_TASK = buildReverseIndex("task");
const CODES_BY_DEPARTMENT = buildReverseIndex("department");

export function codesInSection(sectionNumber: string): string[] {
  return CODES_BY_SECTION_NUMBER.get(sectionNumber) ?? [];
}

export function codesInFunctionGroup(functionGroup: string): string[] {
  return CODES_BY_FUNCTION_GROUP.get(functionGroup) ?? [];
}

export function codesInTask(task: string): string[] {
  return CODES_BY_TASK.get(task) ?? [];
}

export function codesInDepartment(department: string): string[] {
  return CODES_BY_DEPARTMENT.get(department) ?? [];
}

// ── Fixed business order for "Group By: Department" (2026-08-17) ───────────
//
// Not sorted by hours, not alphabetical — the same left-to-right reading
// order as the "Estimate to Complete" reference sheet's own layout: each
// Section 10 function group in its column order (Management, Mechanical
// Engineering, Controls Engineering, General Engineering, Engineering
// "Other", then Shop split into its three trades), then each later phase in
// sequence, Engineering before Shop within a phase, ending with Spare Parts.
// `UNDEFINED_LABEL` is deliberately absent from this list — see
// `departmentOrderRank` below — so it always sorts after every real
// department, never accidentally slotted in the middle by an edit here.
//
// "Project Management"/"Manufacturing Operations" -> "Project Management (PM)"/
// "Manufacturing": wording only, matching the centralized canonical vocabulary
// — see phase10Entry above. (The first of those two became "Management" in
// 2026-08-20 and "Project Management (PM)" on 2026-09-02.) Every other entry, and the
// list's own shape, is unchanged.
export const DEPARTMENT_ORDER: string[] = [
  // Renamed 2026-09-02 with the canonical vocabulary — this list is `string[]`,
  // so a stale entry would not fail the build, it would just silently sort
  // Project Management last (see departmentOrderRank).
  "Project Management (PM)",
  "Mechanical Engineering",
  "Controls Engineering",
  "General Engineering",
  "Engineering",
  "Mechanical Build",
  "Electrical Build",
  "Manufacturing",
  "Machine Testing — Engineering",
  "Machine Testing — Shop",
  "Teardown & Install — Engineering",
  "Teardown & Install — Shop",
  "Warranty — Engineering",
  "Warranty — Shop",
  "Service — Engineering",
  "Service — Shop",
  "Spare Parts — Engineering",
  "Spare Parts — Shop",
];

const DEPARTMENT_RANK = new Map(DEPARTMENT_ORDER.map((d, i) => [d, i]));

// A department NOT in the fixed list — today that's only `UNDEFINED_LABEL`,
// since every real code the app imports resolves to one of the list above —
// ranks after all of them, so it reads at the bottom of any department-
// ordered list without needing its own special-cased position in the array.
export function departmentOrderRank(department: string): number {
  return DEPARTMENT_RANK.get(department) ?? Number.MAX_SAFE_INTEGER;
}
