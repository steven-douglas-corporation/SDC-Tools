"use client";

import { useEffect, useId, useRef, useState } from "react";

// The gear beside the signed-in person's name: settings that are theirs alone. It opens
// and closes in place and goes nowhere. Administration is not here; that is a destination,
// listed in the launcher at the top of the sidebar.
//
// What it holds is passed in by the sidebar, so each setting keeps its one home in the
// code. Today that is the zoom control.

export function SettingsMenu({ collapsed, children }: { collapsed: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const panelId = useId();

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
    <div ref={wrap} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Your settings"
        title="Your settings"
        onClick={() => setOpen((v) => !v)}
        className={`flex h-[26px] w-[26px] items-center justify-center rounded-[7px] motion-interactive hover:bg-[#0E3157] hover:text-[#F3F6FA] ${
          open ? "bg-[#0E3157] text-[#F3F6FA]" : "text-[#8FA6BE]"
        }`}
      >
        <svg
          viewBox="0 0 16 16"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="2" />
          <circle cx="8" cy="8" r="4.6" />
          <path d="M8 1.4 V3.4 M8 12.6 V14.6 M1.4 8 H3.4 M12.6 8 H14.6 M3.3 3.3 L4.75 4.75 M11.25 11.25 L12.7 12.7 M3.3 12.7 L4.75 11.25 M11.25 4.75 L12.7 3.3" />
        </svg>
      </button>

      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="Your settings"
          // Upward, because the gear sits at the foot of the sidebar; beside the rail when
          // the sidebar is collapsed, where there is no width to open into.
          className={`absolute z-30 w-52 rounded-lg bg-[#0B2846] py-2 shadow-[inset_0_0_0_1px_#1B4270,0_8px_24px_rgba(0,0,0,0.45)] ${
            collapsed ? "bottom-0 left-full ml-2" : "right-0 bottom-full mb-2"
          }`}
        >
          <p className="px-[10px] pb-1 font-mono text-micro tracking-[0.16em] text-[#6E88A5] uppercase">
            Your settings
          </p>
          {children}
          <p className="px-[10px] pt-1 text-label text-[#5A7391]">Kept in this browser.</p>
        </div>
      )}
    </div>
  );
}
