import { checkSchedulerToken } from "@/lib/scheduler-api-auth";
import { prisma } from "@/lib/prisma";
import { insertFeedback } from "@/lib/feedback-store";
import { logAuditFor } from "@/lib/audit";
import {
  isFeedbackCategory,
  isFeedbackSeverity,
  DEFAULT_FEEDBACK_CATEGORY,
  DEFAULT_FEEDBACK_SEVERITY,
} from "@/lib/feedback-status";

// ── Feedback from another app in the suite ──────────────────────────────────
//
// Ships DORMANT: nothing calls it yet. It is here in phase 1 because it is the
// difference between "the Scheduler wires in later" being a client-side change
// in that repo and being a redesign in this one — and because ADR 0002 makes
// the Scheduler a separate repository, so the two halves cannot land in one
// commit anyway. Reports must deploy this one release BEFORE the Scheduler
// ships a button that calls it.
//
// Bearer-guarded exactly like every other /api/integration/* route:
// checkSchedulerToken fails closed with a 503 when SCHEDULER_SHARED_TOKEN is
// unset, so an unconfigured install refuses rather than accepting anonymous
// writes. proxy.ts already exempts this whole prefix from the browser session
// gate.
//
// ══ WHY THE IDENTITY IS RE-STAMPED HERE ═════════════════════════════════════
//
// The shared token authenticates an APP, not a person. Anything the caller
// says about WHO is filing is a claim, and is treated as one:
//
//   * `submittedVia` is set to "integration" by this handler, never read from
//     the body — a row whose identity this app did not itself verify must be
//     distinguishable from one where a NextAuth session proved it.
//   * `submittedById` is RESOLVED by looking the claimed email up in this
//     app's own User table (the same move /api/integration/revoke-session
//     makes). It is never accepted as a number from the body, because that
//     would let any caller holding the token attribute a report to any
//     account by guessing an id.
//   * A claimed email with no matching account is fine — the row keeps the
//     email as a snapshot and the FK stays null. The alternative, rejecting
//     it, would throw away a real report because the reporter happens not to
//     have a Reports login.
//
// The calling app is responsible for making sure the email it sends is its own
// session's, not its request body's. See the plan's Scheduler section.

type Body = {
  submitterEmail?: string;
  submitterName?: string;
  sourceApp?: string;
  routePath?: string;
  viewLabel?: string;
  params?: Record<string, string>;
  contextUrl?: string;
  subjectType?: string;
  subjectKey?: string;
  jobId?: string;
  periodMonth?: string;
  employeeKey?: string;
  fieldLabel?: string;
  observedValue?: string;
  expectedValue?: string;
  body?: string;
  category?: string;
  severity?: string;
};

const clamp = (v: string | undefined, max: number): string | null => {
  const s = v?.trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

export async function POST(req: Request) {
  const denied = checkSchedulerToken(req);
  if (denied) return denied;

  const payload = (await req.json().catch(() => null)) as Body | null;
  if (!payload) return Response.json({ error: "invalid_json" }, { status: 400 });

  const text = payload.body?.trim();
  if (!text) return Response.json({ error: "body_required" }, { status: 400 });

  const email = payload.submitterEmail?.trim().toLowerCase();
  if (!email) return Response.json({ error: "submitter_email_required" }, { status: 400 });

  // A claim, resolved against this app's own records — see the header.
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } }).catch(() => null);

  const row = await insertFeedback({
    submittedById: user?.id ?? null,
    submitterEmail: email,
    submitterName: clamp(payload.submitterName, 191),
    // Defaulted to "scheduler" rather than "reports": a row arriving on this
    // endpoint did not come from this app's own UI, and mislabelling it would
    // corrupt the [sourceApp, routePath] rollup this index exists for.
    sourceApp: clamp(payload.sourceApp, 32) ?? "scheduler",
    submittedVia: "integration",
    routePath: clamp(payload.routePath, 128),
    viewLabel: clamp(payload.viewLabel, 64),
    params: payload.params && Object.keys(payload.params).length > 0 ? payload.params : null,
    contextUrl: clamp(payload.contextUrl, 512),
    subjectType: clamp(payload.subjectType, 24),
    subjectKey: clamp(payload.subjectKey, 64),
    jobId: clamp(payload.jobId, 20),
    periodMonth: clamp(payload.periodMonth, 7),
    employeeKey: clamp(payload.employeeKey, 32),
    fieldLabel: clamp(payload.fieldLabel, 64),
    observedValue: clamp(payload.observedValue, 191),
    expectedValue: clamp(payload.expectedValue, 191),
    body: text.length > 10_000 ? `${text.slice(0, 9_999)}…` : text,
    category: isFeedbackCategory(payload.category ?? "") ? (payload.category as never) : DEFAULT_FEEDBACK_CATEGORY,
    severity: isFeedbackSeverity(payload.severity ?? "") ? (payload.severity as never) : DEFAULT_FEEDBACK_SEVERITY,
  });

  // logAuditFor, not logAudit: there is no NextAuth session on this path, and
  // auth() would throw reading headers outside a request scope the same way
  // the auto-sync pass does. The caller's identity is what we just resolved.
  await logAuditFor(user?.id ?? null, email, {
    action: "feedback.submitted",
    entityType: "Feedback",
    entityId: row.id,
    summary: `Feedback from ${row.sourceApp}: ${row.body}`,
    metadata: { sourceApp: row.sourceApp, routePath: row.routePath, submittedVia: "integration" },
  });

  return Response.json({ ok: true, id: row.id });
}
