// ── THE approved Section+Function rule book ─────────────────────────────────
//
// Requested 2026-08-21. One question, one answer, one place: given a raw
// Paylocity punch's MachineSec and Function, which standardized department does
// it belong to — and if the combination is not on the approved list, say so
// rather than guess.
//
// ── Why Section+Function and not Function alone ─────────────────────────────
//
// A Function ID being valid SOMEWHERE does not make it valid EVERYWHERE:
//
//   Section 40 + Function 311  -> Engineering   (approved)
//   Section 10 + Function 311  -> Undefined     (NOT approved)
//   Section 10 + Function 413  -> Shop          (approved)
//   Section 40 + Function 413  -> Undefined     (NOT approved)
//
// So the key is always the PAIR. Validating on Function alone is the specific
// bug this module exists to make impossible — there is deliberately no exported
// function here that accepts a bare Function ID.
//
// ── Undefined is a real answer, not a failure ───────────────────────────────
//
// An unapproved combination is classified `Undefined` and KEPT, with its raw
// Section and Function intact and its hours untouched. It is never forced into
// Engineering, Shop or PM to make a total look tidy. That is what makes the
// reconciliation identity below true by construction:
//
//   PM + Engineering + Shop + Undefined = raw Paylocity hours
//
// Standardization moves hours BETWEEN buckets; it must never create or destroy
// them. tests/paylocity-standard-rules.test.ts proves that as a property.
//
// ── What this module is NOT ─────────────────────────────────────────────────
//
// It is not sections.ts's `mapPunchToColumns`. That function answers a different
// question — "which ETC GRID COLUMN carries this punch" — and its splits/merges
// (the 10-311 30/70 split, the 413+414 merge, the 12/13/14-211 fold) encode
// signed-off grid formulas. This module answers "which DEPARTMENT is this punch",
// and does no splitting or merging at all: one punch in, one classification out,
// hours unchanged. Keeping the two separate is what lets the raw Paylocity
// PivotTable stay exactly reproducible (see rawKey) while the grid keeps its own
// measured behavior.
//
// No I/O whatsoever — pure data plus pure functions, same discipline as
// undefined-hours-rules.ts and paylocity-canonical.ts, so it imports cleanly
// into a server module, a client component, or a test with nothing to mock.

import {
  CANONICAL_FUNCTIONS,
  ENGINEERING_OTHER_DEPARTMENT,
  isTotalControlFunctionId,
  normalizeFunctionId,
} from "@/lib/paylocity-canonical";

// ── The reconciliation buckets ──────────────────────────────────────────────
//
// Deliberately only these four. They are the terms of the identity the spec
// requires (`PM + Engineering + Shop + Undefined = raw total`), so the type
// itself makes an un-reconcilable fifth bucket unrepresentable.
export const STANDARD_DEPARTMENTS = ["PM", "Engineering", "Shop"] as const;
export type StandardDepartment = (typeof STANDARD_DEPARTMENTS)[number];

export const UNDEFINED_LABEL = "Undefined" as const;

export type Department = StandardDepartment | typeof UNDEFINED_LABEL;

/** Every bucket the identity sums over — the three standard ones plus Undefined. */
export const RECONCILIATION_BUCKETS: readonly Department[] = [...STANDARD_DEPARTMENTS, UNDEFINED_LABEL];

export type MappingStatus = "Mapped" | typeof UNDEFINED_LABEL;

// ── The approved rule book, verbatim ────────────────────────────────────────
//
// Written as Section -> Function[] exactly as it was supplied, rather than
// flattened to a list of "10-211"-style strings, so that a reviewer can diff
// this against the source document line by line. `buildRuleIndex` below is what
// turns it into the lookup structure; this stays human-shaped on purpose.
//
// IMPORTANT: adding a Function ID to one Section does NOT make it valid in any
// other Section. Each list stands alone.
const APPROVED: Readonly<Record<StandardDepartment, Readonly<Record<string, readonly string[]>>>> = {
  PM: {
    "10": ["111"],
  },
  Engineering: {
    "10": ["211", "312", "313", "315", "515", "516", "517", "518"],
    "40": ["211", "311"],
    "50": ["211", "311"],
    "70": ["211", "311"],
    "80": ["211", "311"],
  },
  Shop: {
    "10": ["411", "412", "413", "414"],
    "40": ["411", "412"],
    "50": ["411", "412"],
    "70": ["411", "412"],
    "80": ["411", "412"],
  },
};

// ── Task descriptions ───────────────────────────────────────────────────────
//
// The words come from paylocity-canonical.ts, which is already THE centralized
// vocabulary for "what is Function ID X called" — so a rename there reaches this
// module's output too, rather than this file growing a second, drifting copy of
// the same labels. Only the two functions canonical does not name get an entry
// here.
//
// 315 is in the approved Engineering list above but has never been observed in
// real punch data (see SECTION_ALIASES in sections.ts, where it is likewise
// defensive-only). It is named here so that IF it ever appears it is classified
// and labelled rather than falling to Undefined on a missing label alone.
const EXTRA_TASK_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "315": "Database & Device",
};

function taskDescriptionFor(functionId: string): string {
  const extra = EXTRA_TASK_DESCRIPTIONS[functionId];
  if (extra) return extra;
  const canonical = CANONICAL_FUNCTIONS.get(functionId);
  // A function can be approved by the rule book yet unnamed by the canonical
  // vocabulary. That is a labelling gap, never grounds to reclassify the punch —
  // so the classification stands and only the words fall back to the bare ID.
  return canonical ? canonical.section : `Function ${functionId}`;
}

function functionGroupFor(functionId: string, department: StandardDepartment): string {
  const canonical = CANONICAL_FUNCTIONS.get(functionId);
  if (canonical && canonical.department !== ENGINEERING_OTHER_DEPARTMENT) return canonical.department;
  // Same reasoning as taskDescriptionFor: fall back to the coarse but always-correct
  // department rather than inventing a discipline the vocabulary has no basis for.
  return department;
}

// ── Section normalization ───────────────────────────────────────────────────
//
// The two Paylocity feeds disagree cosmetically about this cell: the punch-detail
// export writes a zero-padded label ("010 - Complete Design & Build") while
// Current_Job_Hours.xlsx writes a bare "10", and ExcelJS can hand either one back
// as a number instead of a string. All three mean Section 10, so all three must
// key the same rule. Anything that is not a clean integer — "Not Defined", blank —
// is not a Section this rule book can validate, and returns "" so that it lands
// in Undefined rather than accidentally matching a rule.
export function normalizeSectionId(raw: string | number | null | undefined): string {
  if (raw == null) return "";
  const trimmed = String(raw).trim();
  // "010 - Complete Design & Build" -> "010"; a bare "10" is unaffected.
  const leading = trimmed.split("-")[0].trim();
  if (!/^\d+$/.test(leading)) return "";
  return String(Number(leading));
}

// One flat Set of "section:function" keys, built once at module load. A Set of
// pairs rather than nested lookups so that "is this PAIR approved" is a single
// unambiguous question with no chance of a partial match on section alone.
type RuleIndex = ReadonlyMap<string, StandardDepartment>;

function buildRuleIndex(): RuleIndex {
  const index = new Map<string, StandardDepartment>();
  for (const department of STANDARD_DEPARTMENTS) {
    for (const [section, functions] of Object.entries(APPROVED[department])) {
      for (const functionId of functions) {
        const key = `${normalizeSectionId(section)}:${normalizeFunctionId(functionId)}`;
        if (index.has(key)) {
          // Two departments claiming one pair would make the reconciliation
          // identity ambiguous. Fail loudly at load rather than silently letting
          // whichever department happened to be iterated last win.
          throw new Error(
            `paylocity-standard-rules: ${key} is claimed by both ${index.get(key)} and ${department} — a Section+Function pair must have exactly one department`,
          );
        }
        index.set(key, department);
      }
    }
  }
  return index;
}

const RULE_INDEX: RuleIndex = buildRuleIndex();

/** Every approved pair, as `"section:function"`. Exposed for tests and audit reporting. */
export const APPROVED_PAIRS: ReadonlySet<string> = new Set(RULE_INDEX.keys());

export type RawPair = { rawSection: string; rawFunction: string };

/**
 * The approved raw pairs, as `{rawSection, rawFunction}` — optionally just the ones
 * belonging to one department.
 *
 * Exists for query narrowing: "show me the Undefined hours" cannot be expressed as a
 * column predicate, because Undefined is defined by ABSENCE from the rule book and the
 * set of unapproved pairs is unbounded. So a query asks for these pairs, or for
 * everything that is NOT one of them. Deriving both directions from this one list is
 * what keeps the drill-through and the KPI agreeing by construction rather than by
 * two hand-written pair lists happening to match.
 */
export function approvedRawPairs(department?: StandardDepartment): RawPair[] {
  const out: RawPair[] = [];
  for (const [key, dept] of RULE_INDEX) {
    if (department && dept !== department) continue;
    const [rawSection, rawFunction] = key.split(":");
    out.push({ rawSection, rawFunction });
  }
  return out;
}

// ── The one classification result ───────────────────────────────────────────
//
// Raw values are part of the RESULT, not merely inputs, so that a caller cannot
// hold a classification without also holding the raw punch identity it came
// from. That is what makes the audit table in the spec (raw Section, raw
// Function, standardized destination, hours, side by side) expressible without
// re-deriving anything.
export type PunchClassification = {
  /** Normalized raw Section, e.g. "10". "" when the cell was blank/non-numeric. */
  rawSection: string;
  /** Normalized raw Function, e.g. "311". "" when the cell was blank/non-numeric. */
  rawFunction: string;
  /** `"10-311"` — the raw pair, the grouping key that reproduces the Paylocity pivot. */
  rawKey: string;
  department: Department;
  functionGroup: string;
  taskDescription: string;
  mappingStatus: MappingStatus;
  /** Set only when Undefined, to explain WHY — for the drill-through, never for bucketing. */
  undefinedReason?: UndefinedRuleReason;
};

export type UndefinedRuleReason =
  /** The Section cell was blank or not a number ("Not Defined"). */
  | "MISSING_SECTION"
  /** The Function cell was blank or not a number. */
  | "MISSING_FUNCTION"
  /** A 990-993/998 report/summary row, never a real punch. */
  | "TOTAL_CONTROL_ROW"
  /** Both values are real, but the PAIR is not on the approved list. */
  | "PAIR_NOT_APPROVED";

function undefinedResult(rawSection: string, rawFunction: string, reason: UndefinedRuleReason): PunchClassification {
  return {
    rawSection,
    rawFunction,
    rawKey: `${rawSection}-${rawFunction}`,
    department: UNDEFINED_LABEL,
    functionGroup: UNDEFINED_LABEL,
    taskDescription: UNDEFINED_LABEL,
    mappingStatus: UNDEFINED_LABEL,
    undefinedReason: reason,
  };
}

/**
 * THE classifier. Every page, KPI, drill-through and export must reach a
 * department through this function and no other, so that they cannot disagree.
 *
 * Takes the raw Section and Function TOGETHER — there is no single-argument
 * variant on purpose, because validating on Function alone is the bug this
 * module prevents.
 */
export function classifyPunch(
  rawSectionInput: string | number | null | undefined,
  rawFunctionInput: string | number | null | undefined,
): PunchClassification {
  const rawSection = normalizeSectionId(rawSectionInput);
  const rawFunction = normalizeFunctionId(rawFunctionInput);

  // Checked before the approved-pair lookup so a control row is always reported
  // as a control row, never as a generic unapproved pair — the drill-through
  // needs to tell "someone booked to a summary code" apart from "this real
  // combination isn't in the rule book yet", because the fixes differ.
  if (isTotalControlFunctionId(rawFunction)) {
    return undefinedResult(rawSection, rawFunction, "TOTAL_CONTROL_ROW");
  }
  if (rawSection === "") return undefinedResult(rawSection, rawFunction, "MISSING_SECTION");
  if (rawFunction === "") return undefinedResult(rawSection, rawFunction, "MISSING_FUNCTION");

  const department = RULE_INDEX.get(`${rawSection}:${rawFunction}`);
  if (!department) return undefinedResult(rawSection, rawFunction, "PAIR_NOT_APPROVED");

  return {
    rawSection,
    rawFunction,
    rawKey: `${rawSection}-${rawFunction}`,
    department,
    functionGroup: functionGroupFor(rawFunction, department),
    taskDescription: taskDescriptionFor(rawFunction),
    mappingStatus: "Mapped",
  };
}

/**
 * Convenience for the many callers that already hold a combined `"10-211"` code
 * (JobHoursDetail.section, the drill-through filters). Splits on the FIRST
 * hyphen only, so a padded/labelled section still resolves.
 */
export function classifyPunchCode(code: string | null | undefined): PunchClassification {
  const raw = (code ?? "").trim();
  const at = raw.indexOf("-");
  if (at < 0) return classifyPunch(raw, "");
  return classifyPunch(raw.slice(0, at), raw.slice(at + 1));
}

/** True only for an approved pair. The one predicate callers should branch on. */
export function isApprovedPair(
  rawSection: string | number | null | undefined,
  rawFunction: string | number | null | undefined,
): boolean {
  return classifyPunch(rawSection, rawFunction).mappingStatus === "Mapped";
}

// ── Reconciliation ──────────────────────────────────────────────────────────

export type BucketTotals = Record<Department, number>;

export function emptyBucketTotals(): BucketTotals {
  return { PM: 0, Engineering: 0, Shop: 0, Undefined: 0 };
}

/**
 * Sum hours into the four reconciliation buckets. Every row lands in exactly one
 * bucket, so `PM + Engineering + Shop + Undefined` is the raw total by
 * construction — there is no path through this function that drops a row.
 */
export function bucketHours<T>(
  rows: readonly T[],
  getSection: (row: T) => string | number | null | undefined,
  getFunction: (row: T) => string | number | null | undefined,
  getHours: (row: T) => number,
): BucketTotals {
  const totals = emptyBucketTotals();
  for (const row of rows) {
    const { department } = classifyPunch(getSection(row), getFunction(row));
    totals[department] += getHours(row);
  }
  return totals;
}

/** `PM + Engineering + Shop + Undefined`. */
export function totalOf(totals: BucketTotals): number {
  return RECONCILIATION_BUCKETS.reduce((sum, bucket) => sum + totals[bucket], 0);
}
