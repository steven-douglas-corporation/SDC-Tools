"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BuildReadinessDrawer } from "@/components/build-readiness/BuildReadinessDrawer";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { setFeedbackStatus, assignFeedback } from "@/lib/feedback-actions";
import {
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_STATUS_VARIANT,
  FEEDBACK_SEVERITY_LABELS,
  FEEDBACK_CATEGORY_LABELS,
  canTransition,
  isFeedbackStatus,
  isFeedbackSeverity,
  isFeedbackCategory,
  type FeedbackStatus,
} from "@/lib/feedback-status";

// One item, opened from the queue. A triager acts here; a submitter reads here.
// Same drawer shell as every other drilldown in the app.

export type FeedbackDetail = {
  id: number;
  when: string;
  status: string;
  severity: string;
  category: string;
  viewLabel: string | null;
  routePath: string | null;
  contextUrl: string | null;
  context: string;
  jobId: string | null;
  periodMonth: string | null;
  fieldLabel: string | null;
  observedValue: string | null;
  expectedValue: string | null;
  body: string;
  submitter: string;
  assignedToEmail: string | null;
  resolutionNote: string | null;
  resolvedByEmail: string | null;
  sourceApp: string;
};

const LABEL = "text-xs font-semibold uppercase tracking-wide text-sdc-muted";

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <div className={LABEL}>{label}</div>
      <div className="mt-0.5 text-sm text-sdc-navy">{value}</div>
    </div>
  );
}

export function FeedbackDetailDrawer({
  item,
  canTriage,
  onClose,
}: {
  item: FeedbackDetail;
  canTriage: boolean;
  onClose: () => void;
}) {
  const [note, setNote] = useState(item.resolutionNote ?? "");
  const [assignee, setAssignee] = useState(item.assignedToEmail ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  const current: FeedbackStatus = isFeedbackStatus(item.status) ? item.status : "open";

  function move(to: FeedbackStatus) {
    setError(null);
    // The same rule the server enforces, checked here so the refusal arrives
    // before the round trip rather than after it. canTransition is the single
    // source for both — see lib/feedback-status.ts.
    const allowed = canTransition(current, to, note);
    if (!allowed.ok) {
      setError(allowed.error);
      return;
    }
    startTransition(async () => {
      try {
        const result = await setFeedbackStatus(item.id, to, note || null);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        toast(`Marked ${FEEDBACK_STATUS_LABELS[to].toLowerCase()}.`, "success");
        router.refresh();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't update that.");
      }
    });
  }

  function reassign() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await assignFeedback(item.id, assignee.trim() || null);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        toast(assignee.trim() ? `Assigned to ${assignee.trim()}.` : "Unassigned.", "success");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't assign that.");
      }
    });
  }

  return (
    <BuildReadinessDrawer
      title={`Feedback #${item.id}`}
      subtitle={`${item.submitter} · ${item.when}`}
      breadcrumb={[`Feedback #${item.id}`]}
      onBreadcrumbClick={() => {}}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge variant={FEEDBACK_STATUS_VARIANT[current]}>{FEEDBACK_STATUS_LABELS[current]}</StatusBadge>
          {isFeedbackSeverity(item.severity) && <StatusBadge variant="neutral">{FEEDBACK_SEVERITY_LABELS[item.severity]}</StatusBadge>}
          {isFeedbackCategory(item.category) && <StatusBadge variant="neutral">{FEEDBACK_CATEGORY_LABELS[item.category]}</StatusBadge>}
          {item.sourceApp !== "reports" && <StatusBadge variant="neutral">{item.sourceApp}</StatusBadge>}
        </div>

        {/* ── Where they were standing ──────────────────────────────────────
            The payoff of capturing context: one click puts the triager on the
            same screen, with the same filters, instead of reconstructing it
            from a description. The link is the plain single-pane route (see
            buildContextUrl), so it can also be opened in the other pane
            alongside this queue. */}
        <div className="rounded-lg border border-sdc-border-soft bg-sdc-gray-50 p-3">
          <div className={LABEL}>Where they were</div>
          <div className="mt-1 text-sm text-sdc-navy">{item.viewLabel ?? item.routePath ?? "Unknown view"}</div>
          {item.context && <div className="mt-0.5 font-mono text-xs text-sdc-gray-600">{item.context}</div>}
          {item.contextUrl && (
            <Link href={item.contextUrl} className="mt-2 inline-block text-sm font-semibold text-sdc-blue hover:underline">
              Open the view they were looking at →
            </Link>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Job" value={item.jobId} />
          <Field label="Period" value={item.periodMonth} />
          <Field label="Field" value={item.fieldLabel} />
          <Field label="Assigned to" value={item.assignedToEmail} />
          <Field label="It shows" value={item.observedValue} />
          <Field label="It should be" value={item.expectedValue} />
        </div>

        <div>
          <div className={LABEL}>What they said</div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-sdc-navy">{item.body}</p>
        </div>

        {canTriage ? (
          <>
            <div>
              <label className={LABEL} htmlFor="fb-note">
                Response to the submitter
              </label>
              <textarea
                id="fb-note"
                className="mt-1 min-h-[80px] w-full rounded-lg border border-sdc-border bg-white p-2.5 text-sm text-sdc-navy outline-none focus:border-sdc-blue"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What was wrong, and what you did about it. Required before closing."
              />
            </div>

            <div>
              <div className={LABEL}>Move to</div>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {FEEDBACK_STATUSES.filter((s) => s !== current).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => move(s)}
                    disabled={pending}
                    className="rounded-lg border border-sdc-border bg-white px-3 py-1.5 text-sm font-semibold text-sdc-gray-700 hover:border-sdc-blue hover:text-sdc-blue-dark disabled:opacity-60"
                  >
                    {FEEDBACK_STATUS_LABELS[s]}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className={LABEL} htmlFor="fb-assignee">
                Assign to
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  id="fb-assignee"
                  className="h-9 flex-1 rounded-lg border border-sdc-border bg-white px-2.5 text-sm text-sdc-navy outline-none focus:border-sdc-blue"
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  placeholder="name@stevendouglas.com — blank to unassign"
                />
                <button
                  type="button"
                  onClick={reassign}
                  disabled={pending}
                  className="rounded-lg border border-sdc-border px-3 py-2 text-sm font-semibold text-sdc-gray-700 hover:bg-sdc-gray-50 disabled:opacity-60"
                >
                  Save
                </button>
              </div>
            </div>
          </>
        ) : (
          // The submitter's view: no controls, but the answer is the whole
          // reason they come back to this page.
          <div>
            <div className={LABEL}>Response</div>
            {item.resolutionNote ? (
              <>
                <p className="mt-1 whitespace-pre-wrap text-sm text-sdc-navy">{item.resolutionNote}</p>
                {item.resolvedByEmail && <div className="mt-1 text-xs text-sdc-muted">— {item.resolvedByEmail}</div>}
              </>
            ) : (
              <p className="mt-1 text-sm text-sdc-gray-600">No response yet.</p>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-sdc-red-border bg-sdc-red-bg px-3 py-2 text-sm text-sdc-red-text">{error}</div>
        )}
      </div>
    </BuildReadinessDrawer>
  );
}
