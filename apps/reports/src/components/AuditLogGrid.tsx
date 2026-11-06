"use client";

import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";

export type AuditRow = {
  when: string;
  userEmail: string;
  action: string;
  entity: string;
  summary: string;
};

// The latest entries, newest first, in pages (the page loads up to 1,000). Was an AG Grid
// until 2026-11-06; see components/ui/DataTable.tsx for why.
const COLUMNS: DataTableColumn<AuditRow>[] = [
  { id: "when", header: "When", value: (r) => r.when, width: "150px" },
  { id: "user", header: "User", value: (r) => r.userEmail, width: "220px" },
  { id: "action", header: "Action", value: (r) => r.action, width: "220px", className: "font-mono" },
  { id: "entity", header: "Entity", value: (r) => r.entity, width: "160px" },
  { id: "summary", header: "Summary", value: (r) => r.summary, wrap: true },
];

export function AuditLogGrid({ rows }: { rows: AuditRow[] }) {
  return (
    <DataTable
      rows={rows}
      columns={COLUMNS}
      label="Audit log"
      defaultSort={{ id: "when", dir: "desc" }}
      paging="pages"
      searchPlaceholder="Search user, action, entity or summary…"
      emptyText="No entries yet."
    />
  );
}
