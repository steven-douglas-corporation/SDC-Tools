"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { INPUT, LABEL } from "@/components/ui/classnames";
import type { Department } from "../service/departments";
import { SORT_LABEL, type ListSort } from "./format";

// Choosing a department, in the two places it is chosen: on a project (which one it is for),
// and above a list (which ones to show). Both list the departments the same way, a group with
// its teams under it, so a person sees one shape of the company everywhere.

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
 * The filter above the project list and the timeline of all projects: which department's
 * projects to show, and whether to gather them under a heading per department. Both are kept
 * in the address (?for=12&group=1), so the page is drawn on the server with the figures to
 * match, and a filtered view can be bookmarked or sent to someone.
 */
export function DepartmentFilter({
  departments,
  selected,
  grouped,
}: {
  departments: Department[];
  /** The department chosen, or null for all of them. */
  selected: number | null;
  grouped: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function go(change: { for?: string; group?: boolean }) {
    const next = new URLSearchParams(params.toString());
    if (change.for !== undefined) {
      if (change.for) next.set("for", change.for);
      else next.delete("for");
    }
    if (change.group !== undefined) {
      if (change.group) next.set("group", "1");
      else next.delete("group");
    }
    // What is closed on a grouped timeline belongs to the grouping it was closed in.
    next.delete("closed");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  if (departments.length === 0) return null;
  return (
    <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
      <label className="flex flex-col gap-1">
        <span className={LABEL}>For department</span>
        <select
          value={selected?.toString() ?? ""}
          onChange={(e) => go({ for: e.target.value })}
          className={`${INPUT} min-w-[14rem]`}
        >
          <option value="">All departments</option>
          <DepartmentOptions departments={departments} />
        </select>
      </label>
      <label className="flex items-center gap-2 pb-2 text-sm text-sdc-navy">
        <input type="checkbox" checked={grouped} onChange={(e) => go({ group: e.target.checked })} />
        Group by department
      </label>
    </div>
  );
}

/**
 * Everything above the project list that narrows or orders it: the department and grouping, a
 * search, a sort, and whether finished projects are shown. Each change goes into the address
 * (see listView in ./format.ts), which is what the page is drawn from.
 */
export function ProjectListControls({
  departments,
  selected,
  grouped,
  sort,
  search,
  finished,
  finishedCount,
}: {
  departments: Department[];
  selected: number | null;
  grouped: boolean;
  sort: ListSort;
  search: string;
  finished: boolean;
  /** How many finished or cancelled projects there are to show. With none, the switch is left out. */
  finishedCount: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [typed, setTyped] = useState(search);

  function go(change: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(change)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

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
      {departments.length > 0 && (
        <label className="flex flex-col gap-1">
          <span className={LABEL}>For department</span>
          <select
            value={selected?.toString() ?? ""}
            onChange={(e) => go({ for: e.target.value || null })}
            className={`${INPUT} min-w-[14rem]`}
          >
            <option value="">All departments</option>
            <DepartmentOptions departments={departments} />
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1">
        <span className={LABEL}>Sort by</span>
        <select
          value={sort}
          onChange={(e) => go({ sort: e.target.value === "rank" ? null : e.target.value })}
          className={INPUT}
        >
          {(Object.keys(SORT_LABEL) as ListSort[]).map((key) => (
            <option key={key} value={key}>
              {SORT_LABEL[key]}
            </option>
          ))}
        </select>
      </label>
      {departments.length > 0 && (
        <label className="flex items-center gap-2 pb-2 text-sm text-sdc-navy">
          <input type="checkbox" checked={grouped} onChange={(e) => go({ group: e.target.checked ? "1" : null })} />
          Group by department
        </label>
      )}
      {finishedCount > 0 && (
        <label className="flex items-center gap-2 pb-2 text-sm text-sdc-navy">
          <input type="checkbox" checked={finished} onChange={(e) => go({ done: e.target.checked ? "1" : null })} />
          Show finished ({finishedCount})
        </label>
      )}
    </div>
  );
}
