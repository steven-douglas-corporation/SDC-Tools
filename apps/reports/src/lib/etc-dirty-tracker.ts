"use client";

// Tracks whether any New ETC cell currently holds an edit that hasn't been
// saved — a plain module-scope store (not React state/context) so every
// independent EtcSectionCells instance, the Save button and the navigation
// guards can share it without prop-drilling through the whole grid (same
// no-context spirit as ColumnResize.tsx). Backs the beforeunload warning and
// the "unsaved changes" confirms in MonthYearSelect and the Sidebar.
//
// This used to be a single `let dirty = false` latch that only markEtcDirty()
// set and only a successful Save cleared. Two things were wrong with that,
// and together they meant the warning fired constantly on a grid nobody had
// touched (reported 2026-08-02):
//
//   1. It never reset on navigation. Module scope outlives a client-side route
//      change, so one keystroke anywhere — in a month you then left, or a
//      cell you emptied again — armed the warning for the REST OF THE BROWSER
//      SESSION. Every later month switch, refresh, Back and Sign out asked to
//      save work that didn't exist.
//   2. It latched on the change EVENT, not on the value. Typing "5" and
//      backspacing it left the grid "dirty" with every cell exactly as it was
//      loaded.
//
// So dirtiness is now a property of the CURRENT VALUES: each field registers
// the value it loaded with, reports its value as it changes, and drops out of
// the dirty set the moment it matches its baseline again. Fields unregister on
// unmount, which is what makes a month switch self-cleaning — the grid form is
// keyed on the month, so every cell unmounts and takes its entry with it. No
// reset hook to call, and no ordering hazard between "reset" and "register".

// field name -> the value it should be compared against (normalized).
// Seeded on mount, moved forward by rebaseline() when a Save persists.
const baselines = new Map<string, string>();
// The subset of registered fields whose current value differs from baseline.
const dirtyFields = new Set<string>();

// "5", "5.0", " 5 " and "5.00" are the same number typed four ways, and a
// <input type="number"> hands back whichever one was keyed. Comparing raw
// strings would call a cell dirty for a formatting difference the manager
// can't even see. Blank normalizes to "" (distinct from any number, including
// zero — an empty New ETC is "not decided", not "nothing left to do").
function normalize(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  const n = Number(trimmed);
  // Non-numeric text is kept verbatim rather than collapsed to NaN, so two
  // different unparseable entries don't compare equal.
  return Number.isFinite(n) ? String(n) : trimmed;
}

// Call on mount with the value the field rendered with. Idempotent on name:
// a re-register (React StrictMode's double-invoke in dev) must not clobber a
// baseline that rebaseline() has since moved forward.
export function registerEtcField(name: string, initial: string): void {
  if (!baselines.has(name)) baselines.set(name, normalize(initial));
}

// The server has sent a new value for this field and the cell has adopted it
// (because the user had not diverged from the old one) — so THAT is what
// "unchanged" means from now on.
//
// Distinct from registerEtcField, which is deliberately idempotent and must not
// clobber a baseline that has moved. This one overwrites, and it is only ever
// called with a value the cell is actually displaying.
//
// Without this, adopting another user's saved figure would leave the cell compared
// against the value the PAGE loaded with: it would read as dirty, autosave would
// post it, and the server's stale-write guard would reject it as a conflict — so
// picking up a colleague's change would produce a spurious "changed by another
// user" warning on a cell nobody had touched.
export function adoptEtcFieldBaseline(name: string, value: string): void {
  baselines.set(name, normalize(value));
  dirtyFields.delete(name);
  refusedFields.delete(name);
}

// Call on unmount. Removing the baseline as well as the dirty entry is what
// keeps a stale month's fields from lingering in the store forever.
export function forgetEtcField(name: string): void {
  baselines.delete(name);
  dirtyFields.delete(name);
  refusedFields.delete(name);
}

// Call on every change. Deliberately two-way: a field that returns to its
// baseline is clean again, which is the half the old latch got wrong.
export function updateEtcField(name: string, value: string): void {
  // Typing in a refused cell is the manager dealing with the conflict, so it stops
  // being one — and the background refresh is free to resume once it saves.
  refusedFields.delete(name);
  const baseline = baselines.get(name);
  // Unregistered field — nothing to compare against, so treat any value as an
  // edit rather than silently ignoring it.
  if (baseline === undefined) {
    dirtyFields.add(name);
    return;
  }
  if (normalize(value) === baseline) dirtyFields.delete(name);
  else dirtyFields.add(name);
}

// After a Save (or Submit) persists what's on screen, the values that were
// posted BECOME the baseline — otherwise the next edit would be compared
// against what the page originally loaded with and a cell typed back to its
// pre-save value would read as clean when it isn't.
//
// Takes the posted FormData so the caller doesn't have to know which fields
// exist; only names already registered are touched, so unrelated form fields
// (hours, passwords) can't create phantom baselines.
//
// `refused` names the fields the server did NOT write — cells another user had
// already changed (saveAllNewEtcDrafts's stale-write guard). Re-baselining those
// would be a lie in the one place it matters most: the cell would stop reading as
// dirty, the status chip would say "All changes saved", and the manager's value —
// which the server rejected — would sit on screen looking persisted until the next
// reload silently replaced it. Leaving them dirty is what keeps the unsaved-changes
// warning honest.
export function rebaselineEtcFields(formData: FormData, refused?: Iterable<string>): void {
  const skip = refused ? new Set(refused) : null;
  for (const name of baselines.keys()) {
    if (skip?.has(name)) continue;
    const posted = formData.get(name);
    if (posted === null) continue; // not in this submission (a filtered-out column)
    baselines.set(name, normalize(String(posted)));
    dirtyFields.delete(name);
    refusedFields.delete(name);
  }
}

export function isEtcDirty(): boolean {
  return dirtyFields.size > 0;
}

// ── Cells the server refused, so the refresh interlock can ignore them ──────
//
// A refused cell stays DIRTY on purpose — the manager's value was rejected and is
// genuinely unsaved, so the unsaved-changes warnings must keep covering it. But
// LiveRefresh suppresses its background refresh while anything is dirty, and that
// combination deadlocks the tab: the refusal keeps it dirty, the dirt keeps the
// refresh off, and the refresh is the only thing that would show the manager the
// figure they now have to reconcile against (found by review, 2026-08-04).
//
// So refusals are remembered separately and excluded from the REFRESH question
// only. A field leaves the set the moment its value changes or it re-baselines —
// either way the conflict has been dealt with.
const refusedFields = new Set<string>();

export function markEtcFieldsRefused(names: Iterable<string>): void {
  for (const n of names) refusedFields.add(n);
}

// Unsaved edits that are NOT sitting on a known refusal. This is what gates the
// background refresh; isEtcDirty() (which still counts them) is what gates the
// "you have unsaved changes" warnings.
export function hasUnrefusedEtcEdits(): boolean {
  for (const name of dirtyFields) if (!refusedFields.has(name)) return true;
  return false;
}

// ── Only send what this user actually touched ────────────────────────────────
//
// THE MULTI-USER BUG (reported 2026-08-04, "other users are not seeing the value
// I saved"). The Monthly ETC grid is one <form>, and the save posted
// `new FormData(form)` — all ~450 New ETC cells, every time. Each posted value
// that differed from the database got written. So a second manager with the page
// open was not merely looking at stale numbers: their next autosave pass wrote
// their page-load-time values back over every cell the first manager had saved
// since. The value did not fail to appear, it was actively reverted, which is
// why it looked permanent rather than like a refresh problem.
//
// The fix is to post the cells this user has edited and nothing else. The server
// already treats an ABSENT field as "not rendered — leave it untouched"
// (saveAllNewEtcDrafts), so an omitted cell is precisely a cell this save has no
// opinion about. That was already the contract; the client was just ignoring it.
//
// This mirrors what the Projects grid has done since 2026-08-03 (lib/dirty-form.ts,
// `changedFormData`) — that grid trims its payload the same way, for what was then
// only a performance reason. Same rule, and now the same correctness reason.
//
// `newEtcBase__*` rides along: the value this client believed was stored. The
// server refuses the write if the database has moved since (see
// saveAllNewEtcDrafts), which is what makes this safe even against a browser tab
// running an older bundle that still posts everything.
export const ETC_BASE_PREFIX = "newEtcBase__";

export function dirtyEtcFieldNames(): string[] {
  return [...dirtyFields];
}

// The trimmed payload for one ETC draft save. Values are read from the LIVE form
// control rather than from the tracker, so what gets posted is what is on screen
// — the tracker's job is only to say WHICH fields to look at.
export function changedEtcFormData(form: HTMLFormElement): FormData {
  const fd = new FormData();
  for (const name of dirtyFields) {
    const el = form.elements.namedItem(name);
    // Gone from the DOM (a column filter hid it, a month switch unmounted it).
    // Skipping is right: there is nothing on screen to save, and posting a
    // remembered value would be exactly the stale write this exists to prevent.
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) continue;
    if (el.disabled) continue;
    fd.append(name, el.value);
    // "" means "this client believes no draft is stored". Distinct from a stored
    // 0, which posts as "0".
    fd.append(`${ETC_BASE_PREFIX}${stripEtcFieldPrefix(name)}`, baselines.get(name) ?? "");
  }
  return fd;
}

// `newEtcOverride__123` -> `123`, `newEtcCreate__9__10-211` -> `9__10-211`. The
// base field is keyed by the same suffix so the server can pair them up without
// re-deriving which namespace a cell came from.
export function stripEtcFieldPrefix(name: string): string {
  return name.replace(/^newEtcOverride__/, "").replace(/^newEtcCreate__/, "");
}

// ── injectEtcBaselineFields is GONE (§15, 2026-08-04) ───────────────────────
//
// It existed because Submit and Lock posted the whole grid natively, so the server had
// to be told what each cell BELIEVED was stored — otherwise a stale tab froze its own
// snapshot into confirmed history and no later save could put that right.
//
// The submission does not read the form at all any more (lib/monthly-report.ts): it
// reads the database, which is by definition at least as fresh as any tab. So there is
// nothing to declare, and the class of bug this defended against cannot occur.

// ── Making the submission wait for autosave ─────────────────────────────────
//
// `Submit {Month} Report` reads the month from the DATABASE, so anything still sitting
// on the 800ms autosave debounce would simply not be in the month it freezes. The
// button therefore flushes first and WAITS — the "confirm that all pending auto-saves
// have completed" step, and the only reason the submission touches the save machinery.
//
// A module-scope hook rather than a prop, for the same reason as everything else in
// this file: the button and the autosave component are siblings in a toolbar with no
// shared ancestor short of the page.
// ── A SET of subscribers, not one slot (2026-09-03) ─────────────────────────
//
// This was `let autosaveFlush: (() => Promise<unknown>) | null`, which silently
// assumed exactly one EtcAutosave is ever mounted. Split view breaks that
// assumption (two panes can both be Monthly ETC), and a single slot fails two ways
// once it is broken — both of them silent, both of them data loss:
//
//   1. The second mount OVERWRITES the first. `flushEtcAutosave()` then flushes one
//      grid, and Submit / Refresh Data / Export proceed believing everything is
//      saved. The other pane's pending 800ms debounce is simply discarded — the
//      exact failure the pool registry directly below was added to fix, reappearing
//      one level up.
//   2. The cleanup nulls the slot on the WRONG unmount. `if (autosaveFlush === fn)`
//      correctly no-ops when the first pane unmounts after being overwritten — but
//      when the SECOND unmounts it nulls the slot while the first is still mounted
//      and still has a live debounce. Every flush after that is a no-op against a
//      grid with unsaved edits.
//
// A Set makes both impossible: every mounted autosave is registered, each removes
// only itself, and a flush waits for all of them. With one pane mounted the
// behaviour is identical to before.
const autosaveFlushes = new Set<() => Promise<unknown>>();

export function registerEtcAutosaveFlush(fn: () => Promise<unknown>): () => void {
  autosaveFlushes.add(fn);
  return () => {
    autosaveFlushes.delete(fn);
  };
}

// Resolves once every in-flight or pending save has finished. A no-op when nothing
// is mounted (a locked month renders no autosave) or when there is nothing dirty.
//
// allSettled, not all: these are independent grids, and one pane's save failing
// must not leave the other pane's flush unawaited — the caller's next step
// (freezing the month, refreshing the data) would then race a save it never waited
// for. Each autosave already surfaces its own failure to its own pane.
export async function flushEtcAutosave(): Promise<void> {
  if (autosaveFlushes.size === 0) return;
  await Promise.allSettled([...autosaveFlushes].map((fn) => fn()));
}

// ── The Standard Fees pool cells flush the same way, through a SEPARATE registry ──
//
// "Hours being pulled" and "Rate" are tracked by StandardRatesProvider
// (EtcStandardColumns.tsx's isPoolDirty), not by this file's dirtyFields set, and
// PoolAutosave.tsx — not EtcAutosave.tsx — owns their debounce. Without this second
// registry, `Submit {Month} Report` only ever flushed the ETC grid: a pool edit still
// on its own 800ms debounce would be sitting unsaved in the browser while
// loadStandardSheetRows read (and froze) whatever was already in CategoryPool —
// silently discarding the value on screen, despite the panel's own text promising
// "the submission waits for them."
// A Set for the same reason as the ETC registry above, and it is the same bug —
// two panes on Monthly ETC mount two pool panels, and a single slot would flush one
// of them while Submit froze the month around the other's pending edit.
const poolAutosaveFlushes = new Set<() => Promise<unknown>>();

export function registerPoolAutosaveFlush(fn: () => Promise<unknown>): () => void {
  poolAutosaveFlushes.add(fn);
  return () => {
    poolAutosaveFlushes.delete(fn);
  };
}

// A no-op when no pool panel is mounted (a locked month, or a session that never
// unlocked the Standard view) or when nothing on it is dirty — same contract as
// flushEtcAutosave.
export async function flushPoolAutosave(): Promise<void> {
  if (poolAutosaveFlushes.size === 0) return;
  await Promise.allSettled([...poolAutosaveFlushes].map((fn) => fn()));
}
