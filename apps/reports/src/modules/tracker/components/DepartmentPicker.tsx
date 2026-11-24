"use client";

import { INPUT, LABEL } from "@/components/ui/classnames";
import type { Department } from "../service/departments";
import { GROUPINGS, type Grouping } from "./format";
import { HeaderMenu, useAddress } from "./columnMenu";

// useAddress now lives in ./columnMenu (shared with the column filters); re-exported here so the
// places that import it from this file keep working.
export { useAddress } from "./columnMenu";

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

/** The Group-by dropdown on its own, so the list (column filters) and the timeline (top filters) share it. */
function GroupByControl({ grouping, go }: { grouping: Grouping; go: (change: Record<string, string | null>) => void }) {
  return (
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
  );
}

/** The three department controls, used by the timeline of all projects (the list filters by column). */
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
      <GroupByControl grouping={grouping} go={go} />
    </>
  );
}

/**
 * A department filter inside a table column header (For / Done by on the project list): a small
 * caret beside the label that opens the same tick list as the timeline's filters, and turns blue
 * with a count when the column is filtered — the "this column is filtered" indicator. It writes
 * the choice into the address, so the server redraws and the view can be shared, like every other
 * control here. `param` is the address key it owns, "for" or "by".
 */
export function DepartmentColumnFilter({
  label,
  param,
  departments,
  chosen,
}: {
  label: string;
  param: "for" | "by";
  departments: Department[];
  chosen: number[];
}) {
  const go = useAddress();
  if (departments.length === 0) return <>{label}</>;
  const tops = departments.filter((d) => d.parentId == null);
  const onChange = (ids: number[]) => go({ [param]: ids.join(",") || null });
  const toggle = (id: number) => onChange(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  const tick = (d: Department, indent: boolean) => (
    <label
      key={d.id}
      className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm font-normal text-sdc-navy normal-case hover:bg-sdc-gray-100 ${indent ? "pl-7" : "font-semibold"}`}
    >
      <input type="checkbox" checked={chosen.includes(d.id)} onChange={() => toggle(d.id)} />
      {d.name}
    </label>
  );
  return (
    <HeaderMenu label={label} filterCount={chosen.length}>
      <div className="flex flex-col">
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
            Clear this filter
          </button>
        )}
      </div>
    </HeaderMenu>
  );
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
 * The one control left above the project list: how it is grouped. Every other way of narrowing or
 * ordering it now lives in the table's own column headers — the Project text search, the State,
 * Value, Assigned-to, Against-target, Progress, Hours-left and Dates filters, and the sorts. The
 * "Find a project" box and the "Show finished" switch were folded into the Project and State
 * column filters (2026-11-24). Each change goes into the address (see listView in ./format.ts).
 */
export function ProjectListControls({ grouping }: { grouping: Grouping }) {
  const go = useAddress();
  return (
    <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
      <GroupByControl grouping={grouping} go={go} />
    </div>
  );
}
