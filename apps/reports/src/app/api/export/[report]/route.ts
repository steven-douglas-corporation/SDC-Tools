import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { APP_VERSION } from "@/lib/app-version";
import { buildTmHoursExport } from "@/lib/export/tm-hours-export";
import { buildCsv } from "@/lib/export/csv";
import { buildXlsx } from "@/lib/export/xlsx";
import { exportFileName, todayStamp, type SheetSpec } from "@/lib/export/sheet";
import { buildProjectsExport } from "@/lib/export/projects-export";
import { buildEtcExport } from "@/lib/export/etc-export";
import { buildHoursExport } from "@/lib/export/hours-export";
import { buildStandardExportSheets } from "@/lib/export/standard-export";
import { isStandardSheetUnlocked } from "@/lib/standard-sheet-gate";
import { requireApiPermission } from "@/lib/require-permission";
import type { Permission } from "@/lib/permissions";

// ── The export endpoint (§24) ────────────────────────────────────────────────
//
// GET /api/export/projects?format=xlsx&<the page's own query string>
// GET /api/export/etc?format=csv&month=2026-07&billables=Billable
//
// A route handler rather than a server action, because the browser has to receive a FILE:
// a plain <a download> or window.location assignment gets the Content-Disposition and
// the OS save dialog for free, with no blob juggling and no risk of the page navigating
// away from the manager's filters (§24.12).
//
// It takes the page's OWN query string. That is what makes "the export matches what I am
// looking at" true by construction rather than by re-deriving the filters here — the
// filter rules live in lib/projects-query.ts, which the page uses too.
//
// ── Security (§24.11) ────────────────────────────────────────────────────────
//
// Authenticated here, server-side, not trusted from the caller: this is a public URL
// (the app's own proxy/middleware covers pages, and a route handler must still say no
// itself). Everything it can return is data the signed-in user can already see on the
// two pages, and the builders deliberately select fields rather than dumping rows — no
// internal ids, no sync bookkeeping, no tokens.
//
// The one thing the browser IS trusted with is the FILTER, and that is safe by design:
// a filter can only ever narrow what a signed-in user could already fetch by clicking.
//
// ── The Standards exception ──────────────────────────────────────────────────
//
// The sentence above stops being true for the Standard Sheet and Standard Fees figures:
// those are NOT data every signed-in user can already see. They're gated by the
// standards:view permission (Sales/ELT only), so the export has to make the same
// decision the page makes, and make it the same way.
//
// The authority is `isStandardSheetUnlocked()` — the same role check etc/page.tsx uses to
// decide whether to render the figures at all and that every Standard Sheet mutation
// asserts. It reads the signed-in session, so there is nothing the caller needs to attach.
//
// Three things this deliberately does NOT do:
//   * It does not accept an "include standards" parameter. A caller-supplied flag would
//     make the client the authority on its own permissions, which is the whole bug class
//     this is avoiding — and it would put the fact in the URL and therefore in the audit
//     record's `filters`. The cookie is the only input.
//   * It does not consult whether the Standard UI is currently VISIBLE. Visibility is the
//     §76 `hidden` display toggle in lib/standards-reveal.ts, a client-side module store
//     that explicitly is not a security boundary — a user can be unlocked with the
//     columns hidden, and hiding them must not silently change what a deliberate export
//     contains.
//   * It never touches the password itself. The phrase is compared only inside
//     standard-sheet-gate.ts; it is not a parameter, is not logged, and is not written
//     into the workbook. What lands in the audit record is one boolean — whether the
//     protected sheets were included — which is exactly what an egress record needs and
//     nothing more.
//
// A locked (or signed-in-but-never-unlocked) caller hitting this URL directly gets the
// ordinary Monthly ETC export, ending at Parts Cost, byte for byte as before.

export const dynamic = "force-dynamic";

const REPORTS = new Set(["projects", "etc", "hours", "tm-hours"]);

// Same permission the corresponding page itself requires (requirePagePermission
// in each page.tsx) — the export must not be a back door around the page guard.
const REPORT_PERMISSION: Record<string, Permission> = {
  projects: "projects:view",
  etc: "monthly-etc:view",
  hours: "hours:view",
  "tm-hours": "tm:view",
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ report: string }> }) {
  const session = await auth();
  if (!session?.user) {
    return new Response("Not signed in.", { status: 401 });
  }

  const { report } = await ctx.params;
  if (!REPORTS.has(report)) {
    return new Response(`Unknown report "${report}".`, { status: 404 });
  }

  const permissionDenied = requireApiPermission(session, REPORT_PERMISSION[report]);
  if (permissionDenied) return permissionDenied;

  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format") === "csv" ? "csv" : "xlsx";
  const now = new Date();

  try {
    const built =
      report === "projects"
        ? await buildProjectsExport(
            {
              customers: searchParams.get("customers") ?? undefined,
              types: searchParams.get("types") ?? undefined,
              statuses: searchParams.get("statuses") ?? undefined,
              billables: searchParams.get("billables") ?? undefined,
              sort: searchParams.get("sort") ?? undefined,
              dir: searchParams.get("dir") ?? undefined,
              dateField: searchParams.get("dateField") ?? undefined,
              from: searchParams.get("from") ?? undefined,
              to: searchParams.get("to") ?? undefined,
            },
            now,
          )
        : report === "tm-hours"
          ? // One Hours card's drill, including its search box (`q`). Unlike the
            // three reports below, the narrowing text is NOT in the page URL —
            // it is client state in the drill panel — so the panel sends it and
            // lib/tm-drill-search.ts applies the same predicate on both sides.
            await buildTmHoursExport(
              {
                key: searchParams.get("key") ?? undefined,
                jobs: searchParams.get("jobs") ?? undefined,
                from: searchParams.get("from") ?? undefined,
                to: searchParams.get("to") ?? undefined,
                q: searchParams.get("q") ?? undefined,
              },
              now,
            )
          : report === "hours"
            ? // The page's OWN query string, verbatim — same guarantee as Projects
              // above: the filter/sort/group-by rules live in hours-filters.ts,
              // which the page uses too, so there is no second copy of "what does
              // this URL mean" to drift from it.
            await buildHoursExport(
              {
                jobs: searchParams.get("jobs") ?? undefined,
                employees: searchParams.get("employees") ?? undefined,
                sections: searchParams.get("sections") ?? undefined,
                departments: searchParams.get("departments") ?? undefined,
                from: searchParams.get("from") ?? undefined,
                to: searchParams.get("to") ?? undefined,
                groupBy: searchParams.get("groupBy") ?? undefined,
                sort: searchParams.get("sort") ?? undefined,
                dir: searchParams.get("dir") ?? undefined,
              },
              now,
            )
            : await buildEtcExport(
                searchParams.get("month") ?? "",
                searchParams.get("billables") ?? undefined,
                now,
              );

    // The protected sheets ride along in the same file, and only for a request that
    // proves it is unlocked. buildEtcExport has already rejected an invalid month by
    // this point, so the same string is safe to reuse.
    const sheets: SheetSpec[] = [built.spec];
    let includedStandards = false;
    if (report === "etc" && (await isStandardSheetUnlocked())) {
      sheets.push(...(await buildStandardExportSheets(searchParams.get("month") ?? "", now)));
      includedStandards = true;
    }

    const fileName =
      report === "tm-hours"
        ? // The card's own name in the file name — a folder of these is otherwise
          // five identical "T&M" files. Spaces out, so it is a clean download name.
          exportFileName(["T&M", (built as unknown as { cardLabel: string }).cardLabel.replace(/ /g, "_"), todayStamp(now)], format)
        : report === "projects"
        ? exportFileName(["Projects", (built as unknown as { filterLabel: string }).filterLabel, todayStamp(now)], format)
        : report === "hours"
          ? exportFileName(["Hours", todayStamp(now)], format)
          : exportFileName(["Monthly_ETC", (built as unknown as { monthLabel: string }).monthLabel.replace(" ", "_"), todayStamp(now)], format);

    const reportLabel =
      report === "projects" ? "Projects" : report === "hours" ? "Hours" : report === "tm-hours" ? `T&M ${(built as unknown as { cardLabel: string }).cardLabel}` : "Monthly ETC";

    // The audit record §24.11 asks for: who, what, which format, which filters, when,
    // how many rows, which app version. Awaited rather than fired-and-forgotten — an
    // export is a data egress and the record is the point. `standards` is part of that:
    // an export carrying confidential figures has to be distinguishable afterward from
    // one that did not.
    await logAudit({
      action: "export.download",
      entityType: report === "projects" ? "Job" : report === "hours" || report === "tm-hours" ? "JobHoursDetail" : "EtcMonth",
      entityId: report === "etc" ? (searchParams.get("month") ?? "") : undefined,
      summary: `Exported ${reportLabel} as ${format.toUpperCase()} — ${built.rowCount} row(s)` + (includedStandards ? " (including Standards)" : ""),
      metadata: {
        report,
        format,
        rows: built.rowCount,
        appVersion: APP_VERSION,
        // Whether the protected sheets went out. A boolean — never the password, and
        // never anything the caller could have set.
        standards: includedStandards,
        // The query string as given, so "which view was this" is answerable exactly.
        filters: Object.fromEntries(searchParams.entries()),
      },
    });

    if (format === "csv") {
      return new Response(buildCsv(sheets), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const buffer = await buildXlsx(sheets);
    // Uint8Array, not the Node Buffer: a Response body wants a web-stream-compatible
    // value, and handing it a Buffer works by accident of Buffer being a Uint8Array —
    // being explicit keeps it working if that ever stops being true.
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    // A readable message, because the client shows it (§24.13.23). Logged too: an
    // export that fails silently in a download iframe is invisible otherwise.
    const message = err instanceof Error ? err.message : "The export could not be generated.";
    console.error("[export] failed", report, format, err);
    return new Response(message, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
