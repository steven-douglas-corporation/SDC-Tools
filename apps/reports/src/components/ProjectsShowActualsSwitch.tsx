"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { BTN_H_STANDARD } from "@/components/ui/classnames";
import { ACTUALS_PARAM, isActualsOn } from "@/lib/quoted-display-prefs";

// "Show Actuals" — the ONE control over what the section columns show (§47).
//
// ── What it replaced, and why that was slow ──────────────────────────────────
//
// Two controls did overlapping halves of this job:
//
//   "Show all" switch    set customers + types + statuses + billables + cols to
//                        everything, deleted `hide`, AND set actuals=1 — one
//                        router.push, one full server render, 50 rows -> 233.
//   "Display ▾" menu     an "Actual hours in cells" checkbox writing the same
//                        `actuals` param, also as a navigation.
//
// So "see the actual hours" was reachable two ways, one of which silently changed
// which PROJECTS were on screen, and both of which asked the server to re-render the
// whole grid.
//
// The re-render was never needed. The actual figures are ALREADY in the markup —
// every section cell carries a `.actual-suffix` beside its quoted value — and
// `hide-actuals` on the <table> is what decides whether they show. That is a CSS
// decision, so this switch makes it as one: it toggles the class directly.
//
// ── Scope is not this switch's business (§47.3) ──────────────────────────────
//
// The rows stay the page's default — Active + HeadStart, Billable — with the switch ON
// or OFF. Changing which projects are listed belongs to Filters ▾, which offers
// statuses and billables explicitly; folding it into a display toggle is what made the
// old switch a surprise. Nothing here writes a scope param.
//
// ── Editability is not this switch's business either ────────────────────────
//
// The grid is read-only until Edit Mode is deliberately turned on (see
// ProjectsEditMode, and projects-edit-mode.ts for the server-side guard that is the
// actual enforcement). This switch does not touch that in either state: it changes which
// figure a cell shows, never whether a cell can be typed into.
export function ProjectsShowActualsSwitch() {
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // Seeded from the URL so a reload, a shared link and a saved view all arrive in the
  // state they describe — and so the SERVER's first paint (which sets `hide-actuals`
  // from the same param) already agrees with this component.
  const [on, setOn] = useState(() => isActualsOn(searchParams));

  // Adopt a change that came from somewhere else: a saved view, the Back button, a
  // hand-edited URL. Compared by value, so an unrelated re-render cannot reset the
  // switch — the same resync GridViewProvider uses.
  const fromUrl = isActualsOn(searchParams);
  const [seenUrl, setSeenUrl] = useState(fromUrl);
  if (seenUrl !== fromUrl) {
    setSeenUrl(fromUrl);
    setOn(fromUrl);
  }

  // The one piece of DOM work, and it is one class on one element (§47.6: "update only
  // the affected cell values and labels", "avoid rerendering the entire application").
  // Applied in an effect rather than by rendering the class, because the <table> is
  // server-rendered markup this component does not own — the same reason ColumnResize
  // writes its widths imperatively.
  useEffect(() => {
    const table = document.querySelector<HTMLElement>('table[data-grid="projects"]');
    if (!table) return;
    table.classList.toggle("hide-actuals", !on);
  }, [on]);

  const flip = useCallback(() => {
    const next = !on;
    // The class flips on this frame, via the effect above. Nothing is awaited, so there
    // is no pending state, no spinner and no way for a stale response to arrive: the
    // operation has no response.
    setOn(next);
    // Keep the URL truthful WITHOUT navigating — replaceState, not router.push, so no
    // route render, no refetch, and no scroll reset (§47.6). It matters that the param
    // survives: Export reads the query string, so the export follows whatever the switch
    // is showing (§47 criterion 11), and a pasted link shows the same thing.
    //
    // replaceState rather than pushState: this is a display preference, and forty Back
    // presses to undo forty flips is not what anyone wants.
    const qs = new URLSearchParams(searchParams.toString());
    if (next) qs.set(ACTUALS_PARAM, "1");
    else qs.delete(ACTUALS_PARAM);
    const q = qs.toString();
    window.history.replaceState(null, "", q ? `${pathname}?${q}` : pathname);
  }, [on, pathname, searchParams]);

  return (
    <button
      type="button"
      onClick={flip}
      aria-pressed={on}
      // Names what each state SHOWS. It used to say "showing actual hours … click for
      // quoted", which was accurate while ON replaced the quoted figure (§47.2) and is a
      // lie now that ON shows the pair (§50).
      title={
        on
          ? "Showing quoted / actual hours in the section columns — click for quoted only"
          : "Show actual hours beside the quoted hours in the section columns"
      }
      // BTN_H_STANDARD: this sits in the toolbar row beside Filters, Dates, Sections,
      // Views and Export, and a third height in that row is what §41.21 ruled out.
      className={`flex ${BTN_H_STANDARD} shrink-0 items-center gap-2 rounded-lg border px-2.5 text-xs font-medium motion-interactive ${
        on ? "border-sdc-blue bg-sdc-blue-light text-sdc-blue-dark" : "border-sdc-border bg-white text-sdc-navy hover:bg-sdc-blue-light"
      }`}
    >
      {/* A real switch track — this is the one binary control on the toolbar and it
          should look like one. No spinner slot any more: there is nothing to wait for. */}
      <span
        aria-hidden
        className={`relative h-3.5 w-6 shrink-0 rounded-full motion-interactive ${on ? "bg-sdc-blue" : "bg-sdc-gray-100"}`}
      >
        {/* transform, not `left`: animating `left` animates a layout property every frame
            and drags the knob's shadow with it (§36.15). */}
        <span
          className={`motion-interactive absolute top-0.5 left-0.5 h-2.5 w-2.5 rounded-full bg-white shadow ${
            on ? "translate-x-[10px]" : "translate-x-0"
          }`}
        />
      </span>
      {/* One label, in both states. The old switch reported its DESTINATION ("Show all"
          / "Reset"), which needed a 5.5rem reserved slot to stop four different widths
          shoving the toolbar sideways. A switch already says which way it is set — the
          track does — so the label can just name the thing it controls. */}
      <span>Show Actuals</span>
    </button>
  );
}
