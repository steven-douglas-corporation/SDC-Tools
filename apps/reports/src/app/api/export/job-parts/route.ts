import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { APP_VERSION } from "@/lib/app-version";
import { buildJobPartsSheetSpec } from "@/lib/export/job-parts-export";
import { buildCsv } from "@/lib/export/csv";
import { buildXlsx } from "@/lib/export/xlsx";
import { exportFileName, todayStamp } from "@/lib/export/sheet";
import { requireApiPermission } from "@/lib/require-permission";

// ── POST /api/export/job-parts?format=xlsx|csv (§Job Parts) ─────────────────
//
// A POST, unlike every other report under /api/export/[report]: those re-derive
// their rows from the database using filters carried in the URL's own query
// string, because their filters live there too (Projects, Monthly ETC, Hours).
// The Job Details Parts List filters entirely in the browser — see
// job-parts-export.ts's own header — so there is no server-side filter to point
// this at. The browser sends the rows it is already showing instead, in the
// request body; this route's only job is to turn that into the same CSV/XLSX a
// page-driven export produces, and to log the same audit trail.
//
// Same permission the Job Details page itself requires — job-hour-details:view,
// see job-hours/page.tsx's own requirePagePermission call — so the export is
// not a back door around the page guard.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await auth();
  const permissionDenied = requireApiPermission(session, "job-hour-details:view");
  if (permissionDenied) return permissionDenied;

  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format") === "csv" ? "csv" : "xlsx";
  const now = new Date();

  try {
    const body = await req.json();
    const { spec, rowCount, tab, jobId } = buildJobPartsSheetSpec(body, now);
    const tabLabel = tab === "parts" ? "Parts List" : "Assemblies";

    const fileName = exportFileName(["Job", jobId, tabLabel.replace(" ", "_"), todayStamp(now)], format);

    // Awaited, same as every other export route — an export is a data egress and
    // the record is the point (see [report]/route.ts's own §24.11 note).
    await logAudit({
      action: "export.download",
      entityType: "Job",
      entityId: jobId,
      summary: `Exported Job ${jobId} ${tabLabel} as ${format.toUpperCase()} — ${rowCount} row(s)`,
      metadata: { report: "job-parts", tab, format, rows: rowCount, appVersion: APP_VERSION },
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
    // Uint8Array, not the Node Buffer — see [report]/route.ts's own note on why.
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "The export could not be generated.";
    console.error("[export] job-parts failed", format, err);
    return new Response(message, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
