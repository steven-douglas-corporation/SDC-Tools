// ── One definition per editable cell, for the whole application (§27) ────────
//
// Until this file, every editable column in the app validated itself. Eight action
// modules each carried some shape of
//
//     const n = Number(raw);
//     if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${field} "${raw}".`);
//
// and no two of them agreed. Measured across the codebase before this was written:
//
//   * New ETC (parseNewEtcField)      — bare Number(). REJECTED "1,234" and "$1,234".
//   * Parts Cost Quoted (parseMoney)  — stripped "$", spaces and commas. ACCEPTED them.
//   * Quoted hours (quoted-actions)   — Number.isInteger, so "8.0" was refused.
//   * Pool cells (standard-sheet)     — Number.isFinite && >= 0, silently kept the
//                                       stored value on blank.
//   * Contingency / rates / jobtask   — three more spellings of the same check.
//
// So the same figure, pasted out of the same Excel column, was valid in one cell of
// the grid and invalid in the next — and each cell explained itself differently, or
// (mostly) not at all. That is what §27.2/§27.3/§27.15 are about, and it cannot be
// fixed one column at a time: the fix has to be a place where the rule for a cell is
// WRITTEN DOWN, that both the browser and the server read.
//
// This file is that place. It holds:
//
//   * FieldSpec       — the rule for one cell: type, required, min/max, precision,
//                       and whether zero, negatives and blanks are allowed.
//   * CELL_SPECS      — every editable cell in the app, by id.
//   * parseCell()     — THE parser. One normalisation pipeline (Excel paste, currency
//                       symbols, thousands separators, accounting negatives, stray
//                       spaces) and one set of outcomes.
//   * expectationText — the rule as a sentence, so an invalid cell can say what it
//                       wanted instead of "invalid value".
//   * roundTo()       — the rounding every layer shares (§27.18).
//
// Deliberately dependency-free: no React, no Prisma, no `@/` imports. The server
// actions import it, the client cells import it, and `tsx --test` loads it directly.
// A rule that exists in two places is a rule that will eventually disagree with
// itself, which is the entire lesson of the list above.

// ── Rounding, once (§27.18) ─────────────────────────────────────────────────
//
// `Math.round(n * 100) / 100` is what the app used, and it is subtly wrong: 1.005
// is stored as 1.00499999999999989, so `1.005 * 100` is 100.49999999999999 and it
// rounds DOWN to 1.00. A cent, but the wrong cent, and inconsistently — 2.675 has
// the same problem while 2.665 does not.
//
// Round-tripping through the decimal string representation avoids it: `Number("1.005e2")`
// is exactly 100.5, which rounds to 101, which comes back as 1.01. Falls back to the
// naive form for values where the exponent trick cannot apply (Infinity, NaN, and the
// exponential-notation range beyond ~1e21), which are rejected by parseCell anyway.
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  if (decimals <= 0) {
    // Same string round-trip, so -0.5 and 0.5 round consistently with the fractional case.
    const shifted = Number(`${value}e0`);
    return Math.round(shifted);
  }
  const shifted = Number(`${value}e${decimals}`);
  if (!Number.isFinite(shifted)) return Math.round(value * 10 ** decimals) / 10 ** decimals;
  const rounded = Math.round(shifted);
  const back = Number(`${rounded}e-${decimals}`);
  return Number.isFinite(back) ? back : rounded / 10 ** decimals;
}

// The app's two long-standing precisions, named so call sites read as intent.
export const HOURS_DECIMALS = 0; // hours display AND submit as whole numbers
export const MONEY_DECIMALS = 2; // parts cost is money and keeps its cents

// ── What a cell is ──────────────────────────────────────────────────────────

export type CellKind =
  | "wholeNumber"
  | "decimal"
  | "currency"
  // Stored as a FRACTION (0.2 = 20%) but typed either way; see parseCell.
  | "percent"
  // A multiplier like partsMarkup (1.2) or contingencyRate — a bare decimal that is
  // conventionally > 0 and is NOT a percentage of anything.
  | "rate"
  | "date"
  | "text"
  | "select";

export type FieldSpec = {
  // Stable id. Namespaced by tab so two "New ETC" columns in different units cannot
  // collide — which they genuinely are: hours and dollars.
  id: string;
  // Which surface this cell lives on, for validation messages that have to name the
  // affected tab (§27.9, §27.20).
  tab: string;
  label: string;
  kind: CellKind;
  // false = calculated or display-only. A calculated field is never written from a
  // browser payload; `formula` records where its value comes from instead.
  editable: boolean;
  formula?: string;
  // Must hold a value before the month can be SUBMITTED. Distinct from allowBlank,
  // which is about whether a blank may be SAVED — New ETC is both (you may save it
  // blank all month; you may not submit the month that way).
  requiredForSubmit?: boolean;
  allowBlank: boolean;
  allowZero: boolean;
  allowNegative: boolean;
  min?: number;
  max?: number;
  // Decimal places STORED. Values are rounded to this on the way in, so what is
  // displayed, what is stored, what is totalled and what is submitted are one figure.
  decimals: number;
  options?: readonly string[];
  // Free-text note about a conditional rule (§27.2's "depends on project status,
  // month, department, or another condition"). Carried so the rule is visible next to
  // the field rather than only in whichever action enforces it.
  condition?: string;
};

// ── Every editable cell in the app ──────────────────────────────────────────
//
// Grouped by the surface it appears on. A cell that is NOT here is a cell whose rule
// is still written inline somewhere, which is the thing this registry exists to make
// visible — so the list being incomplete is a fact about the app, not a bug in the
// file. See CELL_SPEC_COVERAGE at the bottom.

export const CELL_SPECS = {
  // ── Monthly ETC ───────────────────────────────────────────────────────────
  "etc.newEtc.hours": {
    id: "etc.newEtc.hours",
    tab: "Monthly ETC",
    label: "New ETC",
    kind: "wholeNumber",
    editable: true,
    // Blank is legal and MEANINGFUL: it is "no decision yet", which is what paints
    // the cell yellow. It is not legal at submission time — see requiredForSubmit and
    // isNewEtcDecisionRequired in lib/etc.ts, which adds the "only if hours were
    // booked" half of the condition.
    allowBlank: true,
    requiredForSubmit: true,
    // Zero is a real plan ("nothing further for this section") and treating it as
    // blank was a live bug. See hasNewEtcValue.
    allowZero: true,
    allowNegative: false,
    min: 0,
    decimals: HOURS_DECIMALS,
    condition: "Required before submitting only when hours were booked to the cell this month.",
  },
  "etc.newEtc.parts": {
    id: "etc.newEtc.parts",
    tab: "Monthly ETC",
    label: "Parts Cost New ETC",
    kind: "currency",
    editable: true,
    allowBlank: true,
    requiredForSubmit: true,
    allowZero: true,
    allowNegative: false,
    min: 0,
    decimals: MONEY_DECIMALS,
    condition: "Required before submitting only when money was spent on the cell this month.",
  },
  "etc.priorEtc": {
    id: "etc.priorEtc",
    tab: "Monthly ETC",
    label: "Prior ETC",
    kind: "decimal",
    editable: false,
    formula: "Previous month's New ETC for this job/section, or the job's quote when it starts this month (priorEtcForMonth).",
    allowBlank: false,
    allowZero: true,
    allowNegative: true,
    decimals: MONEY_DECIMALS,
  },
  "etc.hoursWorked": {
    id: "etc.hoursWorked",
    tab: "Monthly ETC",
    label: "Hours Worked Month",
    kind: "decimal",
    editable: false,
    formula: "Summed from the Paylocity punch export for the month (syncHoursWorked).",
    allowBlank: false,
    allowZero: true,
    // PARTS_COST stores MONEY in this column and a credit note is genuinely negative.
    allowNegative: true,
    decimals: MONEY_DECIMALS,
    condition: "Negative only for the Parts Cost section, where the column holds money.",
  },
  "etc.hoursLeft": {
    id: "etc.hoursLeft",
    tab: "Monthly ETC",
    label: "Hours Left",
    kind: "decimal",
    editable: false,
    formula: "Prior ETC − Hours Worked Month (calcHoursLeft). Not clamped: a section can be overspent.",
    allowBlank: false,
    allowZero: true,
    allowNegative: true,
    decimals: MONEY_DECIMALS,
  },
  "etc.diff": {
    id: "etc.diff",
    tab: "Monthly ETC",
    label: "Diff",
    kind: "decimal",
    editable: false,
    formula: "Hours Left − max(New ETC, 0), and exactly 0 for a cell nobody has decided (newEtcDiff).",
    allowBlank: false,
    allowZero: true,
    allowNegative: true,
    decimals: MONEY_DECIMALS,
  },

  // ── Standard Fees card / Standard Card ────────────────────────────────────
  "pool.hoursPulled": {
    id: "pool.hoursPulled",
    tab: "Standard Card",
    label: "Hours being pulled this month",
    kind: "wholeNumber",
    editable: true,
    // A blank here means "keep what is stored" rather than "write 0" — a wiped field
    // mid-edit must not collapse the department's fee. Kept as the documented rule.
    allowBlank: true,
    allowZero: true,
    allowNegative: false,
    min: 0,
    decimals: 0,
    condition: "Blank leaves the stored value untouched; an explicit 0 is saveable.",
  },
  "pool.rate": {
    id: "pool.rate",
    tab: "Standard Card",
    label: "Rate",
    kind: "currency",
    editable: true,
    allowBlank: true,
    allowZero: true,
    allowNegative: false,
    min: 0,
    decimals: MONEY_DECIMALS,
    condition: "Blank leaves the stored value untouched — a 0 rate collapses the department's Standard Fee.",
  },
  "pool.newEtcHours": {
    id: "pool.newEtcHours",
    tab: "Standard Card",
    label: "New ETC Hours",
    kind: "decimal",
    editable: false,
    formula: "Hours Available − Hours being pulled this month.",
    allowBlank: false,
    allowZero: true,
    allowNegative: true,
    decimals: MONEY_DECIMALS,
  },
  "pool.standardFee": {
    id: "pool.standardFee",
    tab: "Standard Card",
    label: "Standard Fee",
    kind: "currency",
    editable: false,
    formula: "New ETC Hours × Rate.",
    allowBlank: false,
    allowZero: true,
    allowNegative: true,
    decimals: MONEY_DECIMALS,
  },

  // ── Standard Sheet (per-job fee row) ──────────────────────────────────────
  "standard.engrRate": {
    id: "standard.engrRate",
    tab: "Standard Sheet",
    label: "Engineering Rate",
    kind: "currency",
    editable: true,
    allowBlank: false,
    allowZero: false,
    allowNegative: false,
    min: 0,
    decimals: MONEY_DECIMALS,
  },
  "standard.shopRate": {
    id: "standard.shopRate",
    tab: "Standard Sheet",
    label: "Shop Rate",
    kind: "currency",
    editable: true,
    allowBlank: false,
    allowZero: false,
    allowNegative: false,
    min: 0,
    decimals: MONEY_DECIMALS,
  },
  "standard.partsMarkup": {
    id: "standard.partsMarkup",
    tab: "Standard Sheet",
    label: "Parts Markup",
    kind: "rate",
    editable: true,
    allowBlank: false,
    allowZero: false,
    allowNegative: false,
    min: 0,
    decimals: 4,
  },
  "standard.contingencyRate": {
    id: "standard.contingencyRate",
    tab: "Standard Sheet",
    label: "Contingency Rate",
    kind: "rate",
    editable: true,
    allowBlank: false,
    allowZero: true,
    allowNegative: false,
    min: 0,
    decimals: 4,
  },
  "standard.contingencyAmount": {
    id: "standard.contingencyAmount",
    tab: "Standard Sheet",
    label: "Contingency",
    kind: "currency",
    editable: true,
    allowBlank: true,
    allowZero: true,
    allowNegative: false,
    min: 0,
    decimals: MONEY_DECIMALS,
  },
  "standard.notes": {
    id: "standard.notes",
    tab: "Standard Sheet",
    label: "Notes",
    kind: "text",
    editable: true,
    allowBlank: true,
    allowZero: true,
    allowNegative: true,
    decimals: 0,
  },
  "standard.totalEtcDollars": {
    id: "standard.totalEtcDollars",
    tab: "Standard Sheet",
    label: "Total ETC $",
    kind: "currency",
    editable: false,
    formula: "Execution ETC engineering×engrRate + shop×shopRate + parts×partsMarkup (calcTotalEtcDollars).",
    allowBlank: false,
    allowZero: true,
    allowNegative: true,
    decimals: MONEY_DECIMALS,
  },
  "standard.percentOfTotal": {
    id: "standard.percentOfTotal",
    tab: "Standard Sheet",
    label: "% Total",
    kind: "percent",
    editable: false,
    formula: "This job's Total ETC $ ÷ the grand total, or 0 when the grand total is 0 (calcPercentOfTotal).",
    allowBlank: false,
    allowZero: true,
    allowNegative: true,
    decimals: 6,
  },
  "standard.totalStandardFees": {
    id: "standard.totalStandardFees",
    tab: "Standard Sheet",
    label: "Total Standard Fees",
    kind: "currency",
    editable: false,
    formula: "Total ETC $ + Standard Fee Eng + Standard Fee Shop + Contingency × Contingency Rate (calcTotalStandardFees).",
    allowBlank: false,
    allowZero: true,
    allowNegative: true,
    decimals: MONEY_DECIMALS,
  },

  // ── Projects ──────────────────────────────────────────────────────────────
  "projects.quotedHours": {
    id: "projects.quotedHours",
    tab: "Projects",
    label: "Quoted Hours",
    kind: "wholeNumber",
    editable: true,
    // Blank means zero here, historically — an unquoted section. Kept.
    allowBlank: true,
    allowZero: true,
    allowNegative: false,
    min: 0,
    decimals: 0,
    condition: "Blank is stored as 0 (an unquoted section), and a 0 creates no row.",
  },
  "projects.costQuoted": {
    id: "projects.costQuoted",
    tab: "Projects",
    label: "Parts Cost Quoted",
    kind: "currency",
    editable: true,
    // Blank is NULL, not 0: "nobody has quoted parts for this job" is different from
    // "parts were quoted at nothing", and the ETC seed reads the two differently.
    allowBlank: true,
    allowZero: true,
    allowNegative: false,
    min: 0,
    decimals: MONEY_DECIMALS,
    condition: "Blank stores NULL (never quoted), which is not the same as 0.",
  },
  "projects.costActualHistorical": {
    id: "projects.costActualHistorical",
    tab: "Projects",
    label: "Parts Cost Actual",
    kind: "currency",
    editable: true,
    allowBlank: true,
    allowZero: true,
    allowNegative: false,
    min: 0,
    decimals: MONEY_DECIMALS,
  },
  "projects.startDate": {
    id: "projects.startDate",
    tab: "Projects",
    label: "Start Date",
    kind: "date",
    editable: true,
    allowBlank: true,
    allowZero: true,
    allowNegative: false,
    decimals: 0,
    condition: "Drives which month a job's quoted hours enter the department pools.",
  },
  "projects.completeDate": {
    id: "projects.completeDate",
    tab: "Projects",
    label: "Complete Date",
    kind: "date",
    editable: true,
    allowBlank: true,
    allowZero: true,
    allowNegative: false,
    decimals: 0,
  },

  // ── Job detail ────────────────────────────────────────────────────────────
  "jobtask.hours": {
    id: "jobtask.hours",
    tab: "Project detail",
    label: "Task Hours",
    kind: "wholeNumber",
    editable: true,
    allowBlank: true,
    allowZero: true,
    allowNegative: false,
    min: 0,
    decimals: 0,
    condition: "Blank is stored as 0.",
  },
} as const satisfies Record<string, FieldSpec>;

export type CellSpecId = keyof typeof CELL_SPECS;

export function specFor(id: CellSpecId): FieldSpec {
  return CELL_SPECS[id];
}

// Every cell whose rule this registry owns, and every cell that is calculated. Used
// by the coverage test, which is what stops the registry quietly falling behind the
// app it describes.
// Widened to FieldSpec deliberately. `as const satisfies` above is what keeps each
// literal honest against the type; here the values are ITERATED, and the narrow
// literal union would make every `spec.kind === "select"` check a compile error on
// the grounds that this particular spec's kind is known to be something else.
export const ALL_SPECS: FieldSpec[] = Object.values(CELL_SPECS);
export const EDITABLE_SPECS: FieldSpec[] = ALL_SPECS.filter((s) => s.editable);
export const CALCULATED_SPECS: FieldSpec[] = ALL_SPECS.filter((s) => !s.editable);

// ── What a parsed cell means (§27.10) ───────────────────────────────────────
//
// The four outcomes are genuinely different things, and collapsing any two of them
// is how "clearing a value did not stick" happens:
//
//   absent  — the field was not in the request. This save has NO OPINION about the
//             cell: it was filtered out of the view, or nobody touched it. Leave the
//             stored value exactly as it is.
//   clear   — the field IS present and empty. Somebody deliberately emptied a box.
//             That is an edit and must be persisted as one.
//   value   — a finite number (or a string, for text/select/date), INCLUDING 0.
//   invalid — present, non-empty, and not something this cell accepts. Never written,
//             never coerced to 0 or to the previous value, and never fed to a
//             dependent calculation (§27.9).
export type InvalidCode =
  | "notANumber"
  | "notWhole"
  | "negative"
  | "zero"
  | "belowMin"
  | "aboveMax"
  | "notAnOption"
  | "notADate"
  | "blankRequired";

export type CellWriteIntent<T = number | string> =
  | { kind: "absent" }
  | { kind: "clear" }
  | { kind: "value"; value: T }
  | { kind: "invalid"; raw: string; code: InvalidCode; message: string };

// ── Normalising what a human (or Excel) actually types ──────────────────────
//
// Everything §27.3 lists, in one place:
//
//   "$1,234.50"    currency symbol + thousands separators
//   " 1 234 "      stray spaces, including the non-breaking and narrow-nbsp ones
//                  Excel and Windows locales paste
//   "(1,234)"      ACCOUNTING NEGATIVE. Excel's default currency format renders
//                  negatives in parentheses, so this is what a pasted negative
//                  actually looks like — and a bare Number() reads it as NaN.
//   "1,234-"       trailing-minus, from some ERP exports
//   "20%"          a percentage, for a percent-kind cell
//   "1.234,56"     NOT handled. European grouping is genuinely ambiguous against
//                  "1.234" meaning one-point-two-three-four, and guessing would
//                  silently change a figure by a factor of a thousand. It is
//                  rejected, loudly, which is the safe direction.
//
// Anything else still fails rather than being coerced: stripping is limited to
// currency and grouping punctuation.
const CURRENCY_AND_GROUPING = /[$\u00a3\u20ac\u00a5\s\u00a0\u202f\u2009]/g;
// A well-formed thousands-grouped number: 1-3 digits, then groups of exactly 3.
const GROUPED = /^\d{1,3}(,\d{3})+(\.\d+)?$/;

function normaliseNumeric(input: string, kind: CellKind): { text: string; negated: boolean; percent: boolean } | null {
  let text = input.trim();
  let negated = false;
  let percent = false;

  // Accounting parentheses, before anything else strips the brackets.
  const paren = /^\((.*)\)$/.exec(text);
  if (paren) {
    negated = true;
    text = paren[1];
  }
  if (kind === "percent" && text.endsWith("%")) {
    percent = true;
    text = text.slice(0, -1);
  }
  // Currency symbols and every flavour of space — but NOT commas, whose position has
  // to be judged before they can be removed (see below).
  text = text.replace(CURRENCY_AND_GROUPING, "");
  // Trailing minus, as some ERP exports emit.
  if (text.endsWith("-")) {
    negated = !negated;
    text = text.slice(0, -1);
  }
  if (text.startsWith("-")) {
    negated = !negated;
    text = text.slice(1);
  }
  // A leading + is harmless and people paste it.
  if (text.startsWith("+")) text = text.slice(1);
  if (text === "") return null;

  // ── Commas: a thousands separator, or a decimal point? ────────────────────
  //
  // This has to be decided BEFORE they are stripped, and getting it wrong changes a
  // figure by a factor of a thousand. Stripping unconditionally — which is what the
  // app's existing parseMoney does — turns the European "1.234,56" into "1.23456":
  // a number, accepted silently, and wrong.
  //
  // Two refusals rather than two guesses:
  //   * a comma AFTER the last dot means the comma IS the decimal separator, so the
  //     string is European and genuinely ambiguous against "1.234" meaning one point
  //     two three four;
  //   * a comma that is not part of proper 3-digit grouping ("1,23", "12,3456") is
  //     not a thousands separator either.
  if (text.includes(",")) {
    // Only meaningful when there IS a dot to compare against — "1,234" has no decimal
    // point, and lastIndexOf returns -1 for it, which would make every plain grouped
    // number look European.
    if (text.includes(".") && text.lastIndexOf(",") > text.lastIndexOf(".")) return null;
    if (!GROUPED.test(text)) return null;
    text = text.replace(/,/g, "");
  }
  return { text, negated, percent };
}

// ── The rule, as a sentence (§27.9) ─────────────────────────────────────────
//
// "Invalid value" is not an answer a manager can act on. Every refusal names what the
// cell wanted, in the wording §27.9 asks for.
export function expectationText(spec: FieldSpec): string {
  const noun =
    spec.kind === "wholeNumber" ? "a whole number"
    : spec.kind === "currency" ? "an amount"
    : spec.kind === "percent" ? "a percentage"
    : spec.kind === "date" ? "a date"
    : spec.kind === "select" ? "one of the listed options"
    : spec.kind === "text" ? "text"
    : "a number";

  const bounds: string[] = [];
  if (spec.min !== undefined && spec.max !== undefined) bounds.push(`between ${spec.min} and ${spec.max}`);
  else if (spec.min !== undefined) bounds.push(`greater than or equal to ${spec.min}`);
  else if (spec.max !== undefined) bounds.push(`less than or equal to ${spec.max}`);
  else if (!spec.allowNegative) bounds.push("greater than or equal to 0");
  if (!spec.allowZero) bounds.push("and not zero");

  return `${noun}${bounds.length ? ` ${bounds.join(" ")}` : ""}`;
}

function invalid(raw: string, code: InvalidCode, message: string): CellWriteIntent<never> {
  return { kind: "invalid", raw, code, message };
}

// ── THE parser ──────────────────────────────────────────────────────────────
//
// `raw` is whatever arrived: a FormData value, an <input>.value, a pasted string, or
// null/undefined for a field that was not sent at all.
export function parseCell(raw: unknown, spec: FieldSpec): CellWriteIntent {
  if (raw === null || raw === undefined) return { kind: "absent" };
  // A File, an object, an array — a hand-crafted request. Certainly not a cell value.
  if (typeof raw !== "string" && typeof raw !== "number") {
    return invalid(String(raw), "notANumber", `${spec.label} must be ${expectationText(spec)}.`);
  }
  const asText = String(raw);
  const trimmed = asText.trim();

  if (trimmed === "") {
    if (spec.allowBlank) return { kind: "clear" };
    return invalid(asText, "blankRequired", `${spec.label} is required.`);
  }

  if (spec.kind === "text") return { kind: "value", value: trimmed };

  if (spec.kind === "select") {
    const match = spec.options?.find((o) => o.toLowerCase() === trimmed.toLowerCase());
    if (!match) {
      return invalid(asText, "notAnOption", `${spec.label} must be one of: ${(spec.options ?? []).join(", ")}.`);
    }
    return { kind: "value", value: match };
  }

  if (spec.kind === "date") {
    // ISO only — the app stores and posts "YYYY-MM-DD", and accepting "03/04/2026"
    // would mean guessing between two real dates.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return invalid(asText, "notADate", `${spec.label} must be a date in YYYY-MM-DD form.`);
    }
    const d = new Date(`${trimmed}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || !d.toISOString().startsWith(trimmed)) {
      return invalid(asText, "notADate", `${spec.label} is not a real date.`);
    }
    return { kind: "value", value: trimmed };
  }

  // ── Numeric ───────────────────────────────────────────────────────────────
  const norm = normaliseNumeric(asText, spec.kind);
  // Normalising to nothing means the cell held only punctuation ("$", "-", "()").
  // That is not a blank — the user typed something — so it is a refusal, not a clear.
  if (norm === null) {
    return invalid(asText, "notANumber", `${spec.label} must be ${expectationText(spec)}.`);
  }
  // Reject anything that is not a plain decimal after normalisation. This is what
  // catches pasted text ("abc"), European grouping ("1.234,56" → "1.234.56"), stray
  // exponents from a spreadsheet ("1e5" is allowed nowhere in this app) and doubled
  // signs — rather than letting Number() coerce some of them.
  if (!/^-?\d*\.?\d+$/.test(norm.text)) {
    return invalid(asText, "notANumber", `${spec.label} must be ${expectationText(spec)}.`);
  }
  let n = Number(norm.text);
  if (!Number.isFinite(n)) {
    return invalid(asText, "notANumber", `${spec.label} must be ${expectationText(spec)}.`);
  }
  if (norm.negated) n = -n;
  if (norm.percent) n = n / 100;

  // ── Policy, in the order a person would check it ──────────────────────────
  if (spec.kind === "wholeNumber" && !Number.isInteger(n)) {
    return invalid(asText, "notWhole", `${spec.label} must be ${expectationText(spec)}.`);
  }
  if (n < 0 && !spec.allowNegative) {
    return invalid(asText, "negative", `${spec.label} must be ${expectationText(spec)}.`);
  }
  if (n === 0 && !spec.allowZero) {
    return invalid(asText, "zero", `${spec.label} must be ${expectationText(spec)}.`);
  }
  if (spec.min !== undefined && n < spec.min) {
    return invalid(asText, "belowMin", `${spec.label} must be ${expectationText(spec)}.`);
  }
  if (spec.max !== undefined && n > spec.max) {
    return invalid(asText, "aboveMax", `${spec.label} cannot exceed ${spec.max}.`);
  }
  // Rounded LAST, so the bounds are checked against what the user typed and the
  // stored figure is the one the cell will display and submit (§27.18).
  const value = roundTo(n, spec.decimals);
  // Rounding must not smuggle a value past a bound it just failed — e.g. 0.4 rounding
  // to 0 in a cell that forbids zero.
  if (value === 0 && !spec.allowZero) {
    return invalid(asText, "zero", `${spec.label} must be ${expectationText(spec)}.`);
  }
  if (spec.min !== undefined && value < spec.min) {
    return invalid(asText, "belowMin", `${spec.label} must be ${expectationText(spec)}.`);
  }
  return { kind: "value", value };
}

// Convenience for the common numeric case: the caller knows the spec is numeric and
// wants a number back or a refusal.
export function parseNumericCell(raw: unknown, spec: FieldSpec): CellWriteIntent<number> {
  const out = parseCell(raw, spec);
  if (out.kind === "value" && typeof out.value !== "number") {
    return invalid(String(out.value), "notANumber", `${spec.label} must be ${expectationText(spec)}.`);
  }
  return out as CellWriteIntent<number>;
}

// ── The submission-time question (§27.20) ───────────────────────────────────
//
// Separate from parseCell on purpose. "May this be saved blank" and "may the month be
// submitted with it blank" are different questions, and New ETC answers them
// differently — you may leave it empty all month, and you may not submit that way.
export function isBlankForSubmit(spec: FieldSpec, text: string | number | null | undefined): boolean {
  if (!spec.requiredForSubmit) return false;
  if (text === null || text === undefined) return true;
  return String(text).trim() === "";
}

export function requiredForSubmitMessage(spec: FieldSpec): string {
  return `${spec.label} is required before submitting the month.`;
}
