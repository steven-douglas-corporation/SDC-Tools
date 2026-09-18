import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  DEFAULT_FEEDBACK_STATUS,
  OPEN_FEEDBACK_STATUSES,
  type FeedbackCategory,
  type FeedbackSeverity,
  type FeedbackStatus,
} from "@/lib/feedback-status";

// ── Every read and write of the feedback table, in one place ────────────────
//
// Split from feedback-actions.ts on the hiring-positions-store.ts /
// hiring-actions.ts precedent: the actions file owns authorization, auditing
// and the realtime publish; this file owns the SQL and nothing else. The split
// is what lets scripts/feedback-smoke.ts exercise the real queries without
// going through a server action (which would need a request scope it does not
// have) and without hand-writing a second copy of them.
//
// Uses the generated Prisma client rather than raw SQL. MonthlyReportSubmission
// and the AuditLog cell columns use $executeRaw because `prisma generate`
// could not run against a live server, but that was a hotfix constraint, not a
// house rule — the real deploy path (scripts/sdc-main-updater.js) already does
// stop -> migrate deploy -> generate -> build -> start, so a new model gets a
// real client.

/** What the Flag button and the integration route both hand in. */
export type NewFeedback = {
  submittedById: number | null;
  submitterEmail: string;
  submitterName: string | null;
  sourceApp: string;
  submittedVia: "ui" | "integration";
  routePath: string | null;
  viewLabel: string | null;
  params: Record<string, string> | null;
  contextUrl: string | null;
  subjectType: string | null;
  subjectKey: string | null;
  jobId: string | null;
  periodMonth: string | null;
  employeeKey: string | null;
  fieldLabel: string | null;
  observedValue: string | null;
  expectedValue: string | null;
  body: string;
  category: FeedbackCategory;
  severity: FeedbackSeverity;
};

export type FeedbackRow = {
  id: number;
  createdAt: Date;
  updatedAt: Date;
  submitterEmail: string;
  submitterName: string | null;
  sourceApp: string;
  submittedVia: string;
  routePath: string | null;
  viewLabel: string | null;
  params: Record<string, string> | null;
  contextUrl: string | null;
  subjectType: string | null;
  subjectKey: string | null;
  jobId: string | null;
  periodMonth: string | null;
  employeeKey: string | null;
  fieldLabel: string | null;
  observedValue: string | null;
  expectedValue: string | null;
  body: string;
  category: string;
  severity: string;
  status: string;
  assignedToEmail: string | null;
  acknowledgedAt: Date | null;
  resolutionNote: string | null;
  resolvedAt: Date | null;
  resolvedByEmail: string | null;
};

// `params` is a Json column, so Prisma types it as JsonValue — anything at all.
// Narrowed once here rather than cast at each of the four render sites, and
// defensively: a row written by a future caller (or by hand) that put an array
// or a scalar there must render as "no context" rather than crash the grid.
function readParams(value: Prisma.JsonValue | null): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function toRow(r: Prisma.FeedbackGetPayload<object>): FeedbackRow {
  return { ...r, params: readParams(r.params) };
}

export async function insertFeedback(input: NewFeedback): Promise<FeedbackRow> {
  const created = await prisma.feedback.create({
    data: {
      ...input,
      status: DEFAULT_FEEDBACK_STATUS,
      params: (input.params ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
  return toRow(created);
}

export type FeedbackFilter = {
  /** A specific status, "open" for the default queue (open + ack), or null for everything. */
  status?: FeedbackStatus | "queue" | null;
  sourceApp?: string | null;
  jobId?: string | null;
  assignedToEmail?: string | null;
  /** Restricts to one person's own submissions. NOT a UI preference — see listFeedback. */
  submitterEmail?: string | null;
};

/**
 * The triage grid's one query.
 *
 * `submitterEmail` is the security-relevant argument: a caller WITHOUT
 * feedback:triage is scoped to their own rows, and that scoping is applied
 * here in the SQL rather than by filtering in the component. A grid that
 * fetched everything and hid the rest would still have shipped every
 * submitter's text to the browser, where it is one devtools tab away.
 */
export async function listFeedback(filter: FeedbackFilter = {}, limit = 500): Promise<FeedbackRow[]> {
  const where: Prisma.FeedbackWhereInput = {};

  if (filter.status === "queue") where.status = { in: [...OPEN_FEEDBACK_STATUSES] };
  else if (filter.status) where.status = filter.status;

  if (filter.sourceApp) where.sourceApp = filter.sourceApp;
  if (filter.jobId) where.jobId = filter.jobId;
  if (filter.assignedToEmail) where.assignedToEmail = filter.assignedToEmail;
  if (filter.submitterEmail) where.submitterEmail = filter.submitterEmail;

  const rows = await prisma.feedback.findMany({
    where,
    // Newest first, matching the audit log. `id` breaks ties so a page of rows
    // written inside the same millisecond (the smoke script does exactly that)
    // has a stable order instead of a nondeterministic one.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  return rows.map(toRow);
}

export async function getFeedback(id: number): Promise<FeedbackRow | null> {
  const row = await prisma.feedback.findUnique({ where: { id } });
  return row ? toRow(row) : null;
}

/** Per-status counts for the queue tabs' badges — one grouped query, not four. */
export async function countFeedbackByStatus(submitterEmail?: string | null): Promise<Record<string, number>> {
  const grouped = await prisma.feedback.groupBy({
    by: ["status"],
    _count: { _all: true },
    where: submitterEmail ? { submitterEmail } : undefined,
  });
  const out: Record<string, number> = {};
  for (const g of grouped) out[g.status] = g._count._all;
  return out;
}

export type StatusPatch = {
  status: FeedbackStatus;
  resolutionNote: string | null;
  actorEmail: string | null;
};

/**
 * Apply a triage decision. The three timestamp columns are derived here rather
 * than passed in, so "acknowledged at" can never disagree with "status = ack"
 * — and reopening genuinely clears the resolution, instead of leaving a stale
 * "Fixed on the 14th" hanging off an item that is open again.
 */
export async function updateFeedbackStatus(id: number, patch: StatusPatch): Promise<FeedbackRow> {
  const closing = patch.status === "fixed" || patch.status === "wontfix";
  const updated = await prisma.feedback.update({
    where: { id },
    data: {
      status: patch.status,
      resolutionNote: patch.resolutionNote,
      acknowledgedAt: patch.status === "open" ? null : new Date(),
      resolvedAt: closing ? new Date() : null,
      resolvedByEmail: closing ? patch.actorEmail : null,
    },
  });
  return toRow(updated);
}

export async function assignFeedbackRow(id: number, assignedToEmail: string | null): Promise<FeedbackRow> {
  const updated = await prisma.feedback.update({ where: { id }, data: { assignedToEmail } });
  return toRow(updated);
}
