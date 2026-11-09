"use client";

import { useEffect, useRef, useState } from "react";
import { registerEtcField, forgetEtcField, updateEtcField, adoptEtcFieldBaseline } from "@/lib/etc-dirty-tracker";
import { PARTS_COL_W } from "@/components/ui/classnames";
import { manualOverrideStyle } from "@/components/ui/etc-diff-colors";
import { usd } from "@/components/ui/format";
import { publishPartsBreakout, forgetPartsBreakout } from "@/lib/etc-live-totals";

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
  readOnly = false,
  jobName,
  seedHint,
  bg,
  approval = false,
  calcValue = null,
}: {
  /**
   * Left to Purchase in an approval month (2026-11+): the cell shows the CALCULATED figure
   * in light orange until a PM approves or changes it, and only then does it turn grey and
   * count towards New ETC. Ignored for Left to Invoice and for earlier months.
   */
  approval?: boolean;
  /** The calculated Left to Purchase (calcLeftToPurchase), or null when it cannot be worked out. */
  calcValue?: number | null;
  /** Computed, uneditable: renders plain text and posts nothing (Left to Invoice). */
  readOnly?: boolean;
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
    // A read-only cell is never edited, so it has no baseline to guard.
    if (readOnly) return;
    registerEtcField(name, initialValue);
    return () => forgetEtcField(name);
    // initialValue is the mount-time baseline by design — see EtcSectionCells.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, readOnly]);

  useEffect(() => {
    if (readOnly) return;
    if (value === serverValue) adoptEtcFieldBaseline(name, serverValue);
  }, [name, serverValue, value, readOnly]);

  // Publish for the live New ETC sum. New ETC is a read-only cell rendered by the
  // page, so it cannot see this state — the same reason the Parts Cost row's Diff is
  // patched from a published value rather than computed in place.
  useEffect(() => {
    const n = Number(value);
    publishPartsBreakout(jobId, which, value.trim() === "" || !Number.isFinite(n) ? null : n);
    return () => forgetPartsBreakout(jobId, which);
  }, [jobId, which, value]);

  // ── Approval flow (Left to Purchase, 2026-11+) ──────────────────────────────
  //
  // `value` is the APPROVED figure — "" until a PM approves or changes the calculation —
  // so everything downstream (the hidden input the save posts, the figure New ETC is made
  // of) only ever sees an approved number. The calculated figure is display-only: shown in
  // light orange, and reported to the footer total through "purchaseShown" alone.
  const approvalMode = approval && which === "purchase" && !readOnly;
  const approved = value.trim() !== "";
  const shownNum: number | null = approved ? Number(value) : calcValue;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // `flip`: open ABOVE the cell instead of below it (no room under the last visible rows).
  const [menu, setMenu] = useState<{ flip: boolean } | null>(null);
  const touched = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!approvalMode) return;
    publishPartsBreakout(jobId, "purchaseShown", shownNum !== null && Number.isFinite(shownNum) ? shownNum : null);
    return () => forgetPartsBreakout(jobId, "purchaseShown");
  }, [approvalMode, jobId, shownNum]);

  // The Change / Approve menu closes on an outside click, Escape, scroll or resize.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-ltp-menu]")) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  // Tell the grid's autosave something changed. Approving or committing a change is not a
  // keystroke, so it would otherwise wait for the next blur/Save; the form listens for a
  // bubbling `input` event on an opted-in field (see EtcAutosave).
  const nudgeAutosave = () => {
    setTimeout(() => inputRef.current?.dispatchEvent(new Event("input", { bubbles: true })), 0);
  };
  const commitValue = (next: string) => {
    setValue(next);
    updateEtcField(name, next);
    nudgeAutosave();
  };

  const label = which === "invoice" ? "Left to Invoice" : "Left to Purchase";
  // Formatted when idle, raw while typing — a caret must never sit inside a "$" or a
  // thousands separator.
  const display = focused ? value : value.trim() === "" ? "" : usd(Number(value));

  // A computed figure nobody can edit (Left to Invoice, 2026-10-06): plain text, no
  // input, no posted field. It still publishes to the live New ETC sum above, and it
  // reads the server's value directly so it can never show anything typed.
  if (readOnly) {
    return (
      <td
        data-col="parts"
        className={`motion-cell relative border-l border-sdc-border ${bg} ${PARTS_COL_W} px-1 py-1 text-center align-middle`}
        style={overridden ? manualOverrideStyle() : undefined}
        data-parts-override={overridden ? "1" : undefined}
      >
        <span
          className="block w-full text-center text-label font-bold text-sdc-gray-700"
          title={initialValue.trim() === "" && seedHint ? seedHint : `${label} — ${jobName}. ${seedHint ?? ""}`.trim()}
          aria-label={`${label}, ${jobName} (calculated, read-only)`}
        >
          {initialValue.trim() === "" ? "" : usd(Number(initialValue))}
        </span>
      </td>
    );
  }

  if (approvalMode) {
    const pending = !approved;
    const shownText = editing ? draft : shownNum === null || !Number.isFinite(shownNum) ? "" : usd(shownNum);
    const openMenu = (el: HTMLElement) => {
      if (locked || editing) return;
      // The menu is rendered INSIDE this cell and positioned against it (see below), so it
      // sits right next to the cell whatever the app-wide CSS zoom, the grid's transformed
      // scroller or the scroll position are doing — nothing here is a screen coordinate.
      // The one measurement is whether there is room underneath it.
      const r = el.getBoundingClientRect();
      setMenu({ flip: r.bottom + 120 > window.innerHeight });
    };
    const startChange = () => {
      setMenu(null);
      touched.current = false;
      setDraft(approved ? value : shownNum === null || !Number.isFinite(shownNum) ? "" : String(shownNum));
      setEditing(true);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };
    const approve = () => {
      setMenu(null);
      if (shownNum === null || !Number.isFinite(shownNum)) return;
      commitValue(String(shownNum));
    };
    // Back to the original: drop the approved/changed figure so the cell shows the
    // calculation again, light orange, and New ETC goes blank until it is re-approved.
    const reset = () => {
      setMenu(null);
      commitValue("");
    };
    const finishEdit = () => {
      setFocused(false);
      setEditing(false);
      if (!touched.current) return;
      touched.current = false;
      // Whatever was typed becomes the approved figure; emptying the box hands the cell
      // back to the calculation (pending again). Junk like "-" or "." is treated as empty.
      const t = draft.trim();
      commitValue(t === "" || !Number.isFinite(Number(t)) ? "" : t);
    };
    return (
      <td
        data-col="parts"
        // Pending (not yet approved) reads light orange; approved is the regular grey the
        // other money cells wear.
        className={`motion-cell relative border-l border-sdc-border ${pending ? "bg-[#FFE7B8]" : bg} ${PARTS_COL_W} px-1 py-1 text-center`}
        data-ltp-state={pending ? "pending" : "approved"}
      >
        <input type="hidden" name={name} value={value} disabled={locked} />
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={shownText}
          // Read-only until "Change" is chosen, so a click cannot edit by accident and
          // the menu is the one way in. Still a focusable input, which keeps the grid's
          // arrow/Enter navigation working through the cell.
          readOnly={!editing}
          data-etc-autosave="1"
          data-baseline={serverValue}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            if (editing) finishEdit();
            else setFocused(false);
          }}
          onClick={(e) => openMenu(e.currentTarget)}
          onKeyDown={(e) => {
            if (!editing && (e.key === " " || e.key === "F2")) {
              e.preventDefault();
              openMenu(e.currentTarget);
            }
          }}
          onChange={(e) => {
            // Digits, one decimal point, and a leading minus (the calculation can be negative).
            const raw = e.target.value;
            const next = (raw.startsWith("-") ? "-" : "") + raw.replace(/[^0-9.]/g, "");
            touched.current = true;
            setDraft(next);
          }}
          title={pending ? seedHint : `${label} — ${jobName}. Approved. Click to Change or Reset it; New ETC is Left to Invoice + this.`}
          disabled={locked}
          aria-label={`${label}, ${jobName}${pending ? " (pending approval)" : " (approved)"}`}
          className={`w-full rounded-md border-none bg-transparent px-1.5 py-0 text-center text-label font-bold leading-none text-sdc-gray-700 outline-none focus:bg-white focus:shadow-sm ${editing ? "" : "cursor-pointer"}`}
        />
        {menu && (
          <div
            data-ltp-menu
            role="menu"
            // Directly under the cell (above it when flipped), centred on it. The cell is
            // `relative`, so these offsets are relative to IT.
            className={`absolute left-1/2 z-[60] flex w-44 -translate-x-1/2 flex-col gap-1 rounded-lg border border-sdc-border bg-white p-1.5 text-left shadow-xl ${menu.flip ? "bottom-full mb-0.5" : "top-full mt-0.5"}`}
          >
            <button
              type="button"
              role="menuitem"
              className="rounded-md px-3 py-2 text-left text-sm font-semibold text-sdc-gray-700 hover:bg-sdc-gray-100"
              onClick={startChange}
            >
              Change
            </button>
            {!pending && (
              <button
                type="button"
                role="menuitem"
                title="Go back to the calculated figure and pending (orange) status"
                className="rounded-md px-3 py-2 text-left text-sm font-semibold text-[#B45309] hover:bg-[#FFF4DC]"
                onClick={reset}
              >
                Reset
              </button>
            )}
            {pending && (
              <button
                type="button"
                role="menuitem"
                disabled={shownNum === null}
                className="rounded-md bg-[#2E7D32] px-3 py-2 text-left text-sm font-bold text-white hover:bg-[#1B5E20] disabled:cursor-not-allowed disabled:opacity-40"
                onClick={approve}
              >
                Approve
              </button>
            )}
          </div>
        )}
      </td>
    );
  }

  return (
    <td
      data-col="parts"
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
