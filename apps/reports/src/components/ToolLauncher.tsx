"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { AreaId, Tool } from "@/lib/tools";

// The launcher at the top of the sidebar: which tool is open, and a short list for moving
// to another, to Admin, or out to the SDC Scheduler. The Scheduler's link is here and
// nowhere else in the sidebar, so in practice everyone sees the launcher.
//
// A grid of dots, not three lines: three lines reads as "show or hide this menu", and the
// sidebar already has a Collapse control.

const ROW =
  "flex w-full items-center gap-[10px] rounded-[7px] px-[10px] py-[7px] text-left text-sm text-[#C3D1E0] motion-interactive hover:bg-[#0E3157] hover:text-[#F3F6FA]";

function Dots() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true">
      {[3, 8, 13].flatMap((y) => [3, 8, 13].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.35" />))}
    </svg>
  );
}

export function ToolLauncher({
  tools,
  current,
  collapsed,
  railItemClass,
  adminHref,
  scheduler,
}: {
  tools: Tool[];
  /** The area the page on screen belongs to; null on the tools page. */
  current: AreaId | null;
  collapsed: boolean;
  /** The sidebar's own class for an icon-only row in the collapsed rail. */
  railItemClass: string;
  /** The link out to the SDC Scheduler, with the click handling the sidebar already gives it. */
  /** The first Admin page this person may open. Absent, Admin is not listed. */
  adminHref?: string;
  scheduler?: { href: string; onClick: (e: React.MouseEvent<HTMLAnchorElement>) => void; inShell: boolean };
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const label = tools.find((t) => t.id === current)?.label ?? (current === "admin" ? "Admin" : "All tools");

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className={`relative pb-[10px] ${collapsed ? "px-[3px]" : "px-[14px]"}`}>
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        title="Switch to another tool"
        onClick={() => setOpen((v) => !v)}
        className={
          collapsed
            ? `${railItemClass} text-[#A9BCD0] hover:bg-[#0E3157] hover:text-[#F3F6FA]`
            : "flex h-9 w-full items-center gap-[10px] rounded-[7px] bg-[#0B2846] px-[10px] text-sm font-semibold text-[#F3F6FA] shadow-[inset_0_0_0_1px_#17395C] hover:bg-[#0E3157]"
        }
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[#8FA6BE]">
          <Dots />
        </span>
        <span className={collapsed ? "sr-only" : "min-w-0 flex-1 truncate text-left"}>
          {collapsed ? `Switch tool. Open now: ${label}` : label}
        </span>
        {!collapsed && (
          <svg
            viewBox="0 0 16 16"
            width="11"
            height="11"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            className="shrink-0 text-[#6E88A5]"
            aria-hidden="true"
          >
            <path d="M3.5 6 L8 10.5 L12.5 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="Tools"
          className={`absolute z-30 rounded-lg bg-[#0B2846] p-1 shadow-[inset_0_0_0_1px_#1B4270,0_8px_24px_rgba(0,0,0,0.45)] ${
            collapsed ? "left-full top-0 ml-2 w-60" : "inset-x-[14px] top-full -mt-[6px]"
          }`}
        >
          {/* With a single tool the tools page only sends the person back to it. */}
          {tools.length > 1 && (
            <Link
              href="/"
              onClick={() => setOpen(false)}
              aria-current={current === null ? "page" : undefined}
              className={`${ROW} ${current === null ? "bg-[#0E3157] text-[#F3F6FA]" : ""}`}
            >
              All tools
            </Link>
          )}
          {tools.map((t) => (
            <Link
              key={t.id}
              href={t.href}
              onClick={() => setOpen(false)}
              aria-current={current === t.id ? "true" : undefined}
              className={`${ROW} ${current === t.id ? "bg-[#0E3157] text-[#F3F6FA]" : ""}`}
            >
              <span className="min-w-0">
                <span className="block truncate font-semibold">{t.label}</span>
                <span className="block truncate text-note text-[#7E93AC]">{t.description}</span>
              </span>
            </Link>
          ))}
          {/* Listed so that whatever the button names as open is one of the choices here. */}
          {adminHref && (
            <Link
              href={adminHref}
              onClick={() => setOpen(false)}
              aria-current={current === "admin" ? "true" : undefined}
              className={`${ROW} ${current === "admin" ? "bg-[#0E3157] text-[#F3F6FA]" : ""}`}
            >
              <span className="min-w-0">
                <span className="block truncate font-semibold">Admin</span>
                <span className="block truncate text-note text-[#7E93AC]">Users, permissions and logs</span>
              </span>
            </Link>
          )}
          {scheduler && (
            <a
              href={scheduler.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                setOpen(false);
                scheduler.onClick(e);
              }}
              className={ROW}
            >
              <span className="min-w-0">
                <span className="block truncate font-semibold">Project Scheduler</span>
                <span className="block truncate text-note text-[#7E93AC]">
                  {scheduler.inShell ? "A separate app" : "A separate app. Opens in a new tab"}
                </span>
              </span>
            </a>
          )}
        </div>
      )}
    </div>
  );
}
