"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useToast } from "@/components/ui/Toast";
// Same height token as the toolbar row above, so the strip is a peer of View / Export
// rather than a third height in the same band (§41.21).
import { BTN_MIN_H_STANDARD } from "@/components/ui/classnames";
// The store itself, not the hook: this component ACCUMULATES events rather than
// rendering the current queue — see the note where they are applied.
import { readChanges, subscribeChanges } from "@/components/RealtimeProvider";
import {
  ETC_DEPARTMENTS,
  completionCaption,
  fillDepartments,
  parseDepartmentCellKey,
  type DepartmentCompletion,
} from "@/lib/etc-departments";
import { setDepartmentCompletion } from "@/lib/etc-department-actions";

// ── The department ETC sign-off checklist (§50) ─────────────────────────────
//
// Five boxes on ONE line between the toolbar and the KPI card: has each department
// finished entering its ETC for the month on screen. The month's submission will not
// open while any of them is outstanding, which is the whole reason it is here rather
// than on a settings page — the answer belongs next to the work it gates.
//
// ── Plain checkboxes, in a row (2026-08-05, by request) ─────────────────────
//
// This shipped as a vertical list with a status caption per row — "Not complete",
// "Completed by Lisa at 2:35 PM" — and a running count in a header. Five rows of that
// is 150px of vertical space above the grid, spent restating what five ticked boxes
// already say, on the page whose recurring complaint (§26, §44, §49) is things pushing
// the grid down.
//
// So: one line, checkbox and name, tick to save. Who and when are not lost — they move
// into each box's tooltip, where they cost no space and are one hover away. The audit
// log remains the full record either way.
//
// The tick is optimistic, because a checkbox that waits ~200ms before moving reads as
// broken (§36). The optimism is REPLACED by the server's answer rather than merely
// confirmed by it, so a refusal snaps the box back and says why in a toast — a refused
// click that silently leaves the box ticked would send a manager away believing they
// had signed off.

type Props = {
  month: string;
  /** "JULY 2026" — matches the KPI card's own heading, so the two read as one block. */
  monthTitle: string;
  initial: DepartmentCompletion[];
  /** Per department, from the SAME policy the server action enforces (§50). */
  manageable: Record<string, boolean>;
  /** A submitted month is frozen; its sign-offs are history and must not be editable. */
  locked: boolean;
};

/** A status plus WHEN it became true, so three sources of truth can be ordered. */
type Stamped = { status: DepartmentCompletion; at: number };

export function DepartmentEtcChecklist({ month, monthTitle, initial, manageable, locked }: Props) {
  const { toast } = useToast();
  // Only THIS browser's own clicks live in state. Everything else is derived — see below.
  const [mine, setMine] = useState<Record<string, Stamped>>({});
  // Which boxes have a request in flight, so only the clicked one is disabled — a single
  // boolean would freeze all five and make one click look like five.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [, startSave] = useTransition();

  // ── Switching month clears this browser's overrides ─────────────────────────
  //
  // The month picker is a navigation, so July -> August re-renders with August's rows
  // while React keeps the same instance and therefore the same state. Without this,
  // August would show July's optimistic ticks — the specific failure §50 names
  // ("changing from July to August must display August's statuses").
  //
  // State, not a ref: React's "adjust state when a prop changes" pattern, which is what
  // ProjectsShowActualsSwitch uses to resync from the URL. A ref read during render does
  // not participate in the render that reads it.
  const [seenMonth, setSeenMonth] = useState(month);
  if (seenMonth !== month) {
    setSeenMonth(month);
    setMine({});
    setPending({});
  }

  // ── Live updates from other people (§50) ────────────────────────────────────
  //
  // The change feed the whole app already runs on (SSE, lib/realtime-hub.ts). Every
  // sign-off is published through recordChanges with a `cellKey` naming its month and
  // department, so this picks up the ONE event it cares about and repaints the ONE box —
  // no refetch, no router.refresh, nothing else on the page disturbed.
  //
  // ── Why this ACCUMULATES rather than deriving from the feed ─────────────────
  //
  // The first cut folded `useRealtimeChanges()` during render, which is tidier and was
  // wrong for a reason that only shows up live: that queue is the notification banner's
  // buffer. It is capped at 40 and each entry is DISMISSED seven seconds after it
  // arrives (ChangeNotifications' AUTO_DISMISS_MS). So a colleague's tick appeared, and
  // then un-appeared seven seconds later when the event aged out and the derived value
  // fell back to the server render underneath it. Verified in two browser tabs: the
  // event reached the wire with the right cellKey and the box never moved, because every
  // reading happened after the queue had drained.
  //
  // So the events are folded into state as they arrive and KEPT. Subscribing to an
  // external store and calling setState from its callback is the shape React's
  // set-state-in-effect rule explicitly allows — it is mirroring in an effect BODY that
  // it forbids, and that distinction is exactly the difference between reacting to a
  // change and re-deriving on every render.
  useEffect(() => {
    const apply = () => {
      const events = readChanges();
      setMine((cur) => {
        let next = cur;
        for (const c of events) {
          const key = parseDepartmentCellKey(c.cellKey);
          if (!key || key.month !== month) continue;
          const at = Date.parse(c.at);
          const stamp = Number.isFinite(at) ? at : 0;
          // Newest wins, per department. This is what makes a replayed event harmless
          // (same value, same stamp) and an out-of-order one a no-op — the two hazards
          // §50 names, handled by one comparison rather than by a seen-set that only
          // covers the first.
          if ((next[key.code]?.at ?? -1) >= stamp) continue;
          const completed = c.newValue === "Complete";
          next = {
            ...next,
            [key.code]: {
              at: stamp,
              // The event names who did it; an untick has no completer, matching the
              // server.
              status: { code: key.code, completed, completedBy: completed ? c.userName : null, completedAt: completed ? c.at : null },
            },
          };
        }
        return next;
      });
    };
    apply(); // whatever is already queued when this mounts
    return subscribeChanges(apply);
  }, [month]);

  // ── Two sources: the server render, and everything since ────────────────────
  //
  // `initial` is the floor — what was true when this page was built. `mine` holds every
  // status change this tab has learned about since, whether from a colleague's event or
  // from its own click, each stamped with when it happened.
  //
  // An override only ever shadows the server render with a LATER truth, and where the
  // two agree the result is identical either way — so a stale override cannot show a
  // wrong value, only an equal one. The case it cannot cover on its own is an event
  // missed while the stream was down; the provider's throttled live-refresh and any
  // navigation both replace `initial` and resolve it.
  const statuses: DepartmentCompletion[] = fillDepartments(initial).map(
    (server) => mine[server.code]?.status ?? server,
  );

  const toggle = useCallback(
    (code: string, next: boolean) => {
      // Optimistic, and deliberately without a name or a time: this browser does not know
      // what the server will stamp, and inventing "Completed by you at now" would be a
      // figure that changes under the reader a moment later.
      setMine((m) => ({ ...m, [code]: { at: Date.now(), status: { code, completed: next, completedBy: null, completedAt: null } } }));
      setPending((p) => ({ ...p, [code]: true }));
      startSave(async () => {
        try {
          // The ABSOLUTE state, not "flip it" — see the note on the action. A stale view
          // therefore cannot produce the opposite of what was clicked.
          const res = await setDepartmentCompletion(month, code, next);
          if (res.ok) {
            setMine((m) => ({ ...m, [code]: { at: Date.now(), status: res.status } }));
          } else {
            // Drop the override entirely rather than inverting it: the truth is whatever
            // the server and the feed say, and this browser's guess was wrong. A refusal
            // that silently leaves the box ticked is worse than the refusal — the manager
            // walks away believing they signed off.
            setMine((m) => {
              const { [code]: _refused, ...rest } = m;
              return rest;
            });
            // critical: a permission/auth refusal on the ETC sign-off must always
            // reach the manager, even from inside a subtree that suppresses routine
            // toasts — see SuppressToasts in ui/Toast.tsx.
            toast(res.message, "error", { critical: true });
          }
        } catch (err) {
          setMine((m) => {
            const { [code]: _failed, ...rest } = m;
            return rest;
          });
          // critical: a save failure on the sign-off checklist, same reason as above.
          toast(err instanceof Error ? `Could not save — ${err.message}` : "Could not save the status.", "error", { critical: true });
        } finally {
          setPending((p) => {
            const { [code]: _done, ...rest } = p;
            return rest;
          });
        }
      });
    },
    [month, toast],
  );

  return (
    // ── Sized to its content, at toolbar height (2026-08-05, by request) ──────
    //
    // `w-fit` rather than the block default: a <section> fills its parent, so the strip
    // ran the full width of the page with ~900px of empty white after the last checkbox.
    // It is a group of five controls, not a banner, and it should be as wide as the
    // controls are.
    //
    // BTN_MIN_H_STANDARD makes it the same 2.4rem as View / Export / the month picker in
    // the row above, so it reads as a peer of those controls rather than a stray strip —
    // with `rounded-lg` and `px-3.5` to match them too. A FLOOR rather than a fixed
    // height because of the next paragraph.
    //
    // `flex-wrap` stays: with `w-fit`, a window narrower than the content clamps the
    // strip to the space available, and the boxes then wrap to a second line instead of
    // pushing a horizontal scrollbar onto the page (§49 — measure the box, not the
    // viewport). A fixed `h-` would clip that second line.
    <section
      aria-label={`${monthTitle} department ETC sign-off`}
      // No bottom margin: it is a control in the toolbar row now, and the row's own gap
      // spaces it. A margin here would push the row below it down by 12px for nothing.
      className={`flex w-fit ${BTN_MIN_H_STANDARD} flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-sdc-border bg-white px-3 py-1 shadow-sm`}
    >
      {/* Not a heading with its own row — an inline caption. Five bare checkboxes in a
          toolbar would be unexplained furniture, and this is the smallest thing that
          answers "what am I ticking".
          Shortened from "Department ETC complete" when the strip moved onto the controls
          row: the words it lost were the two that were doing least, and the ~90px they
          cost is the difference between this row wrapping and not. The full sentence is
          still in the section's accessible name and in every checkbox's. */}
      <span className="shrink-0 text-label font-semibold uppercase tracking-wide text-sdc-muted">ETC complete</span>
      {ETC_DEPARTMENTS.map((d) => {
        const s = statuses.find((x) => x.code === d.code) ?? {
          code: d.code,
          completed: false,
          completedBy: null,
          completedAt: null,
        };
        const busy = pending[d.code] === true;
        const may = manageable[d.code] === true && !locked;
        // Who and when, kept out of the layout but not out of reach. The inline captions
        // this replaces cost a line each; a title costs nothing and says the same thing.
        // Leads with the FULL name, because the visible label is the short one — this
        // tooltip is where "Elec Build & Wire" is spelled out.
        const hint = locked
          ? `${d.label} — ${monthTitle} is submitted and locked; reopen the month to change this.`
          : !may
            ? `${d.label} is signed off by its own department.`
            : `${d.label} (${d.fullName}) — ${completionCaption(s)}`;
        return (
          <span key={d.code} className="flex shrink-0 items-center gap-1.5" title={hint}>
            <input
              type="checkbox"
              id={`dept-etc-${d.code}`}
              checked={s.completed}
              disabled={!may || busy}
              onChange={(e) => toggle(d.code, e.target.checked)}
              // Named for a screen reader with the FULL name: "ME" and "CE" are not words,
              // and a checkbox announced as "C E" tells nobody anything. The caption above
              // is not programmatically associated with five separate inputs, so each one
              // has to carry its own context.
              aria-label={`${d.fullName} has completed its ETC for ${monthTitle}`}
              className="h-3.5 w-3.5 shrink-0 accent-sdc-blue motion-interactive disabled:cursor-not-allowed disabled:opacity-50"
            />
            <label
              htmlFor={`dept-etc-${d.code}`}
              className={`text-xs font-semibold whitespace-nowrap motion-interactive ${
                may ? "cursor-pointer" : "cursor-not-allowed"
              } ${s.completed ? "text-sdc-navy" : may ? "text-sdc-gray-600" : "text-sdc-gray-400"}`}
            >
              {/* The short name — see EtcDepartment.short. The full one is in the
                  tooltip above and in this checkbox's accessible name, so nothing is
                  hidden from either a hovering reader or a screen reader. */}
              {d.short}
            </label>
          </span>
        );
      })}
    </section>
  );
}
