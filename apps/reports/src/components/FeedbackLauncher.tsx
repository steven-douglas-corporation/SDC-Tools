"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { FeedbackContext } from "@/lib/feedback-context";

// ── Opening the feedback drawer from inside a page (2026-10-20) ─────────────
//
// The drawer is rendered by the shell's Flag button, which owns its open state, so a
// page had no way to open it. This is the missing handle: the shell provides it, a page
// asks for the drawer with the view it is describing, and the Flag button — still the
// only thing that renders the drawer — shows it. There is one drawer and one place that
// mounts it.
//
// `context` is the CALLER's, not the shell's: a page knows which view it is, and the
// shell's own resolution (the active pane, the left one in split view) can be a
// different view from the one a button was clicked in.
//
// The Flag button itself does not use this and behaves exactly as before.

export type FeedbackLaunch = {
  /** Open the suggestion wording ("What would you like to see?") rather than the problem form. */
  suggestion: boolean;
  context: FeedbackContext;
};

type Launcher = {
  /** Whether this role holds feedback:submit — a page should offer nothing when it does not. */
  canSubmit: boolean;
  launch: FeedbackLaunch | null;
  open: (launch: FeedbackLaunch) => void;
  close: () => void;
};

const NO_LAUNCHER: Launcher = { canSubmit: false, launch: null, open: () => {}, close: () => {} };

const LauncherContext = createContext<Launcher>(NO_LAUNCHER);

export function FeedbackLauncherProvider({ canSubmit, children }: { canSubmit: boolean; children: ReactNode }) {
  const [launch, setLaunch] = useState<FeedbackLaunch | null>(null);
  const open = useCallback((next: FeedbackLaunch) => setLaunch(next), []);
  const close = useCallback(() => setLaunch(null), []);
  const value = useMemo<Launcher>(() => ({ canSubmit, launch, open, close }), [canSubmit, launch, open, close]);
  return <LauncherContext.Provider value={value}>{children}</LauncherContext.Provider>;
}

/** Outside the shell (a test, a bare render) there is no provider, and nothing is offered. */
export function useFeedbackLauncher(): Launcher {
  return useContext(LauncherContext);
}
