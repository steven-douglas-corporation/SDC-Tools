import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { APP_VERSION } from "@/lib/app-version";
import { buildCsv } from "@/lib/export/csv";
import { buildXlsx } from "@/lib/export/xlsx";
import { exportFileName, todayStamp } from "@/lib/export/sheet";
import { buildPartsBudgetSheet, parsePartsBudgetQuery } from "@/lib/export/parts-budget-export";
import { loadPartsBudgetAnalysis } from "@/lib/parts-budget-analysis";
import { requireApiPermission } from "@/lib/require-permission";

// ── GET /api/export/parts-budget?format=xlsx|csv&status=&band=&focus=&q=&sort=&dir= ─────────────────────
//
// The Dashboard's Projection vs Budget table, as a file. The browser sends the FILTER it is looking at,
// never rows: the rows are re-read here from the same analysis the Dashboard shows, so the file holds
// exactly what the table shows and nothing a signed-in user could not already open.
//
// Same permission as the Job Details page every row links to (job-hour-details:view), and the same one
// the Finances section requires — the export is not a back door around either.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await auth();
  const permissionDenied = requireApiPermission(session, "job-hour-details:view");
  if (permissionDenied) return permissionDenied;

  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format") === "csv" ? "csv" : "xlsx";
  const now = new Date();

  try {
    const analysis = await loadPartsBudgetAnalysis();
    if (analysis.state !== "ok") {
      return new Response("The projection figures could not be loaded right now. Try again in a moment.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    const query = parsePartsBudgetQuery({
      status: searchParams.get("status") ?? undefined,
      band: searchParams.get("band") ?? undefined,
      focus: searchParams.get("focus") ?? undefined,
      q: searchParams.get("q") ?? undefined,
      sort: searchParams.get("sort") ?? undefined,
      dir: searchParams.get("dir") ?? undefined,
    });
    const { spec, rowCount, fileLabel } = buildPartsBudgetSheet(analysis.rows, query, analysis.asOf, now);
    const fileName = exportFileName(["Parts_vs_Budget", fileLabel, todayStamp(now)], format);

    // Awaited, like every export route: a download is a data egress and the record is the point.
    await logAudit({
      action: "export.download",
      entityType: "Dashboard",
      entityId: "parts-budget",
      summary: `Exported Parts Cost vs Budget as ${format.toUpperCase()} — ${rowCount} row(s)`,
      metadata: {
        report: "parts-budget",
        format,
        rows: rowCount,
        filters: { status: query.status, band: query.band, focus: query.focus, q: query.q || null },
        appVersion: APP_VERSION,
      },
    });

    if (format === "csv") {
      return new Response(buildCsv(spec), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Cache-Control": "no-store",
        },
      });
    }
    const buffer = await buildXlsx(spec);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "The export could not be generated.";
    console.error("[export] parts-budget failed", format, err);
    return new Response(message, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
