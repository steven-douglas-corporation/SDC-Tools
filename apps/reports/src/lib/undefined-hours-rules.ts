// ── THE definition of Undefined Hours (§42.9) ───────────────────────────────
//
// One module, no I/O. Deliberately free of `server-only`, Prisma, `fs` and ExcelJS,
// so it can be imported by the reader, by the page, by the export, and by tests —
// and so that "the definition lives in one place" is structurally true rather than a
// convention somebody has to remember.
//
// §42.9 requires exactly this: "Document and implement one centralized definition for
// Undefined Hours. Do not calculate Undefined Hours differently in: KPI card,
// drill-through, Monthly ETC, backend API, export." Before this, the KPI summed a
// stored table and the drill re-derived the punches from the source — two
// computations that agreed only while nothing had changed since the last sync.

// ── Why a row reached no figure (§42.12) ────────────────────────────────────
//
// Every rejected punch carries exactly one of these. The old importer had a single
// unexplained bucket, which told a manager that 179 hours were wrong but nothing about
// what to correct — and correcting it means opening Paylocity and editing specific
// entries, which needs a cause.
export type UndefinedReason =
  | "MISSING_JOB_ID"
  | "JOB_NOT_FOUND"
  | "INVALID_LABOR_CODE"
  | "DEPARTMENT_NOT_MAPPED"
  | "EMPLOYEE_NOT_MAPPED"
  | "MISSING_WORK_DATE"
  | "INVALID_HOURS"
  | "DUPLICATE_RECORD"
  | "UNSUPPORTED_CATEGORY"
  | "CONTROL_TOTAL_CODE"
  | "OTHER";

// Human wording, in one place so the KPI hint, the drill's group headers, the banner
// and the export all say the same thing.
export const UNDEFINED_REASON_LABEL: Record<UndefinedReason, string> = {
  MISSING_JOB_ID: "Missing Job ID",
  JOB_NOT_FOUND: "Job Not Found",
  INVALID_LABOR_CODE: "Invalid Labor Code",
  DEPARTMENT_NOT_MAPPED: "Department Not Mapped",
  EMPLOYEE_NOT_MAPPED: "Employee Not Mapped",
  MISSING_WORK_DATE: "Missing Work Date",
  INVALID_HOURS: "Invalid Hours",
  DUPLICATE_RECORD: "Duplicate Record",
  UNSUPPORTED_CATEGORY: "Unsupported Category",
  // "990, 991, 992, 993, 998 -> TOTALS/CONTROL rows, never real punch sections" — a
  // Power BI Function Hierarchy summary row, not a real employee timesheet entry.
  // Given its own reason (2026-08-20) rather than folded into UNSUPPORTED_CATEGORY,
  // so a control/total code showing up on a punch is visibly its own, self-explaining
  // category rather than indistinguishable from a deliberately-unmodeled phase.
  CONTROL_TOTAL_CODE: "Total/Control Code",
  OTHER: "Other Mapping Error",
};

// What a manager should actually DO about each one. §42.27 asks the Undefined Hours
// drill to show "corrective data needed", and a reason code alone does not say where
// to go.
export const UNDEFINED_REASON_FIX: Record<UndefinedReason, string> = {
  MISSING_JOB_ID: "Set the job number on this punch in Paylocity.",
  JOB_NOT_FOUND: "Correct the job number in Paylocity, or add the job in Projects if it is real.",
  INVALID_LABOR_CODE: "Correct the MachineSec / Function code on this punch in Paylocity.",
  DEPARTMENT_NOT_MAPPED: "Set this employee's department on the Employees page.",
  EMPLOYEE_NOT_MAPPED: "Add this Paylocity employee id to an employee on the Employees page.",
  MISSING_WORK_DATE: "Set the work date on this punch in Paylocity.",
  INVALID_HOURS: "Correct the hours value on this punch in Paylocity.",
  DUPLICATE_RECORD: "Remove the duplicated entry in Paylocity.",
  UNSUPPORTED_CATEGORY: "No action — this phase is deliberately not modelled on the ETC grid.",
  CONTROL_TOTAL_CODE: "No action — this Function ID is a reporting total, not a real timesheet entry. If it keeps appearing, tell IT; a punch should never carry it.",
  OTHER: "Review this punch in Paylocity.",
};

// ── Which reasons COUNT toward the headline KPI ─────────────────────────────
//
// §42.9 lists ten candidate categories and then says the exact definition "must be
// confirmed from the existing application rules and current reports". The existing
// rule, which the archived reports and the signed-off KPI were built on, is narrow:
//
//     hours booked to something that is not a usable job number, whose section WOULD
//     have landed in an ETC grid column had the job number been valid.
//
// Everything else the importer rejects is rejected CORRECTLY and by design — phase
// 80/90 work the app does not model, the four Standard Fees pool sections that are
// deliberately off the grid, function 417 which Power BI drops too. Folding those into
// the headline would move a number the team signed off on, and would report correct
// exclusions as data-quality faults. 5,170h of the file is in that category; the
// headline is 568h. Merging them would be a nine-fold overstatement.
//
// So the headline keeps its definition, every other rejection is still captured and
// shown in the drill, and the two are labelled. That is what lets §42.7 ("do not
// silently drop unmatched rows") and §42.11 ("the drill-through total must exactly
// match the KPI") both hold — which they cannot if one bucket carries both.
export const KPI_COUNTED_REASONS: ReadonlySet<UndefinedReason> = new Set<UndefinedReason>([
  "MISSING_JOB_ID",
  "JOB_NOT_FOUND",
]);

// The minimum a row needs for the rules below to judge it. Kept structural rather than
// importing the reader's row type, so this module stays free of ExcelJS.
export type RejectionLike = {
  reason: UndefinedReason;
  // Set by the reader: would this punch have reached an ETC grid column, had its job
  // number been valid? A reason can be in scope while the punch still would not have
  // counted — time on an untracked section is missing from the grid whatever its job.
  countsTowardKpi: boolean;
  month: string;
  label: string;
  hours: number;
};

/** The one test. Both halves must hold: the reason is in scope AND the punch would have counted. */
export function countsAsUndefined(r: Pick<RejectionLike, "reason" | "countsTowardKpi">): boolean {
  return r.countsTowardKpi && KPI_COUNTED_REASONS.has(r.reason);
}

export type UndefinedTotal = { month: string; label: string; rows: number; hours: number };

// ── Zero-hour row filtering (by request, 2026-08-20) ────────────────────────
//
// A punch whose hours round to 0 under the same rounding the tables display (ui/format's
// `hours()`: `Math.round`) is real time, but a bare "0" beside someone's name reads as a
// bug rather than a rounding artifact, and letting it stay in the total while never
// appearing as a row would make "the total is the sum of what you can see" false. So a
// row like this is dropped from the visible list AND from every total derived from it —
// consistently with "rounding must happen BEFORE aggregation, not after" above, the
// SUMMED value stays the exact raw figure; only the visibility test is rounded.
export function roundedHoursVisible(hoursValue: number): boolean {
  return Math.round(hoursValue) !== 0;
}

/** `aggregateUndefined`, restricted to rows that will actually be shown (see above). */
export function visibleUndefinedTotals(rejected: RejectionLike[]): UndefinedTotal[] {
  return aggregateUndefined(rejected.filter((r) => roundedHoursVisible(r.hours)));
}

/**
 * Aggregate punch-level rejections into the per-month/label rows the KPI card reads.
 *
 * This is the function that makes §42.11 structural: the card's number is BY
 * CONSTRUCTION the sum of the drill's rows, because both come from this one call over
 * one array. There is no second computation left to disagree.
 */
export function aggregateUndefined(rejected: RejectionLike[]): UndefinedTotal[] {
  const by = new Map<string, UndefinedTotal>();
  for (const r of rejected) {
    if (!countsAsUndefined(r)) continue;
    const key = `${r.month}::${r.label}`;
    const cur = by.get(key) ?? { month: r.month, label: r.label, rows: 0, hours: 0 };
    cur.rows += 1;
    cur.hours += r.hours;
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => (a.month === b.month ? b.hours - a.hours : a.month.localeCompare(b.month)));
}

/** Totals for one month, as the KPI block renders them. */
export function undefinedTotalsForMonth(
  rejected: RejectionLike[],
  month: string,
): { hours: number; entries: number } {
  let hours = 0;
  let entries = 0;
  for (const r of rejected) {
    if (r.month !== month || !countsAsUndefined(r)) continue;
    hours += r.hours;
    entries += 1;
  }
  return { hours, entries };
}

// ── The reconciliation test (§42.28) ────────────────────────────────────────
//
// Pure and exported so it is pinned by a test rather than re-derived in the panel. A
// mismatch is an application fault, not a display nuance, and the drill says so in
// those terms rather than quietly showing whichever number it computed.
//
// Half a cent of an hour: both sides are Decimal(10,2) sums of the same rows, so they
// should agree exactly and anything above float dust is a real divergence.
export const RECONCILE_TOLERANCE = 0.005;

export function reconcileUndefined(detailTotal: number, kpiTotal: number): { ok: boolean; delta: number } {
  const delta = detailTotal - kpiTotal;
  return { ok: Math.abs(delta) < RECONCILE_TOLERANCE, delta };
}

/** The sentence the drill shows (§42.28). Exported so the wording is tested, not typed twice. */
export function reconciliationMessage(detailTotal: number, kpiTotal: number, unit = "hours"): string {
  const { ok, delta } = reconcileUndefined(detailTotal, kpiTotal);
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return ok
    ? `Drill-through total matches KPI: ${fmt(kpiTotal)} ${unit}`
    : `Reconciliation error: KPI shows ${fmt(kpiTotal)} ${unit}, but details total ${fmt(detailTotal)} ${unit} (${delta > 0 ? "+" : ""}${fmt(delta)})`;
}

// ── Report-month assignment (§42.6) ─────────────────────────────────────────
//
// The reporting month is the WORK DATE's month and nothing else — not the upload
// date, the file's modified date, the payroll processing date, the import date or the
// refresh date. Here as a named function so that rule has one implementation and a
// test, rather than being an inline `getMonth()` in whichever reader came first.
//
// UTC throughout: a timezone-shifted date is exactly how a punch on the 1st lands in
// the previous month.
export function reportMonthForWorkDate(workDate: Date): string {
  return `${workDate.getUTCFullYear()}-${String(workDate.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Is this work date inside the given report month? The §42.6 window, stated once. */
export function isInReportMonth(workDate: Date, month: string): boolean {
  return reportMonthForWorkDate(workDate) === month;
}
