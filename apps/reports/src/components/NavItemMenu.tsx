"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TabId } from "@/lib/workspace";
import type { TabInstance } from "@/components/useWorkspaceActions";

// ── One menu, two ways to open it ────────────────────────────────────────────
//
// Requested 2026-09-04: "Do not rely on right-click to expose Open in a new tab or
// Open in Split View. Most users will never discover that interaction."
//
// So every eligible sidebar item now carries a visible ⋮ button, and this is the menu
// it opens. Right-click still opens the SAME component — kept as an optional shortcut
// for anyone who already learned it, which was the other half of the instruction.
//
// Every entry calls into useWorkspaceActions, so the ⋮ button, the right-click menu and
// the tab strip cannot drift apart. This file holds no tab logic at all: it decides
// what to OFFER (which is a function of how many instances are open) and nothing about
// what any of it does.

export type NavMenuAnchor = {
  href: string;
  label: string;
  /** Where to draw it: a pointer position for right-click, or the ⋮ button's rect. */
  x: number;
  y: number;
};

export function NavItemMenu({
  anchor,
  onClose,
  instances,
  duplicable,
  refusal,
  refusesSecondInstance,
  onOpenNewTab,
  onOpenInSplitView,
  onDuplicate,
}: {
  anchor: NavMenuAnchor;
  onClose: () => void;
  /** Open instances of this page, most-recently-used first. Drives the Split View step. */
  instances: TabInstance[];
  /** The instance a Duplicate would copy, or null when none is open. */
  duplicable: TabId | null;
  /** Why this page cannot be opened right now, or null. */
  refusal: string | null;
  /** True when a second instance is refused outright (Monthly ETC). */
  refusesSecondInstance: boolean;
  onOpenNewTab: () => void;
  onOpenInSplitView: (opts?: { instance?: TabId; newInstance?: boolean }) => void;
  onDuplicate: (id: TabId) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Split View becomes a two-step choice only when there is a real choice to make —
  // see the requirement about multiple instances.
  const [step, setStep] = useState<"root" | "split">("root");
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // ── Keyboard ─────────────────────────────────────────────────────────────
  //
  // "Support keyboard navigation." Focus moves into the menu on open so Tab and the
  // arrow keys work from there, and Escape returns to the step above rather than
  // closing outright — backing out of the instance picker should not lose the menu.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measured, then clamped, so a menu opened near the bottom of a short window is not
    // half off-screen. Done after mount because the height depends on how many entries
    // this page actually offers.
    const rect = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(anchor.y, window.innerHeight - rect.height - 8));
    setPos({ left, top });
    el.querySelector<HTMLElement>("[role='menuitem']:not([aria-disabled='true'])")?.focus();
  }, [anchor.x, anchor.y, step]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onDown = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (step === "split") setStep("root");
        else onClose();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
      const items = [...el.querySelectorAll<HTMLElement>("[role='menuitem']:not([aria-disabled='true'])")];
      if (items.length === 0) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === "Home" ? 0
        : e.key === "End" ? items.length - 1
        : e.key === "ArrowDown" ? (at + 1 + items.length) % items.length
        : (at - 1 + items.length) % items.length;
      items[next]?.focus();
    };

    // pointerdown rather than click, so the menu closes on the press before the element
    // underneath acts on the same gesture; capture phase so a stopPropagation in the nav
    // cannot strand an open menu on screen.
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    // A scroll or resize moves the item this is anchored to, so the anchor stops meaning
    // anything — close rather than float somewhere unrelated.
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, step]);

  const run = (fn: () => void) => {
    onClose();
    fn();
  };

  // More than one instance open means Split View has a genuine choice to make: which of
  // them to show, or a fresh one. One instance needs no question, and none means the
  // action simply opens one.
  const choosable = instances.length > 1;

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${anchor.label} options`}
      className="fixed z-50 min-w-[14rem] max-w-[18rem] overflow-hidden rounded-md border border-sdc-border bg-white py-1 shadow-lg"
      // Rendered off-screen for the one frame before it is measured, rather than at 0,0
      // where it would flash in the corner.
      style={pos ?? { left: -9999, top: 0 }}
    >
      <p className="truncate px-3 pb-1 pt-0.5 text-micro font-semibold uppercase tracking-wide text-sdc-gray-400">
        {anchor.label}
      </p>

      {step === "root" ? (
        <>
          {/* Deliberately NOT offering a plain "Open": the row itself is the control for
              that, and the button sits on it. A menu whose first entry duplicates the
              thing you clicked to reach it is padding. */}
          <MenuItem
            onSelect={() => run(onOpenNewTab)}
            disabled={refusal != null || refusesSecondInstance}
            note={
              refusesSecondInstance
                ? "can only be open once at a time"
                : refusal ?? (instances.length > 0 ? `${instances.length} already open` : undefined)
            }
          >
            Open in new tab
          </MenuItem>

          <MenuItem
            onSelect={() => (choosable ? setStep("split") : run(() => onOpenInSplitView()))}
            disabled={refusal != null}
            note={refusal ?? undefined}
            submenu={choosable}
          >
            Open in Split View
          </MenuItem>

          {/* Only when an instance is open — there is otherwise nothing to duplicate,
              and the request asked for it on exactly that condition. */}
          {duplicable && !refusesSecondInstance && (
            <MenuItem onSelect={() => run(() => onDuplicate(duplicable))} disabled={refusal != null}>
              Duplicate current tab
            </MenuItem>
          )}

          {refusal && (
            // Stated in the menu rather than only in a tooltip: a disabled row is not
            // self-explanatory, and this is the one refusal that is a deliberate design
            // limit rather than an oversight.
            <p className="border-t border-sdc-border px-3 pb-0.5 pt-1 text-micro leading-snug text-sdc-gray-400">
              {refusal}.
            </p>
          )}
        </>
      ) : (
        <>
          <p className="px-3 pb-1 text-micro text-sdc-muted">
            {instances.length} tabs are open on this page. Which one goes beside the current tab?
          </p>
          {instances.map((i) => (
            <MenuItem key={i.id} onSelect={() => run(() => onOpenInSplitView({ instance: i.id }))}>
              {i.title}
            </MenuItem>
          ))}
          <div className="my-1 border-t border-sdc-border" />
          <MenuItem
            onSelect={() => run(() => onOpenInSplitView({ newInstance: true }))}
            disabled={refusesSecondInstance}
            note={refusesSecondInstance ? "can only be open once at a time" : undefined}
          >
            Open a new instance
          </MenuItem>
          <MenuItem onSelect={() => setStep("root")}>Back</MenuItem>
        </>
      )}
    </div>
  );
}

function MenuItem({
  onSelect,
  disabled,
  note,
  submenu,
  children,
}: {
  onSelect: () => void;
  disabled?: boolean;
  /** Why this is refused, or what it will do — a disabled row with no reason reads as a bug. */
  note?: string;
  /** Draws the "leads to another step" chevron. */
  submenu?: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    // A <span>, not a disabled <button>: a disabled button is skipped by the arrow-key
    // walk above AND unreachable by Tab, so the reason on it would never be readable.
    // This keeps it in the reading order while staying un-activatable.
    return (
      <span
        role="menuitem"
        aria-disabled="true"
        tabIndex={-1}
        title={note}
        className="block cursor-not-allowed px-3 py-1.5 text-label text-sdc-gray-300"
      >
        {children}
        {note && <span className="block truncate text-micro font-normal text-sdc-gray-400">{note}</span>}
      </span>
    );
  }
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      title={note}
      className="motion-interactive flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-label text-sdc-navy hover:bg-sdc-blue-light/60 focus:bg-sdc-blue-light/60 focus:outline-none"
    >
      <span className="min-w-0">
        <span className="block truncate">{children}</span>
        {note && <span className="block truncate text-micro font-normal text-sdc-gray-400">{note}</span>}
      </span>
      {submenu && (
        <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-sdc-gray-400" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M4.5 2.5l4 3.5-4 3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

/**
 * The visible ⋮ on a sidebar row.
 *
 * The whole point of the request: these options must be discoverable without knowing
 * that right-click does anything. It is subtle at rest and firms up on hover or focus,
 * so it reads as available without turning the sidebar into a column of icons.
 */
export function NavItemMenuButton({
  label,
  open,
  onOpen,
}: {
  label: string;
  open: boolean;
  onOpen: (rect: DOMRect) => void;
}) {
  return (
    <button
      type="button"
      // Not inside the row's <Link> — a button nested in an anchor is invalid markup and
      // the click would activate the link on the way past. It is a sibling, and the row
      // is a flex container.
      onClick={(e) => {
        // "Not trigger normal sidebar navigation when clicked."
        e.preventDefault();
        e.stopPropagation();
        onOpen(e.currentTarget.getBoundingClientRect());
      }}
      onPointerDown={(e) => e.stopPropagation()}
      // Enter/Space already fire onClick on a button; stopping the keydown keeps the
      // sidebar's own Alt+Arrow reorder handler from seeing keys aimed at this control.
      onKeyDown={(e) => e.stopPropagation()}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`More options for ${label}`}
      title="More options"
      className={`motion-interactive shrink-0 rounded p-0.5 text-[#8FA6BE] hover:bg-[#164272] hover:text-white focus:bg-[#164272] focus:text-white focus:outline-none ${
        open ? "bg-[#164272] text-white opacity-100" : "opacity-60 group-hover/nav:opacity-100 focus:opacity-100"
      }`}
    >
      <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" aria-hidden fill="currentColor">
        <circle cx="7" cy="2.6" r="1.25" />
        <circle cx="7" cy="7" r="1.25" />
        <circle cx="7" cy="11.4" r="1.25" />
      </svg>
    </button>
  );
}
