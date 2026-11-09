"use client";

import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
// The theme and the Community module registration both live in one place since
// 2026-09-17, when the feedback queue became the app's second grid — see that
// file for why they are not inline here any more.
import { sdcTheme, GRID_HEIGHT } from "@/components/ui/ag-grid-theme";

export type AuditRow = {
  when: string;
  userEmail: string;
  action: string;
  entity: string;
  summary: string;
};

export default function AuditLogGridInner({ rows }: { rows: AuditRow[] }) {
  const columnDefs: ColDef<AuditRow>[] = [
    { field: "when", headerName: "When", width: 155, sort: "desc" },
    { field: "userEmail", headerName: "User", width: 210 },
    { field: "action", headerName: "Action", width: 210, cellClass: "font-mono" },
    { field: "entity", headerName: "Entity", width: 150 },
    { field: "summary", headerName: "Summary", flex: 1, minWidth: 320, wrapText: true, autoHeight: true },
  ];

  return (
    <div style={{ height: GRID_HEIGHT, width: "100%" }}>
      <AgGridReact<AuditRow>
        theme={sdcTheme}
        rowData={rows}
        columnDefs={columnDefs}
        defaultColDef={{ sortable: true, filter: true, resizable: true, floatingFilter: true }}
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
