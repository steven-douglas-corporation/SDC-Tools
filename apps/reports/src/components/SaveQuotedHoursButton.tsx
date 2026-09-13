"use client";

import { useEffect, useRef, useState } from "react";
import { BUTTON_PRIMARY } from "@/components/ui/classnames";
import { useSaveState } from "@/components/QuotedSaveForm";
import type { SaveQuotedResult } from "@/lib/quoted-actions";

// The Projects grid's save submit: pending state, then a banner across the top
// of the viewport reporting exactly what the save did.
//
// It used to raise a bottom-right toast saying only "Quoted hours saved"
// (2026-07-30). Two problems, both reported: on a full-viewport grid with the
// button top-right, a 4s notice in the opposite corner is easy to miss entirely;
// and "saved" couldn't distinguish a real write from a submit that changed
// nothing, which is the exact doubt a confirmation exists to remove. The action
// now returns counts (see SaveQuotedResult) and this reports them.
//
// One notification per action, deliberately: the shared toast is NOT also fired,
// since two confirmations for one save is noise and the two could disagree.

// "3 cells and 1 job", "2 new projects" — only the parts that actually happened.
// A save that wrote nothing says so plainly rather than claiming a success it
// didn't have: every visible cell resubmits on every save, so "no changes" is a
// completely normal outcome and pretending otherwise trains people to ignore the
// banner.
// How many refused cells the banner lists before collapsing the rest into a count.
const CONFLICTS_SHOWN = 6;

function describe(r: Extract<SaveQuotedResult, { ok: true }>): string {
  const parts: string[] = [];
  if (r.created > 0) parts.push(`${r.created} new project${r.created === 1 ? "" : "s"}`);
  if (r.cells > 0) parts.push(`${r.cells} cell${r.cells === 1 ? "" : "s"}`);
  if (r.jobs > 0) parts.push(`${r.jobs} job${r.jobs === 1 ? "" : "s"}`);
  // Refused writes are named FIRST and never folded into the saved counts: the
  // manager's value did not land, and a banner that led with "Saved 3 cells" would
  // bury the one thing they have to act on (2026-08-04).
  const refused =
    r.conflicts > 0
      ? `${r.conflicts} cell${r.conflicts === 1 ? " was" : "s were"} changed by another user and ${
          r.conflicts === 1 ? "was" : "were"
        } NOT saved — showing the current values`
      : null;
  if (parts.length === 0) return refused ?? "No changes to save";
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return refused ? `Saved ${list}. ${refused}.` : `Saved ${list}`;
}

export function SaveQuotedHoursButton() {
  // Pending comes from useActionState via QuotedSaveForm, NOT useFormStatus:
  // that hook only reports a form's own `action` submission, and this form
  // dispatches manually so it can send just the changed cells.
  const { result, pending } = useSaveState();
  const wasPending = useRef(false);
  // Keyed on a counter, not on `result`: two identical saves in a row can return
  // an equal-looking result, and the banner must still reappear for the second.
  const [shown, setShown] = useState<{ n: number; result: SaveQuotedResult; at: Date } | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    // pending true -> false means the action resolved. `result` is whatever it
    // returned, including a validation failure — which no longer throws, so the
    // grid and every unsaved edit in it stay on screen.
    if (wasPending.current && !pending && result) {
      setShown({ n: ++seq.current, result, at: new Date() });
    }
    wasPending.current = pending;
  }, [pending, result]);

  // Auto-dismiss confirmations; leave failures up until dismissed, since a
  // message that names the cell to fix is no use once it has vanished.
  useEffect(() => {
    if (!shown || !shown.result.ok) return;
    // A refusal stays up until dismissed: it is asking the manager to re-enter a
    // value, which is not something to flash for five seconds.
    if (shown.result.conflicts > 0) return;
    const t = window.setTimeout(() => setShown(null), 5000);
    return () => window.clearTimeout(t);
  }, [shown]);

  // A save that refused a write is NOT a success as far as the banner's colour is
  // concerned — something the manager typed was rejected.
  const ok = shown?.result.ok === true && shown.result.conflicts === 0;

  return (
    <>
      <button type="submit" disabled={pending} className={BUTTON_PRIMARY}>
        {pending ? "Saving…" : "Save"}
      </button>

      {/* aria-live sits on the permanently-mounted wrapper, not the banner: a
          live region that appears at the same moment as its content is not
          reliably announced. */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed inset-x-0 top-3 z-[110] flex justify-center px-4"
      >
        {shown && (
          <div
            role="status"
            className={`pointer-events-auto flex max-w-2xl items-start gap-2.5 rounded-lg border px-4 py-2.5 text-sm font-medium shadow-lg ${
              ok
                ? "border-sdc-green/40 bg-sdc-green-bg text-sdc-green-text"
                : "border-sdc-red-border bg-sdc-red-bg text-sdc-red-text"
            }`}
          >
            {ok ? (
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" className="mt-0.5 shrink-0">
                <circle cx="8" cy="8" r="6.5" />
                <path d="M5 8.2 L7.2 10.4 L11 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" className="mt-0.5 shrink-0">
                <path d="M8 1.8 L14.5 13.5 H1.5 Z" strokeLinejoin="round" />
                <line x1="8" y1="6.2" x2="8" y2="9.5" strokeLinecap="round" />
                <line x1="8" y1="11.6" x2="8" y2="11.6" strokeLinecap="round" />
              </svg>
            )}
            <span className="min-w-0 break-words">
              {shown.result.ok ? describe(shown.result) : `Not saved — ${shown.result.error}`}
              {/* ── The two figures §33.4 requires, per cell ────────────────────
                  A count alone ("2 cells were changed by another user") tells the
                  manager something went wrong but not WHICH cells, what is stored
                  now, or what their own value was — so there is nothing to act on
                  and no way to decide whether to re-enter it. The detail is already
                  returned by the action; it was simply never displayed.

                  Capped, because one Save can refuse a whole column and a banner
                  that grows past the viewport hides its own dismiss button. */}
              {shown.result.ok && shown.result.conflictDetail.length > 0 && (
                <span className="mt-1.5 block font-normal">
                  {shown.result.conflictDetail.slice(0, CONFLICTS_SHOWN).map((line) => (
                    <span key={line} className="block tabular-nums">
                      {line}
                    </span>
                  ))}
                  {shown.result.conflictDetail.length > CONFLICTS_SHOWN && (
                    <span className="block opacity-70">
                      …and {shown.result.conflictDetail.length - CONFLICTS_SHOWN} more
                    </span>
                  )}
                  {/* The retry path, said out loud. Those cells were deliberately
                      left dirty (see QuotedSaveForm), and requestLiveRefresh has
                      already pulled the current figures in — so pressing Save again
                      now writes against what is actually stored. */}
                  <span className="mt-1 block opacity-80">
                    The current values are now on screen. Re-enter what you need and press Save again.
                  </span>
                </span>
              )}
            </span>
            {shown.result.ok && (
              <span className="shrink-0 font-normal opacity-70">
                {shown.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
            )}
            <button
              type="button"
              onClick={() => setShown(null)}
              aria-label="Dismiss"
              className="-mr-1.5 mt-0.5 shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4 4 L12 12 M12 4 L4 12" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </>
  );
}
