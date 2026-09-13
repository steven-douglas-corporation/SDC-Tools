"use client";

import { useState } from "react";

// Currency grid cell for the Projects tab's Parts Cost Quoted / Parts Cost Actual columns.
//
// Replaces a bare <input type="number">, which cannot show thousands separators
// at all — a seven-figure quote rendered as "1300000" and had to be counted by
// eye. Shows "1,300,000" at rest and the plain number while you're editing it,
// because commas that reshuffle under the caret as you type are worse than no
// commas.
//
// Two inputs, deliberately: the visible one is unnamed and never submitted, and
// a hidden field carries the raw digits under `name`. That keeps the server
// contract exactly what it was — a plain numeric string — rather than depending
// on the action to strip formatting. (parseMoney tolerates separators anyway, so
// a pasted "$1,300,000" survives, but this way the happy path never relies on it.)
export function MoneyCell({
  name,
  defaultValue,
  ariaLabel,
  className,
  maxFractionDigits = 2,
}: {
  name: string;
  // Raw numeric string, e.g. "1300000". Empty for "no figure on file".
  defaultValue: string;
  ariaLabel: string;
  className?: string;
  // Caps decimals in the AT-REST display only (mid-edit always shows the raw
  // typed string, unrounded). Parts Cost Actual passes 0 — it's synced from
  // TotalETO with cents attached, and "$728,806.96" reads as false precision
  // next to a whole-dollar quote. Defaults to 2 so every other caller (Parts
  // Cost Quoted, the ETC grid's cells) keeps today's behavior.
  maxFractionDigits?: number;
}) {
  const [raw, setRaw] = useState(defaultValue);
  const [editing, setEditing] = useState(false);

  // ── Adopt a new SERVER value, but never overwrite the user's own edit ───────
  //
  // This cell held two versions of the truth and they disagreed after a
  // re-render: `raw` came from useState, whose initializer runs ONCE, while
  // data-baseline below is the live `defaultValue` prop and re-states itself every
  // render. So when the server sent a newer figure — because another user saved
  // this cell — the baseline moved and `raw` did not, and dirty-form.ts read
  // `value !== baseline` as "this user edited it" and submitted the STALE value,
  // overwriting the other user's save. The cell was not just showing an old
  // number, it was actively reverting a colleague's work on the next autosave.
  //
  // The rule: if this cell was clean (still showing what the server last sent),
  // adopt the new value. If the user had typed something different, keep their
  // text — it is a genuine unsaved edit, and it stays dirty and gets submitted,
  // which is correct.
  //
  // Adjusting state during render, rather than in an effect: React supports this
  // for exactly this "derive from a changed prop" case, and it avoids rendering
  // one frame of the wrong figure.
  const [serverValue, setServerValue] = useState(defaultValue);
  if (serverValue !== defaultValue) {
    const wasClean = raw === serverValue;
    setServerValue(defaultValue);
    if (wasClean && !editing) setRaw(defaultValue);
  }

  // Grouping only — no currency symbol (the cell already prints a "$" beside
  // this) and no forced decimals, so a whole-dollar quote stays whole.
  const display = (() => {
    if (raw === "") return "";
    const n = Number(raw);
    if (!Number.isFinite(n)) return raw; // mid-typing junk: show it, don't eat it
    return n.toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits });
  })();

  return (
    <>
      {/* data-baseline is the SERVER's value, never `raw` — dirty-form.ts compares
          the two to decide whether this cell is submitted at all. It has to be the
          prop rather than a mount-time copy, so that a re-render (after a save, or
          after a filter swaps the rows) re-states the baseline instead of leaving a
          stale one behind. */}
      <input type="hidden" name={name} value={raw} data-baseline={defaultValue} />
      <input
        type="text"
        // decimal, not numeric: numeric hides the minus/decimal keys on mobile.
        inputMode="decimal"
        // Also on the VISIBLE input, so Escape can cancel an edit here
        // (ExcelCellFocus reads this attribute off whatever cell has focus, and the
        // hidden field beside this one never gets focus). Raw digits, matching what
        // onChange stores — restoring "1,300,000" would put separators into `raw`.
        data-baseline={defaultValue}
        value={editing ? raw : display}
        aria-label={ariaLabel}
        className={className}
        onFocus={() => setEditing(true)}
        onChange={(e) => {
          // Accept separators as they're typed or pasted, but store digits only,
          // so the hidden field is always submit-ready.
          setRaw(e.target.value.replace(/[$\s,]/g, ""));
        }}
        onBlur={() => setEditing(false)}
      />
    </>
  );
}
