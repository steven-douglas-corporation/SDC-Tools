"use client";

import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from "ag-grid-community";

// Register the free Community feature set (sort/filter/resize/pagination/CSV).
ModuleRegistry.registerModules([AllCommunityModule]);

// AG Grid v36 Theming API (no CSS import needed) — tuned to the SDC brand so
// the trial grid reads like the rest of the app.
const sdcTheme = themeQuartz.withParams({
  accentColor: "#1574C4",
  headerBackgroundColor: "#061D39",
  headerTextColor: "#ffffff",
  headerFontWeight: 600,
  fontFamily: "inherit",
  fontSize: 8,
  headerFontSize: 8,
  rowHoverColor: "#e6f0fa",
  borderColor: "#e6e9ee",
  wrapperBorderRadius: 12,
  oddRowBackgroundColor: "#fafbfc",
});

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
    <div style={{ height: "calc(var(--app-vh) - 175px)", width: "100%" }}>
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
