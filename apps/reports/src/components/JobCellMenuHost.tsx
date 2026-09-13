"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { JOB_MENU_CELL_SELECTOR, placeContextMenu } from "@/lib/job-cell-menu";
import { currentZoom } from "@/lib/app-zoom";
import { decideCrossAppNav, reportCrossAppNavError } from "@/lib/shell-cross-app-nav";
import { useToast } from "@/components/ui/Toast";

// The Job cell's right-click menu (Job Hour Details / Project Schedule) — ONE
// instance for a whole grid, instead of one component per cell.
//
// ── Why this replaced JobCellMenu (2026-08-03) ──────────────────────────────
// JobCellMenu rendered the <td> itself, so every Job Id and Job Name cell was a
// separate client component. On the Projects grid with "Show all" that is 233
// rows x 2 = 466 hydration roots whose entire job is to catch a right-click, and
// they were a large part of why that button took seconds.
//
// The cells are now plain server-rendered <td>s carrying `data-job-menu-*`
// attributes (see jobCellMenuProps in lib/job-cell-menu.ts), and this single
// component listens for
// `contextmenu` on the document, walks up to the nearest tagged cell and reads
// them. Nothing about the menu's behaviour changes — same items, same portal,
// same edge-flipping, same keyboard handling.
//
// Delegation is also more robust than what it replaced: rows come and go as
// filters, sorting and the column pickers change, and a document-level listener
// cannot be left attached to a cell that no longer exists.

// The cells' attributes and the selector live in lib/job-cell-menu.ts — a plain
// module, because this file is "use client" and its exports become client
// references that a server component cannot call. See the note there.

type OpenAt = { x: number; y: number; ret: string; jobId: string; jobName: string; schedulerUrl: string | null };

const ITEM =
  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-note text-sdc-navy hover:bg-sdc-gray-100 focus:bg-sdc-gray-100 focus:outline-none";

export function JobCellMenuHost() {
  // `ret` is the report URL handed to the Scheduler, captured when the menu
  // OPENS rather than at click time: window.location.href carries the user's
  // current filters/sort/columns, and mutating the anchor's href inside its own
  // click handler races React's unmount of the menu.
  const [at, setAt] = useState<OpenAt | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // For the one failure the shell bridge reports: the target app not running.
  const { toast } = useToast();

  useEffect(() => {
    function onContextMenu(e: MouseEvent) {
      // Shift+right-click falls through to the browser's own menu — these cells
      // hold an editable job-name input, so keep an escape hatch to its native
      // copy/paste/spellcheck items.
      if (e.shiftKey) return;
      const cell = (e.target as HTMLElement | null)?.closest<HTMLElement>(JOB_MENU_CELL_SELECTOR);
      if (!cell) return;
      e.preventDefault();
      const jobId = cell.getAttribute("data-job-menu-id") ?? "";
      const jobName = cell.getAttribute("data-job-menu-name") ?? "";
      const schedulerUrl = cell.getAttribute("data-job-menu-url");
      const ret = window.location.href;
      // The keyboard Menu key (and Shift+F10) fire `contextmenu` with no useful
      // coordinates; anchor to the cell instead of the viewport corner.
      if (e.clientX === 0 && e.clientY === 0) {
        const r = cell.getBoundingClientRect();
        setAt({ x: r.left + 8, y: r.bottom, ret, jobId, jobName, schedulerUrl });
      } else {
        setAt({ x: e.clientX, y: e.clientY, ret, jobId, jobName, schedulerUrl });
      }
    }
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Close on anything that would leave the menu stranded or mispositioned.
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) close();
    };
    // `capture` so a scroll inside the grid container (which doesn't bubble)
    // still closes it.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    // mousedown, not click: a right-click elsewhere must move the menu, not
    // leave two open.
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [at]);

  // Keep it on screen: flip left/up when the cursor is near the viewport edge.
  // Layout effect so the correction paints in the same frame — a visible jump
  // would read as a glitch. Rows near the bottom of a full-height grid hit this
  // constantly.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !at) return;

    // The arithmetic — and the reason it is not simply clientX/clientY — lives
    // in placeContextMenu (lib/job-cell-menu.ts), where it is pure and tested.
    const { x, y } = placeContextMenu({
      clientX: at.x,
      clientY: at.y,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      width: el.offsetWidth,
      height: el.offsetHeight,
      zoom: currentZoom(),
    });
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.visibility = "visible";
    // Focus the first item so the menu is usable from the keyboard once opened.
    el.querySelector<HTMLElement>("[data-menu-item]")?.focus();
  }, [at]);

  if (!at) return null;

  // ── Inside the SDC Tools shell, do NOT open a new tab (2026-08-28) ───────
  //
  // The shell answers every window.open / target="_blank" from an embedded app
  // with `shell.openExternal(url)` and denies the window
  // (apps/shell/electron/main.js's setWindowOpenHandler). So "Project Schedule"
  // threw the user OUT of the shell into their default browser, at the
  // standalone Scheduler — which is the "opens the wrong app" report: the
  // Scheduler was already running as a shell window, and the shell's session
  // does not follow you into Chrome.
  //
  // If the shell exposes an app-launcher bridge, use it: it focuses the
  // Scheduler window that is already open (openAppWindow reuses an existing
  // one) instead of starting anything. Feature-detected, because a browser tab
  // and older shell builds have no such object — those keep the _blank tab,
  // which is the right behaviour there.
  const onScheduleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const href = at.schedulerUrl ? `${at.schedulerUrl}&ret=${encodeURIComponent(at.ret)}` : null;

    // The three tiers (shell bridge / in-place inside an older shell / plain
    // _blank tab) now live in lib/shell-cross-app-nav.ts, because two other
    // links in this app need exactly the same decision. This block used to be
    // that logic; the `ret` parameter above still gives the Scheduler its
    // "← Back to report" button, so a tier-2 in-place navigation is a round
    // trip rather than a dead end.
    if (href) {
      const result = decideCrossAppNav("scheduler", href);
      if (result.mode !== "anchor") {
        e.preventDefault();
        void reportCrossAppNavError(result, (message) => toast(message, "error"));
        setAt(null);
        return;
      }
    }

    // A normal browser tab — the anchor's own target="_blank" is right here.
    // Deferred close: setAt(null) unmounts this anchor, and React flushes that
    // synchronously for discrete events — potentially before the browser
    // performs the default action, which can silently cancel the new tab. A
    // macrotask close lets the navigation start first.
    setTimeout(() => setAt(null), 0);
  };


  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Actions for ${at.jobName}`}
      // Positioned (and revealed) by the layout effect above, after it can
      // measure the real size — hidden until then so the pre-flip position never
      // flashes. z-index clears the sticky header (z-20) and the grid's own
      // stacking contexts.
      style={{ position: "fixed", left: at.x, top: at.y, visibility: "hidden", zIndex: 60 }}
      className="min-w-[190px] overflow-hidden rounded-md border border-sdc-border bg-white py-1 shadow-lg"
    >
      <div className="truncate border-b border-sdc-border px-3 py-1 font-mono text-label text-sdc-muted">{at.jobId}</div>
      <Link
        href={`/job-hours?jobs=${encodeURIComponent(at.jobId)}`}
        role="menuitem"
        data-menu-item
        className={ITEM}
        onClick={() => setAt(null)}
      >
        {/* Same glyphs the removed inline icons used, so the destinations stay
            visually recognizable. */}
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" className="shrink-0 text-sdc-gray-400">
          <line x1="2" y1="14" x2="14" y2="14" strokeLinecap="round" />
          <rect x="2.5" y="8" width="2.5" height="5" rx="0.5" />
          <rect x="6.75" y="4.5" width="2.5" height="8.5" rx="0.5" />
          <rect x="11" y="6.5" width="2.5" height="6.5" rx="0.5" />
        </svg>
        Job Details
      </Link>
      {at.schedulerUrl && (
        <a
          // &ret= is what powers the Scheduler's "← Back to report" button. It
          // has to be passed explicitly: this opens in a new tab (so browser Back
          // has no entry to return to), and the referrer is useless across
          // origins — 4006 → 4003 arrives stripped to the bare origin under
          // strict-origin-when-cross-origin, losing the report's path and filters.
          href={`${at.schedulerUrl}&ret=${encodeURIComponent(at.ret)}`}
          target="_blank"
          rel="noopener noreferrer"
          role="menuitem"
          data-menu-item
          className={ITEM}
          onClick={onScheduleClick}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" className="shrink-0 text-sdc-gray-400">
            <line x1="2.5" y1="3.5" x2="9.5" y2="3.5" strokeLinecap="round" />
            <line x1="5.5" y1="8" x2="13.5" y2="8" strokeLinecap="round" />
            <line x1="3.5" y1="12.5" x2="10.5" y2="12.5" strokeLinecap="round" />
          </svg>
          Project Schedule
        </a>
      )}
    </div>,
    document.body,
  );
}
