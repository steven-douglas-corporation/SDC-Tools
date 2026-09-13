// ── Interaction diagnostics (§38.14) ────────────────────────────────────────
//
// §38 was reported as "the app becomes unresponsive", and the first thing that had to
// happen was measurement: the cause turned out to be a 4,347ms main-thread block during
// hydration of the Monthly ETC route, which no amount of reading the code would have
// ranked ahead of the half-dozen plausible suspects. (DEVLOG §22 has the numbers.)
//
// This module is what keeps that measurable after the fact, without a profiler open.
// It is the pure half: the §38.13 budgets, the decision about whether an interaction
// blew its budget, and the safe label for the control it happened on. The observers that
// feed it live in components/InteractionMetrics.tsx, which cannot be reached from a
// plain node test.
//
// ── What must NOT end up in a log (§38.14) ──────────────────────────────────
//
// This app's grids are full of live commercial figures — quoted hours, parts costs,
// people's names. A diagnostic that logged "input[value=1432857] took 300ms" would put
// those in the console, and in any log shipper pointed at it. So the label is built from
// an ALLOWLIST of structural attributes only (see labelAttributesFor); an element's
// value, its text content and its title are never read.

// The §38.13 targets, in milliseconds, keyed by the event that carries them. These are
// the numbers the requirement states — not guesses — so a regression is measured against
// what was asked for rather than against what the app happens to do today.
export const INTERACTION_BUDGET_MS = {
  // "Pointer hover feedback: within 50–100ms" — the looser end, because a hover that
  // lands inside 100ms reads as instant.
  pointerover: 100,
  pointerout: 100,
  mouseover: 100,
  // "Button pressed state: within 100ms", "cell selection: within 100ms".
  pointerdown: 100,
  mousedown: 100,
  // A click carries the tab/filter/checkbox cases: all 100ms in §38.13.
  click: 100,
  pointerup: 100,
  mouseup: 100,
  // "Dropdown opening: within 150ms" — a click that opens a menu is still a click, so
  // this is the ceiling used when a control declares itself a disclosure.
  disclosure: 150,
  // Typing in a cell: not named in §38.13, held to the same 100ms as selection.
  keydown: 100,
  keyup: 100,
  input: 100,
} as const;

// Anything not in the table above. Deliberately generous: an unnamed event type is not
// something §38.13 set a target for, and reporting it against a made-up budget would
// bury the ones that matter.
export const DEFAULT_BUDGET_MS = 200;

// A main-thread task longer than this is a §38.16 #15 violation ("no normal interaction
// creates a long main-thread block"). 50ms is the standard long-task threshold and the
// one the browser itself uses.
export const LONG_TASK_MS = 50;

export type InteractionRecord = {
  // Which page it happened on — the pathname only. Query strings on this app carry
  // filter state, which is not sensitive, but they are noise in a log line.
  page: string;
  // What was interacted with: a structural label, never a value. See safeControlLabel.
  control: string;
  // The DOM event name, or "longtask".
  action: string;
  // Total time from the input to the next paint, rounded to a whole ms.
  durationMs: number;
  // How long the handlers themselves ran, where the browser reports it.
  processingMs: number;
  // The budget it was judged against, and whether it blew it.
  budgetMs: number;
  overBudget: boolean;
  // How many requests were in flight when it happened (§38.14 asks for this — a slow
  // interaction with six requests outstanding is a different bug from a slow one alone).
  activeRequests: number;
  // Set when the interaction ended in an error or a timeout rather than a result.
  status?: "error" | "timeout";
};

export function budgetFor(action: string, isDisclosure = false): number {
  if (isDisclosure) return INTERACTION_BUDGET_MS.disclosure;
  return (INTERACTION_BUDGET_MS as Record<string, number>)[action] ?? DEFAULT_BUDGET_MS;
}

export function isOverBudget(action: string, durationMs: number, isDisclosure = false): boolean {
  return durationMs > budgetFor(action, isDisclosure);
}

// ── The label ───────────────────────────────────────────────────────────────
//
// Attributes that describe WHAT a control is, none of which can hold a figure someone
// typed. `value`, `title`, `placeholder` and text content are all excluded on purpose:
// the first three carry data on this app's grids and the fourth carries job names.
const LABEL_ATTRIBUTES = ["data-metric", "aria-label", "name", "id", "type", "role"] as const;

export function labelAttributesFor(): readonly string[] {
  return LABEL_ATTRIBUTES;
}

// Structural only, and bounded: `tag[attr=value]`, first match wins, 60 chars.
export function safeControlLabel(el: {
  tagName?: string;
  getAttribute?: (name: string) => string | null;
} | null): string {
  if (!el || !el.tagName) return "unknown";
  const tag = el.tagName.toLowerCase();
  for (const attr of LABEL_ATTRIBUTES) {
    const value = el.getAttribute?.(attr);
    if (value) return `${tag}[${attr}=${value}]`.slice(0, 60);
  }
  return tag;
}

// ── The ring buffer ─────────────────────────────────────────────────────────
//
// Bounded so a tab left open all day — which is how this app is used — cannot grow a log
// into a memory leak. §38.15 asks for a memory-growth test; a fixed-size buffer is what
// makes the answer to it "it cannot".
export const MAX_RECORDS = 50;

export function pushRecord(buffer: InteractionRecord[], record: InteractionRecord): InteractionRecord[] {
  buffer.push(record);
  if (buffer.length > MAX_RECORDS) buffer.splice(0, buffer.length - MAX_RECORDS);
  return buffer;
}

// One line, for the console. Reads as a sentence so it is usable in a screenshot from a
// user rather than only in a debugger.
export function formatRecord(r: InteractionRecord): string {
  const parts = [
    `${r.action} on ${r.control}`,
    `${r.durationMs}ms (budget ${r.budgetMs}ms)`,
    r.processingMs > 0 ? `${r.processingMs}ms in handlers` : null,
    r.activeRequests > 0 ? `${r.activeRequests} request${r.activeRequests === 1 ? "" : "s"} in flight` : null,
    r.status ? r.status.toUpperCase() : null,
  ].filter(Boolean);
  return `[interaction] ${r.page} — ${parts.join(" · ")}`;
}
