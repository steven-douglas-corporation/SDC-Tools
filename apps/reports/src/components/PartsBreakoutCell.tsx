"use client";

import { useState } from "react";
import { registerEtcField, forgetEtcField, updateEtcField, adoptEtcFieldBaseline } from "@/lib/etc-dirty-tracker";
import { PARTS_COL_W } from "@/components/ui/classnames";
import { manualOverrideStyle } from "@/components/ui/etc-diff-colors";
import { usd } from "@/components/ui/format";
import { publishPartsBreakout, forgetPartsBreakout } from "@/lib/etc-live-totals";
import { useEffect } from "react";

// ── Left to Invoice / Left to Purchase, manager-entered ──────────────────────
//
// Requested 2026-09-03. The two cells that now make up Parts Cost New ETC:
//
//     New ETC = Left to Invoice + Left to Purchase
//
// so New ETC became a read-only sum and these two are what a manager types.
//
// ── Why these are entered rather than read from Total ETO ───────────────────
//
// They were built as live figures first (lib/parts-etc-breakout.ts), and it did not
// hold up on the month-end page. The batched 49-job parts-lines query aborts under
// real page load — `[parts-etc-breakout] batched parts lines failed: Error: aborted`
// — and because the BOM half needed those lines to know which parts have already been
// bought, Left to Purchase then read **$0 on every job**. A figure that is silently
// zero is worse than one somebody typed, on a number that seeds the forecast.
//
// ── Both cells start EMPTY, and the upstream figure is a tooltip ─────────────
//
// Left to Purchase by explicit request. Left to Invoice because a seed cannot coexist
// with New ETC being the sum of these two: the seed is live and unstored, so the box
// would show $59,205 against a stored null, and a save carrying only the other half
// would derive New ETC from 0 + that half — storing $2,500 under a cell reading
// $61,705. (Observed, not hypothesised.) Storing the seed on save would freeze a live
// upstream number as though somebody had entered it; marking the cell dirty on arrival
// would put the unsaved-changes warning on a month nobody had touched.
//
// The upstream figure is not thrown away — it is on the tooltip of an empty cell,
// which is exactly what this grid already does with New ETC's own suggestion, and for
// the reason stated there: a suggestion sitting IN the box is indistinguishable from a
// decision somebody made.
//
// ── Deliberately thinner than PartsCostNewEtcCell ───────────────────────────
//
// That component carries realtime presence, remote-value adoption and a per-cell save
// ring, because New ETC is the figure two managers are most likely to edit at once. It
// is also the most complicated component in the grid. These two are inputs to it, so
// they get the parts that protect DATA — the dirty tracker, so the unsaved-changes
// guards and the autosave debounce see them — and not the parts that protect against
// collision. If two people start fighting over these cells, the presence machinery is
// the thing to lift across, and it should be lifted rather than reimplemented.
export function PartsBreakoutCell({
  name,
  initialValue,
  locked,
  jobId,
  which,
  overridden = false,
  jobName,
  seedHint,
  bg,
}: {
  /** `partsLeftToInvoice__<entryId>` or `partsLeftToPurchase__<entryId>`. */
  name: string;
  /**
   * The stored value, and "" renders blank. No upstream figure ever reaches this box —
   * Total ETO's is on `seedHint` instead.
   *
   * The one non-stored value it may carry is a New ETC typed before these columns
   * existed, which the page hands to Left to Invoice while BOTH halves are still empty
   * (see etc/page.tsx). That is a stored figure a manager entered, not a suggestion,
   * and `saveAllNewEtcDrafts` derives it by the same rule so the cell and the write
   * agree about what is in here.
   */
  initialValue: string;
  locked: boolean;
  jobId: number;
  which: "invoice" | "purchase";
  /**
   * Draw the "manually adjusted" highlight.
   *
   * Left to Invoice only, and derived rather than stored: the page compares what is in
   * the database against the computed Parts List default, so typing the original figure
   * back removes the highlight with no second write and no flag to get out of step.
   * See lib/left-to-invoice.ts.
   *
   * The style is amber and cell-level on purpose. It replaced a row-wide red wash that
   * "made the whole row look like an error", and it has to stay distinct from the Diff
   * column’s red/green scale sitting beside it.
   */
  overridden?: boolean;
  jobName: string;
  /**
   * The tooltip for an EMPTY cell: that nothing is auto-filled here, plus whatever
   * upstream figure is known (Total ETO's, on Left to Invoice). Replaced by the normal
   * tooltip the moment a value is typed.
   */
  seedHint?: string;
  bg: string;
}) {
  const [value, setValue] = useState(initialValue);
  const [focused, setFocused] = useState(false);

  // The server sent a different value (a save landed, a refresh happened). Adopt it
  // only when this box has not diverged and is not being typed in — never move a
  // value under an active caret. Same rule as PartsCostNewEtcCell's `serverValue`.
  const [serverValue, setServerValue] = useState(initialValue);
  if (serverValue !== initialValue) {
    const wasClean = value === serverValue;
    setServerValue(initialValue);
    if (wasClean && !focused) setValue(initialValue);
  }

  // Baseline for the unsaved-changes guards, and the unmount cleanup that makes a
  // month switch self-cleaning. Without this the autosave debounce never sees these
  // cells and a typed value would only persist via the Save button.
  useEffect(() => {
    registerEtcField(name, initialValue);
    return () => forgetEtcField(name);
    // initialValue is the mount-time baseline by design — see EtcSectionCells.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(() => {
    if (value === serverValue) adoptEtcFieldBaseline(name, serverValue);
  }, [name, serverValue, value]);

  // Publish for the live New ETC sum. New ETC is a read-only cell rendered by the
  // page, so it cannot see this state — the same reason the Parts Cost row's Diff is
  // patched from a published value rather than computed in place.
  useEffect(() => {
    const n = Number(value);
    publishPartsBreakout(jobId, which, value.trim() === "" || !Number.isFinite(n) ? null : n);
    return () => forgetPartsBreakout(jobId, which);
  }, [jobId, which, value]);

  const label = which === "invoice" ? "Left to Invoice" : "Left to Purchase";
  // Formatted when idle, raw while typing — a caret must never sit inside a "$" or a
  // thousands separator.
  const display = focused ? value : value.trim() === "" ? "" : usd(Number(value));

  return (
    <td
      className={`motion-cell relative border-l border-sdc-border ${bg} ${PARTS_COL_W} px-1 py-1 text-center`}
      // Inline rather than a class: the highlight has to win over the column tint this
      // cell already carries, and an inline style is the one thing that reliably does
      // without a specificity fight in a 450-cell grid.
      style={overridden ? manualOverrideStyle() : undefined}
      // So the live client sum can repaint it without re-deriving the rule.
      data-parts-override={overridden ? "1" : undefined}
    >
      <input type="hidden" name={name} value={value} disabled={locked} />
      <input
        type="text"
        inputMode="decimal"
        value={display}
        // EtcAutosave listens by field NAME on a delegated handler, and the visible
        // input deliberately has none — the name is on the hidden input beside it,
        // which React updates without dispatching an input event. This attribute is
        // what opts the visible box into that listener; without it typing here
        // schedules no autosave at all (the bug found on PartsCostNewEtcCell,
        // 2026-08-04).
        data-etc-autosave="1"
        // The server's last value, for Escape-to-cancel (ExcelCellFocus). Raw digits,
        // matching what the hidden input posts.
        data-baseline={serverValue}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          const next = e.target.value.replace(/[^0-9.]/g, "");
          setValue(next);
          // `next`, not e.target.value: the stripped text is what the hidden input
          // posts, so it is what the baseline must be compared against.
          updateEtcField(name, next);
        }}
        onBlur={() => setFocused(false)}
        title={
          value.trim() === "" && seedHint
            ? seedHint
            : `${label} — ${jobName}. Typed here; New ETC is the sum of this and the other column.`
        }
        disabled={locked}
        aria-label={`${label}, ${jobName}`}
        className="w-full [appearance:textfield] rounded-md border-none bg-transparent px-1.5 py-0 text-center text-label font-bold leading-none text-sdc-gray-700 outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none focus:bg-white focus:shadow-sm"
      />
    </td>
  );
}
