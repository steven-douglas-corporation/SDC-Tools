"use client";

import { useState, type ReactNode } from "react";
import { BUTTON_COMPACT, INPUT } from "@/components/ui/classnames";
import type { DateField } from "./format";
import { HeaderMenu, SortSection, useAddress, type SortOption } from "./columnMenu";

// The filters that live in a table column's header on the project list. Each is one menu (see
// HeaderMenu): a caret that opens a popover with the column's Sort section, when it has one, above
// the filter. The choice is written into the address, so the server redraws and the view can be
// shared. A column that can be sorted is given `sort`; one that cannot leaves it out and the menu is
// only the filter.

/** The Sort section a column menu shows above its filter, when the column can be sorted. */
export type ColumnSort = { view: import("./format").ListView; options: SortOption[] };

/** Whether `sort` is the column currently sorting, and the short word to show for it in the header. */
function sortState(sort?: ColumnSort): { sorted: boolean; word?: string } {
  if (!sort) return { sorted: false };
  const active = sort.options.find((o) => o.sort === sort.view.sort);
  return { sorted: active != null, word: active?.word };
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

/** A text search in a column header. On the project list it is the Project column, writing `q`. */
export function TextColumnFilter({
  label,
  value,
  sort,
  align,
}: {
  label: ReactNode;
  value: string;
  sort?: ColumnSort;
  align?: "left" | "right";
}) {
  const go = useAddress();
  const [typed, setTyped] = useState(value);
  const active = value !== "";
  const { sorted, word } = sortState(sort);
  return (
    <HeaderMenu label={label} sorted={sorted} sortedWord={word} filterCount={active ? 1 : 0} align={align}>
      {(close) => (
        <>
          {sort && <SortSection view={sort.view} options={sort.options} close={close} />}
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              go({ q: typed.trim() || null });
              close();
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
                    close();
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </form>
        </>
      )}
    </HeaderMenu>
  );
}

/** Two string sets equal as sets, order aside. */
function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * A tick list in a column header. Used for State, Value, Assigned to and Against target.
 *
 * `defaultChosen`, when given, is the set shown ticked while the column is at its default (nothing
 * recorded in the address) — the State column uses it to show the open states ticked by default.
 * Ticking back to exactly that set clears the column rather than recording it, so the default view
 * does not read as filtered.
 */
export function ChoiceColumnFilter({
  label,
  param,
  options,
  chosen,
  defaultChosen,
  sort,
  align,
}: {
  label: ReactNode;
  param: string;
  options: { value: string; label: string }[];
  chosen: string[];
  defaultChosen?: string[];
  sort?: ColumnSort;
  align?: "left" | "right";
}) {
  const go = useAddress();
  // What is ticked: the explicit choice, or the default set when nothing is recorded.
  const shown = chosen.length ? chosen : (defaultChosen ?? []);
  // The column reads as filtered only when something is actually recorded in the address.
  const active = chosen.length > 0;
  const { sorted, word } = sortState(sort);
  const set = (vals: string[]) => {
    if (defaultChosen && sameSet(vals, defaultChosen)) go({ [param]: null });
    else go({ [param]: vals.join(",") || null });
  };
  const toggle = (v: string) => set(shown.includes(v) ? shown.filter((x) => x !== v) : [...shown, v]);
  return (
    <HeaderMenu label={label} sorted={sorted} sortedWord={word} filterCount={chosen.length} align={align}>
      {(close) => (
        <>
          {sort && <SortSection view={sort.view} options={sort.options} close={close} />}
          <div className="flex flex-col">
            {options.length === 0 && <span className="px-2 py-1 text-sm text-sdc-gray-600">Nothing to filter</span>}
            {options.map((o) => (
              <label
                key={o.value}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm font-normal text-sdc-navy normal-case hover:bg-sdc-gray-100"
              >
                <input type="checkbox" checked={shown.includes(o.value)} onChange={() => toggle(o.value)} />
                {o.label}
              </label>
            ))}
            {active && <ClearRow onClear={() => set(defaultChosen ?? [])} />}
          </div>
        </>
      )}
    </HeaderMenu>
  );
}

/** A low–high number range in a column header. Used for Progress (percent) and Hours left. */
export function RangeColumnFilter({
  label,
  minParam,
  maxParam,
  min,
  max,
  suffix,
  sort,
  align,
}: {
  label: ReactNode;
  minParam: string;
  maxParam: string;
  min: number | null;
  max: number | null;
  suffix?: string;
  sort?: ColumnSort;
  align?: "left" | "right";
}) {
  const go = useAddress();
  const [lo, setLo] = useState(min?.toString() ?? "");
  const [hi, setHi] = useState(max?.toString() ?? "");
  const active = min != null || max != null;
  const { sorted, word } = sortState(sort);
  const clean = (v: string) => v.replace(/[^0-9.]/g, "");
  return (
    <HeaderMenu label={label} sorted={sorted} sortedWord={word} filterCount={active ? 1 : 0} align={align}>
      {(close) => (
        <>
          {sort && <SortSection view={sort.view} options={sort.options} close={close} />}
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              go({ [minParam]: lo.trim() || null, [maxParam]: hi.trim() || null });
              close();
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
                    close();
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </form>
        </>
      )}
    </HeaderMenu>
  );
}

/** A from–to range on one of the project's dates (target or forecast). The Dates column. */
export function DateColumnFilter({
  label,
  field,
  from,
  to,
  sort,
  align,
}: {
  label: ReactNode;
  field: DateField;
  from: string | null;
  to: string | null;
  sort?: ColumnSort;
  align?: "left" | "right";
}) {
  const go = useAddress();
  const [f, setF] = useState<DateField>(field);
  const [lo, setLo] = useState(from ?? "");
  const [hi, setHi] = useState(to ?? "");
  const active = from != null || to != null;
  const { sorted, word } = sortState(sort);
  const apply = () =>
    go({ datef: (lo || hi) && f === "forecast" ? "forecast" : null, from: lo || null, to: hi || null });
  return (
    <HeaderMenu label={label} sorted={sorted} sortedWord={word} filterCount={active ? 1 : 0} align={align}>
      {(close) => (
        <>
          {sort && <SortSection view={sort.view} options={sort.options} close={close} />}
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              apply();
              close();
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
                    close();
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </form>
        </>
      )}
    </HeaderMenu>
  );
}
