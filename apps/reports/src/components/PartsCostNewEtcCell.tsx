"use client";

import { useEffect, useRef, useState } from "react";
import { registerEtcField, forgetEtcField, updateEtcField, adoptEtcFieldBaseline } from "@/lib/etc-dirty-tracker";
import { PARTS_COL_W } from "@/components/ui/classnames";
import { usd, usdExact } from "@/components/ui/format";
import { publishPartsCell, forgetPartsCell, readPartsBreakoutSum, subscribeEtcLiveTotals } from "@/lib/etc-live-totals";
import { isNewEtcCellDecided, formatNewEtcText, round2, type NewEtcCellState } from "@/lib/etc";
import { useRemoteEtcValue, forgetRemoteEtcValue } from "@/lib/etc-remote-values";
import { useCellSaveState, cellSaveStateStyle } from "@/lib/etc-save-state";
import { CellPresence } from "@/components/CellPresence";
import { beginEditingCell, endEditingCell } from "@/components/RealtimeProvider";

const NEUTRAL_BG = "bg-[#F2F2F2]";
const ATTENTION_BG = "bg-[#FAFAC4]";

// Money formatting comes from ui/format (§39.13), not a local copy of it.
const currency = usd;

// Parts Cost's New ETC cell. Deliberately mirrors the New ETC cell in
// EtcSectionCells rather than reusing EtcDraftInput:
//   * NO autosave on blur — typing persists nothing on its own. The whole grid
//     is one <form>; the toolbar's (password-gated) Save button batch-saves
//     every `newEtcOverride__<id>` field at once. The old blur-autosave here
//     bypassed that gate, which was the one inconsistency in the column.
//   * Live "needs attention" background — yellow only when money was actually
//     spent this month and no value is decided yet; clears the instant the
//     manager types (touched), exactly like the section-hours cells.
//   * NO placeholder. Also like the section-hours cells: money spent means the
//     next figure is a manager's call, and the cell must read as blank until
//     one is made.
//   * Reports its value to the dirty tracker on change so the "unsaved
//     changes" guards cover Parts Cost too — by value, so re-typing the
//     original figure leaves the grid clean.
// Currency masking (plain digits while focused, "$X,XXX" once blurred) is kept
// from the old EtcDraftInput currency mode; the raw digits ride along in a
// hidden input under `name`, so Save/Submit parse a clean number.
export function PartsCostNewEtcCell({
  name,
  jobId,
  priorEtc,
  spent,
  suggested,
  jobName,
  initialValue,
  cellState,
  hint,
  locked,
  derived = false,
}: {
  name: string;
  // Published to lib/etc-live-totals.ts so this cell's dollars reach Total ETC $
  // — and through it % Total, Standard Fees and Total Standard Fees — as they are
  // typed. `suggested` is the server's own suggestNewEtc for this cell, passed in
  // rather than recomputed so the live figure and the submitted one agree.
  jobId: number;
  priorEtc: number;
  spent: number;
  suggested: number;
  jobName: string;
  initialValue: string;
  // This cell's whole state, so "is it decided" comes from the ONE rule in
  // lib/etc.ts that also colours the section-hours cells —
  // rather than the private expression this cell used to carry. That expression
  // treated any submittedAt as decided, so on a reopened month every Parts Cost
  // cell read as settled while the hours cells beside it correctly went yellow.
  //
  // All primitives, so it crosses the server/client boundary as plain data.
  // Whether a value is PRESENT is still judged from the live input below, so
  // clearing a cell by hand brings the yellow straight back.
  cellState: NewEtcCellState;
  // Tooltip only — deliberately NOT a placeholder. A placeholder here renders
  // bold in the same grey as a real value, so an untouched cell read as a
  // decided one; see the call site in etc/page.tsx.
  hint?: string;
  locked?: boolean;
  // ── Calculated, not typed (2026-09-03, by request) ────────────────────────
  //
  // On a month that has the breakout columns, New ETC is no longer something a
  // manager enters: it is Left to Invoice + Left to Purchase, and those two cells are
  // what they type (components/PartsBreakoutCell.tsx). The cell then renders as text
  // instead of an input and takes its value from the live breakout store.
  //
  // It is still the SAME cell rather than a separate read-only one, and that is the
  // point of a flag here rather than a second component. Everything hanging off this
  // figure — the published dollars behind Total ETC $, the row Diff, the footer, the
  // under-planning warning, the `newEtcOverride__<id>` field Save and Submit read —
  // has one implementation, so a calculated month and a typed one cannot come to
  // different answers about what New ETC means.
  //
  // False before August 2026, where the breakout columns do not exist and the cell is
  // typed exactly as it always was (lib/parts-breakout-scope.ts).
  derived?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  const [focused, setFocused] = useState(false);

  // What the server last said about this cell: the prop from the last full render,
  // or a realtime change event naming this exact cell. One variable for both, so the
  // adopt rule below cannot treat them differently. The event path is the 2026-08-04
  // performance fix — the alternative was re-rendering all 4,150 cells of this page
  // (854 KB, ~600ms) to deliver one dollar figure. See lib/etc-remote-values.ts.
  const remoteRaw = useRemoteEtcValue(name);
  // Per-cell save state, same store and same vocabulary as the hours cells (§17).
  const saveState = cellSaveStateStyle(useCellSaveState(name));
  // "exact": Parts Cost is MONEY and keeps its cents, so an announced value must be
  // formatted the way this column seeds — 5819.03, not 5819.
  const serverText = remoteRaw == null ? initialValue : formatNewEtcText(remoteRaw, "exact");

  // Adopt a figure another user saved, unless this user has typed their own.
  // Identical rule to EtcSectionCells and MoneyCell — see the long note in
  // EtcSectionCells for why mount-time state was half of the multi-user bug.
  // `focused` is respected too: never move a value under an active caret.
  const [serverValue, setServerValue] = useState(serverText);
  if (serverValue !== serverText) {
    const wasClean = value === serverValue;
    setServerValue(serverText);
    // A DERIVED cell never adopts a server figure into its box: its value is the sum
    // of the two breakout cells beside it, and those adopt server values of their own.
    // Taking one here would put a figure on screen that its own inputs do not add up
    // to — the one state a calculated cell must not be able to reach.
    if (wasClean && !focused && !derived) setValue(serverText);
  }

  // ── The calculation, live on every keystroke in either half ───────────────
  //
  // Left to Invoice and Left to Purchase are sibling client components, so this cell
  // cannot see their state directly — it reads the store they publish into
  // (lib/etc-live-totals.ts), the same route the row's Diff and the footer already
  // take. `readPartsBreakoutSum` returns null when NEITHER half has been entered,
  // which is a cell nobody has answered and renders blank; one half filled and the
  // other empty counts the empty one as 0, which is what the requirement asks for.
  //
  // updateEtcField is what makes the recalculated figure SAVE. The hidden input below
  // posts under `newEtcOverride__<id>` exactly as a typed cell does, and the dirty
  // tracker is what puts that name into the autosave payload — so a change in either
  // half persists the new sum through the same mechanism as before.
  //
  // `applied` is what stops the mount pass from dirtying the cell. The first apply()
  // recomputes the same figure the server already rendered, and calling
  // updateEtcField with it before registerEtcField below has run would land on an
  // unregistered name — which the tracker treats as an edit, marking every Parts Cost
  // row unsaved on page load. Reporting only genuine MOVEMENT makes this effect
  // independent of the order the effects happen to run in.
  const applied = useRef(initialValue);
  useEffect(() => {
    if (!derived) return;
    const apply = () => {
      const sum = readPartsBreakoutSum(jobId);
      const next = sum == null ? "" : String(round2(sum));
      if (applied.current === next) return;
      applied.current = next;
      setValue(next);
      updateEtcField(name, next);
    };
    // Run once on mount as well as on every publish: the breakout cells render before
    // this one in the row, so their initial publish has already happened by the time
    // this effect runs and there would otherwise be no event left to catch.
    apply();
    return subscribeEtcLiveTotals(apply);
  }, [derived, jobId, name]);

  // A fresh server render retires the realtime patch — a full payload is newer and
  // more complete than any single event. Same rule, same reason as EtcSectionCells.
  useEffect(() => {
    forgetRemoteEtcValue(name);
  }, [name, initialValue]);

  // Baseline for the unsaved-changes guards, and the unmount cleanup that lets
  // a month switch reset them. See EtcSectionCells for the full rationale —
  // this cell posts into the same `newEtcOverride__<id>` namespace, so it has
  // to participate the same way or Parts Cost edits would go unnoticed.
  useEffect(() => {
    registerEtcField(name, initialValue);
    return () => forgetEtcField(name);
    // initialValue is the mount-time baseline by design; see EtcSectionCells.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  // When the box and the server agree, that agreement IS the baseline. Without
  // this, adopting a colleague's saved figure would leave the cell reading as
  // dirty and autosave would post it, only to have the stale-write guard reject it
  // as a conflict on a cell nobody touched. See adoptEtcFieldBaseline.
  useEffect(() => {
    // Compared against what the server last said — which is the prop, or a realtime
    // value the cell has adopted since. Using the raw prop here would leave a cell
    // that took a colleague's announced figure looking dirty, and autosave would post
    // it straight back at them.
    if (value === serverText) adoptEtcFieldBaseline(name, serverText);
  }, [name, serverText, value]);

  // Publish the live dollars for the totals downstream of this cell. Same rule as
  // EtcSectionCells: an empty or unparseable box means "not decided", which is the
  // suggestion — exactly what Submit would write.
  useEffect(() => {
    const typed = Number(value);
    const effective = value.trim() === "" || !Number.isFinite(typed) ? suggested : typed;
    const left = priorEtc - spent;
    // Diff counts a BLANK box as 0, so it reads as the money nobody has planned yet
    // (2026-08-04, by request). `effective` above still falls back to the suggestion
    // because Total ETC $ and the carry-forward depend on it — the two quantities
    // genuinely differ for an unanswered cell. Must match the server's own
    // expression in etc/page.tsx or the figure would jump on hydration.
    const decidedNow = isNewEtcCellDecided(cellState, value);
    // ── Undecided contributes NOTHING, exactly as the hours cells do (§29) ────
    //
    // This was `left - (decidedNow ? effective : 0)`, which for an undecided cell
    // published the whole Money Left as the variance. That is the one thing §29.2
    // forbids outright ("do not display Money Left as the Diff"), and it made this
    // column behave differently from every hours column beside it: newEtcDiff in
    // lib/etc.ts returns 0 for an undecided cell, on the documented reasoning that
    // until a manager enters a figure there is nothing to compare against.
    //
    // The consequence was not cosmetic. It summed: July's Parts Cost footer read
    // $1,085,685 of "variance" that was really just money nobody had planned yet, and
    // the KPI card said the same until §28 stopped it deriving from this number.
    // Fixing it here fixes the cell, the row, the footer and the export at once,
    // because they all read this one published value.
    const diffNow = decidedNow ? left - Math.max(effective, 0) : 0;
    // ── A total is the sum of the column above it (§44, 2026-08-05) ──────────
    //
    // This published `effective`, which for a BLANK box is the suggestion — Money Left.
    // So the footer counted $181,366 for a cell displaying nothing, and typing $1 into
    // it dropped the total by $181,365. Reported as a calculation bug, and it is one,
    // though not in the summation: the sum is correct, it was summing a term the cell
    // never showed.
    //
    // Any total containing invisible terms breaks the property that makes a total
    // checkable — that entering $1 moves it by $1 — and once one figure on the page
    // cannot be verified by eye, none of them can.
    //
    // Blank now contributes 0, which is what `diffNow` two lines above has done since
    // 2026-08-04. Those were two columns of the same row disagreeing about what a blank
    // cell means; this finishes the change that was already made to the adjacent one.
    //
    // ── What this does NOT change ────────────────────────────────────────────
    //
    // submitMonth still writes the SUGGESTION for a blank cell, and next month's Prior
    // ETC still carries from it. This is what the footer DISPLAYS, not what Submit
    // persists — conflating the two would silently zero out carry-forward values.
    //
    // The footer therefore no longer previews the submission while blanks remain. That
    // costs nothing: Submit is blocked while any required New ETC is missing
    // (monthly-report-flow.ts), so the two figures can only differ in a state where
    // submitting is impossible. `plannedNewEtc` in etc-live-totals still carries the
    // "if submitted now" figure for anyone who wants it mid-month.
    publishPartsCell(jobId, {
      prior: priorEtc,
      spent,
      left,
      newEtc: decidedNow ? Math.max(effective, 0) : 0,
      diff: diffNow,
      decided: decidedNow,
    });
  }, [jobId, priorEtc, spent, suggested, value, cellState]);

  useEffect(() => {
    return () => forgetPartsCell(jobId);
  }, [jobId]);

  // Yellow iff money was spent this month AND the box is empty — judged from the
  // value this cell holds RIGHT NOW, so it clears on the keystroke that fills it and
  // returns on the one that empties it. "$0 more parts needed" is an answer, so a
  // typed 0 is not yellow. Literally the same function as EtcSectionCells; see
  // lib/etc.ts for the two rules that used to be one.
  const decided = isNewEtcCellDecided(cellState, value);
  const displayValue = focused ? value : value.trim() === "" ? "" : currency(Number(value));

  // The red under-planned warning is gone (2026-09-04, by request): "remove the
  // existing feature that highlights an entire row red". It painted this cell and the
  // three read-only ones beside it, so removing it removes the whole row wash. Diff
  // still carries the same information, in its own cell.

  return (
    // `relative` so the presence marker sits in the corner without resizing the cell.
    <td
      // motion-cell: same yellow ⇄ neutral crossfade as the hours cells (§36.7). One
      // class, one duration, so the two kinds of New ETC cell cannot end up behaving
      // differently — see EtcSectionCells and globals.css.
      // While flagged, the red REPLACES the decided/attention wash rather than
      // layering over it — an inline style, so it beats the utility class without
      // an !important and clears to nothing when the row recovers (the same
      // mechanism paintDiffColor uses on every other live-recoloured cell here).
      // The cell can only be flagged when `decided` is true, so the red never
      // competes with the yellow "needs an answer" state: they are mutually
      // exclusive by construction, which is what the requirement asks for.
      className={`motion-cell relative border-l border-sdc-border ${decided ? NEUTRAL_BG : ATTENTION_BG} ${saveState?.ring ?? ""} ${PARTS_COL_W} px-1 py-1 text-center`}
      // The save state's own message still wins when there is one: "couldn't save"
      // is more urgent than "this figure looks low", and it is transient.
      title={saveState?.title ?? undefined}
    >
      {/* No presence marker on a derived cell: nobody edits it, so "someone is in
          this cell" would be a claim about a box that cannot be typed in. The two
          cells it is calculated from are where an edit actually happens. */}
      {!derived && <CellPresence cellKey={name} />}
      {/* The hidden input is the cell in BOTH modes — it is what `newEtcOverride__<id>`
          posts, so Save, Submit and the exports read the calculated figure through
          exactly the path they read a typed one. */}
      <input type="hidden" name={name} value={value} disabled={locked} />
      {derived ? (
        <span
          className="block w-full px-1.5 text-center text-label font-bold leading-none text-sdc-gray-600"
          // Says what it is made of, because a cell that refuses the caret has to
          // explain where the number comes from and where to change it.
          title={
            displayValue === ""
              ? "Blank until BOTH Left to Invoice and Left to Purchase have a value — a blank half is not treated as $0. Fill them in and this becomes their sum."
              : `${usdExact(Number(value))} = Left to Invoice + Left to Purchase. Calculated — edit those two cells.`
          }
          aria-label={`New ETC cost, ${jobName}, Parts Cost — calculated from Left to Invoice plus Left to Purchase`}
        >
          {displayValue === "" ? "—" : displayValue}
        </span>
      ) : (
      <input
        type="text"
        inputMode="decimal"
        value={displayValue}
        // EtcAutosave's delegated listener matches on the field NAME, and this
        // visible input deliberately has none (the name is on the hidden input
        // beside it, which React updates without dispatching an input event). So
        // typing here scheduled no autosave at all and the status chip stayed idle
        // — found by review 2026-08-04. Not data loss (the visibilitychange flush
        // and the Save button both cover it), but the debounce is the thing that
        // makes a Parts Cost edit safe within a second like every other cell.
        data-etc-autosave="1"
        // The server's last value, for Escape-to-cancel (ExcelCellFocus). Raw
        // digits, matching what the hidden input posts — restoring the formatted
        // "$12,395" would put a string the save cannot parse into the box.
        data-baseline={serverValue}
        onFocus={() => {
          setFocused(true);
          // Claim the cell so other users see the indicator before they type.
          beginEditingCell({ tab: "Monthly ETC", rowRef: jobName, columnName: "Parts Cost New ETC", cellKey: name });
        }}
        onChange={(e) => {
          const next = e.target.value.replace(/[^0-9.]/g, "");
          setValue(next);
          // Nothing persists from typing alone — the toolbar's gated Save
          // button batch-saves the whole grid. This just reports the current
          // value so the guards can compare it against what was loaded.
          // `next`, not e.target.value: the stripped text is what the hidden
          // input posts, so it's what the baseline has to be compared with.
          updateEtcField(name, next);
        }}
        onBlur={() => {
          setFocused(false);
          endEditingCell(name);
        }}
        title={hint}
        disabled={locked}
        aria-label={`New ETC cost override, ${jobName}, Parts Cost`}
        // text-sdc-gray-600 has to yield, or the number stays grey on red. The
        // focus:bg-white stays in BOTH states on purpose — it is what makes the box
        // still read as editable when you click into it, which the requirement calls
        // out specifically ("editable New ETC cell stays obviously editable").
        className="w-full [appearance:textfield] rounded-md border-none bg-transparent px-1.5 py-0 text-center text-label font-bold leading-none text-sdc-gray-600 outline-none placeholder:font-bold placeholder:text-sdc-gray-600 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none focus:bg-white focus:shadow-sm"
      />
      )}
    </td>
  );
}
