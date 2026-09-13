import { hours as fmtHours } from "@/components/ui/format";
import type { DrillScope } from "@/lib/etc-kpi-strip";

// ── The Monthly ETC data issues, as data (§44) ──────────────────────────────
//
// Deliberately NOT in EtcIssuesIndicator.tsx, which is a `"use client"` module.
//
// The ETC page is a Server Component and builds this list during the server render. A
// function exported from a client module cannot be called there — it arrives as a
// client REFERENCE, and Next fails the render with "Attempted to call buildEtcIssues()
// from the server but buildEtcIssues is on the client". That is exactly what happened
// the first time this shipped, and it is the same trap recorded against the
// presentational-filters work: the boundary is per MODULE, not per export, so a pure
// helper sitting next to a component inherits the component's side of it.
//
// So the rules live here (no "use client", no I/O, no React) and the component next
// door only renders them. Same shape as undefined-hours-rules.ts, and for the same
// reason: it makes the logic callable from either side and testable from neither.

export type EtcIssue = {
  // Sorted on this: a stale-data warning outranks a data-quality finding.
  severity: "critical" | "warn";
  title: string;
  detail: string;
  // The KPI drill this issue has a home in, if any. Clicking the row opens it.
  drill?: DrillScope;
  // What to do about it, when that is not obvious from the title.
  fix?: string;
};

export function buildEtcIssues(input: {
  hoursSyncFailure: { detail: string; at: string | null } | null;
  etcHoursSyncFailure: { detail: string; at: string | null } | null;
  undefinedHours: { hours: number; entries: number };
  offGrid: { hours: number; jobs: number };
}): EtcIssue[] {
  const out: EtcIssue[] = [];

  if (input.hoursSyncFailure) {
    out.push({
      severity: "critical",
      title: "Hours data may be stale",
      detail:
        `The last hours import failed${input.hoursSyncFailure.at ? ` (${input.hoursSyncFailure.at})` : ""}, so Hours Worked below may ` +
        `not reflect recent time entries. ${input.hoursSyncFailure.detail}`,
      fix: "Run Refresh Data. If it fails again, the file may be missing or still uploading.",
    });
  }

  // Only when the feed itself is healthy — one outage must not produce two entries
  // saying the same thing.
  if (input.etcHoursSyncFailure && !input.hoursSyncFailure) {
    out.push({
      severity: "critical",
      title: "Hours Worked may be out of date",
      detail:
        `The hours feed is healthy, but writing it into this month's ETC rows last failed` +
        `${input.etcHoursSyncFailure.at ? ` (${input.etcHoursSyncFailure.at})` : ""}. ${input.etcHoursSyncFailure.detail}`,
      fix: "Run Refresh Data.",
    });
  }

  if (input.undefinedHours.hours > 0) {
    out.push({
      severity: "warn",
      title: `${fmtHours(input.undefinedHours.hours)} hours booked without a valid job number`,
      detail: `${input.undefinedHours.entries} ${input.undefinedHours.entries === 1 ? "entry" : "entries"} reach no figure on this page.`,
      drill: "Unattributed",
      fix: "Correct the job number in Paylocity, then Refresh Data.",
    });
  }

  if (input.offGrid.jobs > 0) {
    out.push({
      severity: "warn",
      title: `${fmtHours(input.offGrid.hours)} hours on ${input.offGrid.jobs === 1 ? "a job" : `${input.offGrid.jobs} jobs`} this grid isn't showing`,
      detail: "The grid lists Active, billable jobs only — anything else reaches no total below.",
      drill: "OffGrid",
      fix: "Set the job back to Active and billable, or accept the shortfall deliberately.",
    });
  }

  return out;
}
