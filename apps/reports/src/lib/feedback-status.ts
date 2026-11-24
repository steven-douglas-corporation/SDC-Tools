// ── The feedback triage vocabulary ──────────────────────────────────────────
//
// Dependency-free at RUNTIME (no React, no Prisma) for the same reason
// permissions.ts and split-view.ts are: `tsx --test` loads it directly, and it
// has to be readable from a server action, a route handler, a server component
// and a client grid renderer without dragging any of those environments'
// assumptions into the others.
//
// The one import below is `import type` from a .tsx file, which TypeScript
// erases entirely — no component, and no React, is pulled in at runtime. It is
// here rather than a hand-copied union because a StatusVariant that drifts out
// of step with StatusBadge's own keys would be a badge that renders unstyled,
// and the compiler should catch that rather than a reviewer.
//
// ── Why these four, and why they are strings in MySQL ───────────────────────
//
// Four states, because the question a submitter actually asks is "did anyone
// look at this, and what happened":
//
//   open     nobody has picked it up yet. The default, and the queue.
//   ack      a triager has read it and accepted it as real work.
//   fixed    the underlying data or report was corrected.
//   wontfix  deliberately closed without a change — the number was right, or
//            the report is behaving as designed. NOT a rejection of the
//            person, which is why resolutionNote is required to reach it
//            (see canTransition) — closing in silence is how a feedback
//            channel dies.
//
// Stored as VARCHAR, not a MySQL enum. Migration 20260901120000 records how
// expensive widening two enum columns was, and this vocabulary is the kind
// that grows ("duplicate", "needs-info"). The repo already prefers this —
// CashFlowSnapshotLine.flowType and AuditLog.changeType are both plain
// strings with their vocabulary pinned in TypeScript instead of in the DDL.
// This module IS that pin: the database will hold whatever it is handed, so
// isFeedbackStatus() at every write boundary is what actually constrains it.

import type { StatusVariant } from "@/components/ui/StatusBadge";
import { toolForPath } from "@/lib/tools";

export const FEEDBACK_STATUSES = ["open", "ack", "fixed", "wontfix"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const DEFAULT_FEEDBACK_STATUS: FeedbackStatus = "open";

/** The words a human reads. Never render a raw status key. */
export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  open: "Open",
  ack: "Acknowledged",
  fixed: "Fixed",
  wontfix: "Won't fix",
};

// Reuses the existing StatusBadge palette rather than introducing a fifth set
// of pill colours — `needsReview` (yellow) is already what the app means by
// "somebody has to look at this", which is exactly what an open item is.
export const FEEDBACK_STATUS_VARIANT: Record<FeedbackStatus, StatusVariant> = {
  open: "needsReview",
  ack: "active",
  fixed: "complete",
  wontfix: "locked",
};

/** Statuses that still want a triager's attention — the default queue filter. */
export const OPEN_FEEDBACK_STATUSES: readonly FeedbackStatus[] = ["open", "ack"];

export const isOpenFeedbackStatus = (s: FeedbackStatus): boolean => OPEN_FEEDBACK_STATUSES.includes(s);

/** Narrows an arbitrary string — a URL filter value, a form field, a JSON body. */
export function isFeedbackStatus(value: string): value is FeedbackStatus {
  return (FEEDBACK_STATUSES as readonly string[]).includes(value);
}

export type TransitionCheck = { ok: true } | { ok: false; error: string };

/**
 * Whether a triager may move an item from `from` to `to`.
 *
 * Deliberately permissive about DIRECTION — a "fixed" item that turns out not
 * to be fixed must be reopenable, and there is no workflow value in forcing
 * someone to walk back through "ack" to get there. What it is strict about is
 * the one thing the submitter experiences:
 *
 *   REACHING A CLOSED STATE REQUIRES A WRITTEN NOTE.
 *
 * "Fixed" with no explanation is indistinguishable from "ignored" to the
 * person who filed it, and this feature exists precisely because managers
 * currently have nowhere that answers back. The rule is enforced here, in the
 * one dependency-free place both the server action and the drawer's disabled
 * state can read it, so the button greys out for the same reason the action
 * would have refused rather than the two drifting apart.
 */
export function canTransition(
  from: FeedbackStatus,
  to: FeedbackStatus,
  resolutionNote?: string | null,
): TransitionCheck {
  if (from === to) return { ok: false, error: `Already ${FEEDBACK_STATUS_LABELS[to].toLowerCase()}.` };
  if ((to === "fixed" || to === "wontfix") && !resolutionNote?.trim()) {
    return { ok: false, error: `Add a note saying what happened before marking this ${FEEDBACK_STATUS_LABELS[to].toLowerCase()}.` };
  }
  return { ok: true };
}

// ── Category and severity, same treatment ───────────────────────────────────
//
// Category exists so the data-accuracy reports — the ones this feature was
// asked for — can be filtered away from the bugs and wishes that will
// inevitably arrive through the same box. Defaulting to "data-accuracy"
// rather than to a generic "other" is deliberate: it is what the button is
// for, and a default that matches the common case is one fewer field to fill.

export const FEEDBACK_CATEGORIES = ["data-accuracy", "bug", "enhancement", "question"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const DEFAULT_FEEDBACK_CATEGORY: FeedbackCategory = "data-accuracy";

export const FEEDBACK_CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  "data-accuracy": "A number is wrong",
  bug: "Something is broken",
  enhancement: "Suggestion",
  question: "Question",
};

export function isFeedbackCategory(value: string): value is FeedbackCategory {
  return (FEEDBACK_CATEGORIES as readonly string[]).includes(value);
}

// Three levels, not five. "How wrong is it" only has to separate the three
// responses a triager can actually give: drop everything, fix it this week,
// fix it when convenient. A finer scale just moves the argument from the
// queue to the dropdown.
export const FEEDBACK_SEVERITIES = ["blocking", "wrong", "cosmetic"] as const;
export type FeedbackSeverity = (typeof FEEDBACK_SEVERITIES)[number];

export const DEFAULT_FEEDBACK_SEVERITY: FeedbackSeverity = "wrong";

export const FEEDBACK_SEVERITY_LABELS: Record<FeedbackSeverity, string> = {
  blocking: "Can't work",
  wrong: "Wrong number",
  cosmetic: "Minor",
};

// ── Which tool a report is about (2026-11-23) ───────────────────────────────
//
// The Flag button is on every page, and the app is no longer only Reports. A report is tagged
// with the tool whose page it was filed from, so the queue can tell "this number is wrong"
// from "this card will not save". `sourceApp` was always a free string (the Scheduler files
// through the integration route as "scheduler"), so this needs no migration: reports filed
// before this change are all "reports", which is what they were.

/** The `sourceApp` for a report filed from a page of this app. */
export function feedbackSourceFor(routePath: string | null | undefined): string {
  return routePath && toolForPath(routePath) === "tracker" ? "tracker" : "reports";
}

const FEEDBACK_SOURCE_LABELS: Record<string, string> = {
  reports: "Reports",
  tracker: "Internal Projects",
  scheduler: "Scheduler",
};

/** A `sourceApp` as a person reads it. One nobody has named is shown as it is. */
export function feedbackSourceLabel(sourceApp: string): string {
  return FEEDBACK_SOURCE_LABELS[sourceApp] ?? sourceApp;
}

/**
 * An urgency as a person reads it. The middle one is "Wrong number" in Reports, where that is
 * what it nearly always is; anywhere else there may be no number in sight, so it says only
 * that something is wrong.
 */
export function feedbackSeverityLabel(severity: FeedbackSeverity, sourceApp: string): string {
  if (severity === "wrong" && sourceApp !== "reports") return "Something is wrong";
  return FEEDBACK_SEVERITY_LABELS[severity];
}

export function isFeedbackSeverity(value: string): value is FeedbackSeverity {
  return (FEEDBACK_SEVERITIES as readonly string[]).includes(value);
}
