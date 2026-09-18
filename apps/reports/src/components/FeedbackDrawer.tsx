"use client";

import { useState, useTransition } from "react";
import { BuildReadinessDrawer } from "@/components/build-readiness/BuildReadinessDrawer";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { submitFeedback } from "@/lib/feedback-actions";
import { describeContext, type FeedbackContext } from "@/lib/feedback-context";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_CATEGORY_LABELS,
  FEEDBACK_SEVERITIES,
  FEEDBACK_SEVERITY_LABELS,
  DEFAULT_FEEDBACK_CATEGORY,
  DEFAULT_FEEDBACK_SEVERITY,
  type FeedbackCategory,
  type FeedbackSeverity,
} from "@/lib/feedback-status";

// ── "Something here is wrong" ───────────────────────────────────────────────
//
// The same BuildReadinessDrawer shell every other drilldown uses, so this
// looks like part of the app rather than a bolted-on feedback widget.
//
// ── Why the form asks for four small things instead of one big one ──────────
//
// A single "describe the problem" box produces "the invoicing numbers look off
// again", which costs a triager a phone call before any work can start. Which
// record / which field / shows / should be are the four things that call would
// establish, and they are cheap to answer WHILE looking at the screen and
// expensive to reconstruct later. The details box is still required — the
// structured fields sharpen a report, they never replace the sentence that
// explains it.
//
// Everything above those four fields is captured, not typed: the view, the
// filters, and the job or month they imply. See lib/feedback-context.ts.

const INPUT = "h-9 w-full rounded-lg border border-sdc-border bg-white px-2.5 text-sm text-sdc-navy outline-none focus:border-sdc-blue";
const LABEL = "text-xs font-semibold uppercase tracking-wide text-sdc-muted";

export function FeedbackDrawer({
  context,
  canView,
  onClose,
}: {
  context: FeedbackContext;
  /** Whether this role can open /feedback — decides what the confirmation promises. */
  canView: boolean;
  onClose: () => void;
}) {
  const [category, setCategory] = useState<FeedbackCategory>(DEFAULT_FEEDBACK_CATEGORY);
  const [severity, setSeverity] = useState<FeedbackSeverity>(DEFAULT_FEEDBACK_SEVERITY);
  // Prefilled from the captured context, and editable: the params can say the
  // user was filtered to job 1131 without that being the job they're unhappy
  // about. A prefill that cannot be corrected is worse than no prefill.
  const [recordRef, setRecordRef] = useState(context.jobId ?? context.employeeKey ?? "");
  const [fieldLabel, setFieldLabel] = useState("");
  const [observed, setObserved] = useState("");
  const [expected, setExpected] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();

  // Only the data-accuracy path asks "what does it show / what should it say".
  // A suggestion has no observed value, and showing those fields anyway would
  // make the form look like it wants numbers it has no use for.
  const isAccuracy = category === "data-accuracy";
  const filters = describeContext(context.params);

  function submit() {
    setError(null);
    if (!body.trim()) {
      setError("Add a line saying what's wrong — that's the part a fixer reads first.");
      return;
    }
    startTransition(async () => {
      try {
        const result = await submitFeedback({
          body,
          category,
          severity,
          routePath: context.routePath,
          viewLabel: context.viewLabel,
          params: context.params,
          contextUrl: context.contextUrl,
          // The subject is whatever the user confirmed in the field, not what
          // was guessed — but its TYPE comes from which context slot the guess
          // originally came from, so the queue can group by it.
          subjectType: recordRef ? (context.jobId ? "job" : context.employeeKey ? "employee" : "other") : null,
          subjectKey: recordRef || null,
          // The indexed columns keep the CAPTURED value, not the typed one:
          // they exist so "everything about job 1131" is one query, and a
          // free-text field is not a job number until somebody validates it.
          jobId: context.jobId,
          periodMonth: context.periodMonth,
          employeeKey: context.employeeKey,
          fieldLabel: fieldLabel || null,
          observedValue: isAccuracy ? observed || null : null,
          expectedValue: isAccuracy ? expected || null : null,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        // Only promise the Feedback page to someone who can actually open it:
        // feedback:view ships MANAGER-only, so for most submitters that link
        // would 404-by-redirect. Telling them it is logged is still true and
        // still worth saying.
        toast(
          canView
            ? "Thanks — that's logged. You can follow it on the Feedback page."
            : "Thanks — that's logged and it'll be picked up from here.",
          "success",
        );
        onClose();
      } catch (err) {
        // assertActionPermission throws rather than returning, so a role
        // without feedback:submit lands here.
        setError(err instanceof Error ? err.message : "Couldn't send that. Try again.");
      }
    });
  }

  return (
    <BuildReadinessDrawer
      title="Report a problem"
      subtitle={context.viewLabel ?? context.routePath}
      breadcrumb={["Report a problem"]}
      onBreadcrumbClick={() => {}}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4 p-4">
        {/* ── What we already know ──────────────────────────────────────────
            Shown rather than hidden so the submitter can see the report will
            carry it — and can tell us it's wrong (the note below) rather than
            silently filing against the wrong screen. */}
        <div className="rounded-lg border border-sdc-border-soft bg-sdc-gray-50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge variant="neutral">Reports</StatusBadge>
            <StatusBadge variant="active">{context.viewLabel ?? context.routePath}</StatusBadge>
            {context.periodMonth && <StatusBadge variant="neutral">{context.periodMonth}</StatusBadge>}
          </div>
          <div className="mt-2 text-xs text-sdc-gray-600">
            {filters ? <span className="font-mono">{filters}</span> : "No filters set on this view."}
          </div>
          <div className="mt-1 text-micro text-sdc-muted">
            Attached automatically — you don&apos;t need to describe where you are.
          </div>
        </div>

        <div>
          <div className={LABEL}>What&apos;s wrong?</div>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {FEEDBACK_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={`rounded-lg border px-3 py-1.5 text-sm ${
                  category === c
                    ? "border-sdc-blue bg-sdc-blue-light font-semibold text-sdc-blue-dark"
                    : "border-sdc-border bg-white text-sdc-gray-700 hover:border-sdc-blue"
                }`}
              >
                {FEEDBACK_CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL} htmlFor="fb-record">
              Which record
            </label>
            <input
              id="fb-record"
              className={INPUT}
              value={recordRef}
              onChange={(e) => setRecordRef(e.target.value)}
              placeholder="Job, part or person"
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="fb-field">
              Which field
            </label>
            <input
              id="fb-field"
              className={INPUT}
              value={fieldLabel}
              onChange={(e) => setFieldLabel(e.target.value)}
              placeholder="e.g. Left to Invoice"
            />
          </div>
        </div>

        {isAccuracy && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL} htmlFor="fb-observed">
                It shows
              </label>
              <input
                id="fb-observed"
                className={INPUT}
                value={observed}
                onChange={(e) => setObserved(e.target.value)}
                placeholder="What's on screen"
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="fb-expected">
                It should be
              </label>
              <input
                id="fb-expected"
                className={INPUT}
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
                placeholder="What you expected"
              />
            </div>
          </div>
        )}

        <div>
          <label className={LABEL} htmlFor="fb-body">
            Details
          </label>
          <textarea
            id="fb-body"
            className="min-h-[90px] w-full rounded-lg border border-sdc-border bg-white p-2.5 text-sm text-sdc-navy outline-none focus:border-sdc-blue"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What made you think it's wrong? Anything you already checked?"
          />
        </div>

        <div>
          <div className={LABEL}>How urgent</div>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {FEEDBACK_SEVERITIES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSeverity(s)}
                className={`rounded-lg border px-3 py-1.5 text-sm ${
                  severity === s
                    ? "border-sdc-blue bg-sdc-blue-light font-semibold text-sdc-blue-dark"
                    : "border-sdc-border bg-white text-sdc-gray-700 hover:border-sdc-blue"
                }`}
              >
                {FEEDBACK_SEVERITY_LABELS[s]}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-sdc-red-border bg-sdc-red-bg px-3 py-2 text-sm text-sdc-red-text">{error}</div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-sdc-border-soft pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-sdc-border px-3 py-2 text-sm font-semibold text-sdc-gray-700 hover:bg-sdc-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="rounded-lg bg-sdc-blue px-4 py-2 text-sm font-semibold text-white hover:bg-sdc-blue-dark disabled:opacity-60"
          >
            {pending ? "Sending…" : "Send feedback"}
          </button>
        </div>
      </div>
    </BuildReadinessDrawer>
  );
}
