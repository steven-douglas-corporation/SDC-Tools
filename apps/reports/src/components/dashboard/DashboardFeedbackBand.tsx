"use client";

import { Band } from "@/components/dashboard/DashboardLayout";
import { useFeedbackLauncher } from "@/components/FeedbackLauncher";
import { dashboardFeedbackContext, type DashboardFeedbackView } from "@/lib/dashboard-feedback";

// ── "Help shape this tab" (2026-10-20) ──────────────────────────────────────
//
// Two large buttons at the end of each Dashboard tab. They exist because the Finances
// tab is a prototype and nobody yet knows everything it should hold — the people who
// will use it are the ones who can say, and a small "Flag" pill that reads as "report a
// bug" is not an invitation to.
//
// Both go into the existing feedback queue through the existing drawer: the first as a
// suggestion, the second as the usual "a number is wrong" report. Neither is a new
// channel. Same wording on both tabs — the label the report is filed under says which
// tab it came from (lib/dashboard-feedback.ts).
//
// Offered only to a role that can submit feedback; for anyone else the band is absent
// rather than present and refusing.

function BigButton({ title, hint, onClick }: { title: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="motion-interactive flex min-w-0 flex-col items-start gap-0.5 rounded-xl border border-sdc-border bg-white px-5 py-4 text-left shadow-sm hover:border-sdc-blue hover:bg-sdc-blue-light/40"
    >
      <span className="text-sm font-semibold text-sdc-navy">{title}</span>
      <span className="text-note text-sdc-muted">{hint}</span>
    </button>
  );
}

export function DashboardFeedbackBand({ view, month }: { view: DashboardFeedbackView; month: string }) {
  const { canSubmit, open } = useFeedbackLauncher();
  if (!canSubmit) return null;
  const context = dashboardFeedbackContext(view, month);

  return (
    <Band label="Help shape this tab">
      <div className="grid gap-3 sm:grid-cols-2">
        <BigButton
          title="Suggest something to add"
          hint="Tell us what you'd want to see on this tab."
          onClick={() => open({ suggestion: true, context })}
        />
        <BigButton
          title="Something looks wrong"
          hint="A number, label or link that doesn't look right."
          onClick={() => open({ suggestion: false, context })}
        />
      </div>
    </Band>
  );
}
