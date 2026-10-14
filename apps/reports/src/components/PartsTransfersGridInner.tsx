"use client";

import { useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ValueFormatterParams } from "ag-grid-community";
import { sdcTheme, GRID_HEIGHT } from "@/components/ui/ag-grid-theme";
import type { AppliedTransferRow, ReviewPullRow } from "@/lib/sync-totaleto";
import { NO_DESTINATION } from "@/lib/parts-transfer-netting";

const money = (p: ValueFormatterParams) =>
  typeof p.value === "number"
    ? p.value.toLocaleString("en-US", { style: "currency", currency: "USD" })
    : "";

const DEFAULT_COL: ColDef = { sortable: true, filter: true, resizable: true, floatingFilter: true };

const REVIEW_COLS: ColDef<ReviewPullRow>[] = [
  { field: "day", headerName: "Fulfilled", width: 115, sort: "desc" },
  { field: "job", headerName: "Job", width: 90, cellClass: "font-mono" },
  { field: "direction", headerName: "Movement", width: 135 },
  { field: "partNumber", headerName: "Part No", width: 150, cellClass: "font-mono" },
  { field: "description", headerName: "Description", width: 240 },
  { field: "qty", headerName: "Qty", width: 85, type: "rightAligned" },
  { field: "cost", headerName: "Cost", width: 115, type: "rightAligned", valueFormatter: money },
  { field: "possibleOtherJobs", headerName: "Possible other job", width: 230 },
  { field: "reasons", headerName: "Why it was not applied", flex: 1, minWidth: 300, wrapText: true, autoHeight: true },
  { field: "pullId", headerName: "Pull ID", width: 100, cellClass: "font-mono" },
];

const APPLIED_COLS: ColDef<AppliedTransferRow>[] = [
  { field: "day", headerName: "Completed", width: 115, sort: "desc" },
  { field: "fromJob", headerName: "From job", width: 105, cellClass: "font-mono" },
  { field: "toJob", headerName: "To job", width: 100, cellClass: "font-mono", valueFormatter: (p: ValueFormatterParams) => (p.value === NO_DESTINATION ? "— removed" : p.value) },
  { field: "partNumber", headerName: "Part No", width: 160, cellClass: "font-mono" },
  { field: "description", headerName: "Description", flex: 1, minWidth: 240 },
  { field: "qty", headerName: "Qty", width: 85, type: "rightAligned" },
  { field: "costOut", headerName: "Left at", width: 120, type: "rightAligned", valueFormatter: money },
  { field: "costIn", headerName: "Arrived at", width: 120, type: "rightAligned", valueFormatter: money },
  { field: "pullIds", headerName: "Pull IDs", width: 150, cellClass: "font-mono" },
];

export default function PartsTransfersGridInner({
  needsReview,
  applied,
}: {
  needsReview: ReviewPullRow[];
  applied: AppliedTransferRow[];
}) {
  const [tab, setTab] = useState<"review" | "applied">(needsReview.length > 0 ? "review" : "applied");
  const tabs = [
    { key: "review" as const, label: `Needs review (${needsReview.length.toLocaleString()})` },
    { key: "applied" as const, label: `Applied transfers (${applied.length.toLocaleString()})` },
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`motion-interactive rounded-full border px-3 py-1 text-xs ${
              tab === t.key
                ? "border-sdc-blue bg-sdc-blue-light text-sdc-blue-dark"
                : "border-sdc-border-soft text-sdc-muted hover:text-sdc-navy"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ height: GRID_HEIGHT, width: "100%" }}>
        {tab === "review" ? (
          <AgGridReact<ReviewPullRow>
            theme={sdcTheme}
            rowData={needsReview}
            columnDefs={REVIEW_COLS}
            defaultColDef={DEFAULT_COL}
            suppressMenuHide
            pagination
            paginationPageSize={50}
            paginationPageSizeSelector={[50, 100, 200]}
            enableCellTextSelection
            overlayNoRowsTemplate="Nothing to review: every pull that looks like half of a transfer was matched."
          />
        ) : (
          <AgGridReact<AppliedTransferRow>
            theme={sdcTheme}
            rowData={applied}
            columnDefs={APPLIED_COLS}
            defaultColDef={DEFAULT_COL}
            suppressMenuHide
            pagination
            paginationPageSize={50}
            paginationPageSizeSelector={[50, 100, 200]}
            enableCellTextSelection
            overlayNoRowsTemplate="No transfers between jobs have been applied yet."
          />
        )}
      </div>
    </div>
  );
}
