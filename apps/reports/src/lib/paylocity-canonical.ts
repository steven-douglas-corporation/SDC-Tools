// ── THE canonical Paylocity Function-ID → Department/Section vocabulary ─────
//
// Requested 2026-08-20: the same underlying Paylocity function was getting a
// different department/section name depending on which page rendered it —
// "ME"/"ME Gen"/"Mechanical Engineering", "HMI"/"HMI Programming", "Panel
// Build"/"Electrical Build" for the identical code. This module is the one
// place that vocabulary lives. No I/O at all (same discipline as
// undefined-hours-rules.ts) — pure data plus pure functions, so it can be
// imported from a server module, a client component, or a test with nothing
// to mock.
//
// ── What this module is NOT ──────────────────────────────────────────────────
//
// It does not replace sections.ts's SECTIONS/HOURS_IMPORT_CODES/mapPunchToColumns,
// or hours-operational-grouping.ts's phase-aware OPERATIONAL_GROUPING. Those two
// encode real, team-confirmed, historically-measured business rules that this flat
// table cannot express on its own:
//
//   - Function 311 is never its own punch column. Phase 10's "10-311" is split
//     30%/70% into 10-312/10-313 by a documented house rule (sections.ts's
//     mapPunchToColumns); other phases fold it onto -211 instead.
//   - Functions 211/311/312/313 (and separately 411/412) MERGE into one shared
//     column once the punch is in the Machine Testing/Teardown/Warranty phase
//     (sections.ts's SECTION_ALIASES) — a single column can represent several
//     canonical Function IDs at once.
//   - The Undefined Hours KPI's headline number deliberately EXCLUDES anything
//     that isn't MISSING_JOB_ID/JOB_NOT_FOUND (undefined-hours-rules.ts's
//     KPI_COUNTED_REASONS) — a measured, signed-off narrowness, not an
//     oversight.
//
// A flat, phase-agnostic table applied naively on top of that would either lose
// the split/merge behavior or silently move already-reported historical totals.
// So this module answers one question only — "what is Function ID X actually
// called" — and every existing phase-aware structure is meant to draw its
// WORDING from here while keeping its own structure (which codes split, merge,
// or get excluded) exactly as today. See sections.ts and
// hours-operational-grouping.ts for where that wiring happens.

// ── The five canonical departments the user's table names, plus one more ───
//
// "Engineering" is not one of the five named departments — it exists ONLY for
// 112/118/119/120 below ("Engineering 'Other' codes... use one consistent
// canonical representation" — the spec asks for consistency, not for a fit
// into one of the five). Kept as its own constant so it is unmistakably a
// deliberate, centralized choice rather than an invented sixth department that
// could be confused with one of the real five.
export const CANONICAL_DEPARTMENTS = [
  // "Project Management (PM)", not "Management" (2026-09-02, by request). The
  // department and the Function-111 section share one word here, and both read
  // as "Project Management (PM)" now — abbreviated to "PM" in narrow band
  // headers by lib/abbrev.ts, which is why the long form is safe to use.
  "Project Management (PM)",
  "Mechanical Engineering",
  "Controls Engineering",
  "General Engineering",
  "Shop",
] as const;
export type CanonicalDepartment = (typeof CANONICAL_DEPARTMENTS)[number];

export const ENGINEERING_OTHER_DEPARTMENT = "Engineering" as const;

export const CANONICAL_SECTIONS = [
  "Project Management (PM)",
  "General",
  "System Design & Drawings",
  "Software",
  "HMI Programming",
  "Robot Programming",
  "Vision Programming",
  "Device Programming",
  "Mechanical Build",
  "Electrical Build",
  "Manufacturing",
] as const;
export type CanonicalSection = (typeof CANONICAL_SECTIONS)[number];

export const ENGINEERING_OTHER_SECTION = "Other" as const;

export type CanonicalFunction = {
  functionId: string; // bare Paylocity Function ID, e.g. "211" — never phase-prefixed
  department: CanonicalDepartment | typeof ENGINEERING_OTHER_DEPARTMENT;
  section: CanonicalSection | typeof ENGINEERING_OTHER_SECTION;
};

// The user's supplied table, verbatim — one row per Function ID they named.
const NAMED_FUNCTIONS: readonly CanonicalFunction[] = [
  { functionId: "111", department: "Project Management (PM)", section: "Project Management (PM)" },
  { functionId: "211", department: "Mechanical Engineering", section: "General" },
  { functionId: "311", department: "Controls Engineering", section: "General" },
  { functionId: "312", department: "Controls Engineering", section: "System Design & Drawings" },
  { functionId: "313", department: "Controls Engineering", section: "Software" },
  { functionId: "515", department: "General Engineering", section: "HMI Programming" },
  { functionId: "516", department: "General Engineering", section: "Robot Programming" },
  { functionId: "517", department: "General Engineering", section: "Vision Programming" },
  { functionId: "518", department: "General Engineering", section: "Device Programming" },
  { functionId: "411", department: "Shop", section: "Mechanical Build" },
  { functionId: "412", department: "Shop", section: "Electrical Build" },
  { functionId: "413", department: "Shop", section: "Manufacturing" },
  { functionId: "414", department: "Shop", section: "Manufacturing" },
];

// "112, 118, 119, 120 -> Engineering 'Other' — valid Engineering codes, need one
// consistent canonical name" (spec, verbatim). None of them fit one of the five
// named departments any more precisely than that, and inventing a specific one
// (Mechanical vs Controls vs General) would be a guess this module has no basis
// for — so they get their own explicit, single, centralized bucket instead. That
// bucket is exactly what "so it can be changed once later if needed" is for:
// change the two constants above, not a scattered set of literals.
const ENGINEERING_OTHER_FUNCTION_IDS = ["112", "118", "119", "120"] as const;
const ENGINEERING_OTHER_FUNCTIONS: readonly CanonicalFunction[] = ENGINEERING_OTHER_FUNCTION_IDS.map((functionId) => ({
  functionId,
  department: ENGINEERING_OTHER_DEPARTMENT,
  section: ENGINEERING_OTHER_SECTION,
}));

/** Every Function ID this module recognizes as a real, nameable function — the named ones plus Engineering "Other". */
export const CANONICAL_FUNCTIONS: ReadonlyMap<string, CanonicalFunction> = new Map(
  [...NAMED_FUNCTIONS, ...ENGINEERING_OTHER_FUNCTIONS].map((f) => [f.functionId, f]),
);

// "990, 991, 992, 993, 998 -> TOTALS/CONTROL rows, never real punch sections" —
// report/summary rows from the Power BI Function Hierarchy dimension (e.g.
// "990-Total PM", "998-Invalid"), not something a real employee timesheet punch
// should ever carry as its own Function ID. Checked BEFORE CANONICAL_FUNCTIONS
// everywhere in this module, so a code cannot be both a total and a real
// function no matter what gets added to either set later.
export const TOTAL_CONTROL_FUNCTION_IDS: ReadonlySet<string> = new Set(["990", "991", "992", "993", "998"]);

export type CanonicalResolution =
  | { kind: "function"; canonical: CanonicalFunction }
  | { kind: "total" } // a control/summary row (990-993, 998) — exclude, never a punch section
  | { kind: "unresolved" }; // missing, non-numeric, or a genuinely unrecognized Function ID

// ── Normalizing a raw Function cell ─────────────────────────────────────────
//
// Paylocity's own export puts a bare numeric-looking value here ("211", "990"),
// but a workbook cell can carry stray whitespace or (via ExcelJS) a number
// instead of a string, and "998-Invalid"/"Not Defined" style composite text
// belongs to Power BI's Function Hierarchy DIMENSION table, not a real punch's
// Function cell — so this deliberately does NOT try to parse a "code-label"
// string apart. A value that isn't a clean, non-negative integer string is not
// a Function ID this module can name; the caller's existing allow-list gating
// (sections.ts's HOURS_IMPORT_CODES) is what keeps it from being force-mapped
// into a real department either way.
export function normalizeFunctionId(raw: string | number | null | undefined): string {
  if (raw == null) return "";
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return "";
  // "0211" and "211" are the same function; Paylocity has never been observed
  // to pad these, but treating them alike costs nothing and rules out one more
  // way two files could disagree about whether a code matches.
  return String(Number(trimmed));
}

export function isTotalControlFunctionId(raw: string | number | null | undefined): boolean {
  const id = normalizeFunctionId(raw);
  return id !== "" && TOTAL_CONTROL_FUNCTION_IDS.has(id);
}

/** The one resolver. Every consumer of a bare Function ID should call this rather than re-deriving. */
export function resolveCanonicalFunction(raw: string | number | null | undefined): CanonicalResolution {
  const id = normalizeFunctionId(raw);
  if (id === "") return { kind: "unresolved" };
  if (TOTAL_CONTROL_FUNCTION_IDS.has(id)) return { kind: "total" };
  const canonical = CANONICAL_FUNCTIONS.get(id);
  return canonical ? { kind: "function", canonical } : { kind: "unresolved" };
}

/** "Mechanical Engineering" for "211", null for anything total/unresolved. */
export function canonicalDepartmentFor(raw: string | number | null | undefined): string | null {
  const r = resolveCanonicalFunction(raw);
  return r.kind === "function" ? r.canonical.department : null;
}

/** "General" for "211", null for anything total/unresolved. */
export function canonicalSectionFor(raw: string | number | null | undefined): string | null {
  const r = resolveCanonicalFunction(raw);
  return r.kind === "function" ? r.canonical.section : null;
}

/** "Mechanical Engineering / General" for "211" — the one display form nothing should hand-type. */
export function canonicalDisplayName(raw: string | number | null | undefined): string | null {
  const r = resolveCanonicalFunction(raw);
  return r.kind === "function" ? `${r.canonical.department} / ${r.canonical.section}` : null;
}

// ── Composite (phase-merged) display names ──────────────────────────────────
//
// sections.ts folds several canonical Function IDs into ONE column for the
// Machine Testing/Teardown/Warranty phases (e.g. functions 211+311+312+313 all
// land in that phase's single "-211" column). That merge is real, measured
// business behavior this module does not change — but the merged column's
// NAME should still be built from these canonical words rather than a separate
// hand-typed abbreviation, so a rename here reaches every merged column too.
// Department names are joined because the merge is coarser than "section" —
// several different canonical sections end up sharing one column.
export function joinCanonicalDepartments(functionIds: readonly string[]): string {
  const departments: string[] = [];
  for (const id of functionIds) {
    const dept = canonicalDepartmentFor(id);
    if (dept && !departments.includes(dept)) departments.push(dept);
  }
  return departments.join(" & ");
}
