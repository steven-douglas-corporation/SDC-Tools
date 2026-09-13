"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { addNewProjectRow } from "@/components/NewProjectRowsStore";
import { createJobFromRelease } from "@/lib/project-release-actions";

// "+ Add Project" now asks HOW to add: a blank Manual row, or From an SDC
// Project Release (.pdf/.docx) that auto-fills the job. Replaces the separate
// "+ From Release" button.
export function AddProjectButton({ className }: { className: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        className={className}
        disabled={pending}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {pending ? "Reading…" : "+ Add Project"}
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-full z-40 mt-2 w-64 overflow-hidden rounded-lg border border-sdc-border bg-white py-1 shadow-lg">
          <button
            type="button"
            role="menuitem"
            className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-sdc-blue-light"
            onClick={() => { setOpen(false); addNewProjectRow(); }}
          >
            <span className="text-sm font-medium text-sdc-navy">Manual entry</span>
            <span className="text-xs text-sdc-muted">Add a blank row and type it in</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full flex-col items-start border-t border-sdc-border-soft px-3 py-2 text-left hover:bg-sdc-blue-light"
            onClick={() => { setOpen(false); inputRef.current?.click(); }}
          >
            <span className="text-sm font-medium text-sdc-navy">From Release</span>
            <span className="text-xs text-sdc-muted">Upload an SDC Project Release (.pdf / .docx)</span>
          </button>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // allow re-selecting the same file later
          if (!file) return;
          setError(null);
          const fd = new FormData();
          fd.append("file", file);
          startTransition(async () => {
            try {
              await createJobFromRelease(fd); // redirects to the new job on success
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.includes("NEXT_REDIRECT")) return; // redirect control-flow, not an error
              setError(msg);
            }
          });
        }}
      />
      {error && (
        <span className="absolute right-0 top-full mt-1 max-w-xs rounded bg-red-600 px-2 py-1 text-xs text-white shadow-lg">
          {error}
        </span>
      )}
    </div>
  );
}
