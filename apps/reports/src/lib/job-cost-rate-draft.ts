import type { CostRates, YearRateOverrides } from "@/lib/job-cost";

// The Rate Matrix's draft: what someone has typed but not yet confirmed.
//
// The matrix used to write through on every blur, so a half-finished edit was
// already live for everyone. It now holds a draft (strings, exactly as typed) and
// only Confirm writes. These are the pure rules for that draft — what counts as a
// change, what counts as valid, which years need a write — kept out of the
// component so they can be tested without a browser.

export const RATE_KEYS = ["engRate", "shopRate", "pmPct", "mfgPct"] as const;
export type RateKey = (typeof RATE_KEYS)[number];

export type DefaultDraft = Record<RateKey, string>;
export type YearDraft = Record<string, Partial<Record<RateKey, string>>>;

export function toDefaultDraft(rates: CostRates): DefaultDraft {
  return { engRate: String(rates.engRate), shopRate: String(rates.shopRate), pmPct: String(rates.pmPct), mfgPct: String(rates.mfgPct) };
}

export function toYearDraft(overrides: YearRateOverrides): YearDraft {
  const out: YearDraft = {};
  for (const [year, o] of Object.entries(overrides)) {
    const row: Partial<Record<RateKey, string>> = {};
    for (const k of RATE_KEYS) if (o[k] != null) row[k] = String(o[k]);
    out[year] = row;
  }
  return out;
}

// null = blank; NaN = something typed that is not a usable rate (not a number, or negative).
function parseCell(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}

/** The default rates, or null when any of the four is blank or invalid (a default can never be blank). */
export function parseDefaultDraft(d: DefaultDraft): CostRates | null {
  const out = {} as CostRates;
  for (const k of RATE_KEYS) {
    const n = parseCell(d[k]);
    if (n == null || Number.isNaN(n)) return null;
    out[k] = n;
  }
  return out;
}

/** Year overrides from the draft. A blank cell is "use the default"; an all-blank year has no override. */
export function parseYearDraft(y: YearDraft): { overrides: YearRateOverrides; valid: boolean } {
  const overrides: YearRateOverrides = {};
  let valid = true;
  for (const [year, row] of Object.entries(y)) {
    const o: Partial<CostRates> = {};
    for (const k of RATE_KEYS) {
      const n = parseCell(row[k]);
      if (n == null) continue;
      if (Number.isNaN(n)) valid = false;
      else o[k] = n;
    }
    if (Object.keys(o).length) overrides[year] = o;
  }
  return { overrides, valid };
}

function sameOverride(a: Partial<CostRates> | undefined, b: Partial<CostRates> | undefined): boolean {
  return RATE_KEYS.every((k) => (a?.[k] ?? null) === (b?.[k] ?? null));
}

/** Years whose override differs between what is saved and what the draft would save. */
export function changedYears(saved: YearRateOverrides, next: YearRateOverrides): string[] {
  return [...new Set([...Object.keys(saved), ...Object.keys(next)])].filter((y) => !sameOverride(saved[y], next[y])).sort();
}

export type RateDraftState = {
  /** Anything differs from the saved rates (or is mid-edit and unusable). */
  dirty: boolean;
  /** Safe to confirm: every default is a number and no year cell is invalid. */
  valid: boolean;
  defaults: CostRates | null;
  overrides: YearRateOverrides;
  defaultsChanged: boolean;
  years: string[];
};

export function evaluateRateDraft(
  savedDefaults: CostRates,
  savedOverrides: YearRateOverrides,
  defaultDraft: DefaultDraft,
  yearDraft: YearDraft,
): RateDraftState {
  const defaults = parseDefaultDraft(defaultDraft);
  const { overrides, valid: yearsValid } = parseYearDraft(yearDraft);
  const defaultsChanged = defaults == null || RATE_KEYS.some((k) => defaults[k] !== savedDefaults[k]);
  const years = changedYears(savedOverrides, overrides);
  return {
    // An unusable cell only exists because someone typed into the matrix, so it counts as unsaved work.
    dirty: defaultsChanged || years.length > 0 || !yearsValid,
    valid: defaults != null && yearsValid,
    defaults,
    overrides,
    defaultsChanged,
    years,
  };
}
