"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { getEmployeePunches, type EmployeePunchDetail, type EmployeePunch } from "@/lib/data-quality-actions";
import type { PunchIssue } from "@/lib/data-quality";
import { useColumnSort } from "@/components/useColumnSort";
import { SortableTh } from "@/components/ui/SortableHeader";
import { sortRows, type SortColumns } from "@/lib/table-sort";
import { hours as fmtHours } from "@/components/ui/format";

// Drill-through for the Data Quality findings, following what the Power BI
// report actually offers rather than inventing new destinations. Its pages drill
// on exactly two fields:
//   • Job Id      -> "Job Detail" / "Assembly"  => /job-hours?jobs=<jobId> here
//   • Employee    -> "Hours Detail"             => the inline panel below
//
// Right-click opens the menu, as in Power BI. Left-clicking the row does the job
// drill directly, since that's the one people want nine times out of ten and
// making them right-click for it would be worse than the report, not the same.
//
// The menu is portaled to <body>: these tables scroll inside a fixed-height box,
// and an absolutely-positioned menu would be clipped by it.

// ── The shared drill treatment (§47) ────────────────────────────────────────
//
// These tables are drill-throughs too, and they were the third of three designs: a navy
// header band with white bold caps, and zebra striping. Both are gone for the same
// reasons the other two panels lost them — a drill is read as a report, so hierarchy
// comes from type and hairlines rather than from a filled band and alternating fills.
// The header treatment matches DrillLines exactly (see components/ui/Drill.tsx); it is
// spelled out here rather than imported because these are plain <table>s that predate
// the shared component and do not have groups to hang off it.
// No text-left/text-right here any more — every header in this file is now a
// SortableTh, which supplies its own alignment (numeric types right, everything else
// left) via table-sort.ts's defaultAlign. Baking text-left in here would fight that
// class on every numeric column, since both would target the same <th>.
const TH = "px-2 py-1 text-label font-semibold uppercase tracking-[0.08em] text-sdc-muted whitespace-nowrap";
const TD = "border-t border-sdc-border-soft px-2 py-1 text-left text-note text-sdc-gray-700";
/** The header row's own fill + rule, replacing `bg-sdc-navy`. */
const THEAD = "bg-sdc-gray-50 [&_th]:border-b [&_th]:border-sdc-border";

type PunchIssueSortKey = "date" | "employee" | "department" | "job" | "completed" | "section" | "hours";

const PUNCH_ISSUE_COLUMNS: SortColumns<PunchIssue, PunchIssueSortKey> = {
  date: { type: "date", value: (r) => r.date },
  employee: { type: "text", value: (r) => r.employee || null },
  department: { type: "text", value: (r) => r.department || null },
  job: { type: "id", value: (r) => r.jobId },
  completed: { type: "date", value: (r) => r.completeDate },
  section: { type: "text", value: (r) => r.section },
  hours: { type: "hours", value: (r) => r.hours },
};

export function DataQualityDrill({ rows, showCompleted }: { rows: PunchIssue[]; showCompleted?: boolean }) {
  const sort = useColumnSort<PunchIssueSortKey>();
  const router = useRouter();
  const [menu, setMenu] = useState<{ x: number; y: number; row: PunchIssue } | null>(null);
  const [panel, setPanel] = useState<EmployeePunchDetail | null>(null);
  const [pending, startTransition] = useTransition();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    // capture, so a scroll inside the table (which doesn't bubble) closes it too
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", close, true);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", close, true);
    };
  }, [menu]);

  function openJob(row: PunchIssue) {
    setMenu(null);
    router.push(`/job-hours?jobs=${encodeURIComponent(row.jobId)}`);
  }

  function openEmployee(row: PunchIssue) {
    setMenu(null);
    startTransition(async () => {
      setPanel(await getEmployeePunches(row.employeeId));
    });
  }

  const ITEM =
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-note text-sdc-navy hover:bg-sdc-gray-100 focus:bg-sdc-gray-100 focus:outline-none";

  return (
    <>
      <div className="max-h-72 overflow-auto rounded-lg border border-sdc-border styled-scrollbar">
        <table className="w-full border-collapse">
          <thead className={`sticky top-0 z-[1] ${THEAD}`}>
            <tr>
              <SortableTh label="Date" sortKey="date" type="date" sort={sort.sort} onSort={sort.onSort} className={TH} />
              <SortableTh label="Employee" sortKey="employee" type="text" sort={sort.sort} onSort={sort.onSort} className={TH} />
              <SortableTh label="Department" sortKey="department" type="text" sort={sort.sort} onSort={sort.onSort} className={TH} />
              <SortableTh label="Job" sortKey="job" type="id" sort={sort.sort} onSort={sort.onSort} className={TH} />
              {showCompleted && <SortableTh label="Completed" sortKey="completed" type="date" sort={sort.sort} onSort={sort.onSort} className={TH} />}
              <SortableTh label="Section" sortKey="section" type="text" sort={sort.sort} onSort={sort.onSort} className={TH} />
              <SortableTh label="Hours" sortKey="hours" type="hours" sort={sort.sort} onSort={sort.onSort} className={TH} />
            </tr>
          </thead>
          <tbody>
            {sortRows(rows, sort.sort, PUNCH_ISSUE_COLUMNS).map((r, i) => (
              <tr
                key={`${r.employeeId}-${r.date}-${r.section}-${i}`}
                onClick={() => openJob(r)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, row: r });
                }}
                title="Click for this job's hours · right-click to drill by employee"
                className={"cursor-pointer hover:bg-sdc-gray-50"}
              >
                <td className={`${TD} whitespace-nowrap font-mono text-label`}>{r.date}</td>
                <td className={TD}>{r.employee}</td>
                <td className={`${TD} text-sdc-muted`}>{r.department}</td>
                <td className={TD} title={r.jobName}>
                  <span className="font-mono text-label text-sdc-muted">{r.jobId}</span> {r.jobName}
                </td>
                {showCompleted && <td className={`${TD} whitespace-nowrap font-mono text-label text-sdc-muted`}>{r.completeDate ?? "—"}</td>}
                <td className={`${TD} font-mono text-label`}>{r.section}</td>
                <td className={`${TD} text-right font-mono tabular-nums`}>{r.hours}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {menu &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: "fixed", left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 120), zIndex: 60 }}
            className="min-w-[220px] overflow-hidden rounded-md border border-sdc-border bg-white py-1 shadow-lg"
          >
            <div className="truncate border-b border-sdc-border px-3 py-1 font-mono text-label text-sdc-muted">
              {menu.row.jobId} · {menu.row.date}
            </div>
            <button type="button" role="menuitem" className={ITEM} onClick={() => openJob(menu.row)}>
              Job Details — {menu.row.jobId}
            </button>
            <button type="button" role="menuitem" className={ITEM} onClick={() => openEmployee(menu.row)}>
              All punches by {menu.row.employee}
            </button>
          </div>,
          document.body,
        )}

      {pending && <p className="mt-2 text-xs text-sdc-gray-400">Loading punches…</p>}

      {panel && <EmployeePanel detail={panel} onClose={() => setPanel(null)} />}
    </>
  );
}

// The unrecognised-ID table, drillable the same way. There is no job on these
// rows — the finding IS the employee — so a click goes straight to the employee
// drill rather than offering a menu with one useful item in it.
type EmployeeIdRow = { employeeId: string; rows: number; hours: number };
const EMPLOYEE_ID_COLUMNS: SortColumns<EmployeeIdRow, "employeeId" | "rows" | "hours"> = {
  employeeId: { type: "id", value: (r) => r.employeeId },
  rows: { type: "number", value: (r) => r.rows },
  hours: { type: "hours", value: (r) => r.hours },
};

export function EmployeeIdDrill({ ids }: { ids: EmployeeIdRow[] }) {
  const [panel, setPanel] = useState<EmployeePunchDetail | null>(null);
  const [pending, startTransition] = useTransition();
  const sort = useColumnSort<"employeeId" | "rows" | "hours">();

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-sdc-border">
        <table className="w-full border-collapse">
          <thead className={THEAD}>
            <tr>
              <SortableTh label="Payroll ID" sortKey="employeeId" type="id" sort={sort.sort} onSort={sort.onSort} className={TH} />
              <SortableTh label="Punches" sortKey="rows" type="number" sort={sort.sort} onSort={sort.onSort} className={TH} />
              <SortableTh label="Hours" sortKey="hours" type="hours" sort={sort.sort} onSort={sort.onSort} className={TH} />
            </tr>
          </thead>
          <tbody>
            {/* No row index any more — it was only ever used for the zebra stripe. */}
            {sortRows(ids, sort.sort, EMPLOYEE_ID_COLUMNS).map((r) => (
              <tr
                key={r.employeeId}
                onClick={() => startTransition(async () => setPanel(await getEmployeePunches(r.employeeId)))}
                title="Click to see everything this ID has booked"
                className={"cursor-pointer hover:bg-sdc-gray-50"}
              >
                <td className={`${TD} font-mono`}>#{r.employeeId}</td>
                <td className={`${TD} text-right tabular-nums`}>{r.rows.toLocaleString()}</td>
                <td className={`${TD} text-right tabular-nums`}>{fmtHours(r.hours)}h</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pending && <p className="mt-2 text-xs text-sdc-gray-400">Loading punches…</p>}
      {panel && <EmployeePanel detail={panel} onClose={() => setPanel(null)} />}
    </>
  );
}

const EMPLOYEE_PUNCH_COLUMNS: SortColumns<EmployeePunch, "date" | "job" | "status" | "section" | "hours"> = {
  date: { type: "date", value: (r) => r.date },
  job: { type: "id", value: (r) => r.jobId },
  status: { type: "status", value: (r) => r.jobStatus },
  section: { type: "text", value: (r) => r.section },
  hours: { type: "hours", value: (r) => r.hours },
};

// The employee drill — the report's "Hours Detail" page filtered to one person.
// Everything they booked, newest first by default, across every job.
function EmployeePanel({ detail, onClose }: { detail: EmployeePunchDetail; onClose: () => void }) {
  // Fully unmounts/remounts per employee (the parent only ever renders one at a time,
  // conditionally) — no reset guard needed, a fresh employee always starts unsorted.
  const sort = useColumnSort<"date" | "job" | "status" | "section" | "hours">();
  return (
    <div className="mt-3 rounded-lg border border-sdc-blue-100 bg-white p-3">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-sdc-navy">
            {detail.name ?? `Payroll ID #${detail.employeeId}`}
            {detail.department && <span className="ml-2 text-xs font-normal text-sdc-muted">{detail.department}</span>}
          </p>
          <p className="text-note text-sdc-muted">
            {detail.rows.length.toLocaleString()} punches · {fmtHours(detail.total)}h
            {detail.truncated && " (most recent 500)"}
            {/* An unresolved ID is the finding itself, so name it here too rather
                than leaving the reader to notice the heading is a number. */}
            {detail.name === null && " · this ID matches nobody on the roster"}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 rounded p-1 text-sdc-gray-400 hover:text-sdc-navy">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 4 L12 12 M12 4 L4 12" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="max-h-72 overflow-auto rounded-lg border border-sdc-border styled-scrollbar">
        <table className="w-full border-collapse">
          <thead className={`sticky top-0 z-[1] ${THEAD}`}>
            <tr>
              <SortableTh label="Date" sortKey="date" type="date" sort={sort.sort} onSort={sort.onSort} className={TH} />
              <SortableTh label="Job" sortKey="job" type="id" sort={sort.sort} onSort={sort.onSort} className={TH} />
              <SortableTh label="Status" sortKey="status" type="status" sort={sort.sort} onSort={sort.onSort} className={TH} />
              <SortableTh label="Section" sortKey="section" type="text" sort={sort.sort} onSort={sort.onSort} className={TH} />
              <SortableTh label="Hours" sortKey="hours" type="hours" sort={sort.sort} onSort={sort.onSort} className={TH} />
            </tr>
          </thead>
          <tbody>
            {sortRows(detail.rows, sort.sort, EMPLOYEE_PUNCH_COLUMNS).map((r, i) => (
              <tr key={`${r.date}-${r.jobId}-${r.section}-${i}`} className="hover:bg-sdc-gray-50">
                <td className={`${TD} whitespace-nowrap font-mono text-label`}>{r.date}</td>
                <td className={TD} title={r.jobName}>
                  <span className="font-mono text-label text-sdc-muted">{r.jobId}</span> {r.jobName}
                </td>
                <td className={`${TD} text-sdc-muted`}>{r.jobStatus}</td>
                <td className={`${TD} font-mono text-label`} title={r.sectionName}>
                  {r.section}
                </td>
                <td className={`${TD} text-right font-mono tabular-nums`}>{r.hours}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
