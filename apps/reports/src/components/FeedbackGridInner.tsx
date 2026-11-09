"use client";

import { useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { sdcTheme, GRID_HEIGHT } from "@/components/ui/ag-grid-theme";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_STATUS_VARIANT,
  FEEDBACK_SEVERITY_LABELS,
  FEEDBACK_CATEGORY_LABELS,
  isFeedbackStatus,
  isFeedbackSeverity,
  isFeedbackCategory,
} from "@/lib/feedback-status";

// The feedback queue. Same shell as AuditLogGridInner — one shared theme (see
// components/ui/ag-grid-theme.ts), same paging, same full-height sizing — so
// the two record views in this app read as the same kind of screen.

export type FeedbackGridRow = {
  id: number;
  when: string;
  status: string;
  severity: string;
  category: string;
  view: string;
  context: string;
  job: string;
  period: string;
  field: string;
  observed: string;
  expected: string;
  submitter: string;
  assigned: string;
  summary: string;
  response: string;
  contextUrl: string | null;
};

// A raw key would render as "wontfix"/"ack" in the grid. Falling back to the
// raw value rather than blanking it means a row written by a newer build (or
// by hand) is still legible here instead of looking like a broken record.
const labelStatus = (v: string) => (isFeedbackStatus(v) ? FEEDBACK_STATUS_LABELS[v] : v);
const labelSeverity = (v: string) => (isFeedbackSeverity(v) ? FEEDBACK_SEVERITY_LABELS[v] : v);
const labelCategory = (v: string) => (isFeedbackCategory(v) ? FEEDBACK_CATEGORY_LABELS[v] : v);

function StatusCell({ value }: ICellRendererParams<FeedbackGridRow, string>) {
  const raw = value ?? "";
  if (!isFeedbackStatus(raw)) return <span>{raw}</span>;
  return <StatusBadge variant={FEEDBACK_STATUS_VARIANT[raw]}>{FEEDBACK_STATUS_LABELS[raw]}</StatusBadge>;
}

export default function FeedbackGridInner({
  rows,
  onOpen,
}: {
  rows: FeedbackGridRow[];
  onOpen?: (id: number) => void;
}) {
  const columnDefs = useMemo<ColDef<FeedbackGridRow>[]>(
    () => [
      { field: "when", headerName: "When", width: 150, sort: "desc" },
      { field: "status", headerName: "Status", width: 130, cellRenderer: StatusCell, valueFormatter: (p) => labelStatus(p.value ?? "") },
      { field: "severity", headerName: "Urgency", width: 120, valueFormatter: (p) => labelSeverity(p.value ?? "") },
      { field: "category", headerName: "Kind", width: 150, valueFormatter: (p) => labelCategory(p.value ?? "") },
      // The context columns — the reason this table exists. Kept to the LEFT
      // of the free text, because "which view / which job / which month" is
      // what a triager scans by, and the prose is what they read once they
      // have picked a row.
      { field: "view", headerName: "View", width: 140 },
      { field: "job", headerName: "Job", width: 100 },
      { field: "period", headerName: "Period", width: 100 },
      { field: "field", headerName: "Field", width: 150 },
      { field: "observed", headerName: "Shows", width: 120 },
      { field: "expected", headerName: "Should be", width: 120 },
      { field: "submitter", headerName: "From", width: 200 },
      { field: "assigned", headerName: "Assigned", width: 180 },
      {
        field: "summary",
        headerName: "What they said",
        flex: 1,
        minWidth: 280,
        wrapText: true,
        autoHeight: true,
        // The captured filters, on hover — too long for a column of its own,
        // too useful to drop.
        tooltipValueGetter: (p) => (p.data?.context ? `Context: ${p.data.context}` : undefined),
      },
      { field: "response", headerName: "Response", width: 240, wrapText: true, autoHeight: true },
    ],
    [],
  );

  return (
    <div style={{ height: GRID_HEIGHT, width: "100%" }}>
      <AgGridReact<FeedbackGridRow>
        theme={sdcTheme}
        rowData={rows}
        columnDefs={columnDefs}
        defaultColDef={{ sortable: true, filter: true, resizable: true, floatingFilter: true }}
        // Opening a row is how a triager acts on it. Guarded so the grid still
        // works as a read-only list for a submitter with no triage rights.
        onRowClicked={onOpen ? (e) => e.data && onOpen(e.data.id) : undefined}
        rowClass={onOpen ? "cursor-pointer" : undefined}
        suppressMenuHide
        pagination
        paginationPageSize={50}
        paginationPageSizeSelector={[50, 100, 200]}
        enableCellTextSelection
        animateRows
      />
    </div>
  );
}
