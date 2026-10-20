import { buildFeedbackContext, type FeedbackContext } from "@/lib/feedback-context";

// ── What a Dashboard feedback button reports about itself (2026-10-20) ───────
//
// The two buttons at the bottom of each Dashboard tab know EXACTLY which view they
// are on, so they say so rather than letting the shell guess. The shell's Flag button
// resolves "the active pane" and, in split view, takes the left one by convention — a
// button in the right-hand pane would otherwise file its suggestion against the wrong
// view.
//
// The label names the tab, not just "Dashboard": a triager reading the queue should
// not have to decode `tab=finances` out of the params to see which tab a suggestion is
// about, and the Finances tab is the one this exists to learn from.

export type DashboardFeedbackView = "executive" | "finances";

const VIEW_LABEL: Record<DashboardFeedbackView, string> = {
  executive: "Dashboard — Executive",
  finances: "Dashboard — Finances",
};

export function dashboardFeedbackContext(view: DashboardFeedbackView, month: string): FeedbackContext {
  const params: Record<string, string> = { m: month };
  if (view === "finances") params.tab = "finances";
  const context = buildFeedbackContext({ path: "/", params });
  return { ...context, viewLabel: VIEW_LABEL[view] };
}
