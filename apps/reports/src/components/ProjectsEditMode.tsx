"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { TOOLBAR_BTN, TOOLBAR_BTN_MUTED } from "@/components/ui/classnames";
import { countChanged } from "@/lib/dirty-form";
import { writeProjectsEditCookie } from "@/lib/projects-edit-cookie";

// Edit Mode for the Projects grid — read-only until someone deliberately turns
// it on. See projects-edit-mode.ts for the cookie and, more importantly, for
// the server-side guard that is the actual enforcement (the projects:edit
// permission — Sales/ELT only, see lib/permissions.ts).
//
// ── No password any more (2026-08-18) ───────────────────────────────────────
// This used to ask for a shared team password on the way into Edit Mode, and
// the same password gated whether the four restricted Standard Fees columns
// existed on the page at all. Both are role checks now: `mayEdit` below
// already means "this signed-in user's role grants projects:edit", so asking
// them to also type a phrase every signed-in user knew was security theatre
// on top of a real check. And the restricted columns no longer depend on this
// switch at all — see quoted/page.tsx's `sectionAllowed`, which reads the
// Standard Fees permissions directly, so flipping Edit Mode on or off never
// changes which columns are rendered and needs no server round trip.
//
// ── What is instant and what is not ─────────────────────────────────────────
// The switch flips CLIENT state, so the cells unlock or lock on the click.
// Nothing about the grid's CONTENT depends on the mode — the same rows, the
// same figures either way — so there is no router.refresh() here at all.

type EditModeValue = {
  editing: boolean;
  // False for a role without projects:edit — the switch renders as a dead
  // "Read-only" label rather than a control that can't work.
  mayEdit: boolean;
  enable: () => void;
  // Returns false if the user backed out of the unsaved-changes prompt.
  disable: () => boolean;
};

const EditModeCtx = createContext<EditModeValue>({
  editing: false,
  mayEdit: false,
  enable: () => {},
  disable: () => true,
});

export function useProjectsEditMode(): EditModeValue {
  return useContext(EditModeCtx);
}

export function ProjectsEditModeProvider({
  initialEditing,
  mayEdit,
  children,
}: {
  // The cookie's value at render time, so a reload keeps you where you were.
  initialEditing: boolean;
  // From the signed-in user's role (projects:edit) — computed server-side in
  // quoted/page.tsx, not re-derived here.
  mayEdit: boolean;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(initialEditing && mayEdit);

  function enable() {
    setEditing(true);
    writeProjectsEditCookie(true);
  }

  function disable(): boolean {
    // Leaving Edit Mode disables every input; anything typed and not saved is
    // still in the DOM, but the Save button is gone, so say so first rather
    // than let an afternoon's edits become unreachable behind a switch
    // labelled "Read-only". countChanged is the same dirty-check Save uses, so
    // this number is exactly what a save would have written.
    //
    // Reached through one of the grid's own cells, NOT document.querySelector
    // ("form") — the sidebar's sign-out form comes first in the DOM, so that
    // would have dirty-checked the wrong form and always found nothing.
    const form = document.querySelector<HTMLInputElement>("input[name^='quoted__']")?.form;
    const changed = form ? countChanged(form) : 0;
    if (changed > 0) {
      const ok = window.confirm(
        `${changed} unsaved change${changed === 1 ? "" : "s"} won't be saved if you leave Edit Mode.\n\nLeave anyway?`,
      );
      if (!ok) return false;
    }

    setEditing(false);
    writeProjectsEditCookie(false);
    return true;
  }

  return (
    <EditModeCtx.Provider value={{ editing: editing && mayEdit, mayEdit, enable, disable }}>
      {children}
    </EditModeCtx.Provider>
  );
}

// Wraps the grid. `disabled` on a fieldset cascades to every input, select and
// button inside it, which is how read-only mode reaches ~1,100 cells without the
// server having to render a prop onto each one — and, being client state, it
// takes effect on the click.
//
// The class list is fighting the fieldset's own UA styling: default margin,
// padding, border, and `min-inline-size: min-content`, the last of which would
// otherwise refuse to let the scroll container shrink below the full width of a
// 20-column table.
export function ProjectsEditFieldset({ children }: { children: ReactNode }) {
  const { editing } = useProjectsEditMode();
  return (
    <fieldset disabled={!editing} className="m-0 min-w-0 border-0 p-0">
      {children}
    </fieldset>
  );
}

// Renders its children only in Edit Mode — the Add Project and Save buttons. In
// read-only they'd be controls that can't do anything, and "Save" in particular
// implies there's something to save.
export function WhenEditing({ children }: { children: ReactNode }) {
  const { editing } = useProjectsEditMode();
  if (!editing) return null;
  return <>{children}</>;
}

// The toolbar switch — the ONLY gate control on this page. First in the row,
// and amber when on, because "this grid is live" is the one piece of state here
// nobody should have to discover by typing into it.
export function ProjectsEditModeToggle() {
  const { editing, mayEdit, enable, disable } = useProjectsEditMode();

  if (!mayEdit) {
    return (
      <span className={`${TOOLBAR_BTN} ${TOOLBAR_BTN_MUTED} cursor-default`} title="You don't have permission to edit this grid — you're viewing it read-only">
        <LockIcon />
        Read-only
      </span>
    );
  }

  function onToggleClick() {
    if (editing) disable();
    else enable();
  }

  return (
    <button
      // type="button" is load-bearing: this sits inside the grid's <form>
      // (QuotedSaveForm wraps the whole page), and a default submit button
      // here would fire a save on click.
      type="button"
      onClick={onToggleClick}
      aria-pressed={editing}
      title={editing ? "Turn editing off — back to read-only" : "Turn editing on — unlocks the cells"}
      className={`${TOOLBAR_BTN} ${
        editing ? "border-sdc-yellow bg-sdc-yellow-bg text-sdc-navy" : "border-sdc-border bg-white text-sdc-gray-600 hover:bg-sdc-blue-light"
      }`}
    >
      {/* The knob slides on `transform`, not `left` (§36.15: "avoid frequent
          animation of … left"). translate-x moves it on the compositor, same
          10px, no layout work. */}
      <span aria-hidden className={`relative h-3.5 w-6 shrink-0 rounded-full motion-interactive ${editing ? "bg-sdc-yellow" : "bg-sdc-gray-100"}`}>
        <span
          className={`motion-interactive absolute top-0.5 left-0.5 h-2.5 w-2.5 rounded-full bg-white shadow ${
            editing ? "translate-x-[10px]" : "translate-x-0"
          }`}
        />
      </span>
      {editing ? "Editing" : "Read-only"}
    </button>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.6" className="shrink-0 opacity-70">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
      <path d="M5.75 7V5.25a2.25 2.25 0 0 1 4.5 0V7" strokeLinecap="round" />
    </svg>
  );
}
