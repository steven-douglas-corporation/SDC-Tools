// Submit only the cells that actually changed.
//
// The Projects grid is ONE <form> around the whole matrix, so every save used to
// post every visible control — ~1,100 fields for 50 jobs × 13 sections — and the
// server then re-parsed and diffed all of them to find the two the user touched.
// The write itself was never the cost (the DB work measures ~100ms); the payload,
// the parse and the diff were.
//
// How "changed" is decided: each control carries its server-rendered value in a
// `data-baseline` attribute, and the client sends a control only when its current
// value differs from it. The baseline comes from the server rather than from a
// snapshot taken on mount, because it then re-states itself on every re-render —
// after a save, or after a filter/sort navigation swaps the rows — with no
// client-side bookkeeping that could go stale and start comparing a cell against
// some other row's old value.
//
// Bias, on purpose: anything whose baseline is UNKNOWN gets sent. A missing
// attribute means "this file didn't teach the server to declare one", and the
// only safe reading of that is to submit it and let the action diff it as before.
// The failure mode is a slightly larger payload, never a silently dropped edit.

export const BASELINE_ATTR = "data-baseline";

// ── Declaring what the client believed was stored ───────────────────────────
//
// Sent alongside every changed field as `__base__<name>`, so the server can tell
// "this manager edited this cell" from "this page was working from stale data".
//
// Why (2026-08-04, the multi-user save bug): the write helpers in
// quoted-actions.ts decide what to save by comparing the POSTED value against the
// DATABASE. That reads a stale page's value as a deliberate edit, so one manager's
// tab could revert another's saved cell — the same defect as the Monthly ETC grid,
// which is fixed by the matching `newEtcBase__*` token. `value !== baseline` alone
// cannot distinguish the two cases, because a server change moves the baseline
// while the displayed value stays put.
export const BASE_FIELD_PREFIX = "__base__";

// New-project rows exist only in the browser until they're saved, so they have no
// server-rendered baseline to compare against and must always go. Prefix-matched
// against the field names in quoted-actions.ts.
export const ALWAYS_SEND_PREFIXES = ["newRow__", "newRowHours__"] as const;

export type FieldState = {
  name: string;
  value: string;
  // null = the control declared no baseline.
  baseline: string | null;
};

// Pure, so the rule above is unit-testable without a DOM.
export function shouldSend({ name, value, baseline }: FieldState): boolean {
  if (ALWAYS_SEND_PREFIXES.some((p) => name.startsWith(p))) return true;
  if (baseline === null) return true;
  return value !== baseline;
}

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

// Named, submittable controls. Unnamed ones are deliberately skipped — MoneyCell
// renders a visible unnamed input for display and a named hidden one for the
// actual value, and only the latter was ever submitted.
function controlsOf(form: HTMLFormElement): FormControl[] {
  return Array.from(form.elements).filter((el): el is FormControl => {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return false;
    if (!el.name || el.disabled) return false;
    if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button" || el.type === "file")) return false;
    return true;
  });
}

// Baseline for a checkbox/radio is its checked-ness, not its value.
function stateOf(el: FormControl): FieldState {
  const baseline = el.getAttribute(BASELINE_ATTR);
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    return { name: el.name, value: String(el.checked), baseline };
  }
  return { name: el.name, value: el.value, baseline };
}

// The trimmed payload for one submission.
export function changedFormData(form: HTMLFormElement): FormData {
  const fd = new FormData();
  for (const el of controlsOf(form)) {
    const state = stateOf(el);
    if (!shouldSend(state)) continue;
    // The value this client believed was stored, so the action can refuse a write
    // that would revert somebody else. Only when the control actually declared one
    // — an unknown baseline stays unknown rather than becoming a false claim.
    if (state.baseline !== null) fd.append(`${BASE_FIELD_PREFIX}${el.name}`, state.baseline);
    // Unchecked boxes are omitted, matching what a native submit would send.
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      if (el.checked) fd.append(el.name, el.value || "on");
      continue;
    }
    fd.append(el.name, el.value);
  }
  return fd;
}

// For the log line / any future "n changes pending" affordance.
export function countChanged(form: HTMLFormElement): number {
  return controlsOf(form).filter((el) => shouldSend(stateOf(el))).length;
}
