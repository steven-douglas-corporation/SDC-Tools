"use server";

import { buildCsv } from "@/lib/export/csv";
import { buildXlsx } from "@/lib/export/xlsx";
import { exportFileName, todayStamp, type SheetColumn, type SheetSpec } from "@/lib/export/sheet";
import { logAudit } from "@/lib/audit";
import type { JobCostComputed } from "@/lib/job-cost";

// ── Job Cost Explorer export ─────────────────────────────────────────────────
//
// Reuses the same SheetSpec/csv/xlsx writers the Projects and Monthly ETC
// exports use (lib/export/{sheet,csv,xlsx}.ts) instead of the standalone
// app's CDN-loaded SheetJS script — one export pipeline app-wide, and no new
// external script dependency for this tab.
//
// A Server Action, not a route handler like /api/export/[report]: that route
// re-derives its data from the page's OWN query-string filters, which this
// page's filters (client-side useState, not URL-driven) don't have. This
// takes the exact rows/columns already computed and visible on screen —
// matching the original app's own export behavior (it always exported
// whatever was currently filtered/sorted/visible, not a server re-query) —
// and returns base64-encoded bytes for the client to turn into a download,
// the same way ExportMenu.tsx turns a fetch response into one.

const COL_DEFS: Record<string, { header: string; type: SheetColumn["type"] }> = {
  customerName: { header: "Customer", type: "text" },
  status: { header: "Status", type: "text" },
  actualHours: { header: "Act Hrs", type: "hours" },
  engineeringHours: { header: "Eng Hrs", type: "hours" },
  shopHours: { header: "Shop Hrs", type: "hours" },
  otherHours: { header: "Other Hrs", type: "hours" },
  pmCost: { header: "PM $", type: "currency" },
  mfgCost: { header: "Mfg $", type: "currency" },
  laborCost: { header: "Labor $", type: "currency" },
  etcEngHours: { header: "ETC Eng", type: "hours" },
  etcShopHours: { header: "ETC Shop", type: "hours" },
  etcPartsCost: { header: "ETC Parts", type: "currency" },
  partCost: { header: "Parts Purchased", type: "currency" },
  partInvoiced: { header: "Parts Invoiced", type: "currency" },
  percentComplete: { header: "% Complete", type: "number" },
  salesPrice: { header: "Sales $", type: "currency" },
  startDate: { header: "Start", type: "date" },
  completeDate: { header: "Complete", type: "date" },
  profit: { header: "Profit", type: "currency" },
  margin: { header: "Margin", type: "number" },
};

function cell(row: JobCostComputed, key: string): string | number | Date | null {
  const v = (row as unknown as Record<string, unknown>)[key];
  if (v == null) return null;
  if (key === "startDate" || key === "completeDate") return new Date(String(v));
  if (typeof v === "number") return v;
  return String(v);
}

export async function exportJobCostRows(
  rows: JobCostComputed[],
  visibleColumnKeys: string[],
  format: "csv" | "xlsx",
): Promise<{ base64: string; fileName: string; mime: string }> {
  const cols = visibleColumnKeys.filter((k) => COL_DEFS[k]);
  const columns: SheetColumn[] = [
    { header: "Job Id", type: "text", width: 10 },
    { header: "Job Name", type: "text", width: 32 },
    ...cols.map((k) => ({ ...COL_DEFS[k], width: 14 })),
  ];
  const specRows = rows.map((r) => [r.jobId, r.jobName, ...cols.map((k) => cell(r, k))]);
  const sum = (k: string) => rows.reduce((a, r) => a + (Number((r as unknown as Record<string, unknown>)[k]) || 0), 0);
  const totals = [`${rows.length} jobs`, "", ...cols.map((k) => (k === "startDate" || k === "completeDate" || k === "customerName" || k === "status" ? null : sum(k)))];

  const now = new Date();
  const spec: SheetSpec = {
    sheetName: "Job Cost",
    title: "Profitability",
    subtitle: [`Exported ${now.toLocaleString()}`],
    columns,
    rows: specRows,
    totals,
    freezeColumns: 2,
  };

  await logAudit({
    action: "export.download",
    entityType: "Profitability",
    summary: `Exported Profitability as ${format.toUpperCase()} — ${rows.length} row(s)`,
    metadata: { format, rows: rows.length },
  });

  const fileName = exportFileName(["Profitability", todayStamp(now)], format);
  if (format === "csv") {
    return { base64: Buffer.from(buildCsv(spec), "utf8").toString("base64"), fileName, mime: "text/csv;charset=utf-8" };
  }
  const buffer = await buildXlsx(spec);
  return { base64: buffer.toString("base64"), fileName, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
}
