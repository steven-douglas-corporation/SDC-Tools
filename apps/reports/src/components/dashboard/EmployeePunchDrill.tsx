"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { DrillPanel } from "@/components/ui/Drill";
import { SortableTh } from "@/components/ui/SortableHeader";
import { cycleSortState, sortRows, type SortState } from "@/lib/table-sort";
import { PUNCH_SORT_COLUMNS, type PunchSortKey } from "@/lib/employee-punch-sort";
import { loadEmployeeMonthPunches } from "@/lib/employee-punch-actions";
import type { EmployeeMonthPunches } from "@/lib/employee-punch-drill";
import type { PunchBucket } from "@/lib/department-utilization";

// ── The punches behind one employee's utilization row (2026-08-28) ──────────
//
// Opened by clicking a person in the expanded Department Utilization table. It
// answers the question the row raises and cannot itself answer: "Adam Haviland
// is 61% utilized — on what?"
//
// Everything here is month-scoped and comes from the same classifier the table
// sums (classifyUtilizationPunch), so the panel's totals ARE the row's figures.
// Verified across every employee with hours in 2026-08: 48/48 reconcile on both
// total and billable hours.

/** Bucket tint. Billable shades green, the two that pull utilization DOWN read neutral/red. */
const BUCKET_TONE: Record<PunchBucket, string> = {
  billableActive: "bg-sdc-green-bg text-sdc-green-text",
  warranty: "bg-sdc-blue-light text-sdc-blue-dark",
  service: "bg-sdc-blue-light text-sdc-blue-dark",
  spareParts: "bg-sdc-blue-light text-sdc-blue-dark",
  bellco: "bg-sdc-gray-100 text-sdc-gray-600",
  nonBillable: "bg-sdc-red-bg text-sdc-red-text",
};

const DATE = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
function dateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return DATE.format(new Date(Date.UTC(y, m - 1, d)));
}
const hrs = (n: number) => (Math.round(n * 100) / 100).toLocaleString("en-US");

// ── Sorting the punch list (2026-08-31) ────────────────────────────────────
//
// Through the app's shared sort (lib/table-sort.ts + ui/SortableHeader.tsx), the
// same one the job drill and the department table use — so the click cycle
// (none → asc → desc → none), the rotating chevron, the full-cell click target
// and the aria-sort wiring are the established behaviour rather than a second
// implementation living in this panel. The column definitions are in
// lib/employee-punch-sort.ts, which has no React in it and is tested directly.
//
// The "none" third click restores the DEFAULT order, which is the server's own
// `orderBy: [{ workDate: "desc" }, { section: "asc" }]` — newest punch first —
// because sortRows() returns the input array untouched for a null sort.
//
// All client-side over the rows already loaded: a header click issues no
// request, and the sorted array is a copy, so `result.rows` — which the bucket
// chips and the footer total also read — is never reordered underneath them.

/** Sticky, so the column names survive a long punch list. See the note in the table below. */
const TH = "sticky top-0 z-10 border-b border-sdc-border bg-white px-3 py-2 font-semibold";

export type PunchDrillTarget = { employeeId: string; name: string };

export function useEmployeePunchDrill(month: string) {
  const [target, setTarget] = useState<PunchDrillTarget | null>(null);
  const [result, setResult] = useState<EmployeeMonthPunches | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per (employee, month) for the life of the component. Not persisted: punches
  // change under you, and a drill served from a stale cache disagreeing with the
  // row above it is the one thing this must never do.
  const cache = useRef(new Map<string, EmployeeMonthPunches>());
  const latest = useRef(0);

  const close = useCallback(() => {
    latest.current++;
    setTarget(null);
    setResult(null);
    setError(null);
    setLoading(false);
  }, []);

  /** Open a person's punches — or close, if that same person is already open. */
  const toggle = useCallback(
    (next: PunchDrillTarget) => {
      if (target?.employeeId === next.employeeId) {
        close();
        return;
      }
      setTarget(next);

      const key = `${next.employeeId}::${month}`;
      const cached = cache.current.get(key);
      if (cached) {
        latest.current++;
        setResult(cached);
        setError(null);
        setLoading(false);
        return;
      }

      const ticket = ++latest.current;
      setLoading(true);
      setError(null);
      // Clear immediately: the previous person's rows under a new heading would
      // read as this person's.
      setResult(null);
      loadEmployeeMonthPunches(next.employeeId, month)
        .then((r) => {
          if (ticket !== latest.current) return;
          cache.current.set(key, r);
          setResult(r);
        })
        .catch((e: unknown) => {
          if (ticket !== latest.current) return;
          setError(e instanceof Error ? e.message : "Could not load these punches.");
        })
        .finally(() => {
          if (ticket === latest.current) setLoading(false);
        });
    },
    [target, month, close],
  );

  return {
    target,
    result,
    loading,
    error,
    toggle,
    close,
    isOpen: (employeeId: string) => target?.employeeId === employeeId,
  };
}

export function EmployeePunchDrillPanel({
  target,
  result,
  loading,
  error,
  monthLabel,
  onClose,
  expectedHours,
}: {
  target: PunchDrillTarget;
  result: EmployeeMonthPunches | null;
  loading: boolean;
  error: string | null;
  monthLabel: string;
  onClose: () => void;
  /** The Actual hours the table row showed. Rendered beside the drill's own total so a mismatch is visible, not silent. */
  expectedHours: number;
}) {
  const reconciles = result === null || Math.abs(result.totalHours - expectedHours) < 0.02;

  // ── Sort state, reset when the panel switches employee ───────────────────
  //
  // Adjusting state during render on a changed prop — React's own documented
  // pattern for exactly this, and cheaper than an effect (no second render, no
  // flash of the previous person's sort). Done HERE rather than with a `key` on
  // the caller so the guarantee belongs to the panel: whoever renders it next
  // cannot forget it. Requirement: opening a different person starts back at the
  // default newest-first order.
  const [sort, setSort] = useState<SortState<PunchSortKey>>(null);
  const [sortedFor, setSortedFor] = useState(target.employeeId);
  if (sortedFor !== target.employeeId) {
    setSortedFor(target.employeeId);
    setSort(null);
  }

  // A COPY, always — sortRows never mutates, and `result.rows` stays in server
  // order for the bucket chips and the footer total that also read it.
  const rows = useMemo(() => sortRows(result?.rows ?? [], sort, PUNCH_SORT_COLUMNS), [result, sort]);
  const onSort = (key: PunchSortKey) => setSort((current) => cycleSortState(current, key));

  return (
    <DrillPanel
      title={`${target.name} — punches in ${monthLabel}`}
      meta={
        loading
          ? "Loading…"
          : result
            ? `${result.rows.length} punch${result.rows.length === 1 ? "" : "es"} · ${hrs(result.totalHours)}h total · ${hrs(result.billableHours)}h billable` +
              (reconciles ? "" : ` · table says ${hrs(expectedHours)}h`)
            : undefined
      }
      // Should be unreachable — both sides run classifyUtilizationPunch over the
      // same rows — so if it ever shows, it is a real defect and needs to be loud.
      note={reconciles ? undefined : "This panel and the table disagree — please report it."}
      onClose={onClose}
      className="min-w-0"
    >
      {error ? (
        <p className="px-4 py-6 text-sm text-sdc-red-text">{error}</p>
      ) : loading ? (
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-sdc-muted">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-sdc-border border-t-sdc-blue" aria-hidden />
          Loading punches…
        </div>
      ) : !result || result.rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-sdc-muted">No punches for {target.name} in {monthLabel}.</p>
      ) : (
        <>
          {/* Where the hours went, before the row-by-row detail — this is the
              line that actually explains a utilization percentage. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-sdc-border-soft bg-sdc-gray-50 px-4 py-2">
            {result.byBucket.map((b) => (
              <span key={b.bucket} className={`rounded px-1.5 py-0.5 text-label font-semibold ${BUCKET_TONE[b.bucket]}`}>
                {b.label} {hrs(b.hours)}h
              </span>
            ))}
          </div>

          {/* No overflow-x wrapper. `overflow-x: auto` computes `overflow-y` to
              auto as well, which would make this div its own unconstrained
              scroll container — and a sticky <thead> inside it would then have
              nothing to stick to, because that container never scrolls
              vertically. DrillPanel's body is already the capped scroller (see
              DRILL_BODY / .drill-cap) and its own overflow-x computes to auto,
              so the table still scrolls sideways on a narrow window; it just
              does it in the element that also owns the vertical scroll. */}
          <table className="w-full min-w-[30rem] border-collapse text-sm">
              <thead>
                {/* Sticky against the drill body's scroll, so the column names
                    stay put through a long punch list. The background sits on the
                    cells, not the row: a <tr> background does not reliably paint
                    over content scrolling beneath a sticky header. */}
                <tr className="text-xs uppercase tracking-wide text-sdc-muted">
                  <SortableTh label="Date" sortKey="date" type="date" sort={sort} onSort={onSort} className={`${TH} w-[7.5rem]`} />
                  <SortableTh label="Job" sortKey="jobId" type="id" sort={sort} onSort={onSort} align="left" className={`${TH} w-[5rem]`} />
                  <SortableTh label="Project" sortKey="project" type="text" sort={sort} onSort={onSort} className={TH} />
                  <SortableTh
                    label="Section"
                    sortKey="section"
                    type="text"
                    sort={sort}
                    onSort={onSort}
                    title="Sorted by section code, not by the name beside it"
                    className={`${TH} w-[10rem]`}
                  />
                  {/* align left despite the numeric comparator: the column holds a
                      label, and the rank it sorts by is an implementation detail. */}
                  <SortableTh
                    label="Counts as"
                    sortKey="bucket"
                    type="number"
                    align="left"
                    sort={sort}
                    onSort={onSort}
                    title="Billable, Warranty, Service, Spare Parts, Bellco, Non-Billable"
                    className={`${TH} w-[7rem]`}
                  />
                  <SortableTh label="Hours" sortKey="hours" type="hours" sort={sort} onSort={onSort} className={`${TH} w-[4.5rem]`} />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.date}-${r.jobId}-${r.section}-${i}`} className="border-b border-sdc-border-soft hover:bg-sdc-blue-light/25">
                    <td className="px-3 py-1.5 whitespace-nowrap tabular-nums text-sdc-gray-700">{dateLabel(r.date)}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap font-medium text-sdc-navy">{r.jobId}</td>
                    <td className="max-w-[18rem] truncate px-3 py-1.5 text-sdc-gray-700" title={r.jobName}>{r.jobName}</td>
                    <td
                      className="max-w-[12rem] truncate px-3 py-1.5 text-sdc-gray-600"
                      title={r.sectionName === r.section ? r.section : `${r.section} — ${r.sectionName}`}
                    >
                      {/* sectionName falls back to the CODE when sections.ts has
                          no entry for it, so printing both unconditionally gave
                          "10-400 10-400". Only show the name when it adds one. */}
                      <span className="font-mono text-label">{r.section}</span>
                      {r.sectionName !== r.section && ` ${r.sectionName}`}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span className={`rounded px-1.5 py-0.5 text-label font-semibold ${BUCKET_TONE[r.bucket]}`}>
                        {result.byBucket.find((b) => b.bucket === r.bucket)?.label ?? r.bucket}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-sdc-navy">{hrs(r.hours)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-sdc-border bg-sdc-gray-50 font-semibold text-sdc-navy">
                  <td colSpan={5} className="px-3 py-2 text-left">
                    Total <span className="font-normal text-sdc-muted">· {hrs(result.billableHours)}h of it billable</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{hrs(result.totalHours)}</td>
                </tr>
              </tfoot>
          </table>
        </>
      )}
    </DrillPanel>
  );
}
