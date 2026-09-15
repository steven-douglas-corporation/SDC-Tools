import { isValidMonth } from "@/lib/etc";

// ── Input validation for the job page's inline server actions ────────────────
//
// (app)/jobs/[id]/page.tsx has four "use server" functions bound straight to
// forms (add/update an ETC section, confirm a New ETC, override a month's
// actual hours, revert that override). Until 2026-09-14 each did
// `Number(formData.get(...))` and wrote the result: a blank or non-numeric
// field became NaN, which Prisma stores as a Decimal write error at best and a
// silent 0 at worst, and a hand-crafted POST could target any row id at all.
//
// Everything here is pure — a `get` function stands in for FormData so the
// rules can be unit tested without constructing one — and every failure is an
// Error with a message written for the person who typed the value, since the
// page surfaces action errors verbatim.

export type FormGet = (name: string) => unknown;

/** A finite number, or throws naming the field. `Number("")` is 0 and `Number("abc")` is NaN — both are caught. */
export function finiteNumber(raw: unknown, label: string, opts: { allowBlankAs?: number } = {}): number {
  const text = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw);
  if (text === "") {
    if (opts.allowBlankAs !== undefined) return opts.allowBlankAs;
    throw new Error(`${label} is required.`);
  }
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number (got "${text}").`);
  return n;
}

/** A positive integer row/entry id, or throws. */
export function positiveInt(raw: unknown, label: string): number {
  const n = finiteNumber(raw, label);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} must be a positive whole number.`);
  return n;
}

// Section codes are "<phase>-<function>", e.g. "10-111" — see lib/sections.ts.
// Format-checked rather than matched against the SECTIONS list on purpose: the
// grid tracks a fixed subset, but EtcEntry rows legitimately exist for off-grid
// codes too, and this form is how one gets typed in by hand.
const SECTION_CODE = /^\d{2}-\d{3}$/;

export type AddEntryInput = { section: string; priorEtc: number; hoursWorked: number; month: string };

export function parseAddEntryInput(get: FormGet): AddEntryInput {
  const section = String(get("section") ?? "").trim();
  if (!SECTION_CODE.test(section)) throw new Error(`Section must look like "10-111" (got "${section}").`);
  const month = String(get("month") ?? "").trim();
  if (!isValidMonth(month)) throw new Error(`"${month}" is not a valid month (expected YYYY-MM).`);
  const priorEtc = finiteNumber(get("priorEtc"), "Prior ETC");
  const hoursWorked = finiteNumber(get("hoursWorked"), "Hours worked", { allowBlankAs: 0 });
  if (priorEtc < 0) throw new Error("Prior ETC cannot be negative.");
  if (hoursWorked < 0) throw new Error("Hours worked cannot be negative.");
  return { section, priorEtc, hoursWorked, month };
}

export type ConfirmEntryInput = { entryId: number; newEtc: number };

export function parseConfirmEntryInput(get: FormGet): ConfirmEntryInput {
  const entryId = positiveInt(get("entryId"), "Entry id");
  const newEtc = finiteNumber(get("newEtc"), "New ETC");
  if (newEtc < 0) throw new Error("New ETC cannot be negative.");
  return { entryId, newEtc };
}

export type OverrideHoursInput = { rowId: number; newHours: number; note: string | null };

const NOTE_MAX = 500;

export function parseOverrideHoursInput(get: FormGet): OverrideHoursInput {
  const rowId = positiveInt(get("rowId"), "Row id");
  const newHours = finiteNumber(get("newHours"), "Actual hours");
  if (newHours < 0) throw new Error("Actual hours cannot be negative.");
  const noteRaw = String(get("note") ?? "").trim();
  if (noteRaw.length > NOTE_MAX) throw new Error(`Reason must be ${NOTE_MAX} characters or fewer.`);
  return { rowId, newHours, note: noteRaw || null };
}

export function parseRowId(get: FormGet): number {
  return positiveInt(get("rowId"), "Row id");
}
