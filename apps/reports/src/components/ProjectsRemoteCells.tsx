"use client";

import { useEffect } from "react";
import { subscribeRemoteEtcValues, readRemoteEtcValue, remoteCellKeys } from "@/lib/etc-remote-values";
import { BASELINE_ATTR } from "@/lib/dirty-form";

// Another user's saved value, applied to ONE cell of the Projects grid.
//
// ── The two bugs this closes ────────────────────────────────────────────────
//
// 1. Projects saves announced NOTHING until 2026-08-04 (§33.1). `recordChanges` was
//    called only from the ETC grid's save path, so a colleague's quoted-hours or
//    Customer edit was invisible here until somebody reloaded. That half is fixed in
//    lib/quoted-actions.ts, which now publishes a per-cell event.
//
// 2. Even once the route DID refetch, the cell on screen did not change. The Projects
//    grid's text/date/enum cells are uncontrolled — server-rendered `defaultValue` —
//    and a browser ignores a changed `defaultValue` once the input has its dirty value
//    flag set, which typing anywhere in that box sets permanently. So a user who had
//    ever touched a cell kept seeing their stale value indefinitely. That was recorded
//    as a known-open defect and is what this component actually fixes.
//
// ── Why DOM writes rather than React state ──────────────────────────────────
//
// Same reason as ProjectsLiveTotals and EtcLiveTotals: these cells are server-rendered
// precisely so a 233-job × 20-column grid stays out of the client bundle. Turning
// every cell into a client component to receive a value that arrives a few times an
// hour would give back the whole saving. One subscriber patches the cells that were
// named, and nothing else re-renders at all.
//
// ── Adopt-on-clean, which is the load-bearing rule ──────────────────────────
//
// A remote value is written ONLY into a cell the user has not diverged from. `clean`
// means the control still holds exactly what the server last sent it, which
// lib/dirty-form.ts already records per control in `data-baseline` for its own
// "post only what changed" purpose — so the test is free and, more importantly, it is
// the SAME notion of dirty the save path uses. A cell someone is mid-edit in is left
// completely alone: overwriting it would destroy typing, and their write is already
// protected against reverting the colleague by the `__base__` belief token
// (beliefIsStale in quoted-actions).
//
// The baseline moves with the value. Without that, an adopted cell would immediately
// read as dirty — its value no longer matching its baseline — and the next save would
// post it back as if the user had typed it, which is precisely the reverting-writes
// defect the baseline exists to prevent.
// The attribute a control must carry to be patched from here. OPT-IN, deliberately.
//
// The first version of this component patched anything it could find by name, and that
// was wrong in a way `next build` cannot see: the two money columns are rendered by
// MoneyCell, a CONTROLLED client component whose posted field is a hidden
// `<input value={raw} data-baseline={defaultValue}>`. Writing to it would be reverted by
// the next React render, and the baseline write would fight a React-managed attribute.
// MoneyCell also already does adopt-on-clean itself (see its `serverValue` state), so it
// neither wants nor needs help — it just needs the route payload to change.
//
// An allow-list rather than "skip hidden inputs" so the same mistake cannot be made
// again by a future controlled component that happens to render a visible named input.
// If you add an uncontrolled, server-rendered cell to this grid, mark it. If you add a
// controlled one, do nothing and it is safe by default.
const ADOPT_ATTR = "data-remote-adopt";

/**
 * Whether `el` should take `announced` as its displayed value.
 *
 * Exported and DOM-shaped rather than pure so a test can drive it with real elements —
 * the whole rule is about an element's live state (its current value versus the baseline
 * the server stamped), which a signature of plain strings would model only by
 * restating it.
 */
export function shouldAdoptRemoteValue(el: HTMLInputElement | HTMLSelectElement, announced: string): boolean {
  // Not an uncontrolled server-rendered cell — see ADOPT_ATTR.
  if (!el.hasAttribute(ADOPT_ATTR)) return false;
  const baseline = el.getAttribute(BASELINE_ATTR);
  // No baseline recorded means this control is not part of the changed-only save
  // contract, so there is no safe way to tell an untouched cell from an edited one.
  // Leave it: a wrong guess here destroys someone's typing.
  if (baseline === null) return false;
  // The user has diverged — their edit wins on screen. The conflict itself is handled
  // by the server refusing whichever write turns out to be stale.
  if (el.value !== baseline) return false;
  // Already showing it: writing would be a no-op that still moves the baseline.
  if (el.value === announced) return false;
  // A <select> must not be sent to a value it has no option for — that blanks the
  // control, which reads as data loss. The server only ever announces validated
  // statuses/types/billables, so this is a guard against a future mismatch rather than
  // a known case.
  if (el instanceof HTMLSelectElement && !Array.from(el.options).some((o) => o.value === announced)) return false;
  return true;
}

export function ProjectsRemoteCells() {
  useEffect(() => {
    const apply = () => {
      for (const cellKey of remoteCellKeys()) {
        const announced = readRemoteEtcValue(cellKey);
        if (announced === null) continue; // nothing said about this cell
        // Attribute selector on the form-field NAME, which is what a cellKey is. Escaped
        // via CSS.escape because these names contain characters CSS treats specially —
        // section codes like `10-312` make `quoted__9__10-312`, and an unescaped
        // selector throws SyntaxError and would take the whole loop down.
        const el = document.querySelector<HTMLInputElement | HTMLSelectElement>(
          `[name="${CSS.escape(cellKey)}"]`,
        );
        if (!el) continue; // that cell isn't on screen (filtered out, or another tab)
        if (!shouldAdoptRemoteValue(el, announced)) continue;

        el.value = announced;
        // Must move together with the value — see the note above.
        el.setAttribute(BASELINE_ATTR, announced);
      }
    };

    apply();
    return subscribeRemoteEtcValues(apply);
  }, []);

  return null;
}
