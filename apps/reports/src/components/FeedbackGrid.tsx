"use client";

import { useState } from "react";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { FeedbackDetailDrawer, type FeedbackDetail } from "@/components/FeedbackDetailDrawer";
import {
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_STATUS_VARIANT,
  FEEDBACK_SEVERITY_LABELS,
  FEEDBACK_CATEGORY_LABELS,
  isFeedbackStatus,
  isFeedbackSeverity,
  isFeedbackCategory,
} from "@/lib/feedback-status";

// The feedback queue. Was an AG Grid until 2026-11-06 (see components/ui/DataTable.tsx).
//
// Field, Shows, Should be and Response are not columns any more: they were the least-read
// of fourteen, and the drawer a row opens shows all four in full. What stays is what a
// triager scans by (status, urgency, kind, which view / job / month, who) and what they said.

export type FeedbackGridRow = {
  id: number;
  when: string;
  status: string;
  severity: string;
  category: string;
  view: string;
  context: string;
  job: string;
  period: string;
  field: string;
  observed: string;
  expected: string;
  submitter: string;
  assigned: string;
  summary: string;
  response: string;
  contextUrl: string | null;
};

// A raw key would read as "wontfix"/"ack". Falling back to the raw value rather than
// blanking it keeps a row written by a newer build (or by hand) legible.
const labelStatus = (v: string) => (isFeedbackStatus(v) ? FEEDBACK_STATUS_LABELS[v] : v);
const labelSeverity = (v: string) => (isFeedbackSeverity(v) ? FEEDBACK_SEVERITY_LABELS[v] : v);
const labelCategory = (v: string) => (isFeedbackCategory(v) ? FEEDBACK_CATEGORY_LABELS[v] : v);

const COLUMNS: DataTableColumn<FeedbackGridRow>[] = [
  { id: "when", header: "When", value: (r) => r.when, width: "140px" },
  {
    id: "status",
    header: "Status",
    value: (r) => labelStatus(r.status),
    width: "130px",
    render: (r) => (isFeedbackStatus(r.status) ? <StatusBadge variant={FEEDBACK_STATUS_VARIANT[r.status]}>{FEEDBACK_STATUS_LABELS[r.status]}</StatusBadge> : r.status),
  },
  { id: "severity", header: "Urgency", value: (r) => labelSeverity(r.severity), width: "100px" },
  { id: "category", header: "Kind", value: (r) => labelCategory(r.category), width: "130px" },
  { id: "view", header: "View", value: (r) => r.view, width: "140px" },
  { id: "job", header: "Job", value: (r) => r.job, width: "80px" },
  { id: "period", header: "Period", value: (r) => r.period, width: "90px" },
  { id: "submitter", header: "From", value: (r) => r.submitter, width: "170px" },
  { id: "assigned", header: "Assigned", value: (r) => r.assigned, width: "170px" },
  {
    id: "summary",
    header: "What they said",
    value: (r) => r.summary,
    wrap: true,
    // The captured filters, on hover: too long for a column, too useful to drop.
    title: (r) => (r.context ? `Context: ${r.context}` : undefined),
  },
];

export function FeedbackGrid({
  rows,
  details,
  canTriage,
}: {
  rows: FeedbackGridRow[];
  /** The full record per row, so opening one costs no round trip. */
  details: Record<number, FeedbackDetail>;
  canTriage: boolean;
}) {
  const [openId, setOpenId] = useState<number | null>(null);
  const open = openId != null ? details[openId] : null;

  return (
    <>
      {/* Every row opens: a submitter needs to read the response as much as a triager
          needs to write it. What differs inside the drawer is whether the controls are
          there, not whether it opens. */}
      <DataTable
        rows={rows}
        columns={COLUMNS}
        rowKey={(r) => r.id}
        label="Feedback"
        defaultSort={{ id: "when", dir: "desc" }}
        paging="more"
        searchPlaceholder="Search view, job, person or what they said…"
        onRowClick={(r) => setOpenId(r.id)}
      />
      {open && <FeedbackDetailDrawer item={open} canTriage={canTriage} onClose={() => setOpenId(null)} />}
    </>
  );
}
