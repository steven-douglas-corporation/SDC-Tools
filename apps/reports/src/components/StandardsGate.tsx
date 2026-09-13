"use client";

import { useSyncExternalStore } from "react";
import { TOOLBAR_BTN, TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_NEUTRAL, TOOLBAR_MIN_W } from "@/components/ui/classnames";
import {
  hideStandardSheet,
  readStandardsState,
  revealStandardSheet,
  serverStandardsState,
  subscribeStandards,
} from "@/lib/standards-reveal";

// ── Hide / Show, for an already-authorized tab (§76) ─────────────────────────
//
// The password box that used to live in this file is gone (2026-08-18):
// Standard Sheet visibility is a role check now (standard-sheet-gate.ts), so
// there is nothing left for a client-side gesture to unlock — a Sales/ELT
// user's Standard Sheet columns and card render the moment the server says
// `showStandards`. What's left is a genuinely different feature: collapsing
// the section to reduce clutter without losing already-fetched figures or
// re-asking the server anything — see standards-reveal.ts's `hidden` flag,
// which every Standard Sheet consumer (EtcStandardCells, StandardGrandCells,
// the two header blocks, StandardFeesCard) reads alongside its own
// visibility condition.
//
// Still a real `<form action={lockAction}>` underneath, not a bare button — a
// client that never hydrates falls through to the no-JS fallback (a
// revalidate that leaves the section exactly as visible as the role says it
// should be) rather than losing the control entirely.
export function StandardsVisibilityToggle({ lockAction }: { lockAction: () => Promise<void> }) {
  const { hidden } = useSyncExternalStore(subscribeStandards, readStandardsState, serverStandardsState);
  return (
    <form action={lockAction}>
      <button
        type="submit"
        onClick={(e) => {
          // Once this handler runs, JS has hydrated and the click is fully handled
          // here — instant, no request of any kind — so the <form>'s own submission
          // must not also fire.
          e.preventDefault();
          if (hidden) revealStandardSheet();
          else hideStandardSheet();
        }}
        className={`${TOOLBAR_BTN} ${TOOLBAR_MIN_W} ${hidden ? TOOLBAR_BTN_NEUTRAL : TOOLBAR_BTN_ACTIVE} justify-center`}
        title={
          hidden
            ? "Show the Standard Sheet columns and the Standard Fees card again."
            : "Standard Sheet columns and the Standard Fees card are showing — click to hide them."
        }
      >
        {hidden ? "Show Standards" : "Standards"}
      </button>
    </form>
  );
}
