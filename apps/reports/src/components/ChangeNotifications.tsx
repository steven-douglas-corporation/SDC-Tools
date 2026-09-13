"use client";

import { useEffect, useMemo } from "react";
import { dismissAllChanges, dismissChange, useRealtimeChanges, useRealtimeStatus } from "@/components/RealtimeProvider";
import { useExitList } from "@/components/useMotion";

// The change-notification banner (spec 5).
//
// Rules it exists to satisfy, and how:
//   • appears without a refresh          — fed by the SSE stream, not a poll
//   • shown to every connected user      — the hub broadcasts to all subscribers
//   • does not block normal app usage    — pointer-events-none on the container it
//                                          renders into (owned by ui/Toast.tsx since
//                                          2026-08-10 — see the note below), auto on
//                                          the cards themselves
//   • queued/grouped, not replaced       — a stack, newest first, capped at VISIBLE (3)
//                                          on screen with a count for the remainder
//   • distinguishes added/edited/removed — colour AND the wording of the line
//   • no sensitive or internal data      — it prints the user's display name, the
//                                          tab, the row, the column and the two
//                                          values. No ids, no SQL, no stack traces.
//
// ── No longer its own fixed corner (2026-08-10) ─────────────────────────────
//
// This used to render its own `fixed right-4 top-20 z-40` container, entirely
// independent of ui/Toast.tsx's `fixed bottom-4 right-4 z-[100]` one — reported
// as notifications "spreading" instead of forming one clean stack, because that
// is exactly what two uncoordinated fixed corners look like. ToastProvider now
// owns the ONE fixed container for both; this component renders only its
// content (see the return statement) and is mounted from inside it, not from
// app/(app)/layout.tsx any more.

const TONE: Record<string, { dot: string; label: string }> = {
  added: { dot: "bg-sdc-green-text", label: "Added" },
  edited: { dot: "bg-sdc-blue", label: "Edited" },
  removed: { dot: "bg-sdc-red", label: "Removed" },
  recalculated: { dot: "bg-sdc-gray-400", label: "Recalculated" },
  rejected: { dot: "bg-sdc-red", label: "Refused" },
};

// Time as a person reads it. The event carries an ISO string from the server, so
// every viewer sees it in their own locale rather than the server's.
function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

const VISIBLE = 3;

// ── Keeping the stack quiet (2026-08-05, by request) ────────────────────────
//
// Reported as "sometimes these are too many, it gets noisy" — with a screenshot of four
// cards describing what were really two cells being edited back and forth.
//
// Two causes, and they need different answers:
//
//   1. REPETITION. Toggling one cell 0 -> 1 -> 0 is three events about the same cell,
//      and three cards saying so is two cards too many. Collapsed below: one card per
//      cell, newest wording, with a count.
//   2. PERSISTENCE. Nothing left the stack until it was dismissed by hand, so a busy
//      ten minutes accumulated into a wall. They now expire on their own.
//
// A REFUSED change is exempt from both. It means somebody's edit was rejected because
// another user got there first, which is the one notification here that is asking the
// reader to do something — it stays until dismissed.
const AUTO_DISMISS_MS = 7000;

export function ChangeNotifications() {
  const changes = useRealtimeChanges();
  const status = useRealtimeStatus();

  // Offline is worth saying out loud: with the stream down, this tab is NOT
  // receiving other people's changes, and silence would otherwise read as "nothing
  // is happening". Autosave still works (it is an ordinary request) — the wording
  // is careful not to imply edits are being lost.
  const offline = status === "offline";

  // ── One card per CELL, not per event ──────────────────────────────────────
  //
  // Keyed on tab+row+column, which is the cell. `changes` is newest-first, so the first
  // event seen for a key is the one to show and the rest only add to its count. The
  // members are kept so dismissing the card dismisses every event behind it — otherwise
  // the card would reappear a frame later showing the second-newest.
  const groups = useMemo(() => {
    const byCell = new Map<string, { head: (typeof changes)[number]; members: typeof changes; refused: boolean }>();
    for (const c of changes) {
      // A `system` event is the app's own background work — today, the hourly
      // refresh pass. It still arrives, and LiveRefresh still acts on it, so
      // every open tab updates; it simply does not get a card. The person who
      // started a refresh already has one notification about it (the toast),
      // and the people who did not start it do not need to be interrupted by
      // a machine finishing a scheduled job. See lib/change-log.ts.
      if (c.system) continue;
      const key = `${c.tab}|${c.rowRef}|${c.columnName}`;
      const g = byCell.get(key);
      if (g) {
        g.members.push(c);
        g.refused ||= c.changeType === "rejected";
      } else {
        byCell.set(key, { head: c, members: [c], refused: c.changeType === "rejected" });
      }
    }
    return [...byCell.values()];
  }, [changes]);

  // ── They expire on their own ──────────────────────────────────────────────
  //
  // One timer per render pass over the current groups, cleared on the next — not a timer
  // per card held across renders, which would leak on a stack that changes every few
  // seconds. A refused change is never scheduled: it is the one card that is asking for
  // a decision, so it waits for one.
  useEffect(() => {
    const expiring = groups.filter((g) => !g.refused).slice(0, VISIBLE);
    if (expiring.length === 0) return;
    const timers = expiring.map((g) =>
      setTimeout(() => {
        for (const m of g.members) dismissChange(m.changeId, m.rowRef, m.columnName);
      }, AUTO_DISMISS_MS),
    );
    return () => timers.forEach(clearTimeout);
  }, [groups]);

  const shown = groups.slice(0, VISIBLE);
  // Counted in CELLS, matching what the cards are — "+2 more changes" beside three cards
  // that each already stand for several events was describing a different unit.
  const hidden = groups.length - shown.length;
  // ── Cards enter and leave, rather than blinking (§36.13) ──────────────────
  //
  // A change event arriving used to insert a card instantly and pop the stack; a
  // dismissal removed it the same way. On a busy month with several managers editing,
  // that is the "repeated flashing" §36.13 forbids.
  //
  // useExitList holds a departed card in its own slot for one --motion-panel while it
  // fades out, which also covers the case that produces the most churn: a fifth change
  // arriving pushes the oldest past VISIBLE, so it leaves at the same moment the new one
  // arrives. Held in place, the two cross over instead of the whole stack jumping.
  //
  // Called BEFORE the early return below — a hook cannot be conditional, and this is
  // also what lets the last card animate out instead of the container disappearing from
  // under it.
  const cards = useExitList(shown, (g) => `${g.head.tab}|${g.head.rowRef}|${g.head.columnName}`);
  if (cards.length === 0 && !offline) return null;

  // ── No fixed wrapper here any more (2026-08-10) ─────────────────────────────
  //
  // This used to be its own `fixed right-4 top-20 z-40` container, entirely
  // independent of Toast.tsx's `fixed bottom-4 right-4 z-[100]` one — two
  // uncoordinated notification surfaces, which is the "spreads across the
  // screen instead of one clean stack" report. ToastProvider now renders this
  // component INSIDE its own single fixed container (see ui/Toast.tsx), so this
  // returns only its content — a Fragment, not a positioned box — and every
  // pointer-events-auto card still works exactly as it did, just one level
  // higher up the tree than before. The cap (VISIBLE=3), the per-cell dedup, the
  // 7s auto-dismiss and the "refused changes never auto-dismiss" rule are all
  // unchanged: only the OUTER box moved.
  //
  // Padding is now px-3.5 py-2.5, up from px-3 py-2, to match Toast's cards —
  // "keep consistent... padding" (the task's own wording) means a change-card
  // and a toast-card sitting back to back in one stack should not visibly step
  // in size between them.
  return (
    <>
      {offline && (
        <div className="motion-toast-in pointer-events-auto rounded-lg border border-sdc-border bg-white px-3.5 py-2.5 text-note text-sdc-gray-600 shadow-lg">
          <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-sdc-red align-middle" />
          Live updates disconnected — reconnecting. Your edits are still being saved.
        </div>
      )}

      {cards.map(({ key, item: g, leaving }) => {
        const c = g.head;
        const tone = TONE[c.changeType] ?? TONE.edited;
        const repeats = g.members.length;
        return (
          <div
            key={key}
            className={`pointer-events-auto rounded-lg border border-sdc-border bg-white px-3.5 py-2.5 shadow-lg ${
              leaving ? "motion-toast-out" : "motion-toast-in"
            }`}
          >
            <div className="flex items-start gap-2">
              <span className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
              <div className="min-w-0 flex-1">
                <p className="text-note leading-snug text-sdc-navy">{c.message}</p>
                <p className="mt-0.5 text-label text-sdc-muted">
                  {tone.label} · {clockTime(c.at)}
                  {/* The events this card stands for. Without it, collapsing would hide
                      that a cell was changed repeatedly — which is exactly the thing
                      somebody watching this stack would want to know. */}
                  {repeats > 1 && <> · {repeats} changes to this cell</>}
                </p>
              </div>
              <button
                type="button"
                // Dismisses every event behind the card, not just the one being shown —
                // otherwise it would reappear a frame later showing the next-newest.
                onClick={() => g.members.forEach((m) => dismissChange(m.changeId, m.rowRef, m.columnName))}
                aria-label="Dismiss notification"
                className="motion-interactive shrink-0 rounded px-1 text-sm leading-none text-sdc-gray-400 hover:text-sdc-navy"
              >
                ×
              </button>
            </div>
          </div>
        );
      })}

      {hidden > 0 && (
        <button
          type="button"
          onClick={dismissAllChanges}
          className="motion-interactive motion-toast-in pointer-events-auto rounded-lg border border-sdc-border bg-sdc-gray-100 px-3 py-1.5 text-label tabular-nums text-sdc-gray-600 shadow hover:bg-white"
        >
          + {hidden} more cell{hidden === 1 ? "" : "s"} changed — clear all
        </button>
      )}
    </>
  );
}
