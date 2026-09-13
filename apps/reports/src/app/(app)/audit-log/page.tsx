import { prisma } from "@/lib/prisma";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { AuditLogGrid } from "@/components/AuditLogGrid";
import { requirePagePermission } from "@/lib/require-permission";

// How many recent entries to load into the grid (AG Grid then sorts/filters/
// paginates them client-side).
const LOAD_LIMIT = 1000;

// ELT-only view of AuditLog — every logged data-changing action. AG Grid
// (Community) provides sort / column filters / resize / pagination
// client-side.
//
// A role check WAS dropped from here 2026-08-02 in favor of a shared
// password (audit-log-gate.ts), on the reasoning that a gate nobody could
// reach never gets corrected. That's why this one is reachable now: the real
// 2026-08-18 role system (lib/permissions.ts) is actually maintained and
// tested, unlike the ad hoc `role !== "ADMIN"` this replaces — the password
// gate is retired, not layered on top.
export async function AuditLogView() {
  await requirePagePermission("audit-log:view");
  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: LOAD_LIMIT }),
    prisma.auditLog.count(),
  ]);

  const rows = logs.map((log) => ({
    when: log.createdAt.toISOString().slice(0, 16).replace("T", " "),
    userEmail: log.userEmail ?? "—",
    action: log.action,
    entity: log.entityType ? `${log.entityType}${log.entityId ? ` #${log.entityId}` : ""}` : "—",
    summary: log.summary ?? "",
  }));

  return (
    <div className={PAGE_SHELL}>
      <PageTitle className="mb-1">Audit Log</PageTitle>
      <p className="mb-6 text-sm text-sdc-gray-600">
        Every recorded data change across the app — ETC edits, employee/job changes, Standard Sheet edits,
        month submit/reopen/refresh, and sign-ins. {total.toLocaleString()} total{" "}
        {total === 1 ? "entry" : "entries"}
        {total > LOAD_LIMIT ? ` (showing the latest ${LOAD_LIMIT.toLocaleString()})` : ""}. Sort or filter any column.
      </p>
      <AuditLogGrid rows={rows} />
    </div>
  );
}


// -- Route entry point --
//
// The page's body lives in `AuditLogView` above so that BOTH this route and the split
// view can render it. Split view renders two views in ONE document (see
// lib/split-view.ts for why one document rather than two frames), which means a
// pane cannot be a route and therefore cannot read `searchParams` - there is only
// one URL and two panes would collide in it. So the body takes its context as a
// plain argument, and the two callers differ only in where they read that context
// from: this wrapper reads the URL, a pane reads its own `l.`/`r.` namespace.
export default async function AuditLogPage() {
  return <AuditLogView />;
}
