"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_RATIO,
  MIN_PANE_PX,
  clampRatio,
  closePaneHref,
  encodeSplit,
  paneHref,
  ratioBounds,
  splitRoute,
  swap,
  type Pane,
  type SplitState,
} from "@/lib/split-view";

// ── The split view's chrome: divider, per-pane controls, active pane ─────────
//
// Layout and interaction only. The two panes' CONTENT is rendered on the server and
// handed in as `left`/`right` children, so nothing about a drag, a focus change or a
// keyboard shortcut can re-render a page's body — see the note on history.replaceState
// below, which is the mechanism that makes that true rather than merely intended.

// ── Why a drag must never touch the Next router ─────────────────────────────
//
// Ratio and active-pane live in the URL (lib/split-view.ts explains why: App Refresh
// is a full reload that keeps only the URL). The obvious way to write them back is
// router.replace() — and it is the wrong one. /split is a dynamic server route whose
// render runs both panes' data loads; a router.replace on every drag frame, or even
// once per drag release, would re-run Monthly ETC's queries and a live Total ETO call
// because the user nudged a divider two pixels.
//
// window.history.replaceState updates the address bar WITHOUT notifying the router, so
// no navigation, no RSC request, no refetch. The URL stays the single source of truth
// and a reload restores the layout, while dragging costs nothing but a CSS width. This
// is the documented pattern for search-param state that is not a navigation.
function syncUrl(state: SplitState) {
  if (typeof window === "undefined") return;
  const q = encodeSplit(state);
  window.history.replaceState(null, "", `/split?${q}`);
}

export function SplitViewShell({
  state,
  left,
  right,
}: {
  /** Decoded on the server, so the first paint is already the right layout — no post-hydration snap. */
  state: SplitState;
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  const router = useRouter();
  const rowRef = useRef<HTMLDivElement | null>(null);

  // Ratio and active pane are CLIENT state seeded from the server-decoded URL. They
  // are the two things that change without being a navigation.
  const [ratio, setRatio] = useState(() => clampRatio(state.ratio));
  const [active, setActive] = useState<Pane>(state.active);
  const [dragging, setDragging] = useState(false);

  // ── Responsive collapse ──────────────────────────────────────────────────
  //
  // Measured, not guessed from a media query: the panes live inside <main>, whose
  // width is the viewport minus a sidebar the user can collapse or drag. A breakpoint
  // on the viewport would be wrong by exactly the sidebar's width, which is the
  // difference between two readable panes and two unreadable ones.
  //
  // `null` until measured so the server's own two-pane markup is what renders first
  // and nothing collapses-then-expands on hydration.
  const [available, setAvailable] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bounds = available == null ? null : ratioBounds(available);
  // Too narrow for two panes: show only the active one, full width, and say so. The
  // split is NOT closed — the URL still holds both panes, so widening the window (or
  // collapsing the sidebar) brings the other one straight back. Requirement:
  // "never create unreadable 200px-wide Monthly ETC tables".
  const collapsed = available != null && bounds == null;
  // A drag is clamped to what actually fits at THIS width, not to the static 20..80.
  const effectiveRatio = bounds ? Math.min(bounds.max, Math.max(bounds.min, ratio)) : ratio;

  const commit = useCallback(
    (next: { ratio?: number; active?: Pane }) => {
      const r = next.ratio ?? ratio;
      const a = next.active ?? active;
      if (next.ratio !== undefined) setRatio(r);
      if (next.active !== undefined) setActive(a);
      syncUrl({ ...state, ratio: r, active: a });
    },
    [ratio, active, state],
  );

  // ── Dragging ─────────────────────────────────────────────────────────────
  //
  // Pointer events, captured on the divider: setPointerCapture means the drag keeps
  // tracking even when the cursor crosses into a pane, over an iframe-free table, or
  // leaves the window — the failure mode of mousemove-on-document is a divider that
  // sticks to the cursor after release.
  //
  // `touch-action: none` on the handle stops a touch drag from scrolling the page
  // instead of moving the divider; `user-select: none` on the row for the duration
  // stops a drag from selecting table text across both panes.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (collapsed) return;
    e.preventDefault();
    const row = rowRef.current;
    if (!row) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);

    const rect = row.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      const b = ratioBounds(rect.width);
      // Local state only while dragging — the URL is written once, on release, so a
      // drag produces one history.replaceState rather than sixty.
      setRatio(b ? Math.min(b.max, Math.max(b.min, Math.round(pct))) : clampRatio(pct));
    };
    const up = (ev: PointerEvent) => {
      e.currentTarget.releasePointerCapture?.(ev.pointerId);
      e.currentTarget.removeEventListener("pointermove", move);
      e.currentTarget.removeEventListener("pointerup", up);
      setDragging(false);
      // Read the committed value out of state on the next tick rather than
      // recomputing it from the event: the last `move` already clamped it.
      setRatio((r) => {
        syncUrl({ ...state, ratio: r, active });
        return r;
      });
    };
    e.currentTarget.addEventListener("pointermove", move);
    e.currentTarget.addEventListener("pointerup", up);
  };

  // Keyboard resize on the separator: arrows nudge, Home/End go to the extremes a
  // pointer drag can reach, Enter/double-click resets to even. role="separator" with
  // aria-valuenow makes the current split announceable rather than purely visual.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 2;
    const b = bounds ?? { min: 20, max: 80 };
    const at = (n: number) => {
      e.preventDefault();
      commit({ ratio: Math.min(b.max, Math.max(b.min, n)) });
    };
    if (e.key === "ArrowLeft") at(effectiveRatio - step);
    else if (e.key === "ArrowRight") at(effectiveRatio + step);
    else if (e.key === "Home") at(b.min);
    else if (e.key === "End") at(b.max);
    else if (e.key === "Enter" || e.key === " ") at(DEFAULT_RATIO);
  };

  // ── Ctrl+\ ───────────────────────────────────────────────────────────────
  //
  // Closes the split, leaving the ACTIVE pane as a normal full-width page — the
  // toggle's "off" direction. Turning split ON from a single page is the sidebar's
  // "Open in Split View", which needs a target route to open; a shortcut cannot
  // guess one.
  //
  // Skipped while focus is in a text field or a contenteditable: Monthly ETC is a
  // grid of inputs, and a shortcut that fires mid-cell-edit would navigate away
  // from an unsaved value.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== "\\") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      router.push(closePaneHref({ ...state, active }, active === "l" ? "r" : "l"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, state, active]);

  const right_ = state.r;
  if (!right_) {
    // Not split. Rendering the pane bare — no chrome, no wrapper — is what makes a
    // one-pane /split indistinguishable from the page itself.
    return <>{left}</>;
  }

  return (
    <div
      ref={rowRef}
      className="flex min-h-[var(--app-vh)] w-full items-stretch"
      style={dragging ? { userSelect: "none", cursor: "col-resize" } : undefined}
    >
      <PaneFrame
        pane="l"
        state={state}
        active={active}
        onActivate={() => commit({ active: "l" })}
        hidden={collapsed && active !== "l"}
        width={collapsed ? "100%" : `${effectiveRatio}%`}
        collapsed={collapsed}
      >
        {left}
      </PaneFrame>

      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the split. Arrow keys adjust, Enter resets to an even split."
          aria-valuenow={effectiveRatio}
          aria-valuemin={bounds?.min ?? 20}
          aria-valuemax={bounds?.max ?? 80}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onDoubleClick={() => commit({ ratio: DEFAULT_RATIO })}
          onKeyDown={onKeyDown}
          title="Drag to resize · double-click for an even split"
          // 9px of hit area around a 1px rule: "easy to grab" without a fat visible
          // seam. `group` drives the inner rule's hover/active colour so the target
          // and the thing that looks like the target are the same element.
          className={`group relative z-10 w-[9px] shrink-0 cursor-col-resize touch-none focus:outline-none ${
            dragging ? "bg-sdc-blue/10" : "hover:bg-sdc-blue/5"
          }`}
          style={{ touchAction: "none" }}
        >
          <span
            aria-hidden
            // motion-interactive, not a hand-rolled `transition-colors` (§36.17 —
            // the durations live in globals.css so every control in the app answers
            // a hover on the same curve).
            className={`motion-interactive pointer-events-none absolute inset-y-0 left-1/2 -ml-px w-0.5 ${
              dragging ? "bg-sdc-blue" : "bg-sdc-border group-hover:bg-sdc-blue/60 group-focus:bg-sdc-blue"
            }`}
          />
        </div>
      )}

      <PaneFrame
        pane="r"
        state={state}
        active={active}
        onActivate={() => commit({ active: "r" })}
        hidden={collapsed && active !== "r"}
        width={collapsed ? "100%" : `${100 - effectiveRatio}%`}
        collapsed={collapsed}
      >
        {right}
      </PaneFrame>
    </div>
  );
}

function PaneFrame({
  pane,
  state,
  active,
  onActivate,
  hidden,
  width,
  collapsed,
  children,
}: {
  pane: Pane;
  state: SplitState;
  active: Pane;
  onActivate: () => void;
  hidden: boolean;
  width: string;
  collapsed: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const self = pane === "l" ? state.l : state.r!;
  const isActive = active === pane;
  const label = splitRoute(self.path)?.label ?? self.path;

  if (hidden) return null;

  return (
    // `onFocusCapture` alongside the click: tabbing into a pane makes it active too,
    // so keyboard users are never navigating with the sidebar into a pane they cannot
    // see they are in. Capture phase because the focus lands on a descendant.
    <section
      onMouseDown={onActivate}
      onFocusCapture={onActivate}
      aria-label={`${label} pane`}
      // min-w-0 is what lets a dense page scroll horizontally INSIDE its pane rather
      // than forcing the pane wider than its share (which would push the divider off
      // the ratio the user set). Requirement: horizontal scrolling inside the pane is
      // acceptable for Monthly ETC.
      className="flex min-w-0 flex-col"
      style={{ width, minWidth: collapsed ? undefined : MIN_PANE_PX }}
    >
      {/* ── The pane's own header ───────────────────────────────────────────
          Deliberately thin (h-8, one line, no icons beyond the two controls):
          two of these are on screen at once above pages that already have their
          own titles and toolbars, so anything taller reads as a second chrome
          competing with the app's.

          The active indication is this bar's tint plus a 2px top rule, not a ring
          around the whole pane — a ring around a full-height column of tables is
          the "visually noisy" outcome the requirement rules out. */}
      <header
        className={`flex h-8 shrink-0 items-center justify-between gap-2 border-b px-2 ${
          isActive ? "border-sdc-blue/40 bg-sdc-blue-light/40" : "border-sdc-border bg-sdc-gray-50"
        }`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive ? "bg-sdc-blue" : "bg-sdc-gray-300"}`}
          />
          <span className={`truncate text-label font-semibold ${isActive ? "text-sdc-navy" : "text-sdc-gray-600"}`}>
            {label}
          </span>
          {isActive && (
            // Says WHY the highlight matters, which is the thing an active-pane
            // outline on its own never manages to communicate.
            <span className="hidden whitespace-nowrap text-micro text-sdc-blue-dark sm:inline">
              · sidebar opens here
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          <PaneButton
            onClick={() => router.push(paneHref(self))}
            title={`Expand ${label} to the full window and close the other pane`}
          >
            Expand
          </PaneButton>
          <PaneButton
            onClick={() => {
              const s = swap(state);
              // A swap reorders the panes, which IS a change to what each side
              // renders — so unlike a resize it goes through the router.
              router.push(`/split?${encodeSplit(s)}`);
            }}
            title="Swap the two panes"
          >
            Swap
          </PaneButton>
          <PaneButton
            onClick={() => router.push(closePaneHref(state, pane))}
            title={`Close ${label} — the other pane returns to full width`}
          >
            {/* A word, not a bare ×: there are two of these eight pixels apart, and
                "which × closes which pane" is not a question a control should pose. */}
            Close
          </PaneButton>
        </span>
      </header>

      {/* Each pane its own scroll container — the requirement that scrolling Monthly
          ETC on the left must not move Job Hour Details on the right. `overflow-auto`
          both ways: dense pages scroll horizontally in here too, and ScrollHandoff
          (mounted once in AppShell, above both panes) keeps nested table scrolling
          working inside each one because it listens at the document level. */}
      <div className="min-h-0 flex-1 overflow-auto bg-background">{children}</div>
    </section>
  );
}

function PaneButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        // The header sits inside the pane, whose mousedown activates it. A control
        // click should not ALSO be an activation — pressing Close on the inactive
        // pane would otherwise make it active for the instant before it closes.
        e.stopPropagation();
        onClick();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      title={title}
      className="motion-interactive rounded px-1.5 py-0.5 text-micro font-medium text-sdc-gray-600 hover:bg-white hover:text-sdc-navy"
    >
      {children}
    </button>
  );
}
