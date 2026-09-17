import Link from "next/link";
import { PAGE_SHELL } from "@/components/ui/classnames";
import { PageTitle } from "@/components/ui/Typography";
import { EmptyState } from "@/components/ui/EmptyState";
import { FeedbackGrid } from "@/components/FeedbackGrid";
import type { FeedbackGridRow } from "@/components/FeedbackGridInner";
import type { FeedbackDetail } from "@/components/FeedbackDetailDrawer";
import { requirePagePermission } from "@/lib/require-permission";
import { hasPermission } from "@/lib/permissions";
import { listFeedback, countFeedbackByStatus, type FeedbackFilter } from "@/lib/feedback-store";
import { describeContext } from "@/lib/feedback-context";
import { isFeedbackStatus, OPEN_FEEDBACK_STATUSES } from "@/lib/feedback-status";

// ── The feedback queue ──────────────────────────────────────────────────────
//
// One page for two audiences:
//
//   a TRIAGER (feedback:triage) sees everything and can act on it;
//   a SUBMITTER (feedback:view alone) sees their own reports and the
//   responses to them, read-only.
//
// ── Who can actually reach it today ─────────────────────────────────────────
//
// feedback:view ships MANAGER-only (2026-09-17, by request) — the queue is an
// oversight surface, not a nav item every signed-in user needs. So the
// submitter branch below is live code with no default audience: it exists for
// the moment somebody ticks View for PM or Sales on /admin/permissions, which
// is the supported way to let those people read the answers to their own
// reports. Do not delete it as dead — it is one checkbox from being used, and
// rebuilding it later is how "we'll add it back when someone asks" turns into
// a second feedback system.
//
// Everyone still holds feedback:submit, so reports keep arriving from every
// role whether or not that role can see this page.
//
// ── The row scoping is a SECURITY boundary, not a filter ────────────────────
//
// A caller without feedback:triage is pinned to their own submitterEmail in
// the SQL (see the `scope` below and listFeedback's own note). It is not done
// by filtering in the component, because a grid that fetched everything and
// rendered a subset would still have shipped every submitter's text to the
// browser, where it is one devtools tab away.

const LOAD_LIMIT = 1000;

const TABS = [
  { key: "queue", label: "Open" },
  { key: "all", label: "All" },
  { key: "mine", label: "Mine" },
] as const;

export async function FeedbackView({
  params,
}: {
  params: { status?: string; app?: string; job?: string; assignee?: string; mine?: string };
}) {
  const session = await requirePagePermission("feedback:view");
  const role = session.user.role;
  const canTriage = hasPermission(role, "feedback:triage");
  const myEmail = session.user.email ?? "";

  // "mine" is a UI tab for a triager and the ONLY possible view for everyone
  // else — a submitter cannot turn their own scoping off by editing the URL.
  const wantsMine = params.mine === "1" || !canTriage;
  const scope = wantsMine ? myEmail : null;

  const status = params.status && isFeedbackStatus(params.status) ? params.status : params.status === "all" ? null : "queue";

  const filter: FeedbackFilter = {
    status,
    sourceApp: params.app || null,
    jobId: params.job || null,
    assignedToEmail: params.assignee || null,
    submitterEmail: scope,
  };

  const [items, counts] = await Promise.all([
    listFeedback(filter, LOAD_LIMIT),
    countFeedbackByStatus(scope),
  ]);

  const openCount = OPEN_FEEDBACK_STATUSES.reduce((n, s) => n + (counts[s] ?? 0), 0);
  // Counts are computed over the caller's whole scope, not the current filter,
  // so this distinguishes "nothing matches this tab" from "nothing exists" —
  // see the empty state below for why that distinction is worth a variable.
  const everFiled = Object.values(counts).some((n) => n > 0);

  const rows: FeedbackGridRow[] = items.map((f) => ({
    id: f.id,
    when: f.createdAt.toISOString().slice(0, 16).replace("T", " "),
    status: f.status,
    severity: f.severity,
    category: f.category,
    view: f.viewLabel ?? f.routePath ?? "—",
    context: f.params ? describeContext(f.params) : "",
    job: f.jobId ?? "—",
    period: f.periodMonth ?? "—",
    field: f.fieldLabel ?? "—",
    observed: f.observedValue ?? "—",
    expected: f.expectedValue ?? "—",
    submitter: f.submitterName ?? f.submitterEmail,
    assigned: f.assignedToEmail ?? "—",
    summary: f.body,
    response: f.resolutionNote ?? "",
    contextUrl: f.contextUrl,
  }));

  // The full record per row, handed down with the page so opening one costs no
  // round trip — the same shape the audit log's grid uses for its own rows.
  const details: Record<number, FeedbackDetail> = {};
  for (const f of items) {
    details[f.id] = {
      id: f.id,
      when: f.createdAt.toISOString().slice(0, 16).replace("T", " "),
      status: f.status,
      severity: f.severity,
      category: f.category,
      viewLabel: f.viewLabel,
      routePath: f.routePath,
      contextUrl: f.contextUrl,
      context: f.params ? describeContext(f.params) : "",
      jobId: f.jobId,
      periodMonth: f.periodMonth,
      fieldLabel: f.fieldLabel,
      observedValue: f.observedValue,
      expectedValue: f.expectedValue,
      body: f.body,
      submitter: f.submitterName ? `${f.submitterName} (${f.submitterEmail})` : f.submitterEmail,
      assignedToEmail: f.assignedToEmail,
      resolutionNote: f.resolutionNote,
      resolvedByEmail: f.resolvedByEmail,
      sourceApp: f.sourceApp,
    };
  }

  const activeTab = wantsMine && canTriage ? "mine" : status === null ? "all" : "queue";

  return (
    <div className={PAGE_SHELL}>
      <PageTitle className="mb-1">Feedback</PageTitle>
      <p className="mb-4 max-w-3xl text-sm text-sdc-gray-600">
        {canTriage ? (
          <>
            Data-accuracy reports from across the app, with the view, filters and record the submitter was looking at
            attached automatically. Open a row to see where they were standing, then acknowledge it or close it with a
            response they&apos;ll read here.
          </>
        ) : (
          <>
            The problems you&apos;ve reported, and what came of them. Use the <strong>Flag</strong>{" "}
            button in the corner of any page to report a number that looks wrong — the view and filters you&apos;re on
            are attached for you.
          </>
        )}
      </p>

      {/* Status tabs as URL params, the DashboardTabs pattern — so a filtered
          queue survives a tab/split move and can be sent to someone. */}
      <div className="mb-4 flex items-center gap-1 border-b border-sdc-border-soft">
        {TABS.filter((t) => t.key !== "mine" || canTriage).map((t) => {
          const href =
            t.key === "queue" ? "/feedback" : t.key === "all" ? "/feedback?status=all" : "/feedback?status=all&mine=1";
          const active = activeTab === t.key;
          return (
            <Link
              key={t.key}
              href={href}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                active
                  ? "border-sdc-blue font-semibold text-sdc-navy"
                  : "border-transparent text-sdc-gray-600 hover:text-sdc-navy"
              }`}
            >
              {t.label}
              {t.key === "queue" && openCount > 0 && (
                <span className="ml-1.5 rounded-full bg-sdc-yellow-bg px-1.5 py-0.5 text-micro font-bold text-sdc-yellow-text">
                  {openCount}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {rows.length === 0 ? (
        // Three different empty states, because they mean three different
        // things and one message for all of them reads as a bug. "Every report
        // has been dealt with" is actively wrong for somebody who has never
        // filed one — which is the state every user starts in.
        <EmptyState
          title={everFiled ? (activeTab === "queue" ? "Nothing open" : "Nothing here") : "No feedback yet"}
          message={
            !everFiled
              ? canTriage
                ? "When someone flags a number that looks wrong, it lands here with the view, the filters and the record they were looking at already attached."
                : "Nothing reported yet. Use the Flag button in the corner of any page and the view you're on comes with it."
              : activeTab === "queue"
                ? `Everything has been dealt with — ${counts.fixed ?? 0} fixed, ${counts.wontfix ?? 0} closed without a change.`
                : "Nothing matches this filter."
          }
        />
      ) : (
        <FeedbackGrid rows={rows} details={details} canTriage={canTriage} />
      )}
    </div>
  );
}

// -- Route entry point --
//
// The page's body lives in `FeedbackView` above so that BOTH this route and the
// split view can render it. Split view renders two views in ONE document (see
// lib/split-view.ts for why one document rather than two frames), which means a
// pane cannot be a route and therefore cannot read `searchParams` - there is only
// one URL and two panes would collide in it. So the body takes its context as a
// plain argument, and the two callers differ only in where they read that context
// from: this wrapper reads the URL, a pane reads its own `l.`/`r.` namespace.
//
// This route is the one most worth having in split view: a triager can keep the
// queue in one pane and open the disputed report in the other, at the submitter's
// own job and month.
export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; app?: string; job?: string; assignee?: string; mine?: string }>;
}) {
  return <FeedbackView params={await searchParams} />;
}
