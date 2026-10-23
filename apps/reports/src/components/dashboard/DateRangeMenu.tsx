"use client";

import { useEffect, useRef, useState } from "react";
import { DATE_FIELD_LABEL, cleanBound, type DateField } from "@/lib/parts-budget-bands";

// ── The project-date filter for the Parts cost vs budget section (2026-10-23) ───────────────────
//
// "Show me jobs from 2025", "jobs that finished this year". The same two choices the Projects tab filters on:
// the project's Start date or its Complete date, between a From and a To (both optional, inclusive). The
// quick choices are the calendar years the jobs actually span, so a year is one click.

export type DateValue = { field: DateField; from: string | null; to: string | null };

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** What the button says: nothing set is "All"; a whole calendar year is just the year. */
export function describeDates(v: DateValue): string {
  if (!v.from && !v.to) return "All";
  if (v.from && v.to && v.from.endsWith("-01-01") && v.to.endsWith("-12-31") && v.from.slice(0, 4) === v.to.slice(0, 4)) {
    return `${DATE_FIELD_LABEL[v.field].split(" ")[0]} ${v.from.slice(0, 4)}`;
  }
  return `${DATE_FIELD_LABEL[v.field].split(" ")[0]} ${v.from ?? "…"} → ${v.to ?? "…"}`;
}

export function DateRangeMenu({
  value,
  years,
  undated,
  onChange,
}: {
  value: DateValue;
  /** How many jobs have no value for the chosen date field (a range leaves them out). */
  undated: number;
  /** Calendar years the chosen date field spans, newest first. */
  years: number[];
  onChange: (next: DateValue) => void;
}) {
  const [open, setOpen] = useState(false);
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

  const active = value.from != null || value.to != null;
  const setYear = (y: number) => onChange({ ...value, from: `${y}-01-01`, to: `${y}-12-31` });
  const lastTwelveMonths = () => {
    const to = new Date();
    const from = new Date(to);
    from.setUTCFullYear(from.getUTCFullYear() - 1);
    onChange({ ...value, from: iso(from), to: iso(to) });
  };
  const yearOn = (y: number) => value.from === `${y}-01-01` && value.to === `${y}-12-31`;
  const invalid = value.from != null && value.to != null && value.from > value.to;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`motion-interactive inline-flex max-w-[18rem] items-center gap-1.5 rounded-lg border bg-white px-3 py-1.5 text-sm shadow-sm hover:bg-sdc-gray-50 ${
          active ? "border-sdc-blue text-sdc-blue-dark" : "border-sdc-border text-sdc-gray-600"
        }`}
      >
        <span className="font-medium">Dates</span>
        <span className="truncate text-sdc-gray-400">{describeDates(value)}</span>
        <span aria-hidden className="text-sdc-gray-400">
          ▾
        </span>
      </button>

      {open && (
        <div role="dialog" aria-label="Project dates" className="absolute left-0 z-30 mt-1 w-80 rounded-lg border border-sdc-border bg-white p-3 shadow-lg">
          <fieldset className="mb-3">
            <legend className="mb-1 text-label font-semibold uppercase tracking-[0.06em] text-sdc-gray-600">Filter by</legend>
            <div className="inline-flex overflow-hidden rounded-lg border border-sdc-border text-sm">
              {(["start", "end"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={value.field === f}
                  onClick={() => onChange({ ...value, field: f })}
                  className={`motion-interactive px-3 py-1 font-medium ${
                    value.field === f ? "bg-sdc-blue text-white" : "text-sdc-gray-600 hover:bg-sdc-gray-50"
                  }`}
                >
                  {DATE_FIELD_LABEL[f]}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="mb-3 grid grid-cols-2 gap-2">
            <label className="text-xs text-sdc-gray-600">
              From
              <input
                type="date"
                value={value.from ?? ""}
                onChange={(e) => onChange({ ...value, from: cleanBound(e.target.value) })}
                className="mt-0.5 w-full rounded-md border border-sdc-border px-2 py-1 text-sm focus:border-sdc-blue focus:outline-none"
              />
            </label>
            <label className="text-xs text-sdc-gray-600">
              To
              <input
                type="date"
                value={value.to ?? ""}
                onChange={(e) => onChange({ ...value, to: cleanBound(e.target.value) })}
                className="mt-0.5 w-full rounded-md border border-sdc-border px-2 py-1 text-sm focus:border-sdc-blue focus:outline-none"
              />
            </label>
          </div>
          {invalid && <p className="mb-2 text-xs text-sdc-red-text">&ldquo;From&rdquo; is after &ldquo;To&rdquo;, so no job matches.</p>}

          <div className="mb-3 flex flex-wrap gap-1.5">
            {years.slice(0, 6).map((y) => (
              <button
                key={y}
                type="button"
                aria-pressed={yearOn(y)}
                onClick={() => setYear(y)}
                className={`motion-interactive rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                  yearOn(y) ? "border-sdc-blue bg-sdc-blue-light text-sdc-blue-dark" : "border-sdc-border text-sdc-gray-600 hover:bg-sdc-gray-50"
                }`}
              >
                {y}
              </button>
            ))}
            <button
              type="button"
              onClick={lastTwelveMonths}
              className="motion-interactive rounded-full border border-sdc-border px-2.5 py-0.5 text-xs font-medium text-sdc-gray-600 hover:bg-sdc-gray-50"
            >
              Last 12 months
            </button>
          </div>

          <p className="mb-2 text-label text-sdc-gray-400">
            {undated > 0
              ? `${undated} job${undated === 1 ? " has" : "s have"} no ${DATE_FIELD_LABEL[value.field].toLowerCase()} on the Projects tab, so a range leaves ${undated === 1 ? "it" : "them"} out.`
              : `Every job has a ${DATE_FIELD_LABEL[value.field].toLowerCase()}.`}
          </p>
          <div className="flex items-center justify-between border-t border-sdc-border-soft pt-2 text-xs">
            <button
              type="button"
              disabled={!active}
              onClick={() => onChange({ ...value, from: null, to: null })}
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
