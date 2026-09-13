"use client";

// App-wide toast notifications — one shared system replacing the three
// hand-rolled `useState + setTimeout + fixed div` toasts (RunReportButton,
// SyncHistoryButton, EtcSyncMenu) that each had different durations/positions.
// Mounted once in AppShell; any client component calls useToast().toast(...).
//
// useToast() returns a no-op when used outside the provider, so a component
// that renders in isolation (tests, stories) never crashes.
//
// ── One physical stack, not two (2026-08-10) ────────────────────────────────
//
// Reported: notifications "spread in parallel" instead of reading as one clean
// list. The cause was that this component and ChangeNotifications.tsx (the
// realtime "who changed what" banner) were two entirely independent `fixed`
// containers — bottom-right growing up here, top-right growing down there — with
// no shared cap, no shared width, and (this half specifically) no dedup and no
// cap at all. On a short viewport their bounding boxes could genuinely meet.
//
// They now render into ONE fixed container, owned here. The two producers'
// STATE stays separate on purpose — a realtime change event and an arbitrary
// action-result toast are shaped nothing alike (one is keyed on a grid cell and
// groups repeats by cell; one is keyed on a message and groups repeats by exact
// text) — but they share one position, one width, one z-index, and one padding
// rhythm, so the result reads as one list rather than two. ChangeNotifications'
// own cap (3) and dedup (by cell) are unchanged; this file's are new, in
// lib/notification-stack.ts, deliberately shaped the same way so the two halves
// stay recognisable as one system without being the same code.
//
// Two independent, hand-rolled notification-like elements were found in the same
// audit and deliberately left alone rather than folded in here:
//   - AddProjectButton.tsx's upload-error <span> (no close button, no timer)
//   - SaveQuotedHoursButton.tsx's top-of-viewport save-result banner, whose own
//     comment explains it does NOT also fire the shared toast because "two
//     confirmations for one save is noise and the two could disagree"
// Both are working, deliberate designs; absorbing them was a larger, separate
// change than "stop the two real stacks from spreading" and was not done here.

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useExitList } from "@/components/useMotion";
import { ChangeNotifications } from "@/components/ChangeNotifications";
import {
  foldToast,
  capToasts,
  shouldSuppress,
  autoDismissMs,
  MAX_VISIBLE_TOASTS,
  type ToastItem,
  type ToastKind,
} from "@/lib/notification-stack";

type ToastType = ToastKind;
type ToastOpts = {
  // Bypasses suppression (SuppressToasts, below) and the cap's trim order — see
  // lib/notification-stack.ts. Reserve for the categories the task names as
  // "keep notifications for": a save/autosave failure, a refresh failure or
  // completion, a submission success/failure, a realtime connection issue, a
  // permission/authorization error. Routine confirmations ("Copied X", "Saved
  // view Y", an export finishing) are NOT critical, even when they are errors —
  // an export failing is still just an export, not one of the five categories.
  critical?: boolean;
};
type ToastCtxValue = { toast: (message: string, type?: ToastType, opts?: ToastOpts) => void };

const ToastCtx = createContext<ToastCtxValue | null>(null);

// Default false: nowhere is suppressed unless explicitly wrapped.
const ToastSuppressCtx = createContext(false);

/**
 * Wrap a subtree to silence its ROUTINE toasts — Job Cost Explorer, the Standard
 * Sheet grid columns, and the Standard Card / Standard Fees panel are the three
 * named in the task. A `critical: true` toast called from inside still shows
 * (shouldSuppress in lib/notification-stack.ts is the one place that rule lives).
 *
 * Deliberately a context, not a route-level or global flag: these three areas
 * are component SUBTREES (Standard Sheet's cells are interleaved into the same
 * grid rows as the un-suppressed Monthly ETC cells; Job Cost Explorer is one
 * page among several under a shared layout), and a flag scoped any wider would
 * either miss them or over-suppress a sibling that must not be. Nesting
 * `SuppressToasts` around exactly the JSX that belongs to each area is what
 * keeps the suppression as narrow as the request.
 */
export function SuppressToasts({ children }: { children: React.ReactNode }) {
  return <ToastSuppressCtx.Provider value={true}>{children}</ToastSuppressCtx.Provider>;
}

export function useToast(): ToastCtxValue {
  const ctx = useContext(ToastCtx);
  const suppressed = useContext(ToastSuppressCtx);
  return useMemo<ToastCtxValue>(() => {
    if (!ctx) return { toast: () => {} };
    if (!suppressed) return ctx;
    return {
      toast: (message, type, opts) => {
        if (!shouldSuppress(true, opts?.critical)) ctx.toast(message, type, opts);
      },
    };
  }, [ctx, suppressed]);
}

function Glyph({ type }: { type: ToastType }) {
  const common = { viewBox: "0 0 16 16", width: 15, height: 15, fill: "none", stroke: "currentColor", strokeWidth: 1.8 } as const;
  if (type === "error") {
    return (
      <svg {...common} className="mt-0.5 shrink-0">
        <path d="M8 1.8 L14.5 13.5 H1.5 Z" strokeLinejoin="round" />
        <line x1="8" y1="6.2" x2="8" y2="9.5" strokeLinecap="round" />
        <line x1="8" y1="11.6" x2="8" y2="11.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (type === "warning") {
    // The error triangle, deliberately: a warning is the same SHAPE of message —
    // something needs your attention — at a lower volume, and the colour is what
    // carries the difference. A third unrelated glyph would just be one more
    // thing to learn.
    return (
      <svg {...common} className="mt-0.5 shrink-0">
        <path d="M8 1.8 L14.5 13.5 H1.5 Z" strokeLinejoin="round" />
        <line x1="8" y1="6.2" x2="8" y2="9.5" strokeLinecap="round" />
        <line x1="8" y1="11.6" x2="8" y2="11.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (type === "info") {
    return (
      <svg {...common} className="mt-0.5 shrink-0">
        <circle cx="8" cy="8" r="6.5" />
        <line x1="8" y1="7.3" x2="8" y2="11.2" strokeLinecap="round" />
        <line x1="8" y1="4.8" x2="8" y2="4.8" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...common} className="mt-0.5 shrink-0">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5 8.2 L7.2 10.4 L11 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  // One timer per toast id, so a bumped toast's OWN timer can be cleared and
  // restarted rather than leaving the original timer to fire early on a card
  // that has just been re-shown as "most recent". Bare setTimeout/clearTimeout,
  // not window.-prefixed — matching components/useAutosave.ts's own ref typing,
  // since `ReturnType<typeof window.setTimeout>` and the ambient Node `Timeout`
  // type disagree under this project's mixed DOM+Node lib config.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const scheduleDismiss = useCallback((id: number, type: ToastType) => {
    const existing = timers.current.get(id);
    if (existing !== undefined) clearTimeout(existing);
    const t = setTimeout(() => {
      timers.current.delete(id);
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, autoDismissMs(type));
    timers.current.set(id, t);
  }, []);

  const toast = useCallback(
    (message: string, type: ToastType = "success", opts?: ToastOpts) => {
      const id = ++idRef.current;
      // `target` is written inside the setState updater (a plain local variable,
      // not a ref) purely to learn WHICH id survived the fold — foldToast may keep
      // the incoming id or an existing one it bumped. The updater itself stays
      // pure (no timers, no other side effects) so React re-invoking it (dev
      // StrictMode) can never double-schedule a dismissal; the one side effect —
      // arming the timer — happens once, after setToasts returns, below.
      const target = { id };
      setToasts((prev) => {
        const { items, bumpedId } = foldToast(prev, { id, message, type, critical: opts?.critical ?? false });
        target.id = bumpedId ?? id;
        return capToasts(items, MAX_VISIBLE_TOASTS);
      });
      scheduleDismiss(target.id, type);
    },
    [scheduleDismiss],
  );

  const dismiss = useCallback((id: number) => {
    const existing = timers.current.get(id);
    if (existing !== undefined) {
      clearTimeout(existing);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ── Enter and exit, not appear and vanish (§36.13) ────────────────────────
  //
  // React unmounts a removed item on the spot, so an exit animation on a toast never
  // ran — a confirmation popped in and blinked out, which on the success message
  // after a 20-second refresh is the one moment the user is actually watching.
  //
  // useExitList keeps a dismissed toast mounted, marked `leaving`, for exactly as long
  // as the CSS animation lasts (both read --motion-panel / PANEL_MS, so they cannot
  // disagree), and holds it in its original slot so the ones above it do not jump while
  // it goes (§36.14). Under reduced motion it passes items straight through, so a
  // dismissed toast is simply gone.
  const shown = useExitList(toasts, (t) => String(t.id));

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      {/* ── The one notification stack for the whole app ──────────────────────
          top-20/right-4, matching ChangeNotifications' own (already-tuned)
          position: below the header/toolbar, clear of the grid's bottom
          scrollbar. `--sidebar-w` bounds the width so a narrow window with the
          sidebar dragged wide can never let this reach into the sidebar's own
          span — the one positioning gap the audit found in both of the old,
          separate containers. z-[45] sits above the sidebar/grid-sticky layer
          (z-20) and below a modal dialog (z-50), so an open dialog always wins
          a spatial overlap rather than being covered by a passive notification. */}
      <div
        // ── The clamp that had never actually applied (2026-09-02) ───────────
        //
        // This read `max-w-[calc(var(--app-vw) - var(--sidebar-w) - 2rem)]`, and
        // it did nothing at all: `--sidebar-w` is set on the sidebar element,
        // which is not an ancestor of this fixed container, so the variable
        // resolves to nothing here, the calc() is invalid, and the browser drops
        // the whole declaration. Measured in the running app: computed
        // max-width `none`. The stack was therefore a hard 320px with no bound,
        // which is what made it cover the page in the ~480px window the SDC
        // Tools shell opens.
        //
        // `--app-vw` IS declared on :root (globals.css) and already carries the
        // app-zoom correction, so it resolves here. No sidebar term: the stack
        // is anchored to the right edge, and 1rem of margin on each side is the
        // whole requirement.
        className="pointer-events-none fixed right-4 top-20 z-[45] flex w-[320px] max-w-[calc(var(--app-vw)_-_2rem)] flex-col gap-2"
        aria-live="polite"
        aria-atomic="false"
        aria-label="Notifications"
      >
        <ChangeNotifications />
        {shown.map(({ key, item: t, leaving }) => (
          <div
            key={key}
            role="status"
            // motion-toast-out also sets pointer-events: none, so a toast on its way out
            // can never swallow a click meant for the one behind it or for the grid.
            className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-sm shadow-lg ${
              leaving ? "motion-toast-out" : "motion-toast-in"
            } ${
              t.type === "error"
                ? "border-sdc-red-border bg-sdc-red-bg text-sdc-red-text"
                : t.type === "warning"
                  ? "border-sdc-yellow/70 bg-sdc-yellow-bg text-sdc-yellow-text"
                  : t.type === "info"
                    ? "border-sdc-border bg-white text-sdc-navy"
                    : "border-sdc-green/40 bg-sdc-green-bg text-sdc-green-text"
            }`}
          >
            <Glyph type={t.type} />
            <span className="min-w-0 flex-1 break-words font-medium">
              {t.message}
              {/* The dedup badge (lib/notification-stack.ts's foldToast): the SAME
                  message firing again bumps this card's count instead of stacking
                  a second, visually identical one. */}
              {t.count > 1 && (
                <span
                  className="ml-1.5 inline-block shrink-0 rounded bg-black/10 px-1 align-middle text-label font-semibold leading-4"
                  title={`Happened ${t.count} times`}
                >
                  ×{t.count}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="motion-interactive -mr-1 shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
            >
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4 4 L12 12 M12 4 L4 12" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
