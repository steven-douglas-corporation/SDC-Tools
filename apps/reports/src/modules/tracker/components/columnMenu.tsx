"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ListSort, ListView } from "./format";

// The shared pieces of a column header that can be sorted and filtered. One menu per column: a
// single caret that opens a popover holding a Sort section and/or a filter, so a header carries one
// affordance instead of a sort icon and a separate filter icon that looked like each other. The
// menu closes when you click away or press Escape. Kept here, apart from the filter bodies and the
// department picker, so both can use it without importing each other.

/**
 * Writes a change into the address (?sort=value&state=active). A truthy value sets the key, a null
 * clears it; `alsoClear` always drops those keys too. The server then redraws to match and the view
 * can be bookmarked or shared — every control on the list goes through here.
 */
export function useAddress(alsoClear: string[] = []) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (change: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(change)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    for (const key of alsoClear) next.delete(key);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
}

/**
 * The open/closed state of a popover, with the two things a native <details> does not do: close
 * when the click lands outside it, and close on Escape. Returns a ref to put on the popover's
 * outermost element so a click inside it is not treated as outside.
 */
export function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/** The blue pill that says how many filter choices are in force on a column. */
function CountBadge({ n }: { n: number }) {
  return <span className="rounded-full bg-sdc-blue px-1.5 text-micro font-bold text-white">{n}</span>;
}

/** The mark beside a sorted column's label: a small arrow, with the field's word where one helps (Dates). */
function SortMark({ word }: { word?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-sdc-blue" aria-hidden="true">
      {word && <span className="text-micro font-semibold normal-case">{word}</span>}
      {"↓"}
    </span>
  );
}

/** One sort option offered inside a column menu. `word` is the short tag shown in the header when it is the sort. */
export type SortOption = { sort: ListSort; label: string; word?: string };

/**
 * A column header's menu: the label, the one caret that opens it, and the popover. The label turns
 * blue and shows a sort arrow or a filter count when the column is sorted or filtered, so a glance
 * still tells you what is applied without opening it. `children` is the panel; given a function, it
 * receives a close() to dismiss the menu after a one-shot action (a sort choice, a form submit).
 */
export function HeaderMenu({
  label,
  sorted = false,
  sortedWord,
  filterCount = 0,
  align = "left",
  children,
}: {
  label: ReactNode;
  /** This column is the current sort. */
  sorted?: boolean;
  /** A word shown with the sort arrow — Dates shows which date is sorting. */
  sortedWord?: string;
  /** How many filter choices are in force; 0 shows no badge. */
  filterCount?: number;
  /** Which edge the popover hangs from. Right for columns near the table's right edge. */
  align?: "left" | "right";
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const { open, setOpen, ref } = useMenu();
  const filtered = filterCount > 0;
  const active = sorted || filtered;
  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`inline-flex cursor-pointer items-center gap-1 ${
          active ? "text-sdc-blue" : "text-sdc-navy hover:text-sdc-blue"
        }`}
        title="Sort and filter this column"
      >
        {label}
        {sorted && <SortMark word={sortedWord} />}
        {filtered && <CountBadge n={filterCount} />}
        <span aria-hidden="true" className={active ? "text-sdc-blue" : "text-sdc-gray-400 opacity-60"}>
          {"▾"}
        </span>
      </button>
      {open && (
        <div
          role="group"
          className={`styled-scrollbar absolute z-20 mt-1 max-h-96 min-w-[14rem] overflow-y-auto rounded-lg border border-sdc-border bg-white p-2 text-left font-normal normal-case shadow-lg ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {typeof children === "function" ? children(() => setOpen(false)) : children}
        </div>
      )}
    </div>
  );
}

/**
 * The Sort block at the top of a column's menu. Each option sets that sort (and closes the menu);
 * when one is in force it also offers to clear back to the stack rank. Columns with no sort leave
 * this out, and the menu is then only the filter.
 */
export function SortSection({ view, options, close }: { view: ListView; options: SortOption[]; close: () => void }) {
  const go = useAddress();
  const apply = (s: ListSort | null) => {
    go({ sort: s });
    close();
  };
  const activeHere = options.some((o) => o.sort === view.sort);
  const row = (on: boolean) =>
    `flex items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-sdc-gray-100 ${
      on ? "font-semibold text-sdc-blue" : "text-sdc-navy"
    }`;
  return (
    <div className="mb-2 flex flex-col border-b border-sdc-border pb-2">
      <span className="px-2 pb-1 text-micro font-semibold uppercase tracking-wide text-sdc-muted">Sort</span>
      {options.map((o) => (
        <button key={o.sort} type="button" className={row(view.sort === o.sort)} onClick={() => apply(o.sort)}>
          {o.label}
          {view.sort === o.sort && <span aria-hidden="true">✓</span>}
        </button>
      ))}
      {activeHere && (
        <button
          type="button"
          className="mt-0.5 rounded px-2 py-1 text-left text-sm font-semibold text-sdc-blue hover:bg-sdc-gray-100"
          onClick={() => apply(null)}
        >
          Clear sort (stack rank)
        </button>
      )}
    </div>
  );
}
