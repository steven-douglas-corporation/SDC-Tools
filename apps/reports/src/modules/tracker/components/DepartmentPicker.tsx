"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { INPUT, LABEL } from "@/components/ui/classnames";
import type { Department } from "../service/departments";
import { GROUPINGS, type Grouping } from "./format";

// Choosing a department, in the two places it is chosen: on a project (which one it is for and
// which one does the work), and above a list (which ones to show). Both list the departments
// the same way, a group with its teams under it, so a person sees one shape of the company
// everywhere.

/**
 * The departments as <option>s. A group with teams under it becomes an <optgroup> whose first
 * choice is the group as a whole; a department that stands alone is a plain choice.
 */
export function DepartmentOptions({ departments }: { departments: Department[] }) {
  const tops = departments.filter((d) => d.parentId == null);
  return (
    <>
      {tops.map((top) => {
        const teams = departments.filter((d) => d.parentId === top.id);
        if (teams.length === 0) {
          return (
            <option key={top.id} value={top.id}>
              {top.name}
            </option>
          );
        }
        return (
          <optgroup key={top.id} label={top.name}>
            <option value={top.id}>All of {top.name}</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}

/**
 * A filter on departments with a tick box for each, so several can be shown at once. Ticking a
 * group shows everything for it and for the teams under it. Nothing ticked means all of them.
 */
function DepartmentTicks({
  label,
  departments,
  chosen,
  onChange,
}: {
  label: string;
  departments: Department[];
  chosen: number[];
  onChange: (ids: number[]) => void;
}) {
  const tops = departments.filter((d) => d.parentId == null);
  const names = chosen.map((id) => departments.find((d) => d.id === id)?.name).filter(Boolean);
  const said = names.length === 0 ? "All departments" : names.length <= 2 ? names.join(", ") : `${names.length} chosen`;
  const toggle = (id: number) => onChange(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  const tick = (d: Department, indent: boolean) => (
    <label
      key={d.id}
      className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-sdc-navy hover:bg-sdc-gray-100 ${indent ? "pl-7" : "font-semibold"}`}
    >
      <input type="checkbox" checked={chosen.includes(d.id)} onChange={() => toggle(d.id)} />
      {d.name}
    </label>
  );
  return (
    <div className="flex flex-col gap-1">
      <span className={LABEL}>{label}</span>
      <details className="relative">
        <summary
          className={`${INPUT} flex min-w-[13rem] cursor-pointer list-none items-center justify-between gap-2 [&::-webkit-details-marker]:hidden`}
        >
          <span className="truncate">{said}</span>
          <span aria-hidden="true" className="text-sdc-gray-600">
            {"▾"}
          </span>
        </summary>
        <div
          role="group"
          aria-label={label}
          className="styled-scrollbar absolute left-0 z-20 mt-1 max-h-80 min-w-[16rem] overflow-y-auto rounded-lg border border-sdc-border bg-white p-1.5 shadow-lg"
        >
          {tops.map((top) => (
            <div key={top.id}>
              {tick(top, false)}
              {departments.filter((d) => d.parentId === top.id).map((t) => tick(t, true))}
            </div>
          ))}
          {chosen.length > 0 && (
            <button
              type="button"
              className="mt-1 w-full rounded px-2 py-1 text-left text-sm font-semibold text-sdc-blue hover:bg-sdc-gray-100"
              onClick={() => onChange([])}
            >
              Show all departments
            </button>
          )}
        </div>
      </details>
    </div>
  );
}

/** The three department controls, shared by the project list and the timeline of all projects. */
function DepartmentControls({
  departments,
  forIds,
  byIds,
  grouping,
  go,
}: {
  departments: Department[];
  forIds: number[];
  byIds: number[];
  grouping: Grouping;
  go: (change: Record<string, string | null>) => void;
}) {
  if (departments.length === 0) return null;
  return (
    <>
      <DepartmentTicks
        label="For department"
        departments={departments}
        chosen={forIds}
        onChange={(ids) => go({ for: ids.join(",") || null })}
      />
      <DepartmentTicks
        label="Done by department"
        departments={departments}
        chosen={byIds}
        onChange={(ids) => go({ by: ids.join(",") || null })}
      />
      <label className="flex flex-col gap-1">
        <span className={LABEL}>Group by</span>
        <select value={grouping} onChange={(e) => go({ group: e.target.value || null })} className={INPUT}>
          {(Object.keys(GROUPINGS) as Grouping[]).map((g) => (
            <option key={g} value={g}>
              {GROUPINGS[g]}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function useAddress(alsoClear: string[] = []) {
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
 * The controls above the timeline of all projects: which departments' projects to show, and
 * whether to gather them under a heading per department. Kept in the address (?for=12,14&group=by),
 * so the page is drawn on the server to match and a view can be bookmarked or sent to someone.
 */
export function DepartmentFilter({
  departments,
  forIds,
  byIds,
  grouping,
}: {
  departments: Department[];
  forIds: number[];
  byIds: number[];
  grouping: Grouping;
}) {
  // What is closed on a grouped timeline belongs to the grouping it was closed in.
  const go = useAddress(["closed"]);
  if (departments.length === 0) return null;
  return (
    <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
      <DepartmentControls departments={departments} forIds={forIds} byIds={byIds} grouping={grouping} go={go} />
    </div>
  );
}

/**
 * Everything above the project list that narrows or orders it: a search, the departments, the
 * grouping, a sort, and whether finished projects are shown. Each change goes into the address
 * (see listView in ./format.ts), which is what the page is drawn from.
 */
export function ProjectListControls({
  departments,
  forIds,
  byIds,
  grouping,
  search,
  finished,
  finishedCount,
}: {
  departments: Department[];
  forIds: number[];
  byIds: number[];
  grouping: Grouping;
  search: string;
  finished: boolean;
  /** How many finished or cancelled projects there are to show. With none, the switch is left out. */
  finishedCount: number;
}) {
  const go = useAddress();
  const [typed, setTyped] = useState(search);

  return (
    <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
      <form
        role="search"
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          go({ q: typed.trim() || null });
        }}
      >
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Find a project</span>
          <input
            type="search"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              // Emptying the box shows everything again without a second step.
              if (e.target.value === "" && search !== "") go({ q: null });
            }}
            placeholder="Name or key"
            className={`${INPUT} w-48`}
          />
        </label>
      </form>
      <DepartmentControls departments={departments} forIds={forIds} byIds={byIds} grouping={grouping} go={go} />
      {/* Sorting moved onto the table's column headers (components/ProjectList.tsx) 2026-11-24. */}
      {finishedCount > 0 && (
        <label className="flex items-center gap-2 pb-2 text-sm text-sdc-navy">
          <input type="checkbox" checked={finished} onChange={(e) => go({ done: e.target.checked ? "1" : null })} />
          Show finished ({finishedCount})
        </label>
      )}
    </div>
  );
}
