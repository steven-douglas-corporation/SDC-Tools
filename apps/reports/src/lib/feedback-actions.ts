"use server";

import { revalidatePath } from "next/cache";
import { assertActionPermission } from "@/lib/require-permission";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import {
  insertFeedback,
  updateFeedbackStatus,
  assignFeedbackRow,
  getFeedback,
  type NewFeedback,
} from "@/lib/feedback-store";
import {
  canTransition,
  isFeedbackStatus,
  isFeedbackCategory,
  isFeedbackSeverity,
  DEFAULT_FEEDBACK_CATEGORY,
  DEFAULT_FEEDBACK_SEVERITY,
  FEEDBACK_STATUS_LABELS,
  type FeedbackStatus,
} from "@/lib/feedback-status";

// ── The write paths for feedback (2026-09-17) ───────────────────────────────
//
// Two permissions, deliberately split: `feedback:submit` gates filing, and
// `feedback:triage` gates every decision ABOUT a filing — status, assignment,
// and the reply the submitter reads. Every call is audited through the
// existing AuditLog (logAudit), following the precedent hiring-actions.ts
// states outright: no separate feedback-specific audit table.
//
// Authorization lives here rather than in feedback-store.ts so there is one
// obvious layer to read when asking "who can do this", and so the smoke script
// can exercise the queries without a request scope.

export type FeedbackResult = { ok: true; id: number } | { ok: false; error: string };

// VARCHAR(191) on the free-text-ish columns, VARCHAR(1000) on resolutionNote.
// Truncating here rather than letting MySQL refuse the INSERT (P2000): losing
// the tail of a long pasted value is a much better outcome than losing the
// whole report, which is the same call lib/audit.ts makes for `summary`.
const SHORT_MAX = 191;
const NOTE_MAX = 1000;
const BODY_MAX = 10_000;

function clamp(value: string | null | undefined, max: number): string | null {
  const v = value?.trim();
  if (!v) return null;
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

/** What the Flag drawer posts. Context fields are captured, not typed. */
export type SubmitFeedbackInput = {
  body: string;
  category?: string;
  severity?: string;
  routePath?: string | null;
  viewLabel?: string | null;
  params?: Record<string, string> | null;
  contextUrl?: string | null;
  subjectType?: string | null;
  subjectKey?: string | null;
  jobId?: string | null;
  periodMonth?: string | null;
  employeeKey?: string | null;
  fieldLabel?: string | null;
  observedValue?: string | null;
  expectedValue?: string | null;
};

export async function submitFeedback(input: SubmitFeedbackInput): Promise<FeedbackResult> {
  const session = await assertActionPermission("feedback:submit");

  const body = input.body?.trim();
  if (!body) return { ok: false, error: "Say what's wrong before sending." };

  const email = session.user.email;
  if (!email) return { ok: false, error: "We couldn't tell who you are — sign in again." };

  const record: NewFeedback = {
    submittedById: session.user.id ? Number(session.user.id) : null,
    submitterEmail: email,
    submitterName: session.user.name ?? null,
    sourceApp: "reports",
    submittedVia: "ui",
    routePath: clamp(input.routePath, 128),
    viewLabel: clamp(input.viewLabel, 64),
    params: input.params && Object.keys(input.params).length > 0 ? input.params : null,
    contextUrl: clamp(input.contextUrl, 512),
    subjectType: clamp(input.subjectType, 24),
    subjectKey: clamp(input.subjectKey, 64),
    jobId: clamp(input.jobId, 20),
    periodMonth: clamp(input.periodMonth, 7),
    employeeKey: clamp(input.employeeKey, 32),
    fieldLabel: clamp(input.fieldLabel, 64),
    observedValue: clamp(input.observedValue, SHORT_MAX),
    expectedValue: clamp(input.expectedValue, SHORT_MAX),
    body: body.length > BODY_MAX ? `${body.slice(0, BODY_MAX - 1)}…` : body,
    // An unrecognised value falls back to the default rather than being
    // rejected: the column is a VARCHAR, so a stale client posting a category
    // this build doesn't know about should still get its report filed.
    category: isFeedbackCategory(input.category ?? "") ? (input.category as never) : DEFAULT_FEEDBACK_CATEGORY,
    severity: isFeedbackSeverity(input.severity ?? "") ? (input.severity as never) : DEFAULT_FEEDBACK_SEVERITY,
  };

  const row = await insertFeedback(record);

  await logAudit({
    action: "feedback.submitted",
    entityType: "Feedback",
    entityId: row.id,
    summary: `Feedback on ${row.viewLabel ?? row.routePath ?? "the app"}${row.jobId ? ` (job ${row.jobId})` : ""}: ${row.body}`,
    metadata: { routePath: row.routePath, params: row.params, category: row.category, severity: row.severity },
  });

  revalidatePath("/feedback");
  return { ok: true, id: row.id };
}

export async function setFeedbackStatus(
  id: number,
  status: string,
  resolutionNote?: string | null,
): Promise<FeedbackResult> {
  const session = await assertActionPermission("feedback:triage");
  if (!isFeedbackStatus(status)) return { ok: false, error: `"${status}" isn't a status.` };

  const before = await getFeedback(id);
  if (!before) return { ok: false, error: "That feedback no longer exists." };

  const from: FeedbackStatus = isFeedbackStatus(before.status) ? before.status : "open";
  const note = clamp(resolutionNote, NOTE_MAX);

  // The same check the drawer uses to disable the button, so a refusal here is
  // never a surprise — and so a direct call (a stale tab, a scripted client)
  // cannot close an item without the explanation the submitter is owed.
  const allowed = canTransition(from, status, note ?? before.resolutionNote);
  if (!allowed.ok) return { ok: false, error: allowed.error };

  const row = await updateFeedbackStatus(id, {
    status,
    // Keep the existing note when the caller sends none — reopening clears the
    // timestamps (see the store) but the history of what was said stays.
    resolutionNote: note ?? before.resolutionNote,
    actorEmail: session.user.email ?? null,
  });

  await logAudit({
    action: "feedback.statusChanged",
    entityType: "Feedback",
    entityId: id,
    summary: `Feedback #${id}: ${FEEDBACK_STATUS_LABELS[from]} → ${FEEDBACK_STATUS_LABELS[status]}`,
    metadata: { from, to: status, resolutionNote: row.resolutionNote },
  });

  revalidatePath("/feedback");
  return { ok: true, id };
}

export async function assignFeedback(id: number, assignedToEmail: string | null): Promise<FeedbackResult> {
  // The session is not read here — assignment records WHO the work is for, not
  // who handed it over; that attribution is the audit entry below. The guard is
  // still the point of the call.
  await assertActionPermission("feedback:triage");

  const before = await getFeedback(id);
  if (!before) return { ok: false, error: "That feedback no longer exists." };

  const target = clamp(assignedToEmail, SHORT_MAX);
  // Assigning to a stranger produces a queue nobody is watching, so the target
  // has to be a real account here. Null is always allowed — that's unassigning.
  if (target) {
    const exists = await prisma.user.findUnique({ where: { email: target }, select: { id: true } });
    if (!exists) return { ok: false, error: `${target} doesn't have an SDC Reports account.` };
  }

  await assignFeedbackRow(id, target);

  await logAudit({
    action: "feedback.assigned",
    entityType: "Feedback",
    entityId: id,
    summary: target ? `Feedback #${id} assigned to ${target}` : `Feedback #${id} unassigned`,
    metadata: { from: before.assignedToEmail, to: target },
  });

  revalidatePath("/feedback");
  return { ok: true, id };
}

// ── Why there is no realtime broadcast here ─────────────────────────────────
//
// The first draft published each submission and status change through
// lib/realtime-hub.ts, so a triager watching the queue would see a report
// arrive without reloading. That was removed on 2026-09-17, when feedback:view
// became MANAGER-only, because the hub cannot target:
//
//   publishChanges() broadcasts to EVERY connected session by design — its own
//   comment says so, and for an ETC cell edit that is right, because everyone
//   looking at that month needs the new number.
//
// Feedback is not that. Announcing "Dana filed feedback on Job Details" to
// every signed-in user tells the four roles that cannot open /feedback about
// something they can neither see nor act on, and quietly puts who-complained-
// about-what in front of them. It also narrated the submitter's own action
// back at them, on top of the confirmation toast they had just been shown.
//
// revalidatePath("/feedback") above already means the queue is current for
// anyone who navigates to it. If live updates are wanted later, the fix is a
// permission-scoped channel in realtime-hub — not a broadcast to everyone.
