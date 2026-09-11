import { CELL_SPECS, parseCell, roundTo, type FieldSpec } from "@/lib/cell-rules";

// Core ETC math, ported from "Managers Fill Out" as confirmed by Dan:
// - suggested hours left = prior ETC - hours worked this month
// - if zero hours worked, assume no progress: new ETC carries forward = prior ETC
// - otherwise the manager confirms/overrides the suggested value
export function calcHoursLeft(priorEtc: number, hoursWorked: number): number {
  return priorEtc - hoursWorked;
}

export function suggestNewEtc(priorEtc: number, hoursWorked: number): number {
  if (hoursWorked === 0) return priorEtc;
  return Math.max(calcHoursLeft(priorEtc, hoursWorked), 0);
}

// ── What the submission FREEZES into `newEtc` for one unsubmitted row ────────
//
// The same precedence the cell renders by (newEtcSeedText): the saved draft, else
// the figure this row was CONFIRMED at before the month was reopened, else the
// suggestion. The middle rung is the one that was missing (2026-09-11).
//
// What happened without it: August 2026 was submitted, reopened, and submitted again
// within twenty minutes. The first submission consumed every draft (`newEtcDraft:
// null` — "consumed by the submission") and froze the managers' figures into
// `newEtc`. The reopen only flipped `needsReview` back on, so every cell arrived
// pre-filled from `newEtc` — the grid looked exactly as it had been signed off. But
// the SECOND submission read `draft ?? suggestion`, found no drafts, and wrote the
// carry-forward suggestion over 161 hours cells that managers had typed a figure
// into: 1122 ME & CE went 160 -> 93.5, 1118 CE 400 -> 12.92, 1130 CE 20 -> 0. The
// second reopen then showed those numbers back to the people who had entered the
// originals, and it was reported as "the tab changes the values managers enter".
//
// A deliberate clear on a reopened month still falls through to the suggestion:
// the cell is blank on screen and its own tooltip says that is what a blank submits
// as. `confirmed` is the caller's `submittedAt != null ? newEtc : null` — the exact
// expression etc/page.tsx seeds `initialConfirmed` from, so what is frozen is what
// was on screen.
export function newEtcForSubmission(s: {
  draft: number | null;
  confirmed: number | null;
  cleared: boolean;
  priorEtc: number;
  hoursWorked: number;
}): number {
  if (s.draft != null) return round2(s.draft);
  if (!s.cleared && s.confirmed != null) return round2(s.confirmed);
  return round2(suggestNewEtc(s.priorEtc, s.hoursWorked));
}

// ── The realtime name of a cell that has no row yet — WITH its month ─────────
//
// A cell with no EtcEntry posts under the form-field name `newEtcCreate__<jobPk>__
// <section>`, and that name deliberately carries no month (lib/split-view.ts pins
// the fact and guards against it by keeping Monthly ETC single-instance). But the
// same string was also the key a colleague's saved value was DELIVERED under
// (lib/etc-remote-values.ts) and the key presence markers hung on — and a save to
// job X / section S in September names exactly the cell job X / section S in a tab
// showing August, if August has no row there either. A clean August cell would
// adopt September's figure; the presence marker would light up a month away.
//
// So the live key is the field name plus the month. The FORM field name is
// unchanged: the server parser, the dirty tracker and the split-view guard all
// still see `newEtcCreate__<jobPk>__<section>`. An existing row needs none of this
// — `newEtcOverride__<id>` is unique across months by construction.
export function etcCreateCellLiveKey(jobPk: number, section: string, month: string): string {
  return `newEtcCreate__${jobPk}__${section}__${month}`;
}

// Has a manager actually decided this cell's New ETC? Submitted (needsReview
// false) or typed-and-saved (a draft) both count; anything else is still the
// machine's suggestion standing in for an answer nobody has given.
export function isNewEtcDecided(entry: { needsReview: boolean; newEtcDraft: unknown }): boolean {
  return !entry.needsReview || entry.newEtcDraft != null;
}

// What a row's New ETC currently amounts to: the submitted value, else the saved
// draft, else the suggestion. Shared so the grid, its totals and the KPI cards
// cannot each answer this differently.
export function effectiveNewEtc(entry: {
  needsReview: boolean;
  newEtc: unknown;
  newEtcDraft: unknown;
  priorEtc: unknown;
  hoursWorked: unknown;
}): number {
  if (!entry.needsReview) return Number(entry.newEtc);
  if (entry.newEtcDraft != null) return Number(entry.newEtcDraft);
  return suggestNewEtc(Number(entry.priorEtc), Number(entry.hoursWorked));
}

// Diff — "how far is the manager's New ETC from the hours actually remaining?" —
// and NULL when there is no decision to compare.
//
// It used to compare the SUGGESTION for undecided cells, which quietly turned
// every overspent-but-untouched cell into an overage: suggestNewEtc clamps at 0
// (a plan cannot be negative) while Hours Left stays negative, so the clamped gap
// surfaced as "over" on a cell nobody had opened. Measured on 2026-07-31, that was
// −1,065 of Engineering's −1,071 and −325 of Shop's −310: essentially the whole
// figure, invented, with exactly ONE of 241 Engineering cells actually decided.
//
// A number nobody entered must not be reported as their overrun.
export function newEtcDiff(entry: {
  needsReview: boolean;
  newEtc: unknown;
  newEtcDraft: unknown;
  priorEtc: unknown;
  hoursWorked: unknown;
}): number {
  // An UNTYPED New ETC counts as 0; a typed one counts as max(value, 0)
  // (2026-08-03, by request). This is the second revision of the rule, so both
  // predecessors are worth recording.
  //
  // Until 2026-08-02 this returned null for an undecided cell, so the column read
  // "—" across most of the grid and hid the one thing it exists to show: a
  // section already burned past its Prior ETC. That was replaced by comparing
  // against the SUGGESTION, which fixed the overruns but produced a column that
  // could not be read off the screen, and was reported as a bug:
  //
  //     Prior 174, Worked  98 -> Left  77, blank New ETC -> Diff 0
  //     Prior 160, Worked 167 -> Left  -7, blank New ETC -> Diff -7
  //
  // Both were right under that rule — the suggestion clamps at 0, so it equals
  // Hours Left while Hours Left is positive and 0 once it goes negative — but with
  // the cell visibly empty the two look arbitrary side by side.
  //
  // Treating a blank as 0 makes the column say ONE thing: Diff is Hours Left
  // until somebody plans the section, and the real variance once they do.
  // Overspent cells are unaffected (-7 stays -7); the 77 now reads as 77 hours
  // nobody has accounted for, which is a fair thing to be told.
  //
  // Scope: this is how DIFF reads an empty cell. effectiveNewEtc is deliberately
  // NOT changed — it answers "what will this month be if submitted as-is", and
  // the carry-forward into next month's Prior ETC depends on that answer. Making
  // it 0 would zero every unplanned section's balance at submission.
  // An UNDECIDED cell has no variance and contributes NOTHING (2026-08-03, third
  // and final revision — see the history above). Diff reports decisions: until a
  // manager enters a New ETC there is nothing to compare against, so the cell
  // prints empty and adds 0 to every total that sums it.
  //
  // Returning 0 rather than null keeps every caller — the cell, the row totals,
  // the grand total, the KPI cards, the live store — on one numeric type. "Adds
  // nothing" and "is nothing" are the same thing to a sum; only the CELL needs to
  // tell them apart, and it does that with isNewEtcDecided directly.
  if (!isNewEtcDecided(entry)) return 0;
  return calcHoursLeft(Number(entry.priorEtc), Number(entry.hoursWorked)) - Math.max(effectiveNewEtc(entry), 0);
}

// ── The TOTAL (NEW ETC) rollup: all-or-nothing (§51) ────────────────────────
//
// The ENG and SHOP blocks at the right of the grid are a rollup of a job's section
// cells. §51 makes them all-or-nothing: **a rollup with a required cell still blank
// shows nothing at all**, rather than a partial figure that reads as a plan.
//
// ── Why the old behaviour had to go ─────────────────────────────────────────
//
// It printed three columns that invited a subtraction which did not hold. Measured on
// job 1101 for 2026-07:
//
//     Hours Left 1,017    Total New ETC 205    Diff -22
//
// -22 was correct and unreadable. Total New ETC and Diff both counted only the four
// sections somebody had planned (183 - 205 = -22); Hours Left counted all seven,
// including 834 hours in three nobody had touched. Two columns meaning "planned" and
// one meaning "everything", side by side, with no way to tell from the screen. Blank
// says the true thing — *this rollup is not ready yet* — and once it is ready all
// three columns agree, because every cell is then counted by all of them.
//
// ── What "required" means, and why zero is not blank ────────────────────────
//
// A cell needs an answer only when hours were booked to it this month
// (isNewEtcDecisionRequired), and it HAS one as soon as it holds any text at all —
// including "0", which is a real plan and the distinction hasNewEtcValue exists to
// make. So the blocking set is exactly the YELLOW cells: a decision is required here
// and the box is empty. Sections with nothing booked never block, which is what keeps
// a rollup from being held hostage by the ~350 sections no job ever quoted.
//
// That is also the same set the submission gate counts as `missingNewEtc`, so "the
// rollup is blank" and "the month cannot be submitted" are one fact with one cause.
//
// Deliberately scoped (§51's second half): this is the ENG/SHOP rollup and NOTHING
// else. Section cells, Parts Cost, the Standard columns and the KPI cards all keep
// their existing behaviour — a partial figure is right for a single cell, which is
// only ever reporting itself.
export type NewEtcRollupCell = {
  /** Yellow is `!decided`: an answer is required here and the box is empty. */
  decided: boolean;
  hoursLeft: number;
  /** The cell's effective New ETC. Only read when the whole group is complete. */
  newEtc: number;
};

export type NewEtcRollup = {
  complete: boolean;
  /** Always a figure — Prior and Worked are synced facts, not decisions (§51). */
  hoursLeft: number;
  /** null until every required cell in the group has an answer. */
  newEtc: number | null;
  /** null whenever `newEtc` is null. Never a fallback, never 0 (§51 #8). */
  diff: number | null;
};

export function rollupNewEtc(cells: Iterable<NewEtcRollupCell>): NewEtcRollup {
  let hoursLeft = 0;
  let newEtc = 0;
  let complete = true;
  for (const c of cells) {
    hoursLeft += c.hoursLeft;
    // Clamped per cell, matching what a cell publishes and what newEtcDiff compares
    // against — a negative New ETC is not a negative plan.
    newEtc += Math.max(c.newEtc, 0);
    if (!c.decided) complete = false;
  }
  if (!complete) return { complete: false, hoursLeft, newEtc: null, diff: null };
  // Once complete this is the plain subtraction §51 asks for — and it EQUALS the
  // per-cell sum the block used before, because every cell now contributes to both
  // operands. That equivalence is a test, not a hope: it is the reason this change
  // can drop the per-cell rollup without changing any completed figure.
  return { complete: true, hoursLeft, newEtc, diff: hoursLeft - newEtc };
}

// ── The yellow "needs attention" New ETC cell ───────────────────────────────
//
// Yellow means one thing: somebody still has to make a judgement call here, and
// the box is EMPTY. Lives here rather than inline in the cell so that the client
// (which knows the LIVE input text) and the server (which knows what would seed)
// give identical answers from identical inputs.
//
// History worth keeping, because the rule has been wrong in both directions. It
// used to answer two questions at once — the colour AND which cells the Clear ETC
// button emptied — and that forced the colour to call a reopened month's
// carried-over figure "undecided", so cells with values in them rendered yellow.
// That was reported as a bug and fixed by splitting the two apart; the Clear ETC
// button has since been removed outright (2026-08-04, §14), so only the colour
// question remains:
//
//     yellow  <=>  a decision is required here  AND  the cell is blank
//
// Blank means null, undefined or empty/whitespace text. NOT 0, and not "0": zero
// is a real, valid, entered figure ("plan nothing further for this section") and a
// cell holding it is answered. See hasNewEtcValue.
export type NewEtcCellState = {
  priorEtc: number;
  hoursWorked: number;
  // The saved draft, if any.
  draft: number | null;
  // The submitted value — non-null ONLY on a submitted or historical month. This
  // is what makes a reopened cell arrive pre-filled.
  confirmed: number | null;
  // The cell was emptied DELIBERATELY (EtcEntry.newEtcClearedAt), as opposed to
  // never having been filled in. Kept — and load-bearing — after the Clear ETC
  // button's removal: it is what makes clearing an individual cell survive a
  // reload, because a null draft otherwise falls through to the confirmed value or
  // the carry-forward. See newEtcSeedText and DEVLOG §16.
  cleared: boolean;
  // A fully-submitted month nobody has reopened.
  locked: boolean;
  // Are the month's actuals complete? Gates the zero-hours carry-forward.
  // Gates the zero-hours carry-forward when the prior is NON-zero, so a partial
  // mid-month figure can't look final. A zero carry-forward ignores it — 0 cannot
  // masquerade as anything. See newEtcSeedText.
  monthComplete: boolean;
  // How this column seeds its box, because it decides what "unchanged" looks like
  // as a STRING:
  //   * "whole" (default) — the hours cells. Hours display as whole numbers
  //     everywhere, and the box is seeded with the same whole number it will
  //     submit (2026-08-03), so display, submission and next month's Prior ETC are
  //     one figure.
  //   * "exact" — Parts Cost, which is MONEY and keeps its cents. Rounding a
  //     dollar seed to whole would quietly drop cents from what a no-changes
  //     resubmit writes.
  precision?: "whole" | "exact";
};

function fmt(n: number, precision: "whole" | "exact" | undefined): string {
  return precision === "exact" ? String(round2(n)) : String(Math.round(n));
}

// A stored/announced New ETC value, as the CELL would print it.
//
// Same formatting the seed uses, exposed because a value can now reach a cell by a
// second route: a realtime change event naming that cell (lib/etc-remote-values.ts).
// It must land formatted identically to the seed or the two paths would disagree —
// an hours cell would show "93.75" where a page render shows "94", and the dirty
// tracker would then read the difference as an unsaved edit and try to save it back.
//
// null / "" / unparseable all mean "the cell is empty", which for a cleared cell is
// exactly what is being announced.
export function formatNewEtcText(value: string | null | undefined, precision?: "whole" | "exact"): string {
  if (value === null || value === undefined) return "";
  const trimmed = String(value).trim();
  if (trimmed === "") return "";
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return "";
  return fmt(n, precision);
}

// What the New ETC box holds on arrival.
export function newEtcSeedText(s: NewEtcCellState): string {
  // Cleared beats confirmed — that is the entire reason newEtcClearedAt exists.
  // A draft saved afterwards wins again, so re-entering a value un-clears the
  // cell even if the flag were somehow left behind.
  if (s.cleared && s.draft == null) return "";
  if (s.draft != null) return fmt(s.draft, s.precision);
  if (s.confirmed != null) return fmt(s.confirmed, s.precision);
  // ── Nothing worked this month ─────────────────────────────────────────────
  // New ETC just carries the prior forward, so there is no decision to make and the
  // box shows that figure. suggestNewEtc(prior, 0) IS priorEtc, so this is the
  // suggestion, spelled as the prior because that is what carrying forward means.
  //
  // Shown even for a section with NO row yet (2026-08-03, by request). Those cells
  // used to stay blank deliberately, which left whole stretches of the grid sitting
  // at Prior 0 / Worked 0 / Hours Left 0 with an empty New ETC and an empty Diff —
  // reading as missing data rather than as "nothing needed here".
  //
  // They were blanked because of a real outage, not fussiness: rendering a literal
  // "0" made every one of ~350 unquoted sections post a value, and Submit tried to
  // create them all in one transaction and timed out. That is now blocked at the
  // source — parseNewEtcCreateFields drops a 0 outright, specifically so nothing
  // downstream depends on this box being empty.
  //
  // A ZERO carry-forward shows even mid-month: monthComplete exists so a partial
  // figure cannot masquerade as final, and 0 cannot. A non-zero prior still waits
  // for the month's actuals to be complete.
  if (s.hoursWorked === 0 && (s.monthComplete || s.priorEtc === 0)) return fmt(s.priorEtc, s.precision);
  return "";
}

// Does this New ETC cell hold a value at all? THE one place that question is
// answered, so every consumer — the colour, the Diff, the live totals, the save
// action, the tests — draws the same line between "nothing entered" and "a figure
// entered".
//
// The distinctions that matter, stated once:
//   * null / undefined  -> no value (a cell that has never been filled in)
//   * ""  / "   "       -> no value (a cell somebody emptied)
//   * 0   / "0"         -> A VALUE. Zero hours to complete is a real plan, and
//                          treating it as blank was the bug this rule is written
//                          against. Same for "0.00" and "-0".
//   * any finite number -> a value, negative included where the column allows it
//
// Non-numeric junk ("abc") counts as a value here on purpose: the cell is not
// empty, the manager can see that it is not empty, and painting it as "nothing
// entered" would contradict the screen. Validation rejects it separately, at the
// point where it would be written (parseNewEtcField).
export function hasNewEtcValue(text: string | number | null | undefined): boolean {
  if (text === null || text === undefined) return false;
  return String(text).trim() !== "";
}

// Is a decision being asked for in this cell at all?
//
// Only when hours (or, for Parts Cost, money) were actually booked to it this
// month. With nothing spent, New ETC just carries the prior forward — there is
// nothing to judge, so the cell is never yellow, even mid-month.
export function isNewEtcDecisionRequired(s: NewEtcCellState): boolean {
  return s.hoursWorked !== 0;
}

// Has this cell been answered? `text` is the CURRENT contents — the live input
// value on the client, the seed text on the server. Yellow is !decided, so:
//
//     yellow  <=>  isNewEtcDecisionRequired(s)  &&  !hasNewEtcValue(text)
//
// Judged from the text the cell holds RIGHT NOW, which is what makes the colour
// live: it clears on the keystroke that fills the cell and comes straight back on
// the keystroke that empties it, with no save, refresh or remount involved.
//
// What is NOT considered any more (2026-08-04): whether the figure is merely the
// one last submission left behind. A reopened month's cells arrive pre-filled and
// that used to render the whole grid yellow — "still yellow with a value in it",
// which is what was reported. The rule is now purely about the colour.
export function isNewEtcCellDecided(s: NewEtcCellState, text: string): boolean {
  if (!isNewEtcDecisionRequired(s)) return true;
  return hasNewEtcValue(text);
}

// ── What a posted New ETC field MEANS ───────────────────────────────────────
//
// The single parse for every New ETC value that arrives from a browser, shared by
// the draft save and (through parseNewEtcCreateFields) the create path, so no
// caller can invent its own reading of an empty box.
//
// It exists because "clearing a value did not stick" was reported, and the reason
// was that a blank had no agreed meaning on the way in: `if (value) save(value)`
// logic — in various shapes — dropped it, so an empty box was indistinguishable
// from a field nobody sent. Four outcomes, and they are genuinely different
// things:
//
//   absent  — the field is not in the request at all. This save has NO OPINION
//             about the cell: it was filtered out of the view, or this user never
//             touched it. Leave the stored value exactly as it is.
//   clear   — the field IS present and empty. The user deliberately emptied a box.
//             That is an edit, and it must be persisted as one.
//   value   — a finite number, INCLUDING 0. "0" is not empty.
//   invalid — present, non-empty, and not a number this column accepts. Never
//             written, and never silently coerced to 0 or to the previous value.
export type NewEtcWriteIntent =
  | { kind: "absent" }
  | { kind: "clear" }
  | { kind: "value"; value: number }
  // `message` says what the cell wanted, so a refusal can be shown IN the cell
  // rather than swallowed (§27.9). Optional so older callers still typecheck.
  | { kind: "invalid"; raw: string; message?: string };

// ── Now a thin wrapper over the shared parser (§27, 2026-08-04) ─────────────
//
// The four outcomes above, and everything documented about them, are unchanged —
// they were the model for lib/cell-rules.ts, which now states them once for every
// editable cell in the app. What this delegation BUYS is the normalisation half,
// which this function did not have and which the Projects grid's money cells did:
//
//     "1,234"      was refused here, accepted on Projects
//     "$1,234.50"  was refused here, accepted on Projects
//     " 1 234 "    was refused here, accepted on Projects
//     "(1,234)"    refused in both — Excel's accounting negative
//
// A manager pasting one column out of one spreadsheet got two different answers
// depending on which grid the cell was in. That is the §27.3 complaint, and it is
// fixed by there being one parser rather than by patching this one.
//
// The numeric POLICY is deliberately unchanged: still 2 decimal places, still
// negatives-only-on-request. Tightening hours to whole numbers would be a
// behaviour change for people who type them, and belongs in its own decision
// rather than riding along with a parser swap.
export function parseNewEtcField(
  raw: FormDataEntryValue | string | null | undefined,
  opts: { allowNegative?: boolean } = {},
): NewEtcWriteIntent {
  const spec: FieldSpec = {
    ...CELL_SPECS["etc.newEtc.parts"],
    // 2dp and the same min/negative policy this function has always applied.
    decimals: 2,
    allowNegative: opts.allowNegative === true,
    min: opts.allowNegative ? undefined : 0,
  };
  const out = parseCell(raw, spec);
  switch (out.kind) {
    case "absent":
    case "clear":
      return out;
    case "invalid":
      return { kind: "invalid", raw: out.raw.trim(), message: out.message };
    default:
      return { kind: "value", value: out.value as number };
  }
}

// The app's 2-decimal rounding, now delegating to the one implementation that does
// not lose a cent to floating point — `Math.round(1.005 * 100) / 100` was 1.00,
// because 1.005 is stored as 1.00499999999999989. See roundTo in lib/cell-rules.ts.
export function round2(n: number): number {
  return roundTo(n, 2);
}

// ── Would this write revert another user? ────────────────────────────────────
//
// Optimistic concurrency for the New ETC draft save, and the rule that makes the
// 2026-08-04 multi-user bug unrepeatable. The client sends the value it BELIEVED
// was stored beside the value it wants to write; if the stored draft has moved
// since, somebody else saved this cell in between and this write would silently
// undo them.
//
// Pure and tested rather than inline in the action, because it is the one rule
// standing between two managers and a lost afternoon.
//
// Three deliberate decisions:
//
//   * `believedStored` null — the client said nothing (an older bundle, a
//     hand-posted request). NOT treated as stale: refusing every such write would
//     break saving for anyone on a cached page, which is a worse failure than the
//     one being prevented. The client-side payload trimming is what covers that
//     case; this is the second line.
//   * `storedDraft` null — nothing is stored, so there is nothing to revert. This
//     action never touches the CONFIRMED value (`newEtc`), only the draft, so a
//     cell with no draft is free to take one. UNLESS that null is a deliberate
//     clear (`storedCleared`) — see below.
//   * `storedCleared` — somebody emptied this cell on purpose, and the client
//     believed a figure was stored. That client is working from a page rendered
//     before the clear, so its write would restore the value that was just
//     removed. Refused, exactly like any other stale write: the requirement is
//     that "an older save request cannot restore the deleted value", and a clear
//     is the one edit whose stored form (null) is indistinguishable from "never
//     set" without this flag.
//   * Compared as NUMBERS, not as strings. "5819.03" and "5819.030" are the same
//     stored figure, and a formatting difference must not read as a conflict —
//     that would reject a legitimate save and tell the manager a colleague had
//     edited a cell nobody had touched.
//   * Compared at the precision the CELL DISPLAYS, which is what `precision` is
//     for. This is not a nicety: the hours cells seed from
//     `String(Math.round(n))` (see fmt), so a stored draft of 93.75 puts "94" in
//     the box. Comparing the client's "94" against 93.75 at 2dp would call every
//     such cell a conflict — refused, left dirty, blamed on a colleague who did
//     nothing, and never recoverable because the seed would keep rounding.
//     Parts Cost passes "exact" and keeps its cents. Same expression the grid uses
//     to seed the cell, so the two cannot disagree.
export function isStaleDraftWrite(opts: {
  believedStored: string | null;
  storedDraft: number | null;
  // Was the stored null written by a deliberate clear (EtcEntry.newEtcClearedAt)?
  storedCleared?: boolean;
  precision?: "whole" | "exact";
}): boolean {
  const { believedStored, storedDraft, storedCleared, precision } = opts;
  if (believedStored === null) return false;
  if (storedDraft === null) {
    // A deliberate clear is a value in its own right: "" is the only belief that
    // agrees with it, and anything else is a page that predates the clear.
    if (storedCleared) return believedStored.trim() !== "";
    return false;
  }
  const trimmed = believedStored.trim();
  if (trimmed === "") return true; // "I believe nothing is stored" — but something is.
  const believed = Number(trimmed);
  // Unparseable belief: cannot prove the client was up to date, so treat as stale
  // rather than write over a figure on the strength of a value we can't read.
  if (!Number.isFinite(believed)) return true;
  const at = (n: number) => (precision === "exact" ? round2(n) : Math.round(n));
  return at(believed) !== at(storedDraft);
}

// "YYYY-MM" for the given instant, local server time — the app's one definition
// of "what month is it right now." Three call sites each declared this same
// six-line function against local `new Date()`, while cash-flow-view.ts's own
// copy read `toISOString()` (UTC) instead — harmless most days, but the two
// conventions can name a DIFFERENT month for the same instant near a month
// boundary, depending on the server's UTC offset direction. This is the one
// version now; takes an explicit date so callers that need purity/testability
// (no I/O) can inject one, defaulting to "right now" for page-level callers.
export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// "YYYY-MM" month arithmetic, shared by seeding (carry-forward source), the
// in-order start guard, and the month picker's "next startable month" option.
export function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 2, 1); // m is 1-indexed; m-2 lands on the previous month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m, 1); // m is 1-indexed; index m is the next month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function isValidMonth(month: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

/**
 * The half-open UTC window a reporting month covers: `[start, endExclusive)`.
 *
 * Half-open on purpose, and the reason is §41.3's own wording — "Purchased Date >= July 1
 * and < August 1". A `<=` end bound would either drop everything booked on the 31st (if
 * the bound is midnight) or need a timezone-sensitive end-of-day, and both are how a
 * month-boundary purchase goes missing from every report.
 *
 * UTC, not local: the source dates are stored as plain dates, and a local-time window
 * shifts by the server's offset — which on a US host silently moves the first and last
 * few hours of every month into the neighbouring one.
 *
 * Extracted and tested because it is now the single definition used by the money that
 * this month reports (§41.4), and because year rollover is exactly the case an inline
 * `new Date(Date.UTC(y, m, 1))` gets right by accident and a refactor gets wrong.
 */
export function monthWindowUtc(month: string): { start: Date; endExclusive: Date } {
  if (!isValidMonth(month)) throw new Error(`${JSON.stringify(month)} is not a valid month.`);
  const [year, monthNum] = month.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, monthNum - 1, 1)),
    // Month index `monthNum` is the month AFTER a 1-indexed monthNum, and Date.UTC
    // normalises 12 into January of the next year — which is what makes December work.
    endExclusive: new Date(Date.UTC(year, monthNum, 1)),
  };
}

// The Prior ETC carry-forward source for every job/section: the New ETC of the
// LATEST month before `month` that has an entry for it — not necessarily the
// month immediately before.
//
// Why this is not just prevMonth (found 2026-08-02, job 1104):
//
// Seeding used to read prevMonth(month) alone, and fall back to the job's
// QUOTED hours when it found nothing. That fallback is right for a job with no
// ETC history at all — the report's own rule (verified 2026-07-17) is that a
// job entering its first ETC period starts from quoted. It is badly wrong for a
// job that merely SKIPPED a month, which happens whenever a job drops out of
// etcActiveJobFilter for one period and comes back: seedMonth doesn't seed it,
// pruneStaleEntries removes any unsubmitted row, and the month has no entry.
//
// The result was a silent balance RESET. 1104's ME Gen had been worked down
// 40 -> 9 -> 8 -> 40 -> 0 across five months, had no June row, and reappeared
// in July at 1420 — its full original quote. Across the grid that was 49
// entries on 21 jobs, and it inflates every figure downstream of Prior ETC:
// Hours Left, the suggested New ETC, and the dollars on the Standard sheet.
//
// Pure and separate from the query so the rule can be tested; callers pass
// whatever prior rows they've already fetched.
export function latestPriorEtcByKey<T extends { jobId: number; section: string; month: string; newEtc: unknown }>(
  priorEntries: T[],
): Map<string, number> {
  // Keyed jobId-section; the winner is the highest month string, which sorts
  // correctly because months are zero-padded YYYY-MM.
  const bestMonth = new Map<string, string>();
  const out = new Map<string, number>();
  for (const e of priorEntries) {
    const key = `${e.jobId}-${e.section}`;
    const seen = bestMonth.get(key);
    if (seen !== undefined && seen >= e.month) continue;
    bestMonth.set(key, e.month);
    out.set(key, Number(e.newEtc));
  }
  return out;
}

// The ONE rule for what a month's Prior ETC opens at, extracted so that every
// path that writes the column answers it identically: seedMonth (Refresh Data),
// cascadePriorEtcForward (a corrected month pushed forward), reopenMonth, and
// syncPartsCost.
//
// Two inputs and a precedence:
//   * `carried` — the New ETC of the LATEST earlier month holding this
//     job/section (latestPriorEtcByKey). NOT prevMonth: a job that skips a
//     period must resume where its balance left off. `undefined` means no ETC
//     history at all.
//   * `quoted` — the job's quote for this section (hours) or its Parts Cost
//     Quoted (money). Used when there is no history, and when the job STARTS
//     this month.
//
// startsThisMonth WINS over a carried balance: a job whose Start Date falls in
// the month opens at its quote whatever the chain says. This is Power BI's own
// rule ([ETC Historical Hours Prior Month] uses [Hours Quoted] there), and it is
// why jobs 1159/1160 stopped inheriting the 0 their pre-quote rows carried.
export function priorEtcForMonth(opts: { startsThisMonth: boolean; carried: number | undefined; quoted: number }): number {
  return round2(!opts.startsThisMonth && opts.carried !== undefined ? opts.carried : opts.quoted);
}

// "Which ETC month does this Start Date fall in?" — the other half of
// priorEtcForMonth, and the half that was being hand-inlined at every call site
// (seedMonth, derivePriorEtcForMonth, syncPartsCost, syncHoursWorked) as four
// copies of the same getUTC* template string. One of them getting it wrong is a
// job silently opening at the wrong figure, so it is one function.
//
// UTC deliberately, and it must stay UTC. Start Dates are written by parseDate in
// quoted-actions.ts from the grid's "YYYY-MM-DD" — a date-only ISO string, which
// the spec parses as UTC midnight. Reading it back with the LOCAL getMonth() in a
// negative-offset zone (SDC is UTC-4/-5) turns 2026-08-01T00:00:00Z into July 31st
// and drops the job's first ETC month by one, which is exactly the shift this
// centralization exists to make impossible to reintroduce.
//
// A year is compared as part of the string, never a bare month number: January
// 2027 against 2026-01 must not match.
export function monthOfDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Does `startDate` fall in `month`? Null (no Start Date on the job) is NOT this
// month: a job with no date has no known first ETC month, so it carries forward
// like any other rather than being reset to its quote every month forever.
export function startsInMonth(startDate: Date | null | undefined, month: string): boolean {
  return startDate != null && monthOfDate(startDate) === month;
}

// Does a saved draft merely ECHO the suggestion computed from the Prior ETC that
// was in place when it was written? If so it is not a decision, and it must move
// when that Prior ETC moves.
//
// Why this exists (found 2026-08-04, three of July 2026's Parts Cost cells):
// Save persists whatever the New ETC box CONTAINS, and on a zero-spend cell the
// box arrives pre-filled with the carry-forward. Job 979's parts cell was saved
// at 11:02 while its Prior ETC was still 0 — a draft of 0, correct at the time.
// A later Refresh moved that Prior to $8,600 and the stale 0 stayed, so the cell
// read "spend nothing, plan nothing" over a live $8,600 balance, and Submit would
// have written the 0 into history. 1159 was the same at $25,000 and 1105 at
// $636,234: $669,834 of parts balance about to be zeroed by a figure nobody typed.
//
// Deliberately exact-match only. A draft that differs from the old suggestion by
// even a cent is a manager's own number and is never touched. And a manager who
// typed the suggestion because they agreed with it wants the suggestion — which is
// what they get, recomputed from the figure that changed.
export function redrivenDraft(opts: {
  draft: number | null;
  oldPriorEtc: number;
  newPriorEtc: number;
  hoursWorked: number;
}): number | null {
  const { draft, oldPriorEtc, newPriorEtc, hoursWorked } = opts;
  if (draft === null) return null;
  if (round2(oldPriorEtc) === round2(newPriorEtc)) return round2(draft);
  if (round2(draft) !== round2(suggestNewEtc(oldPriorEtc, hoursWorked))) return round2(draft);
  return round2(suggestNewEtc(newPriorEtc, hoursWorked));
}

// Weekday (Mon–Fri) count for a "YYYY-MM" month — the same rule as the
// report's [ETC Historical Working Days] measure (COUNTROWS of 'Date' where
// Is Weekend = FALSE for the work month). No holiday calendar on either
// side, so plain weekday counting IS exact parity.
export function workingDaysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate(); // day 0 of next month = last day of this one
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(y, m - 1, d).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

// A month is locked once every entry in it has been submitted/confirmed.
// `length > 0` matters: `Array.every` on an empty array is vacuously true, which
// would make a month with no entries yet (never started) look "locked".
export function isMonthLocked(entries: { needsReview: boolean }[]): boolean {
  return entries.length > 0 && entries.every((e) => !e.needsReview);
}

// Is `month` safe for Power BI's LIVE hours/parts sync (Run Report)? Only the
// single most-recently-started month qualifies — either it's already the
// latest (an ongoing refresh) or it's the very next one (starting a new
// month, which has no entries yet so can never itself be "latest"). `null`
// latestMonth means no month has ever been started — anything goes.
//
// Found 2026-07-14: reopening an OLDER month and running Run Report seeds/
// resyncs it against TODAY's active-job roster and TODAY's raw actuals —
// wrong on both counts for a month that's already closed. Proven by directly
// reopening a corrected historical month and running it: real entries for
// since-completed jobs were deleted, and entries for jobs that only became
// active later were injected. See sync-etc-history.ts's assertCurrentEtcMonth.
export function isSafeForLiveEtcSync(month: string, latestMonth: string | null): boolean {
  if (latestMonth === null) return true;
  return month === latestMonth || month === nextMonth(latestMonth);
}

// Has Power BI actually published a real (non-blank) historical value for
// this month? Power BI's SUMMARIZECOLUMNS returns a row per Job/measure combo
// whether or not the period has been archived yet — an unarchived period
// still yields rows, just with every measure BLANK (→ null here). Used by
// sync-etc-history.ts to detect when a month that's locked in the app (and
// therefore normally skipped) now has real Power BI data available, so a
// premature/stale submission doesn't silently stay wrong forever — see the
// June 2026 data-correction incident.
export function hasPublishedHistory(rows: { NewEtc: number | null }[]): boolean {
  return rows.some((r) => r.NewEtc != null);
}

// Same idea as hasPublishedHistory, but for the 'Standard Fees' archive
// table, which reports existence via rows (a month with no archive yet
// simply has no rows at all) rather than a nullable measure. Splits Power
// BI's flat row list into per-month buckets, routing rows for an app-owned
// month into `ownedRowsByMonth` (+ `ownedWithHistoryNow` for visibility)
// instead of `rowsByMonth` — so syncCategoryPoolHistory can skip the normal
// full-replace path for that month while still reconciling its non-decision
// fact fields against the newly-available archive.
export function groupStandardFeesRows<Row>(
  rows: Row[],
  monthForRow: (row: Row) => string | undefined,
  ownedMonths: Set<string>
): { rowsByMonth: Map<string, Row[]>; ownedWithHistoryNow: string[]; ownedRowsByMonth: Map<string, Row[]> } {
  const rowsByMonth = new Map<string, Row[]>();
  const ownedRowsByMonth = new Map<string, Row[]>();
  const ownedWithHistoryNow: string[] = [];
  for (const row of rows) {
    const month = monthForRow(row);
    if (!month) continue;
    if (ownedMonths.has(month)) {
      if (!ownedWithHistoryNow.includes(month)) ownedWithHistoryNow.push(month);
      if (!ownedRowsByMonth.has(month)) ownedRowsByMonth.set(month, []);
      ownedRowsByMonth.get(month)!.push(row);
      continue;
    }
    if (!rowsByMonth.has(month)) rowsByMonth.set(month, []);
    rowsByMonth.get(month)!.push(row);
  }
  return { rowsByMonth, ownedWithHistoryNow, ownedRowsByMonth };
}

// ── The Parts Cost red-row warning was REMOVED (2026-09-04) ─────────────────
//
// By request: "Remove the existing feature that highlights an entire row red. Do not
// use row-level red backgrounds for Parts Cost validation/differences. Any
// status/difference indication should stay at the specific cell level only."
//
// It painted four cells of a row — Prior ETC, Money Spent, Money Left and New ETC —
// whenever the entered New ETC came in under the remaining parts cost, which read as
// "this row is broken" rather than "look at this number". The Diff column already
// carries the same information at cell level, and Left to Invoice now shows its own
// override highlight, so the row-wide wash was the only part that had to go.
//
// `partsCostRisk`, `partsCostRiskTitle`, `partsRiskStyle` and `paintPartsRisk` are all
// gone with it rather than left as dead code behind a flag.
