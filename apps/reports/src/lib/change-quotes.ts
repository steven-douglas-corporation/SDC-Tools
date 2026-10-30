// ── Change quotes: the arithmetic, with no database in it ───────────────────
//
// A change quote is extra budget a customer approves on top of the original
// quote — a dollar amount made of hours per section plus a parts cost. The
// Projects grid holds only the TOTAL (EstimatedHours.quotedHours per section,
// Job.costQuoted), and everything else in the app reads that, so it is never
// split. What a change quote contributed is recorded beside it
// (JobChangeQuote / JobChangeQuoteHours) and ORIGINAL is derived:
//
//     original = total − Σ (applied change quotes)
//
// Kept pure — plain numbers in, plain numbers out — so the rules that decide
// whether a change quote can be applied or reversed are covered by tests
// without a database, and so the server actions and the panel cannot disagree
// about them. Money is handled in whole cents, never as float dollars.

export type CqStatus = "Draft" | "Applied";

export type CqInput = {
  /** Section code → whole hours. Absent / 0 means none. */
  hours: Readonly<Record<string, number>>;
  /** Cents. */
  partsCents: number;
  status: CqStatus;
  /** Only meaningful when status is Applied. */
  addedToTotals: boolean;
};

export const LABEL_MAX = 64;
export const NOTE_MAX = 255;

/** Dollars (number | numeric string, "$" and commas tolerated) → cents. null when blank. */
export function parseCents(raw: unknown): number | null | "invalid" {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return "invalid";
    return Math.round(raw * 100);
  }
  const s = String(raw).trim().replace(/[$,\s]/g, "");
  if (s === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return "invalid";
  const [d, c = ""] = s.split(".");
  return Number(d) * 100 + Number(c.padEnd(2, "0"));
}

export function centsToDollars(cents: number): number {
  return cents / 100;
}

/** Whole non-negative hours. Blank is 0; anything else non-integer is invalid. */
export function parseWholeHours(raw: unknown): number | "invalid" {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 0 ? raw : "invalid";
  const s = String(raw).trim();
  if (s === "") return 0;
  return /^\d{1,6}$/.test(s) ? Number(s) : "invalid";
}

export function totalHours(hours: Readonly<Record<string, number>>): number {
  let t = 0;
  for (const v of Object.values(hours)) t += v;
  return t;
}

/** Hours with zero entries dropped, so "not entered" and "0" store identically. */
export function compactHours(hours: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(hours)) if (v > 0) out[k] = v;
  return out;
}

// ── Original / change-quote / total, per section ────────────────────────────

export type SectionSplit = { total: number; changeQuote: number; original: number };

/**
 * The per-section split for the panel. `totals` is what the grid holds;
 * `applied` are the Applied change quotes only — a Draft is not in the totals yet.
 * A section whose applied change quotes exceed its total would have a NEGATIVE
 * original; that is reported (`negative`) rather than clamped, since a clamp would
 * hide exactly the inconsistency a manager needs to fix.
 */
export function splitBySection(
  totals: Readonly<Record<string, number>>,
  applied: readonly Pick<CqInput, "hours">[],
): { bySection: Record<string, SectionSplit>; negative: string[] } {
  const cq: Record<string, number> = {};
  for (const c of applied) for (const [s, h] of Object.entries(c.hours)) cq[s] = (cq[s] ?? 0) + h;
  const bySection: Record<string, SectionSplit> = {};
  const negative: string[] = [];
  for (const s of new Set([...Object.keys(totals), ...Object.keys(cq)])) {
    const total = totals[s] ?? 0;
    const changeQuote = cq[s] ?? 0;
    const original = total - changeQuote;
    bySection[s] = { total, changeQuote, original };
    if (original < 0) negative.push(s);
  }
  return { bySection, negative };
}

/** Parts cost split, in cents. `totalCents` null (never entered) reads as 0. */
export function splitParts(totalCents: number | null, applied: readonly Pick<CqInput, "partsCents">[]) {
  const total = totalCents ?? 0;
  const changeQuote = applied.reduce((a, c) => a + c.partsCents, 0);
  return { total, changeQuote, original: total - changeQuote };
}

// ── Applying and reversing ──────────────────────────────────────────────────

export type TotalsState = { hours: Record<string, number>; partsCents: number | null };

export type PlanResult =
  | { ok: true; hours: Record<string, number>; partsCents: number | null; changedSections: string[]; partsChanged: boolean; addedToTotals: boolean }
  | { ok: false; error: string };

/**
 * What the totals become when `cq` is applied, or an error naming why it can't be.
 * Pure: the caller writes the result inside one transaction and re-checks status there.
 * Applying always ADDS — there is one rule: whatever is in the grid is the baseline, and
 * every change quote after it goes through the panel.
 */
export function planApply(totals: TotalsState, cq: CqInput): PlanResult {
  if (cq.status === "Applied") return { ok: false, error: "This change quote is already applied." };
  const entered = compactHours(cq.hours);
  if (Object.keys(entered).length === 0 && cq.partsCents === 0) {
    return { ok: false, error: "Enter hours or a parts cost before applying — this change quote is empty." };
  }
  const hours = { ...totals.hours };
  const changedSections: string[] = [];
  for (const [s, h] of Object.entries(entered)) {
    hours[s] = (hours[s] ?? 0) + h;
    changedSections.push(s);
  }
  const partsChanged = cq.partsCents > 0;
  const partsCents = partsChanged ? (totals.partsCents ?? 0) + cq.partsCents : totals.partsCents;
  return { ok: true, hours, partsCents, changedSections, partsChanged, addedToTotals: true };
}

/**
 * What the totals become when an Applied `cq` is reversed back to Draft. A change
 * quote that was never added to the totals (none can be created now — kept as a guard) leaves them alone. One
 * that was added is subtracted — refused if that would take a total below zero,
 * which can only mean someone has since edited the totals down by hand.
 */
export function planReverse(totals: TotalsState, cq: CqInput): PlanResult {
  if (cq.status !== "Applied") return { ok: false, error: "This change quote is not applied." };
  if (!cq.addedToTotals) {
    return { ok: true, hours: { ...totals.hours }, partsCents: totals.partsCents, changedSections: [], partsChanged: false, addedToTotals: false };
  }
  const hours = { ...totals.hours };
  const changedSections: string[] = [];
  for (const [s, h] of Object.entries(compactHours(cq.hours))) {
    const next = (hours[s] ?? 0) - h;
    if (next < 0) {
      return { ok: false, error: `Can't reverse: the grid total for ${s} is ${hours[s] ?? 0}, below this change quote's ${h}. Fix the total first.` };
    }
    hours[s] = next;
    changedSections.push(s);
  }
  const partsChanged = cq.partsCents > 0;
  let partsCents = totals.partsCents;
  if (partsChanged) {
    const next = (totals.partsCents ?? 0) - cq.partsCents;
    if (next < 0) {
      return { ok: false, error: "Can't reverse: the grid's Parts Cost Quoted is below this change quote's parts cost. Fix the total first." };
    }
    partsCents = next;
  }
  return { ok: true, hours, partsCents, changedSections, partsChanged, addedToTotals: false };
}

// ── The grid's Change Quote $ column ────────────────────────────────────────
//
// Applying a change quote ADDS its amount to Job.changeQuote and reversing takes it
// back out, so the dollar figure is entered once, in the panel.

export type ColumnPlan = { ok: true; nextCents: number | null; changed: boolean } | { ok: false; error: string };

export function planColumnAmount(columnCents: number | null, amountCents: number | null, op: "apply" | "reverse", addedToTotals: boolean): ColumnPlan {
  const amount = amountCents ?? 0;
  if (!addedToTotals || amount <= 0) return { ok: true, nextCents: columnCents, changed: false };
  if (op === "apply") return { ok: true, nextCents: (columnCents ?? 0) + amount, changed: true };
  const next = (columnCents ?? 0) - amount;
  if (next < 0) {
    return { ok: false, error: "Can't reverse: the grid's Change Quote column is below this change quote's amount. Fix the column first." };
  }
  // Back to nothing entered rather than a stored $0.
  return { ok: true, nextCents: next === 0 ? null : next, changed: true };
}

// ── The all-in contract value: Total = Sales Price + Change Quote ────────────
//
// One definition, used by every writer of Job.totalPrice (applying/reversing a change quote,
// saving a Sales Price) so the Projects grid's Total and Profitability's Sales $ cannot
// disagree. Total and Change Quote are no longer typed into the grid. A job with no change
// quote has no Total: it would only repeat the Sales Price, so the cell stays empty.
/** Cents; null when the job has no change quote. */
export function allInCents(salesCents: number | null, changeQuoteCents: number | null): number | null {
  if (!changeQuoteCents) return null;
  return (salesCents ?? 0) + changeQuoteCents;
}

// ── The $155,300 = labor + parts check ──────────────────────────────────────

export type Reconciliation = {
  laborCents: number;
  hours: number;
  /** Effective labor $/hr, cents, or null with no hours (or a non-positive labor remainder). */
  ratePerHourCents: number | null;
  /** The parts cost exceeds the amount — the figures can't both be right. */
  partsExceedAmount: boolean;
};

export function reconcile(amountCents: number | null, partsCents: number, hours: Readonly<Record<string, number>>): Reconciliation | null {
  if (amountCents === null) return null;
  const h = totalHours(hours);
  const laborCents = amountCents - partsCents;
  return {
    laborCents,
    hours: h,
    ratePerHourCents: h > 0 && laborCents > 0 ? Math.round(laborCents / h) : null,
    partsExceedAmount: laborCents < 0,
  };
}

// ── Validation of a change quote's own fields ───────────────────────────────

export type CqDraftInput = {
  label: unknown;
  note: unknown;
  amount: unknown;
  partsCost: unknown;
  quoteDate: unknown;
  hours: Readonly<Record<string, unknown>>;
};

export type CqDraftClean = {
  label: string;
  note: string | null;
  amountCents: number | null;
  partsCents: number;
  quoteDate: string | null; // YYYY-MM-DD
  hours: Record<string, number>;
};

export function cleanDraft(input: CqDraftInput, validSections: ReadonlySet<string>): { ok: true; value: CqDraftClean } | { ok: false; error: string } {
  const label = String(input.label ?? "").trim();
  if (label === "") return { ok: false, error: "Give the change quote a label, e.g. CQ4." };
  if (label.length > LABEL_MAX) return { ok: false, error: `Label is too long (max ${LABEL_MAX} characters).` };
  const note = String(input.note ?? "").trim();
  if (note.length > NOTE_MAX) return { ok: false, error: `Note is too long (max ${NOTE_MAX} characters).` };

  const amount = parseCents(input.amount);
  if (amount === "invalid") return { ok: false, error: "Amount must be a dollar figure like 155300 or 155,300.00." };
  const parts = parseCents(input.partsCost);
  if (parts === "invalid") return { ok: false, error: "Parts cost must be a dollar figure like 33050." };
  const partsCents = parts ?? 0;
  if (amount !== null && partsCents > amount) return { ok: false, error: "Parts cost can't be more than the change quote amount." };

  let quoteDate: string | null = null;
  const rawDate = String(input.quoteDate ?? "").trim();
  if (rawDate !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate) || Number.isNaN(new Date(`${rawDate}T00:00:00Z`).getTime())) {
      return { ok: false, error: "Date must look like 2026-10-29." };
    }
    quoteDate = rawDate;
  }

  const hours: Record<string, number> = {};
  for (const [section, raw] of Object.entries(input.hours)) {
    if (!validSections.has(section)) return { ok: false, error: `Unknown section "${section}".` };
    const h = parseWholeHours(raw);
    if (h === "invalid") return { ok: false, error: `Hours for ${section} must be a whole number.` };
    if (h > 0) hours[section] = h;
  }
  return { ok: true, value: { label, note: note === "" ? null : note, amountCents: amount, partsCents, quoteDate, hours } };
}
