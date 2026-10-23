"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// ── A multi-select dropdown for the Parts cost vs budget filters (2026-10-23) ───────────────────
//
// Customer and Type, beside the status chips. Nothing ticked means "every one" — the same as the status
// chip's Both — so a filter only ever narrows. The list is searchable once it is long (there are dozens of
// customers), shows how many jobs each option holds, and closes on an outside click or Escape.

export type FilterOption = { value: string; label: string; count: number };

export function FilterMenu({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [needle, setNeedle] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shown = useMemo(() => {
    const n = needle.trim().toLowerCase();
    return n ? options.filter((o) => o.label.toLowerCase().includes(n)) : options;
  }, [options, needle]);

  const chosen = new Set(selected);
  const toggle = (value: string) => onChange(chosen.has(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  const summary =
    selected.length === 0
      ? "All"
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? "1 selected")
        : `${selected.length} selected`;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`motion-interactive inline-flex max-w-[16rem] items-center gap-1.5 rounded-lg border bg-white px-3 py-1.5 text-sm shadow-sm hover:bg-sdc-gray-50 ${
          selected.length > 0 ? "border-sdc-blue text-sdc-blue-dark" : "border-sdc-border text-sdc-gray-600"
        }`}
      >
        <span className="font-medium">{label}</span>
        <span className="truncate text-sdc-gray-400">{summary}</span>
        <span aria-hidden className="text-sdc-gray-400">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label={label}
          className="absolute left-0 z-30 mt-1 w-72 rounded-lg border border-sdc-border bg-white p-2 shadow-lg"
        >
          {options.length > 8 && (
            <input
              type="search"
              value={needle}
              onChange={(e) => setNeedle(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}`}
              aria-label={`Search ${label.toLowerCase()}`}
              autoFocus
              className="mb-2 w-full rounded-md border border-sdc-border px-2.5 py-1.5 text-sm placeholder:text-sdc-gray-400 focus:border-sdc-blue focus:outline-none"
            />
          )}
          <ul className="max-h-64 overflow-auto">
            {shown.length === 0 ? (
              <li className="px-2 py-3 text-center text-sm text-sdc-muted">No match.</li>
            ) : (
              shown.map((o) => (
                <li key={o.value}>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-sdc-gray-50">
                    <input type="checkbox" checked={chosen.has(o.value)} onChange={() => toggle(o.value)} />
                    <span className="min-w-0 flex-1 truncate text-sdc-navy" title={o.label}>
                      {o.label}
                    </span>
                    <span className="shrink-0 text-label tabular-nums text-sdc-gray-400">{o.count}</span>
                  </label>
                </li>
              ))
            )}
          </ul>
          <div className="mt-2 flex items-center justify-between border-t border-sdc-border-soft pt-2 text-xs">
            <button
              type="button"
              disabled={selected.length === 0}
              onClick={() => onChange([])}
              className="font-semibold text-sdc-blue hover:underline disabled:cursor-default disabled:text-sdc-gray-400 disabled:no-underline"
            >
              Clear
            </button>
            <button type="button" onClick={() => setOpen(false)} className="font-semibold text-sdc-blue hover:underline">
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
