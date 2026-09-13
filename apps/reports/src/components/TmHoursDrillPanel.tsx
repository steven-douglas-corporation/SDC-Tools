"use client";

import { useMemo, useState } from "react";
import { DRILL_NUM, DRILL_TOTAL_LABEL, DrillEmpty, DrillLines } from "@/components/ui/Drill";
import { SortableTh } from "@/components/ui/SortableHeader";
import { useColumnSort } from "@/components/useColumnSort";
import { sortRows, type SortColumns } from "@/lib/table-sort";
import { hoursCell, hoursExact } from "@/components/ui/format";
import { BUTTON_COMPACT } from "@/components/ui/classnames";
import type { TmHoursDrillRow } from "@/lib/tm-hours";
// The SAME predicate the export applies server-side — see tm-drill-search.ts.
import { filterTmDrillRows } from "@/lib/tm-drill-search";
import { useToast } from "@/components/ui/Toast";

// The drill-through TABLE behind the T&M tab's five Hours cards (Engineering,
// Shop, PM, Manufacturing, Other) — rendered inside the shared right-side drawer
// (BuildReadinessDrawer, see TmReportClient.tsx) that owns the
// title/subtitle/close chrome, so this is just the search box + table, on the
// same DrillLines/SortableTh primitives HoursDetailPanel already uses for
// Monthly ETC's own punch drill. Rows come from tm-report.ts's
// fetchTmHoursDrill, which applies the exact same filters + measure condition
// the KPI row's own number came from — so this table's Hours column always
// sums back to the row, whatever the current Job/Status/date selection is.

type SortKey = "date" | "employee" | "department" | "jobId" | "jobName" | "rawSection" | "rawSectionName" | "rawFunction" | "standardTaskDescription" | "hours";

const COLUMNS: SortColumns<TmHoursDrillRow, SortKey> = {
  date: { type: "date", value: (r) => r.date },
  employee: { type: "text", value: (r) => r.employee || null },
  department: { type: "text", value: (r) => r.department || null },
  jobId: { type: "id", value: (r) => r.jobId || null },
  jobName: { type: "text", value: (r) => r.jobName || null },
  rawSection: { type: "text", value: (r) => r.rawSection || null },
  rawSectionName: { type: "text", value: (r) => r.rawSectionName || null },
  rawFunction: { type: "text", value: (r) => r.rawFunction || null },
  standardTaskDescription: { type: "text", value: (r) => r.standardTaskDescription || null },
  hours: { type: "hours", value: (r) => r.hours },
};

export function TmHoursDrillPanel({
  rows,
  error,
  exportParams,
}: {
  /** null while the drill is loading. */
  rows: TmHoursDrillRow[] | null;
  error: string | null;
  /**
   * What the export needs that this panel does not otherwise know: which card is
   * open and the page's current job/date selection. The search box is NOT in
   * here — it is this component's own state and is appended at click time.
   * Omitted/null hides the export control rather than sending a broken request.
   */
  exportParams?: { key: string; jobs: string[]; from: string; to: string } | null;
}) {
  const sort = useColumnSort<SortKey>({ key: "date", direction: "desc" });
  const [query, setQuery] = useState("");
  const [exporting, setExporting] = useState<"csv" | "xlsx" | null>(null);
  const { toast } = useToast();

  // One predicate, shared with the export (lib/tm-drill-search.ts) — this used
  // to be an inline eight-field OR here, which is what the server would have had
  // to duplicate.
  const filtered = useMemo(() => (rows ? filterTmDrillRows(rows, query) : []), [rows, query]);

  const sorted = useMemo(() => sortRows(filtered, sort.sort, COLUMNS), [filtered, sort.sort]);
  const total = filtered.reduce((sum, r) => sum + r.hours, 0);
  const filtering = query.trim().length > 0;

  // fetch + blob rather than a plain <a download>, for the three reasons
  // ExportMenu.tsx gives: a link cannot show progress, cannot tell a 500 from a
  // success (the failure just looks like nothing happened), and cannot be
  // awaited. The drawer never navigates — the anchor is synthetic and revoked.
  async function handleExport(format: "csv" | "xlsx") {
    if (exporting || !exportParams) return;
    setExporting(format);
    try {
      const qs = new URLSearchParams({
        format,
        key: exportParams.key,
        from: exportParams.from,
        to: exportParams.to,
      });
      if (exportParams.jobs.length > 0) qs.set("jobs", exportParams.jobs.join(","));
      // The search box, so the file matches THIS table and not the unfiltered
      // card. Applied server-side by the same predicate used above.
      if (filtering) qs.set("q", query.trim());

      const res = await fetch(`/api/export/tm-hours?${qs.toString()}`);
      if (!res.ok) throw new Error((await res.text()) || `Export failed (${res.status}).`);

      const blob = await res.blob();
      const fileName =
        /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? `T&M.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      toast(`${fileName} downloaded.`, "success");
    } catch (err) {
      toast(err instanceof Error ? `Export failed — ${err.message}` : "Export failed.", "error");
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-sdc-border-soft px-4 py-2.5">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search employee, job, or function…"
          className="h-7 w-full max-w-xs rounded-md border border-sdc-border-soft px-2 text-note outline-none motion-interactive focus:border-sdc-blue"
        />
        {/* Export sits opposite the search box on purpose: the box is what
            decides what lands in the file, so the two controls read together.
            Hidden until rows are loaded — there is nothing to export before
            that, and an enabled button that produces an empty sheet is worse
            than no button. */}
        {exportParams && rows !== null && rows.length > 0 ? (
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-note text-sdc-muted">
              Export {filtering ? `${filtered.length} of ${rows.length}` : `${rows.length}`} row
              {(filtering ? filtered.length : rows.length) === 1 ? "" : "s"}:
            </span>
            <button
              type="button"
              className={BUTTON_COMPACT}
              disabled={exporting !== null}
              onClick={() => handleExport("csv")}
            >
              {exporting === "csv" ? "Exporting…" : "CSV"}
            </button>
            <button
              type="button"
              className={BUTTON_COMPACT}
              disabled={exporting !== null}
              onClick={() => handleExport("xlsx")}
            >
              {exporting === "xlsx" ? "Exporting…" : "Excel"}
            </button>
          </div>
        ) : null}
      </div>
      <div className="styled-scrollbar min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <DrillEmpty>Couldn&apos;t load this detail: {error}</DrillEmpty>
        ) : rows === null ? (
          <DrillEmpty>Loading…</DrillEmpty>
        ) : sorted.length === 0 ? (
          <DrillEmpty>No hours match.</DrillEmpty>
        ) : (
          <div className="overflow-x-auto">
            <DrillLines
              head={
                <>
                  <SortableTh label="Date" sortKey="date" type="date" sort={sort.sort} onSort={sort.onSort} className="w-24" />
                  <SortableTh label="Employee" sortKey="employee" type="text" sort={sort.sort} onSort={sort.onSort} />
                  <SortableTh label="Department" sortKey="department" type="text" sort={sort.sort} onSort={sort.onSort} className="w-40" />
                  <SortableTh label="Job ID" sortKey="jobId" type="id" sort={sort.sort} onSort={sort.onSort} className="w-20" />
                  <SortableTh label="Job / Machine" sortKey="jobName" type="text" sort={sort.sort} onSort={sort.onSort} className="w-56" />
                  {/* Separate columns (2026-08-21) — consistent with every other view
                      of these same JobHoursDetail rows. */}
                  <SortableTh label="Section" sortKey="rawSection" type="text" sort={sort.sort} onSort={sort.onSort} className="w-16" />
                  <SortableTh label="Section Name" sortKey="rawSectionName" type="text" sort={sort.sort} onSort={sort.onSort} className="w-40" />
                  <SortableTh label="Function" sortKey="rawFunction" type="text" sort={sort.sort} onSort={sort.onSort} className="w-16" />
                  <SortableTh label="Function Name" sortKey="standardTaskDescription" type="text" sort={sort.sort} onSort={sort.onSort} className="w-40" />
                  <SortableTh label="Hours" sortKey="hours" type="hours" sort={sort.sort} onSort={sort.onSort} className="w-20" />
                </>
              }
              foot={
                <tr>
                  <td className={DRILL_TOTAL_LABEL} colSpan={9}>
                    {filtering ? "Shown" : "Total"}
                  </td>
                  <td className={`${DRILL_NUM} text-sm font-semibold`} title={hoursExact(total)}>
                    {hoursCell(total)}
                  </td>
                </tr>
              }
            >
              {sorted.map((r, i) => (
                <tr key={`${r.date}-${r.employee}-${r.jobId}-${r.section}-${i}`}>
                  <td className="font-mono tabular-nums text-sdc-muted">{r.date ?? "—"}</td>
                  <td className="text-sdc-gray-700">{r.employee || "—"}</td>
                  <td className="text-sdc-muted">{r.department || "—"}</td>
                  <td className="font-mono text-sdc-muted">{r.jobId || "—"}</td>
                  <td className="text-sdc-gray-700" title={r.jobName}>
                    <span className="line-clamp-1">{r.jobName || "—"}</span>
                  </td>
                  <td className="font-mono text-sdc-muted">{r.rawSection || "—"}</td>
                  <td className="text-sdc-muted">{r.rawSectionName || "—"}</td>
                  <td className="font-mono text-sdc-muted">{r.rawFunction || "—"}</td>
                  <td className="text-sdc-muted">{r.standardTaskDescription || "—"}</td>
                  <td className={DRILL_NUM} title={hoursExact(r.hours)}>
                    {hoursCell(r.hours)}
                  </td>
                </tr>
              ))}
            </DrillLines>
          </div>
        )}
      </div>
    </div>
  );
}
