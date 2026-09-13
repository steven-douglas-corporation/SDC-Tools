import "server-only";

import path from "path";

// ── THE centralized Paylocity source-selection service ─────────────────────
//
// Requested 2026-08-21. One place decides which workbook owns a punch, so that no
// page can independently pick a file — and, more importantly, so that no code path
// can concatenate two workbooks whose contents overlap.
//
// ── The problem this exists to make structurally impossible ────────────────
//
// The OneDrive folder holds several workbooks whose date ranges OVERLAP. Measured
// 2026-08-21:
//
//   Current_Job_Hours.xlsx        21,440 rows   65,686.78h   2026-01-01 -> 2026-08-21
//   Job_Hours_2025.xlsx           33,510 rows  101,330.70h   2025-01-06 -> 2026-01-05
//   Hours Through 20250131.xlsx      not punch rows at all — see CROSSTAB below
//
// Job_Hours_2025.xlsx runs five days INTO 2026: 191 rows / 588.20h dated 2026-01,
// of which 190 rows / 587.20h are the very same punches (same employee, date, job,
// section and function) that Current_Job_Hours.xlsx also carries. Reading both files
// and summing would therefore double-count 587.20h — real hours, silently inflated,
// and exactly the class of defect that makes the app read HIGH against a Paylocity
// pivot.
//
// Deduplicating after the fact is deliberately NOT the approach. It requires a punch
// identity that the export does not actually guarantee (two genuine punches by one
// person, on one day, to one job/section/function are indistinguishable from one
// duplicated row), so it would silently delete real hours in order to remove
// imagined ones. Instead each YEAR has exactly one authoritative file, and rows
// outside a file's owned years are dropped as it is read — before standardization,
// before aggregation, before anything can sum them.
//
// ── Why year ranges are validated rather than trusted ──────────────────────
//
// The whole guarantee rests on the ranges below being total (every year has an
// owner) and disjoint (no year has two). Both are asserted at module load, so a
// future edit that reintroduces an overlap fails immediately and loudly instead of
// quietly double-counting. Adding next year's file is a one-line change to SOURCES.

// ── Configuration ───────────────────────────────────────────────────────────
//
// JOB_HOURS_LOCAL_PATH is the pre-existing variable that pointed at the single
// current-year workbook. It is still honoured, and still wins, so no deployment has
// to change: when it is set, it supplies the current-year file's path AND the folder
// the other workbooks are looked up in. PAYLOCITY_HOURS_DIR overrides just the
// folder, for the case where the current-year file is named as normal.
const DEFAULT_DIR =
  "C:/Users/akamuju/OneDrive - Steven Douglas Corp/SDC- Power BI Integration - Job Hours Report/Job Hours From Paylocity";

/** The folder every Paylocity workbook is read from. */
export function paylocityFolder(): string {
  const explicitFile = process.env.JOB_HOURS_LOCAL_PATH?.trim();
  if (explicitFile) return path.dirname(explicitFile);
  return process.env.PAYLOCITY_HOURS_DIR?.trim() || DEFAULT_DIR;
}

export type SourceKind =
  /** One row per employee/day/job/section-function, with a Work Date. Ingestible. */
  | "punch"
  /**
   * A job x section-code matrix of LIFETIME totals — no work dates, no employee
   * ids, no punch grain. Not ingestible as punches at any fidelity; see the
   * `Hours Through 20250131.xlsx` entry below for what this means in practice.
   */
  | "job-section-crosstab";

type SourceSpec = {
  fileName: string;
  kind: SourceKind;
  /** First punch year this file owns. null = open-ended into the past. */
  fromYear: number | null;
  /** Last punch year this file owns. null = open-ended into the future. */
  toYear: number | null;
  /** Why this file owns those years, for the audit report and the refresh log. */
  note: string;
};

// ── The year -> file rule, declared once ────────────────────────────────────
//
// Ordered newest-first purely for readability; correctness comes from the ranges,
// which are validated below, not from the order.
const SOURCES: readonly SourceSpec[] = [
  {
    fileName: "Current_Job_Hours.xlsx",
    kind: "punch",
    fromYear: 2026,
    toYear: null,
    note: "the live rolling file Lisa replaces daily — authoritative for the current year and later",
  },
  {
    fileName: "Job_Hours_2025.xlsx",
    kind: "punch",
    fromYear: 2025,
    toYear: 2025,
    note: "the closed 2025 archive — authoritative for 2025 only; its 2026-01 rows are DISCARDED as they duplicate Current_Job_Hours.xlsx",
  },
  {
    fileName: "Hours Through 20250131.xlsx",
    kind: "job-section-crosstab",
    fromYear: null,
    toYear: 2024,
    // Measured 2026-08-21: two sheets ("All Job Data", 170 rows; "Old", 46 rows),
    // both a job-per-row matrix of section codes (10-211, 10-312, ...) holding
    // LIFETIME totals. There is no Work Date column and no Employee Id column
    // anywhere in it, so a punch cannot be reconstructed from it — not with reduced
    // fidelity, not at all. Synthesising a date or an employee to force it into the
    // punch pipeline would be fabricating provenance, so this source is declared
    // and then deliberately NOT ingested: pre-2025 punches have no punch-grain
    // source, and that gap is reported rather than papered over.
    note: "a job x section matrix of lifetime totals, with no work dates or employee ids — NOT punch data, cannot be ingested as punches",
  },
];

export type PaylocitySource = SourceSpec & {
  /** Absolute path, resolved against the configured folder. */
  path: string;
  ownsYear: (year: number) => boolean;
  /** "2026 and later", "2025", "2024 and earlier" — for reports. */
  ownershipLabel: string;
};

function ownershipLabel(s: SourceSpec): string {
  if (s.fromYear == null && s.toYear == null) return "all years";
  if (s.fromYear == null) return `${s.toYear} and earlier`;
  if (s.toYear == null) return `${s.fromYear} and later`;
  if (s.fromYear === s.toYear) return String(s.fromYear);
  return `${s.fromYear}-${s.toYear}`;
}

function resolvePath(s: SourceSpec): string {
  const explicitFile = process.env.JOB_HOURS_LOCAL_PATH?.trim();
  // The explicit override names the CURRENT-year file specifically (that is what it
  // always meant), so it applies only to the open-ended-future source. Every other
  // workbook is still looked up by name in the same folder.
  if (explicitFile && s.toYear == null) return explicitFile;
  // /*turbopackIgnore*/: paylocityFolder() is a runtime value (env var, or the
  // absolute OneDrive path it falls back to) pointing OUTSIDE the project, so
  // Next's build tracer can't resolve it and over-includes the whole project
  // into every route that reaches this module -- the "whole project was traced
  // unintentionally" warning. Tracing only; the join is unchanged. Same fix as
  // job-cost-inventory-sync.ts (2026-08-11) and hiring-workbook.ts.
  return path.join(/* turbopackIgnore: true */ paylocityFolder(), s.fileName);
}

// ── Validation: total and disjoint ──────────────────────────────────────────
//
// This is the entire anti-double-counting guarantee, so it runs at module load and
// throws rather than warning. A year owned twice means duplicated hours; a year
// owned by nobody means silently missing hours. Both are bugs worth refusing to
// start over.
function validate(specs: readonly SourceSpec[]): void {
  const lo = (s: SourceSpec) => s.fromYear ?? Number.NEGATIVE_INFINITY;
  const hi = (s: SourceSpec) => s.toYear ?? Number.POSITIVE_INFINITY;

  for (const s of specs) {
    if (lo(s) > hi(s)) throw new Error(`paylocity-sources: ${s.fileName} has an inverted year range`);
  }
  const sorted = [...specs].sort((a, b) => lo(a) - lo(b));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (lo(cur) <= hi(prev)) {
      throw new Error(
        `paylocity-sources: ${prev.fileName} (${ownershipLabel(prev)}) and ${cur.fileName} (${ownershipLabel(cur)}) both claim the same punch year — that would double-count hours`,
      );
    }
    if (lo(cur) > hi(prev) + 1) {
      throw new Error(
        `paylocity-sources: no file owns year${hi(prev) + 2 <= lo(cur) - 1 ? "s" : ""} ${hi(prev) + 1}${lo(cur) - 1 > hi(prev) + 1 ? `-${lo(cur) - 1}` : ""} — punches in that range would be silently missing`,
      );
    }
  }
  if (hi(sorted[sorted.length - 1]) !== Number.POSITIVE_INFINITY) {
    throw new Error("paylocity-sources: no file owns future years — next year's punches would be silently missing");
  }
  if (lo(sorted[0]) !== Number.NEGATIVE_INFINITY) {
    throw new Error("paylocity-sources: no file owns the earliest years — old punches would be silently missing");
  }
}

validate(SOURCES);

function decorate(s: SourceSpec): PaylocitySource {
  return {
    ...s,
    path: resolvePath(s),
    ownsYear: (year: number) => year >= (s.fromYear ?? Number.NEGATIVE_INFINITY) && year <= (s.toYear ?? Number.POSITIVE_INFINITY),
    ownershipLabel: ownershipLabel(s),
  };
}

/** Every declared source, ingestible or not. For the audit report. */
export function allSources(): PaylocitySource[] {
  return SOURCES.map(decorate);
}

/**
 * The sources that actually carry punches, in the order they should be read.
 * `job-section-crosstab` sources are excluded — see the Hours Through 20250131
 * entry for why they cannot be ingested as punches.
 */
export function punchSources(): PaylocitySource[] {
  return allSources().filter((s) => s.kind === "punch");
}

/** The one file authoritative for a punch year, or null if none is ingestible. */
export function sourceForYear(year: number): PaylocitySource | null {
  return allSources().find((s) => s.ownsYear(year)) ?? null;
}

/**
 * Years that have an owner on paper but no punch-grain file behind it — today,
 * everything before 2025. Surfaced so the gap is reportable instead of looking
 * like an absence of work.
 */
export function yearsWithoutPunchSource(): PaylocitySource[] {
  return allSources().filter((s) => s.kind !== "punch");
}
