"use client";

import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { sdcTheme, GRID_HEIGHT } from "@/components/ui/ag-grid-theme";
import { usdExact } from "@/components/ui/format";
import { fmtDate } from "@/lib/po-detail";
import { OPEN_PO_STATUS_LABEL, type OpenPoRow, type OpenPoStatus } from "@/lib/open-pos-rules";

// Subtle colour on the status text only; the label carries the meaning.
const STATUS_CLASS: Record<OpenPoStatus, string> = {
  "past-due": "text-red-700 font-semibold",
  "over-invoiced": "text-amber-700",
  "awaiting-delivery": "text-sdc-navy",
  "awaiting-invoice": "text-sdc-gray-600",
  open: "text-sdc-gray-600",
};

function JobsCell({ value }: ICellRendererParams<OpenPoRow, string[]>) {
  return (
    <span className="flex flex-wrap gap-x-2">
      {(value ?? []).map((j) => (
        <a key={j} href={`/job-hours?jobs=${encodeURIComponent(j)}`} className="text-sdc-blue hover:underline">
          {j}
        </a>
      ))}
    </span>
  );
}

const money = { type: "rightAligned", width: 140, filter: "agNumberColumnFilter", valueFormatter: (p: { value: number | null }) => (p.value == null ? "" : usdExact(p.value)) } as const;

export default function OpenPosGridInner({ rows }: { rows: OpenPoRow[] }) {
  const columnDefs: ColDef<OpenPoRow>[] = [
    { field: "poNumber", headerName: "PO #", width: 110, pinned: "left", cellClass: "font-mono" },
    {
      field: "status",
      headerName: "Status",
      width: 200,
      valueFormatter: (p) => (p.value ? OPEN_PO_STATUS_LABEL[p.value as OpenPoStatus] : ""),
      filterValueGetter: (p) => (p.data ? OPEN_PO_STATUS_LABEL[p.data.status] : ""),
      cellClass: (p) => (p.value ? STATUS_CLASS[p.value as OpenPoStatus] : ""),
    },
    {
      field: "jobIds",
      headerName: "Job",
      width: 120,
      cellRenderer: JobsCell,
      filterValueGetter: (p) => p.data?.jobIds.join(" ") ?? "",
      comparator: (a: string[], b: string[]) => (a[0] ?? "").localeCompare(b[0] ?? "", undefined, { numeric: true }),
    },
    {
      field: "suppliers",
      headerName: "Supplier",
      flex: 1,
      minWidth: 180,
      valueGetter: (p) => p.data?.suppliers.join(", ") ?? "",
    },
    { field: "purchaseDate", headerName: "Ordered", width: 120, valueFormatter: (p) => fmtDate(p.value) },
    {
      field: "nextDue",
      headerName: "Next due",
      headerTooltip: "Earliest required date among lines not yet fully received",
      width: 120,
      valueFormatter: (p) => (p.value ? fmtDate(p.value) : ""),
    },
    {
      colId: "received",
      headerName: "Lines received",
      width: 140,
      valueGetter: (p) => (p.data && p.data.receiptsKnown ? `${p.data.linesReceived} of ${p.data.linesReceivable}` : "Not known"),
      comparator: (_a, _b, na, nb) =>
        (na.data ? na.data.linesReceived / Math.max(1, na.data.linesReceivable) : 0) - (nb.data ? nb.data.linesReceived / Math.max(1, nb.data.linesReceivable) : 0),
    },
    { field: "purchased", headerName: "Purchased", ...money },
    { field: "invoiced", headerName: "Invoiced", ...money },
    { field: "leftToInvoice", headerName: "Left to invoice", ...money },
  ];

  return (
    <div style={{ height: GRID_HEIGHT, width: "100%" }}>
      <AgGridReact<OpenPoRow>
        theme={sdcTheme}
        rowData={rows}
        columnDefs={columnDefs}
        getRowId={(p) => p.data.poNumber}
        defaultColDef={{ sortable: true, filter: true, resizable: true, floatingFilter: true }}
        suppressMenuHide
        pagination
        paginationPageSize={100}
        paginationPageSizeSelector={[50, 100, 200]}
        enableCellTextSelection
        animateRows
      />
    </div>
  );
}
