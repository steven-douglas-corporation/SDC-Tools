"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRealtimeChanges } from "@/components/RealtimeProvider";
import { sequenced } from "@/lib/request-sequence";
import { loadHoursGroupChildren, loadHoursDetailRows } from "@/lib/hours-actions";
import { narrowFiltersForGroupValue, reconcileGroupRowHours, type HoursFilters, type HoursGroupBy } from "@/lib/hours-filters";
import type { HoursGroupRow, HoursRow, HoursDrillRows } from "@/lib/hours-explorer";
import { useColumnSort } from "@/components/useColumnSort";
import { sortRows, type SortColumns } from "@/lib/table-sort";
import { SortableTh } from "@/components/ui/SortableHeader";
import { hours, hoursCell, hoursExact } from "@/components/ui/format";

// A nested, expandable rollup — Excel PivotTable "compact form", not Drill.tsx's flat
// N-side-by-side-columns shape (that shape assumes every row fills all N dimensions,
// which a variable-depth tree never does). One "Group" column (caret + label, indented
// by depth) + Hours, rendered as flat sibling <tr>s under one <tbody> — real
// nested <table>s inside cells would work but aren't semantic and complicate styling
// for no benefit here.
//
// No Punches column (2026-08-17, by request): a punch COUNT is a property of
// the underlying data, not something a grouped rollup needs to show — the
// backend still computes and returns `HoursGroupRow.punchCount` (nothing
// about the data changed), this table just no longer renders it. The
// ungrouped detail table/drill-through rows (each already ONE punch) never
// had this column to begin with.
//
// Every row's numbers come from its OWN independent server aggregate query
// (queryHoursGrouped, via loadHoursGroupChildren) — never a client-side re-sum of
// children — so a parent's total is correct regardless of whether or how much of its
// subtree has been fetched. Level 0 is computed server-side in page.tsx exactly like
// the old single-dimension view; every deeper level is fetched lazily, on expand.
//
// ── The terminal level: every row is expandable, even the last configured one ──
//
// A row past the last chosen Group By dimension (or the ONLY dimension, if just one
// is chosen — "Service Engineering" with no other grouping) used to render as plain,
// non-interactive text: there was nowhere left for the tree to go. It now expands to
// the raw punch records behind it instead (queryHoursDrillRows, via
// loadHoursDetailRows) — same narrowed-filters chain as every group level above it,
// so "the detail sums to the parent's total" holds by the SAME construction that
// already makes a group's total agree with its children's: both are independent
// server aggregates over the identical `where`, not one re-summing the other.
// DetailBlock (below) renders these with their own header/sort/footer, since their
// column shape (Date/Employee/Job/Section/Hours) has nothing in common with a group
// row's (Group/Hours) — a plain text label sharing this table's 2 columns.
//
// ── The realtime-refresh interaction ─────────────────────────────────────────
//
// (app)/layout.tsx mounts <LiveRefresh/> app-wide, which re-renders this page (fresh
// `rootRows`) on tab focus and on a background interval whenever ANYONE changes
// ANYTHING. Two things follow:
//   - page.tsx remounts this component (via a content-derived `key`) only when
//     `filters`/`groupByLevels` themselves change — a routine refresh must NOT
//     collapse every open node, which a naive remount-on-every-render would do.
//   - This component must still notice that its OWN `children` cache can go stale
//     under an open node when nothing about `filters`/`groupByLevels` changed. Simply
//     excluding `children` from the refetch effect's deps (as EtcMonthKpiCards' single-
//     slot "Parts" drill cache first looked like it did) turns out not to generalize
//     here: that effect's OWN dependency list includes its cache variable (`parts`)
//     precisely so clearing it retriggers the fetch. This effect does the same —
///    depends on `children` as well as `expanded`, guarded so it only ever fetches
//     what's actually missing.

type GroupStep = { groupBy: HoursGroupBy; value: string };
type GroupPath = GroupStep[];

// JSON, not a joined string — a job id, employee id or section code could in
// principle collide across a plain separator.
function pathKey(path: GroupPath): string {
  return JSON.stringify(path.map((s) => [s.groupBy, s.value]));
}

type SortKey = "group" | "hours";

const SORT_COLUMNS: SortColumns<HoursGroupRow, SortKey> = {
  group: { type: "text", value: (r) => r.label },
  hours: { type: "hours", value: (r) => r.hours },
};

// The detail block's own sort keys — a SUPERSET of hours-filters.ts's
// HoursDetailSortKey (Date/Job Id/Job Name/Section/Hours), which deliberately
// excludes Employee/Department because that type also drives the plain
// ungrouped table's SERVER `ORDER BY` (hours-explorer.ts's orderByForSort),
// where employeeId has no Prisma relation to sort a name by. Here the rows
// are already fetched and already carry the resolved employee/department
// NAME (HoursRow.employee/.department), so sorting by them is a plain
// client-side string compare with no such constraint — extended locally
// rather than widening the shared type (which would force orderByForSort to
// grow a case it has no correct way to satisfy).
type DetailSortKey = "date" | "employee" | "department" | "jobId" | "jobName" | "rawSection" | "rawSectionName" | "rawFunction" | "standardTaskDescription" | "mappingStatus" | "hours";

const DETAIL_SORT_COLUMNS: SortColumns<HoursRow, DetailSortKey> = {
  date: { type: "date", value: (r) => r.date },
  employee: { type: "text", value: (r) => r.employee },
  department: { type: "text", value: (r) => r.department },
  jobId: { type: "id", value: (r) => r.jobId },
  jobName: { type: "text", value: (r) => r.jobName },
  // Sortable on each half independently — the point of splitting them. Section and
  // Function sort as TEXT on their numeric strings, matching how the codes read
  // elsewhere in the app (and they are fixed-width in practice, so text order is
  // numeric order).
  rawSection: { type: "text", value: (r) => r.rawSection },
  rawSectionName: { type: "text", value: (r) => r.rawSectionName },
  rawFunction: { type: "text", value: (r) => r.rawFunction },
  standardTaskDescription: { type: "text", value: (r) => r.standardTaskDescription },
  mappingStatus: { type: "text", value: (r) => r.mappingStatus },
  hours: { type: "hours", value: (r) => r.hours },
};

const TD = "border-b border-sdc-border-soft px-3 py-1.5 text-sm text-sdc-navy";
const TD_NUM = "border-b border-sdc-border-soft px-3 py-1.5 text-right font-mono text-sm tabular-nums text-sdc-navy";
const DETAIL_TH = "border-b border-sdc-border px-3 py-1.5 text-label font-semibold uppercase tracking-[0.08em] text-sdc-muted";

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="9"
      height="9"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      aria-hidden
      className={`shrink-0 opacity-60 motion-interactive ${open ? "rotate-90" : ""}`}
    >
      <path d="M6 3.5 L10.5 8 L6 12.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// The tree's terminal level: the raw punch records behind one leaf group, in their
// own small sortable table (their column shape has nothing in common with a group
// row's Group/Hours, so they get their own <thead> rather than trying to
// line up under it). A real component, not another branch of renderLevel's plain
// function, specifically so it can hold ITS OWN sort state via useColumnSort — each
// expanded leaf sorts independently or a sort applied while browsing one group would
// otherwise have to apply to every other open leaf too.
//
// The footer sums exactly the rows THIS component was handed, never re-derives or
// re-fetches anything — when `truncated` is false (the overwhelmingly common case:
// a leaf this deep is normally tens to a few hundred punches, not thousands) that sum
// is mathematically the same figure the parent row above it already shows, which is
// what makes the "detail total equals the group total" requirement visibly true, not
// just true by construction. `parentDisplayHours` — the parent row's OWN already-
// rounded (and possibly reconciled) figure — is shown here rather than a fresh,
// independent `hours(shownHours)`, so the footer can never read one unit off from the
// row directly above it that opened it (2026-08-17). When `truncated` IS true, the
// footer says so and shows "—" for Hours instead of printing a sum that would
// UNDERSTATE the real total — the parent row's own total (still fully correct; it
// never depended on this fetch) remains the number to trust. Printing `shownHours`
// unconditionally here used to contradict that exact promise the moment a leaf was
// ever actually truncated.
function DetailBlock({ depth, drill, parentDisplayHours }: { depth: number; drill: HoursDrillRows; parentDisplayHours: number }) {
  const { sort, onSort } = useColumnSort<DetailSortKey>();
  const sorted = sortRows(drill.rows, sort, DETAIL_SORT_COLUMNS);
  const pad = 0.75 + depth * 1.25;
  return (
    <div className="styled-scrollbar overflow-x-auto rounded-md border border-sdc-border-soft bg-sdc-gray-50" style={{ marginLeft: `${pad}rem`, marginRight: "0.75rem" }}>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <SortableTh label="Date" sortKey="date" type="date" sort={sort} onSort={onSort} className={DETAIL_TH} />
            <SortableTh label="Employee" sortKey="employee" type="text" sort={sort} onSort={onSort} className={DETAIL_TH} />
            <SortableTh label="Department" sortKey="department" type="text" sort={sort} onSort={onSort} className={DETAIL_TH} />
            <SortableTh label="Job Id" sortKey="jobId" type="id" sort={sort} onSort={onSort} className={DETAIL_TH} />
            <SortableTh label="Job / Machine" sortKey="jobName" type="text" sort={sort} onSort={onSort} className={DETAIL_TH} />
            {/* Separate columns (2026-08-21) — see the Hours page table for why the
                combined "Function / Section" cell was removed. `section` stays the sort
                key because it is the indexed column; the split is presentational. */}
            <SortableTh label="Section" sortKey="rawSection" type="text" sort={sort} onSort={onSort} className={DETAIL_TH} />
            <SortableTh label="Section Name" sortKey="rawSectionName" type="text" sort={sort} onSort={onSort} className={DETAIL_TH} />
            <SortableTh label="Function" sortKey="rawFunction" type="text" sort={sort} onSort={onSort} className={DETAIL_TH} />
            <SortableTh label="Function Name" sortKey="standardTaskDescription" type="text" sort={sort} onSort={onSort} className={DETAIL_TH} />
            <SortableTh label="Mapping Status" sortKey="mappingStatus" type="text" sort={sort} onSort={onSort} className={DETAIL_TH} />
            <SortableTh label="Hours" sortKey="hours" type="hours" sort={sort} onSort={onSort} className={DETAIL_TH} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.id} className="hover:bg-sdc-gray-50">
              <td className={TD}>{r.date}</td>
              <td className={TD}>{r.employee}</td>
              <td className={TD}>{r.department}</td>
              <td className={TD}>{r.jobId}</td>
              <td className={`${TD} max-w-xs truncate`} title={r.jobName}>
                {r.jobName}
              </td>
              <td className={`${TD} font-mono`}>{r.rawSection}</td>
              <td className={TD}>{r.rawSectionName}</td>
              <td className={`${TD} font-mono`}>{r.rawFunction}</td>
              <td className={TD}>{r.standardTaskDescription}</td>
              <td className={TD}>
                {r.mappingStatus === "Undefined" ? (
                  <span
                    className="text-sdc-yellow-text"
                    title={`Undefined${r.undefinedReason ? `: ${r.undefinedReason}` : ""} — Section ${r.rawSection || "(blank)"} + Function ${r.rawFunction || "(blank)"} is not in the approved rule book. The hours are still counted.`}
                  >
                    Undefined
                  </span>
                ) : (
                  <span className="text-sdc-muted">Mapped</span>
                )}
              </td>
              {/* hoursCell(), matching every other punch-level view in the app —
                  never a decimal, and a real sub-half-hour punch reads as "<1"
                  rather than a misleading "0". */}
              <td className={TD_NUM} title={hoursExact(r.hours)}>{hoursCell(r.hours)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <td colSpan={10} className="border-b border-sdc-border-soft px-3 py-1.5 text-sm text-sdc-muted">
              {drill.truncated
                ? `Showing the first ${drill.rows.length.toLocaleString()} punches — narrow the filters or add another Group By level to see the rest.`
                : `Total (${drill.rows.length.toLocaleString()} punch${drill.rows.length === 1 ? "" : "es"})`}
            </td>
            {/* The parent row's OWN figure, not a fresh sum of these (possibly
                capped) rows — see this component's own header. Truncated: "—",
                never a number that would understate the real total. */}
            <td className={TD_NUM}>{drill.truncated ? "—" : hours(parentDisplayHours)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function HoursGroupedTree({
  rootRows,
  groupByLevels,
  filters,
}: {
  rootRows: HoursGroupRow[];
  groupByLevels: HoursGroupBy[];
  filters: HoursFilters;
}) {
  const sortState = useColumnSort<SortKey>();
  // `expanded` maps a node's pathKey -> the actual path, so a node's ancestor chain
  // never needs reverse-parsing out of its own serialized key.
  const [expanded, setExpanded] = useState<Map<string, GroupPath>>(new Map());
  const [children, setChildren] = useState<Map<string, HoursGroupRow[]>>(new Map());
  // Populated instead of `children` for a node past the last configured Group By
  // dimension — see the header comment on "the terminal level" above. A node is
  // deterministically ONE or the other (which map a fetch fills is decided by its
  // depth, in fetchChildren below), never both, so there is no ambiguity in reading
  // "is this node cached yet" from either map alone.
  const [detail, setDetail] = useState<Map<string, HoursDrillRows>>(new Map());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  // Its `isPending` is unused — this exists purely so the auto-refetch effect below can
  // hand its fetch off through `startTransition`, which is the sanctioned way to defer
  // a state update out of an effect's own synchronous call stack (the same device
  // EtcMonthKpiCards' drills use for the identical shape of fetch-on-open effect).
  const [, startFetchTransition] = useTransition();
  // Deliberately no separate `loading` state: "this row is loading" is fully derived —
  // open, no cached children yet, no error yet (see renderLevel) — rather than tracked,
  // so fetchChildren has nothing to set synchronously before its first `await`. Calling
  // setState synchronously inside the effect below (via a function that sets loading
  // BEFORE awaiting) is exactly what react-hooks/set-state-in-effect flags; the fix
  // mirrors EtcMonthKpiCards' own drills, which get their pending flag from
  // useTransition rather than a hand-rolled pre-await setState.

  async function fetchChildren(path: GroupPath, key: string) {
    let narrowed = filters;
    for (const step of path) narrowed = narrowFiltersForGroupValue(narrowed, step.groupBy, step.value);
    const nextDim = groupByLevels[path.length];
    const clearError = () =>
      setErrors((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    if (nextDim) {
      const out = await sequenced(`hours-group:${key}`, key, () => loadHoursGroupChildren(narrowed, nextDim));
      if (out.ok) {
        setChildren((prev) => new Map(prev).set(key, out.value));
        clearError();
      } else if (out.reason === "error") {
        setErrors((prev) => new Map(prev).set(key, out.error instanceof Error ? out.error.message : "Could not load this group."));
      }
      return;
    }
    // Terminal level: no dimension left to group by, so this expansion is the raw
    // punch records instead of another rollup.
    const out = await sequenced(`hours-detail:${key}`, key, () => loadHoursDetailRows(narrowed));
    if (out.ok) {
      setDetail((prev) => new Map(prev).set(key, out.value));
      clearError();
    } else if (out.reason === "error") {
      setErrors((prev) => new Map(prev).set(key, out.error instanceof Error ? out.error.message : "Could not load these punches."));
    }
  }

  function toggle(path: GroupPath, key: string) {
    const willOpen = !expanded.has(key);
    setExpanded((prev) => {
      const next = new Map(prev);
      if (willOpen) next.set(key, path);
      else next.delete(key);
      return next;
    });
    if (willOpen && !children.has(key) && !detail.has(key)) void fetchChildren(path, key);
  }

  // Routine background refresh (LiveRefresh, any colleague's change) invalidates the
  // fetched-children/detail cache — NOT `expanded` (an open node must stay open) — so
  // stale numbers under an open node can't linger after the top-level rootRows prop
  // moves on.
  const changes = useRealtimeChanges();
  const seenChanges = useRef(changes.length);
  useEffect(() => {
    if (changes.length === seenChanges.current) return;
    seenChanges.current = changes.length;
    setChildren(new Map());
    setDetail(new Map());
    setErrors(new Map());
  }, [changes.length]);

  // Refetches whatever's open but missing its cache entry — on a fresh expand AND
  // after the invalidation above clears it. Depends on `children`/`detail` as well as
  // `expanded`: excluding them would mean the effect above clearing the caches never
  // retriggers a refetch, since clearing a cache alone doesn't touch `expanded`.
  // Guarded so this can't loop: each key is excluded from the sweep the instant it's
  // cached (in EITHER map — a node only ever populates one, see the `detail` state's
  // own comment) or errored. A key already in flight gets called again on a re-run
  // (there's no separate loading flag to skip it on) — harmless: sequenced() joins an
  // identical in-flight request rather than issuing a second one.
  useEffect(() => {
    for (const [key, path] of expanded) {
      if (children.has(key) || detail.has(key) || errors.has(key)) continue;
      startFetchTransition(() => {
        void fetchChildren(path, key);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, children, detail]);

  function renderLevel(rows: HoursGroupRow[], path: GroupPath, depth: number, targetTotal?: number): React.ReactNode[] {
    const levelDim = groupByLevels[depth];
    // Whether there's ANOTHER configured Group By dimension below this one. Every
    // row is expandable regardless — this only decides what expanding it fetches
    // and renders (one more rollup level vs. the raw punch records), never whether
    // the caret/button appears at all.
    const hasNextGroupLevel = depth + 1 < groupByLevels.length;
    const sorted = sortRows(rows, sortState.sort, SORT_COLUMNS);
    // Whole-number hours for these SIBLINGS that always sum to `targetTotal` (the
    // parent row's own displayed figure — omitted at the root, where there's no
    // parent and reconciling against these rows' own sum is also exactly what the
    // Total Hours KPI's own rounding produces) — see hours-filters.ts's own header
    // for why independent per-row rounding can't guarantee that on its own.
    const displayHours = reconcileGroupRowHours(rows, targetTotal);
    return sorted.flatMap((row) => {
      const nodePath = [...path, { groupBy: levelDim, value: row.key }];
      const key = pathKey(nodePath);
      const isOpen = expanded.has(key);
      // The reconciled figure for THIS row — shown here, and handed down as the
      // target for whatever this row expands into (another level's siblings, or
      // a drill's own footer), so a child's displayed total can never disagree
      // with the row that opened it. The `?? Math.round` fallback only matters
      // if `row.key` were somehow absent from `rows` itself, which can't happen
      // (displayHours is built FROM `rows`) — kept as a defensive, not a real path.
      const rowDisplayHours = displayHours.get(row.key) ?? Math.round(row.hours);
      const out: React.ReactNode[] = [
        <tr key={key} className="hover:bg-sdc-gray-50">
          <td className={TD} style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}>
            <button
              type="button"
              onClick={() => toggle(nodePath, key)}
              aria-expanded={isOpen}
              title={hasNextGroupLevel ? undefined : "View the punch records behind this total"}
              className="inline-flex items-center gap-1.5 text-left motion-interactive hover:opacity-70"
            >
              <Caret open={isOpen} />
              <span>{row.label}</span>
            </button>
          </td>
          <td className={TD_NUM} title={hoursExact(row.hours)}>{hours(rowDisplayHours)}</td>
        </tr>,
      ];
      if (isOpen) {
        if (errors.has(key)) {
          out.push(
            <tr key={`${key}:error`}>
              <td colSpan={2} className="px-3 py-1.5 text-xs" style={{ paddingLeft: `${0.75 + (depth + 1) * 1.25}rem` }}>
                <span className="font-medium text-sdc-red-text">{errors.get(key)}</span>{" "}
                <button type="button" onClick={() => void fetchChildren(nodePath, key)} className="font-medium text-sdc-blue hover:underline">
                  Retry
                </button>
              </td>
            </tr>,
          );
        } else if (hasNextGroupLevel) {
          if (!children.has(key)) {
            // Open, no cached children, no error — the fetch is in flight (or about
            // to be, via the effect above). See the state note in the component
            // body for why this is derived rather than a separate `loading` state.
            out.push(
              <tr key={`${key}:loading`}>
                <td colSpan={2} className="px-3 py-1.5 text-xs text-sdc-muted" style={{ paddingLeft: `${0.75 + (depth + 1) * 1.25}rem` }}>
                  Loading…
                </td>
              </tr>,
            );
          } else {
            const kids = children.get(key);
            if (kids) out.push(...renderLevel(kids, nodePath, depth + 1, rowDisplayHours));
          }
        } else {
          // Terminal level: the raw punch records, not another rollup.
          if (!detail.has(key)) {
            out.push(
              <tr key={`${key}:loading`}>
                <td colSpan={2} className="px-3 py-1.5 text-xs text-sdc-muted" style={{ paddingLeft: `${0.75 + (depth + 1) * 1.25}rem` }}>
                  Loading…
                </td>
              </tr>,
            );
          } else {
            const d = detail.get(key);
            if (d) {
              out.push(
                <tr key={`${key}:detail`}>
                  <td colSpan={2} className="py-1.5">
                    <DetailBlock depth={depth + 1} drill={d} parentDisplayHours={rowDisplayHours} />
                  </td>
                </tr>,
              );
            }
          }
        }
      }
      return out;
    });
  }

  const rootTotal = rootRows.reduce((s, r) => s + r.hours, 0);

  return (
    <div className="styled-scrollbar overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <SortableTh label="Group" sortKey="group" type="text" sort={sortState.sort} onSort={sortState.onSort} className="border-b border-sdc-border px-3 py-1.5 text-label font-semibold uppercase tracking-[0.08em] text-sdc-muted" />
            <SortableTh label="Hours" sortKey="hours" type="hours" sort={sortState.sort} onSort={sortState.onSort} className="border-b border-sdc-border px-3 py-1.5 text-label font-semibold uppercase tracking-[0.08em] text-sdc-muted" />
          </tr>
        </thead>
        <tbody>{renderLevel(rootRows, [], 0)}</tbody>
        <tfoot>
          <tr className="font-semibold">
            <td className="px-3 py-1.5 text-sm text-sdc-navy">{`TOTAL (${rootRows.length})`}</td>
            {/* hours(), matching the KPI strip above the table — and exactly what
                the root rows below this reconcile against, since renderLevel's own
                root call has no parent to target and defaults to this same sum. */}
            <td className={TD_NUM}>{hours(rootTotal)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
