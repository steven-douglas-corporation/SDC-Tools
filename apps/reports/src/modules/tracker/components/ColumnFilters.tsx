"use client";

import { useState, type ReactNode } from "react";
import { BUTTON_COMPACT, INPUT } from "@/components/ui/classnames";
import type { DateField } from "./format";
import { useAddress } from "./DepartmentPicker";

// The filters that live in a table column's header on the project list, beside the sort. Each is a
// small caret that opens a panel and writes its choice into the address, so the server redraws and
// the view can be shared — the same contract as DepartmentColumnFilter (For / Done by). They turn
// blue with a count when the column is filtered, the "this column is filtered" cue.

/** The caret, the open/close, and the dropdown panel every column filter shares. */
function FilterShell({
  label,
  active,
  count,
  align = "left",
  children,
}: {
  label: ReactNode;
  active: boolean;
  count?: number;
  /** Which edge the panel hangs from. Right for columns near the right of the table. */
  align?: "left" | "right";
  children: ReactNode;
}) {
  return (
    <details className="relative inline-block">
      <summary
        className={`inline-flex cursor-pointer list-none items-center gap-1 ${active ? "text-sdc-blue" : "hover:text-sdc-blue"} [&::-webkit-details-marker]:hidden`}
        title={active ? "Filtered — click to change" : "Filter this column"}
      >
        {label}
        <span aria-hidden="true" className={active ? "text-sdc-blue" : "text-sdc-gray-400 opacity-60"}>
          {"▾"}
        </span>
        {active && count != null && count > 0 && (
          <span className="rounded-full bg-sdc-blue px-1.5 text-micro font-bold text-white">{count}</span>
        )}
      </summary>
      <div
        role="group"
        className={`styled-scrollbar absolute z-20 mt-1 max-h-80 min-w-[14rem] overflow-y-auto rounded-lg border border-sdc-border bg-white p-2 text-left font-normal normal-case shadow-lg ${
          align === "right" ? "right-0" : "left-0"
        }`}
      >
        {children}
      </div>
    </details>
  );
}

function ClearRow({ onClear }: { onClear: () => void }) {
  return (
    <button
      type="button"
      className="mt-1 w-full rounded px-2 py-1 text-left text-sm font-semibold text-sdc-blue hover:bg-sdc-gray-100"
      onClick={onClear}
    >
      Clear this filter
    </button>
  );
}

/** A text search inside a column header. On the project list it is the Project column, writing `q`. */
export function TextColumnFilter({
  label,
  value,
  align,
}: {
  label: ReactNode;
  value: string;
  align?: "left" | "right";
}) {
  const go = useAddress();
  const [typed, setTyped] = useState(value);
  const active = value !== "";
  return (
    <FilterShell label={label} active={active} count={active ? 1 : 0} align={align}>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          go({ q: typed.trim() || null });
        }}
      >
        <input
          type="search"
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Name or key"
          className={`${INPUT} w-48`}
        />
        <div className="flex items-center justify-between gap-2">
          <button type="submit" className={BUTTON_COMPACT}>
            Filter
          </button>
          {active && (
            <button
              type="button"
              className="text-sm font-semibold text-sdc-blue hover:underline"
              onClick={() => {
                setTyped("");
                go({ q: null });
              }}
            >
              Clear
            </button>
          )}
        </div>
      </form>
    </FilterShell>
  );
}

/** A tick list inside a column header. Used for State, Value, Assigned to and Against target. */
export function ChoiceColumnFilter({
  label,
  param,
  options,
  chosen,
  align,
}: {
  label: ReactNode;
  param: string;
  options: { value: string; label: string }[];
  chosen: string[];
  align?: "left" | "right";
}) {
  const go = useAddress();
  const active = chosen.length > 0;
  const set = (vals: string[]) => go({ [param]: vals.join(",") || null });
  const toggle = (v: string) => set(chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v]);
  return (
    <FilterShell label={label} active={active} count={chosen.length} align={align}>
      <div className="flex flex-col">
        {options.length === 0 && <span className="px-2 py-1 text-sm text-sdc-gray-600">Nothing to filter</span>}
        {options.map((o) => (
          <label
            key={o.value}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm font-normal text-sdc-navy normal-case hover:bg-sdc-gray-100"
          >
            <input type="checkbox" checked={chosen.includes(o.value)} onChange={() => toggle(o.value)} />
            {o.label}
          </label>
        ))}
        {active && <ClearRow onClear={() => set([])} />}
      </div>
    </FilterShell>
  );
}

/** A low–high number range inside a column header. Used for Progress (percent) and Hours left. */
export function RangeColumnFilter({
  label,
  minParam,
  maxParam,
  min,
  max,
  suffix,
  align,
}: {
  label: ReactNode;
  minParam: string;
  maxParam: string;
  min: number | null;
  max: number | null;
  suffix?: string;
  align?: "left" | "right";
}) {
  const go = useAddress();
  const [lo, setLo] = useState(min?.toString() ?? "");
  const [hi, setHi] = useState(max?.toString() ?? "");
  const active = min != null || max != null;
  const clean = (v: string) => v.replace(/[^0-9.]/g, "");
  return (
    <FilterShell label={label} active={active} count={active ? 1 : 0} align={align}>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          go({ [minParam]: lo.trim() || null, [maxParam]: hi.trim() || null });
        }}
      >
        <div className="flex items-center gap-2">
          <input
            inputMode="numeric"
            value={lo}
            onChange={(e) => setLo(clean(e.target.value))}
            placeholder="min"
            aria-label={`${label} minimum`}
            className={`${INPUT} w-20`}
          />
          <span className="text-sdc-gray-600">to</span>
          <input
            inputMode="numeric"
            value={hi}
            onChange={(e) => setHi(clean(e.target.value))}
            placeholder="max"
            aria-label={`${label} maximum`}
            className={`${INPUT} w-20`}
          />
          {suffix && <span className="text-sm text-sdc-gray-600">{suffix}</span>}
        </div>
        <div className="flex items-center justify-between gap-2">
          <button type="submit" className={BUTTON_COMPACT}>
            Filter
          </button>
          {active && (
            <button
              type="button"
              className="text-sm font-semibold text-sdc-blue hover:underline"
              onClick={() => {
                setLo("");
                setHi("");
                go({ [minParam]: null, [maxParam]: null });
              }}
            >
              Clear
            </button>
          )}
        </div>
      </form>
    </FilterShell>
  );
}

/** A from–to range on one of the project's dates (target or forecast). The Dates column. */
export function DateColumnFilter({
  label,
  field,
  from,
  to,
  align,
}: {
  label: ReactNode;
  field: DateField;
  from: string | null;
  to: string | null;
  align?: "left" | "right";
}) {
  const go = useAddress();
  const [f, setF] = useState<DateField>(field);
  const [lo, setLo] = useState(from ?? "");
  const [hi, setHi] = useState(to ?? "");
  const active = from != null || to != null;
  const apply = () =>
    go({ datef: (lo || hi) && f === "forecast" ? "forecast" : null, from: lo || null, to: hi || null });
  return (
    <FilterShell label={label} active={active} count={active ? 1 : 0} align={align}>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <label className="flex flex-col gap-1 text-sm font-normal text-sdc-navy normal-case">
          Which date
          <select value={f} onChange={(e) => setF(e.target.value as DateField)} className={INPUT}>
            <option value="target">Target</option>
            <option value="forecast">Forecast</option>
          </select>
        </label>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={lo}
            onChange={(e) => setLo(e.target.value)}
            aria-label="From date"
            className={INPUT}
          />
          <span className="text-sdc-gray-600">to</span>
          <input
            type="date"
            value={hi}
            onChange={(e) => setHi(e.target.value)}
            aria-label="To date"
            className={INPUT}
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <button type="submit" className={BUTTON_COMPACT}>
            Filter
          </button>
          {active && (
            <button
              type="button"
              className="text-sm font-semibold text-sdc-blue hover:underline"
              onClick={() => {
                setLo("");
                setHi("");
                go({ from: null, to: null, datef: null });
              }}
            >
              Clear
            </button>
          )}
        </div>
      </form>
    </FilterShell>
  );
}
