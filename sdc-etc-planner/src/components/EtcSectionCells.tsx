"use client";

import { useEffect, useState } from "react";
import {
  calcHoursLeft,
  suggestNewEtc,
  round2,
  newEtcSeedText,
  isNewEtcCellDecided,
  hasNewEtcValue,
  formatNewEtcText,
  etcCreateCellLiveKey,
  type NewEtcCellState,
} from "@/lib/etc";
import { registerEtcField, forgetEtcField, updateEtcField, adoptEtcFieldBaseline } from "@/lib/etc-dirty-tracker";
import { useRemoteEtcValue, forgetRemoteEtcValue } from "@/lib/etc-remote-values";
import { useCellSaveState, cellSaveStateStyle, setCellInvalid, clearCellSaveState, useCellInvalidMessage } from "@/lib/etc-save-state";
import { CELL_SPECS, parseCell, type FieldSpec } from "@/lib/cell-rules";
import { requestAutosaveFlush } from "@/lib/autosave";

// What this column accepts, from the registry (§27.2). Deliberately the SAME effective
// spec the server applies in parseNewEtcField — 2 decimal places, no negatives — rather
// than the stricter whole-number rule the hours column displays with. Tightening hours
// to integers is a real decision with a user-visible consequence (typing "93.75" would
// start being refused), and it belongs in its own change rather than arriving as a side
// effect of adding validation feedback. What matters here is that the cell and the write
// agree, and they do.
// `decimal`, not `currency`: same policy, but the refusal reads "New ETC must be a
// number greater than or equal to 0" rather than "an amount", which is the wrong noun
// for a column of hours.
const NEW_ETC_SPEC: FieldSpec = { ...CELL_SPECS["etc.newEtc.parts"], label: "New ETC", kind: "decimal", decimals: 2, min: 0 };
import { publishEtcCell, forgetEtcCell } from "@/lib/etc-live-totals";
import { CellPresence } from "@/components/CellPresence";
import { beginEditingCell, endEditingCell } from "@/components/RealtimeProvider";
import { hours as formatHours } from "@/components/ui/format";
import { ETC_COL_W } from "@/components/ui/classnames";
import { diffCellStyle, DIFF_CEILING } from "@/components/ui/etc-diff-colors";

const HOURS_WORKED_BG = "bg-[#C7DAF7]";
const HOURS_LEFT_BG = "bg-[#F1F6FD]";
function newEtcBg(hasValue: boolean) {
  return hasValue ? "bg-[#F2F2F2]" : "bg-[#FAFAC4]";
}
// The Diff colouring is shared with etc/page.tsx and, crucially, with the live
// repaint in EtcLiveTotals — see components/ui/etc-diff-colors.ts. It is a gradient
// now: the shade carries HOW FAR off plan, not just which side.
// Whole hours with thousands separators, via the shared formatter — these cells
// sit in the same rows as the ones rendered by etc/page.tsx, so the two must
// format identically or one grid row would print "1,769" beside "1769".
//
// Display only. The hidden hoursWorked field submits String(worked) and the New
// ETC input holds its own raw text, both deliberately unformatted: a comma here
// would reach submitMonth's Number() parse as NaN.
function wholeNum(n: number): string {
  return formatHours(n);
}

// Live client-side counterpart to a section's 4 derived cells (Hours Worked,
// Hours Left, New ETC, Diff). Hours Worked Month is read-only display (it
// auto-syncs from Power BI — see instrumentation.ts) but still rides along
// in the form submission via a hidden input, since submitMonth reads it by
// `name` unchanged. New ETC recomputes client-side as Hours Worked changes
// between syncs, so Hours Left/New ETC/Diff stay in sync without waiting for
// the next Submit or Sync round-trip.
export function EtcSectionCells({
  entryId,
  jobId,
  sectionCode,
  billingGroup,
  edge,
  jobName,
  sectionName,
  priorEtc,
  initialWorked,
  initialDraft,
  initialConfirmed,
  cleared,
  locked,
  monthComplete,
  month,
}: {
  // NULL when this job/section has no EtcEntry yet.
  //
  // startMonth seeds one row per section the job was QUOTED for, so a section it
  // was never quoted for had no row — and the grid printed a dead "—" in all five
  // of its columns. 357 of July's 754 cells were like that (2026-08-03), so a
  // manager could not plan a section simply because nobody had quoted it, even
  // with work happening there.
  //
  // Now every cell is editable and the row is CREATED on save if a value is
  // typed. Prior ETC and Hours Worked are 0 for these, which is exactly what they
  // are — no prior estimate, no time booked yet.
  entryId: number | null;
  // Which job this cell belongs to and which rollup block it feeds. Used to
  // publish the cell's live figures (lib/etc-live-totals.ts) so the row totals,
  // the grand-total row and the Standard Sheet can move as you type — and, when
  // entryId is null, to name the field the create-on-save path reads.
  jobId: number;
  sectionCode: string;
  billingGroup: "Engineering" | "Shop";
  edge: string;
  jobName: string;
  sectionName: string;
  priorEtc: number;
  initialWorked: number;
  initialDraft: number | null;
  // The entry's confirmed New ETC when it was already submitted once (a
  // REOPENED month) — null on a first-pass month. Without this, a reopened
  // cell seeded blank (worked > 0) or with priorEtc (worked == 0), so a
  // no-changes resubmit posted those seeds as overrides and silently
  // replaced the manager's confirmed values — found 2026-07-14, where 135
  // of April's 366 cells had a worked==0 manager override != priorEtc that
  // a round-trip would have wiped.
  initialConfirmed: number | null;
  // This cell was emptied DELIBERATELY (EtcEntry.newEtcClearedAt). Without it, a
  // cleared cell on a reopened month would seed straight back from initialConfirmed
  // above and the clear would look like it never happened.
  cleared?: boolean;
  locked: boolean;
  // False while the month's actuals are still incomplete (Paylocity not yet
  // refreshed through month-end). When false we do NOT auto-fill the New ETC
  // carry-forward — the cell stays blank until the month is complete, so a
  // partial-month value never looks final. Submit still falls back to the
  // suggestion, so nothing is lost.
  monthComplete?: boolean;
  // Which month this grid shows. Only used to scope the realtime and presence key
  // of a cell that has no row yet — see `liveKey` below.
  month: string;
}) {
  // Hours Worked Month is no longer manager-editable — it auto-syncs from
  // Power BI on the same cadence as the rest of the live sync (see
  // instrumentation.ts), so a manual edit would just get overwritten anyway.
  //
  // The hidden form input must carry the EXACT stored value, not the rounded
  // display text: submitMonth writes this value back to hoursWorked, so
  // posting the display rounding would permanently replace every fractional
  // Power-BI-synced value (e.g. 40.33) with its integer on each Submit —
  // manufacturing drift against the source that the history reconcile would
  // then keep flagging. Rounding is display-only.
  const worked = round2(initialWorked);
  const workedDisplay = wholeNum(initialWorked);
  // Hoisted out of the useState initializer because the unsaved-changes
  // tracker needs the same value as its baseline — the cell is "dirty" only
  // when what's in it differs from what it loaded with, so both have to read
  // from one expression or they'd drift apart.
  // Hours show as WHOLE numbers everywhere in the app (ui/format.ts), but this
  // cell is an <input> and seeded itself with the stored Decimal verbatim — so
  // the New ETC column printed 93.75, 410.57, 15.48 while every figure around it,
  // including the totals that sum this very cell, was rounded. Rounded on the way
  // in (2026-08-03, by request) so what is displayed, what is submitted, and what
  // carries into next month's Prior ETC are all the same number.
  //
  // The seeding rule itself lives in lib/etc.ts (newEtcSeedText) so the server can
  // answer "what would this box hold" identically — a cell with NO row yet stays
  // blank rather than auto-filling (its Prior ETC is 0, so the zero-hours
  // carry-forward would print a literal "0" in ~350 empty boxes and post a create
  // for every unquoted section).
  const cellState: NewEtcCellState = {
    priorEtc,
    hoursWorked: worked,
    draft: initialDraft,
    confirmed: initialConfirmed,
    cleared: cleared === true,
    locked,
    monthComplete: monthComplete !== false,
  };
  // An existing row is addressed by its entry id; one that does not exist yet is
  // addressed by job + section, and saveAllNewEtcDrafts/submitMonth create it.
  // Two prefixes rather than one overloaded name, so a malformed id can never be
  // mistaken for a create instruction.
  //
  // Declared here, above everything that uses it, because the realtime lookup below
  // is keyed on it — a change event names the cell by this exact string.
  const fieldName = entryId != null ? `newEtcOverride__${entryId}` : `newEtcCreate__${jobId}__${sectionCode}`;
  // Stable key for the live-totals store, which cannot use an id that has not
  // been assigned yet.
  const cellKey = entryId != null ? String(entryId) : `${jobId}:${sectionCode}`;
  // What a colleague's save is DELIVERED under, and what the presence marker hangs on
  // (2026-09-11). For an existing row it is the field name. For a cell with no row it
  // is the field name PLUS the month, because the bare name is identical for this
  // job/section in every month that has no row here — so a September save reached
  // a clean August cell and was adopted as August's value. The form field name itself
  // is unchanged; only what the realtime layer keys on. See etcCreateCellLiveKey.
  const liveKey = entryId != null ? fieldName : etcCreateCellLiveKey(jobId, sectionCode, month);

  const seedText = newEtcSeedText(cellState);
  const [newEtcText, setNewEtcText] = useState(seedText);

  // ── What the server last said about this cell ──────────────────────────────
  //
  // Two ways it can speak, and they are the same fact from this cell's point of
  // view, so they go through ONE variable:
  //
  //   * a full route render — `seedText`, from the props above.
  //   * a realtime change event naming this cell — the incremental path added in the
  //     2026-08-04 performance pass. It exists because the alternative was asking the
  //     server to re-render all 4,150 cells (854 KB, ~600ms) for one number; see
  //     lib/etc-remote-values.ts.
  //
  // A remote value is a patch on TOP of the last render, so it must not outlive it: as
  // soon as the props bring a new server value, the patch is dropped (the effect
  // below). A full payload is newer and more complete than any single event — it may
  // carry changes whose events this tab never received — so it always wins. That is
  // what keeps an older response from replacing a newer result.
  const remoteRaw = useRemoteEtcValue(liveKey);
  // Where THIS cell's save got to (§17): saving / saved / failed / conflict. A ring on
  // the cell, because a single toolbar chip cannot answer "did my cell save" on a grid
  // this size. See lib/etc-save-state.ts.
  const saveState = cellSaveStateStyle(useCellSaveState(fieldName));
  // The rule this cell broke, in the words lib/cell-rules.ts produced — "New ETC must
  // be a whole number greater than or equal to 0." (§27.9: identify the expected
  // format or allowed range, rather than only marking the cell red).
  const invalidMessage = useCellInvalidMessage(fieldName);
  const initialText = remoteRaw == null ? seedText : formatNewEtcText(remoteRaw, cellState.precision);

  // ── Adopt what another user saved, without touching this user's typing ──────
  //
  // Half of the multi-user bug fixed on 2026-08-04: even once the server was
  // re-queried (LiveRefresh) and the payload arrived with a colleague's new
  // figure, this cell would not show it. `useState` runs its initializer once, so
  // the mount-time value was permanent until the component unmounted — and the
  // only thing that unmounts these is the month switch (key={month} on the grid).
  // router.refresh() deliberately preserves state, so it could not help either.
  //
  // The rule is the same one MoneyCell uses: if the box still holds exactly what
  // the server last sent, take the new value. If the user has typed something
  // else, that is an unsaved edit and it wins — it stays on screen, stays dirty,
  // and autosave still tries to persist it.
  const [serverText, setServerText] = useState(initialText);
  if (serverText !== initialText) {
    const wasClean = newEtcText === serverText;
    setServerText(initialText);
    if (wasClean) setNewEtcText(initialText);
  }

  const hoursLeft = calcHoursLeft(priorEtc, worked);
  const suggested = suggestNewEtc(priorEtc, worked);
  // ── The yellow cell, in one line ───────────────────────────────────────────
  //
  //     yellow  <=>  a decision is required here  AND  the box is empty
  //
  // A decision is required when this section actually logged hours this month
  // (worked > 0). With no hours worked, New ETC just carries the prior forward —
  // nothing to decide — so the cell stays neutral even mid-month.
  //
  // Both halves read the LIVE input text (lib/etc.ts owns the rule; hasNewEtcValue
  // owns what "empty" means). That is what makes the colour honest with no save,
  // refresh, tab switch or remount involved: it clears on the keystroke that fills
  // the cell and returns on the keystroke that empties it. 0 and "0" are VALUES —
  // a section planned at zero has been answered.
  //
  // Two earlier versions of this rule are worth remembering, because both produced
  // a cell whose colour disagreed with its contents:
  //   * a latching `newEtcTouched` flag — filling a cell and emptying it again left
  //     it neutral, i.e. a section with hours worked and no New ETC looking done.
  //   * "a reopened month asks again" (2026-08-03 – 2026-08-04) — on a reopen every
  //     cell arrives carrying the value it was submitted with, so the entire grid
  //     rendered yellow WITH VALUES IN IT. That was reported as the bug it is:
  //     yellow tells a manager to type something, and these cells were not asking
  //     for anything. (The Clear ETC button that needed that question has since
  //     been removed outright — §14.)
  const filled = hasNewEtcValue(newEtcText);
  const decided = isNewEtcCellDecided(cellState, newEtcText);
  const newEtcNum = Number(newEtcText);
  const effective = newEtcText.trim() === "" || !Number.isFinite(newEtcNum) ? suggested : newEtcNum;
  // Live for every cell, typed or not (2026-08-02, by request). It used to
  // render "—" until a manager typed a New ETC, which meant the column was
  // blank across most of the grid for most of the month and hid the one thing
  // it exists to show: a section that has already burned past its Prior ETC.
  //
  // With the cell blank, `effective` is the suggestion — so the number reads 0
  // while there are hours left, and turns into the overrun only once Hours Left
  // goes negative (suggestNewEtc clamps at 0, Hours Left doesn't). An untouched
  // cell is therefore quiet unless it's genuinely overspent.
  //
  // Matches newEtcDiff() server-side, so this cell, the row totals and the KPI
  // cards all still count the same set.
  // Diff reads an EMPTY New ETC as 0, and a typed one as max(value, 0)
  // (2026-08-03, by request) — matching newEtcDiff() server-side exactly, which
  // is what keeps this cell, the row totals, the grand total and the KPI cards
  // counting the same thing.
  //
  // Deliberately NOT `effective`: that still falls back to the suggestion because
  // it is what the month would submit as, and next month's Prior ETC carries from
  // it. The two answer different questions — "what is planned" vs "what has been
  // decided" — and only the second one belongs in a variance column.
  // An UNDECIDED cell contributes NOTHING — matching newEtcDiff() server-side, so
  // this cell, the row totals, the grand total and the KPI cards all count one
  // set. It used to subtract 0 here, which made Diff equal Hours Left and fed
  // that same figure into the "unplanned" KPI split.
  const diff = filled ? hoursLeft - Math.max(effective, 0) : 0;

  // ── What the row PRINTS, as opposed to what it computes ────────────────────
  //
  // Reported 2026-08-03: "a lot of values are wrong based on the formulae".
  // Audited across July's 398 hours cells — the maths is right everywhere
  // (stored Hours Left matches Prior − Worked, and Diff never violated
  // Hours Left − New ETC). What was wrong was the PRINTING.
  //
  // Prior ETC is always a whole number; Hours Worked is not (129 of 398 cells
  // carry a fraction, straight from the punch feed). Rounding each cell on its
  // own then breaks the visible subtraction whenever Worked lands on exactly
  // x.5 — and the 18 rows that looked wrong were exactly the 18 x.5 cells:
  //
  //     job 1118 ME Gen — exact 40 − 1.5 = 38.5
  //     printed          — 40 − 2 = 39      (both halves rounded UP)
  //
  // So the derived cells are printed from the printed inputs, not rounded
  // independently. Because Prior is whole, that makes every row satisfy both
  // formulas exactly, as a reader checking the arithmetic expects.
  //
  // The EXACT values above are untouched and are what gets published to the
  // totals, submitted, and reconciled against Power BI — only these three
  // strings change. A column total is therefore still the rounded exact sum
  // rather than the sum of the rounded cells, which can differ by a few hours
  // (measured: 4h Engineering, 1h Shop for July). That is deliberate: the totals
  // are what reconcile to the model, and normal practice for rounded reporting.
  // Both figures remain exact in the cell tooltips.
  const workedRounded = Math.round(worked);
  const hoursLeftShown = Math.round(priorEtc) - workedRounded;
  // Empty string, not a number, when nothing has been decided — see `diff` above.
  const diffShown = filled ? hoursLeftShown - Math.round(Math.max(effective, 0)) : null;


  // Register the value this cell LOADED with, so the unsaved-changes guards
  // can tell an actual edit from a keystroke that was undone. Unregistering on
  // unmount is what makes a month switch reset the guard: the grid form is
  // keyed on the month, so every cell here is torn down and takes its entry
  // in the tracker with it.
  //
  // Mount effect, not render: registering during render would be a side
  // effect, and a change event can't fire before mount anyway. `newEtcText` is
  // intentionally not a dependency — this captures the INITIAL value once, and
  // re-running it on every keystroke would make the baseline chase the edits
  // and nothing would ever read as dirty.
  useEffect(() => {
    registerEtcField(fieldName, initialText);
    return () => forgetEtcField(fieldName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldName]);

  // Keep the baseline honest when the box and the server agree.
  //
  // Two ways to get here: the cell adopted a value another user saved (see the
  // clean/dirty rule above), or the user typed the server's value back by hand.
  // Either way the cell is genuinely unchanged, and saying so is what stops
  // autosave posting it — which would otherwise be rejected by the stale-write
  // guard and reported as a conflict on a cell nobody edited.
  //
  // Safe to run on every render: adoptEtcFieldBaseline is idempotent, and while
  // the user has an unsaved edit the two are unequal so nothing happens.
  useEffect(() => {
    if (newEtcText === initialText) adoptEtcFieldBaseline(fieldName, initialText);
  }, [fieldName, initialText, newEtcText]);

  // A fresh SERVER RENDER retires the realtime patch for this cell.
  //
  // The incremental path (lib/etc-remote-values.ts) exists so one colleague's value
  // does not cost a full re-render of the page. But a full render, when one does
  // happen, is strictly better information: it is a complete snapshot, and it may
  // carry changes whose events this tab never received (a dropped SSE frame, a
  // reconnect gap). So the moment `seedText` moves, the patch is dropped and the
  // props win — which is what makes it impossible for a cached event to reinstate a
  // value the database no longer holds, cleared values included.
  //
  // Keyed on seedText alone: an unchanged prop means the server has said nothing new
  // and the patch is still the freshest thing this cell knows.
  useEffect(() => {
    forgetRemoteEtcValue(liveKey);
  }, [liveKey, seedText]);

  // Publish this cell's live figures for the totals that sum it — the row's
  // TOTAL (NEW ETC) block, the grand-total row, and the Standard Sheet's
  // Total ETC $ / % Total / Standard Fees chain.
  //
  // The values published are the ones computed ABOVE for this cell's own
  // display, so a total can never show something the cell it sums doesn't. That
  // is the whole safety argument: this page is what Submit ETC freezes, and a
  // live total derived by some second formula would be worse than a stale one.
  //
  // In an effect rather than during render: publishing mutates a module store,
  // and a render React discards must not be allowed to change what other
  // components read.
  useEffect(() => {
    // ── `effective` is what SUBMIT would write; 0 is what the CELL shows (§44) ──
    //
    // The hours columns had the same defect the Parts Cost column did: a blank box
    // published its suggestion (Hours Left) into the footer, so the total counted a
    // figure the cell did not display and typing a value made the total FALL. See the
    // long note in PartsCostNewEtcCell — same reasoning, same fix, and it lands here
    // too because both columns feed one store.
    //
    // `filled` is the same flag `diff` above already uses to contribute nothing, so
    // after this the two columns agree about a blank cell for the first time.
    //
    // Submit is unaffected: it re-derives the suggestion server-side from the stored
    // row, and next month's Prior ETC still carries from it.
    publishEtcCell(cellKey, {
      jobId,
      billingGroup,
      sectionCode,
      prior: priorEtc,
      worked,
      hoursLeft,
      effective: filled ? Math.max(effective, 0) : 0,
      diff,
      decided: filled,
    });
  }, [cellKey, jobId, billingGroup, sectionCode, priorEtc, worked, hoursLeft, effective, diff, filled]);

  // Unmount is what makes a month switch or a column filter self-cleaning: the
  // grid is keyed on the month, so every cell tears down and takes its
  // contribution to the totals with it.
  useEffect(() => {
    return () => forgetEtcCell(cellKey);
  }, [cellKey]);

  function handleNewEtcChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    setNewEtcText(raw);
    // ── Validate on the keystroke, against the shared rule (§27.9) ──────────
    //
    // The SAME spec the server action re-checks (lib/cell-rules.ts), so the cell and
    // the write cannot disagree about what this column accepts. Three things follow
    // from a refusal, and all three are what §27.9 asks for:
    //
    //   * the typed text stays exactly where the user put it — this branch never
    //     touches `raw`, so nothing is reset, coerced or blanked;
    //   * the cell is not reported to the dirty tracker, so autosave never sends it
    //     and the status chip cannot claim "All changes saved";
    //   * and it does not reach the live totals, because the effect above publishes
    //     the parsed figure, not this string — an invalid cell contributes nothing
    //     rather than contributing a NaN.
    const parsed = parseCell(raw, NEW_ETC_SPEC);
    if (parsed.kind === "invalid") {
      setCellInvalid(fieldName, parsed.message);
      return;
    }
    clearCellSaveState(fieldName);
    // Nothing persists from typing alone — autosave batches every currently-typed
    // value across the grid ~0.8s after the last keystroke. This just reports the
    // current value so the "unsaved changes" guards know whether anything actually
    // differs from what was loaded. Typing a value and then putting the cell back how
    // it was leaves the grid clean.
    updateEtcField(fieldName, raw);
  }

  // Which view keys hide this cell. Space-separated and matched with `[data-col~=]`,
  // so ONE attribute answers both "is this section hidden" and "is this billing group
  // hidden" — the Monthly ETC View menu filters by group, and the cell does not need
  // to know which of the two is being used. See lib/grid-view.ts.
  //
  // On all five cells rather than a wrapper, because there is no wrapper: these are
  // sibling <td>s in the row, and a <td> is the only thing a column can be hidden by.
  const colKey = `${sectionCode} ${billingGroup}`;

  return (
    <>
      <td data-col={colKey} className={`${edge} ${ETC_COL_W} overflow-hidden bg-[#5E91D3] px-1 py-1 text-center align-middle text-label whitespace-nowrap text-sdc-gray-700`} title={String(round2(priorEtc))}>
        {wholeNum(priorEtc)}
      </td>
      <td
        data-col={colKey}
        className={`border-l border-sdc-border ${ETC_COL_W} ${HOURS_WORKED_BG} overflow-hidden px-1 py-1 text-center align-middle text-label whitespace-nowrap text-sdc-navy`}
        title={String(worked)}
      >
        {/* Read-only — auto-synced from Power BI, not manager-editable. The
            hidden input still carries the value into the form submission,
            since submitMonth reads it by `name` unchanged. */}
        {/* Only a real row has hours to submit back. A not-yet-created cell has
            no hours by definition, and posting a hoursWorked field for an id that
            does not exist would be meaningless. */}
        {entryId != null && <input type="hidden" name={`hoursWorked__${entryId}`} value={String(worked)} />}
        {workedDisplay}
      </td>
      <td
        data-col={colKey}
        className={`border-l border-sdc-border ${ETC_COL_W} ${HOURS_LEFT_BG} overflow-hidden px-1 py-1 text-center align-middle text-label whitespace-nowrap text-sdc-muted`}
        title={`${round2(hoursLeft)} = Prior ETC (${round2(priorEtc)}) − Hours Worked (${worked})`}
      >
        {wholeNum(hoursLeftShown)}
      </td>
      {/* `relative` so the presence marker can sit in the corner without changing
          the cell's size — see CellPresence. */}
      {/* motion-cell (§36.7): the yellow ⇄ neutral fill crossfades over
          --motion-hover instead of snapping. It changes on a KEYSTROKE — filling the
          box clears the flag, emptying it brings it back — so §36.7's "yellow
          highlighting should appear or disappear smoothly without delay" is really
          two requirements, and 120ms satisfies both.
          background-color only, deliberately: this cell also wears the save-state
          ring (a box-shadow) and lives under the row-hover rule, whose highlight is an
          inset shadow with a 9999px spread. See the class in globals.css. */}
      <td
        data-col={colKey}
        className={`motion-cell relative border-l border-sdc-border ${ETC_COL_W} ${newEtcBg(decided)} ${saveState?.ring ?? ""} px-1 py-1 text-center align-middle whitespace-nowrap`}
        title={invalidMessage ?? saveState?.title}
        // Announced, not just coloured: a red ring is invisible to a screen reader and
        // to anyone who cannot distinguish the shade from the yellow "needs attention"
        // background two cells over.
        aria-invalid={invalidMessage ? true : undefined}
      >
        <CellPresence cellKey={liveKey} />
        {/* No hours worked -> carry-forward is deterministic, safe to auto-fill.
            Hours worked > 0 -> a manager's judgment call, not auto-filled;
            flagged yellow so it's obviously not done yet — left with no
            placeholder hint (rather than showing the suggestion) so the cell
            reads as genuinely blank until the manager types a value.
            Typing autosaves 800ms after the last keystroke (EtcAutosave), and so
            does EMPTYING it — Delete/Backspace on a focused cell (which arrives
            fully selected, see ExcelCellFocus) is a save like any other edit. */}
        <input
          // ── text, not number (§27.3, 2026-08-04) ─────────────────────────
          //
          // `type="number"` looks like the safe choice and is the reason the shared
          // parser could not reach this cell at all. The browser DISCARDS anything it
          // cannot read as a number before any handler runs: paste "$1,234" or "1,234"
          // out of the spreadsheet this grid replaces and the box goes EMPTY — which
          // this cell then reads, correctly, as a deliberate clear. So the one input
          // people paste into was the one input that silently threw the paste away and
          // wiped the cell instead. (Found by testing exactly that, live.)
          //
          // As text, the value arrives intact and lib/cell-rules.ts decides — accepting
          // the separators and the currency symbol, refusing the genuinely ambiguous,
          // and saying which it was. Same move MoneyCell already made for the Projects
          // grid's money cells, and for the same reason.
          //
          // Nothing is lost visually: the spinners were already suppressed in CSS
          // below, and `step`/`min` were never a real guard — a number input enforces
          // them on arrow keys and on form validation, neither of which this cell uses.
          // The rule now lives in NEW_ETC_SPEC, where the server reads it too.
          type="text"
          inputMode="decimal"
          name={fieldName}
          value={newEtcText}
          // What the SERVER last sent for this cell. Read by ExcelCellFocus so
          // Escape restores the last saved value (Excel's cancel-edit), and it is
          // deliberately `serverText` rather than the mount-time seed: after a save
          // or an adopted colleague's figure, THAT is what cancelling should return
          // to.
          data-baseline={serverText}
          onChange={handleNewEtcChange}
          // Presence: focus claims the cell, blur releases it. Other users see the
          // marker from the moment the caret lands here, which is the point — they
          // need it BEFORE they type, not after a conflict.
          onFocus={() =>
            beginEditingCell({
              tab: "Monthly ETC",
              rowRef: jobName,
              columnName: sectionName,
              cellKey: liveKey,
            })
          }
          onBlur={() => {
            endEditingCell(liveKey);
            // Commit on leaving the cell rather than waiting out the debounce (§43).
            // The 800ms exists to batch keystrokes WITHIN a cell; once focus has gone
            // there is nothing left for it to batch, and every millisecond of it is
            // delay before the value can be saved and broadcast to anybody else.
            // A no-op when this cell is clean — see requestAutosaveFlush.
            requestAutosaveFlush();
          }}
          disabled={locked}
          aria-label={`New ETC override, ${jobName}, ${sectionName}`}
          className="w-full [appearance:textfield] rounded-md border-none bg-transparent px-1.5 py-0 text-center text-label font-bold leading-none text-sdc-gray-600 outline-none placeholder:font-bold placeholder:text-sdc-gray-600 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none focus:bg-white focus:shadow-sm"
        />
      </td>
      <td
        data-col={colKey}
        className={`border-l border-sdc-border ${ETC_COL_W} ${diffShown == null ? "bg-white" : ""} overflow-hidden px-1 py-1 text-center align-middle text-label whitespace-nowrap text-sdc-gray-700`}
        // Coloured from the ROUNDED value, so the shade matches the number printed
        // in the cell rather than the exact figure behind it. Recomputed on every
        // keystroke, since diffShown derives from the live New ETC text.
        style={diffCellStyle(diffShown, DIFF_CEILING.hoursCell)}
        // The tooltip is where an EMPTY cell explains itself — there is no number
        // to hover, so it says why, and what would happen on submit anyway.
        title={
          filled
            ? `${round2(diff)} = Hours Left (${round2(hoursLeft)}) − New ETC (${round2(Math.max(effective, 0))})`
            : `No New ETC entered yet, so there is nothing to compare against and no variance to report. ` +
              `Hours Left is ${round2(hoursLeft)}; submitting as-is would use the suggestion, ${round2(suggested)}.`
        }
      >
        {diffShown == null ? "" : wholeNum(diffShown)}
      </td>
    </>
  );
}
