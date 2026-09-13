// ── The submission flow, stated once, as pure functions ─────────────────────
//
// `Submit {Month} Report` moved out of the toolbar and into the bottom of the
// Standard Fees card (§26, 2026-08-04), and gained a confirmation dialog on the
// way. That turned one button into a seven-state workflow — ready, blocked,
// confirmation open, validating, submitting, submitted, failed — with rules
// about what may be clicked in each one.
//
// Those rules live here rather than inside the component, for two reasons:
//
//   * A workflow whose only definition is a chain of `disabled={a || b || !c}`
//     expressions cannot be tested, and this is the one irreversible action in
//     the app. tests/monthly-report-submit.test.ts imports this file directly.
//   * The SERVER needs the same vocabulary. The failure categories the button
//     shows are the reasons the action returns; keeping them in one file is what
//     stops "conflict" meaning one thing on each side.
//
// Deliberately dependency-free — no React, no Prisma, no `@/` imports at all —
// so `tsx --test` can load it and so it costs the client bundle nothing but the
// functions themselves. That is also why the validation TYPES live here and
// lib/monthly-report.ts re-exports them: they cross the server/client boundary
// in both directions.
//
// The one import below is RELATIVE for that same reason, not by accident: the rest of
// this codebase uses `@/`, which the test runner does not resolve. lib/etc-departments
// carries the identical no-dependencies rule, so importing it keeps this module loadable
// by `tsx --test` while letting both places word an English list the same way — the
// alternative was a second copy of `joinLabels` here, in the file whose whole purpose is
// that the submission is described in exactly one place.
import { joinLabels as joinNames } from "./etc-departments";

// ── What the month is made of ───────────────────────────────────────────────

export type ReportSection = "Monthly ETC" | "Standard Sheet" | "Standard Card";

// One thing wrong, named the way a manager would have to go and fix it: which
// tab, which project, which row, which field (§26.4).
export type ValidationIssue = {
  section: ReportSection;
  // The job number, or the pool/department name for a non-job row.
  rowRef: string;
  department?: string;
  column?: string;
  reason: string;
};

export type MonthlyReportValidation = {
  ok: boolean;
  // Capped for display; `totalIssues` is the real count.
  issues: ValidationIssue[];
  totalIssues: number;
  sections: ReportSection[];
  // Enough of a summary to put in the submission record without the whole list.
  counts: { entries: number; jobs: number; missingNewEtc: number; standardJobs: number };
  // ── Which departments have not signed off (§50) ───────────────────────────
  //
  // Labels, in checklist order, e.g. ["CE", "Wire"]. Its own field rather than something
  // derived from `issues`, for one reason: `issues` is capped at MAX_REPORTED_ISSUES and
  // a month with 25 missing New ETC cells would push the department rows off the end —
  // so the blocker would stop naming the departments in exactly the situation where the
  // most is wrong. §50 requires them to be "clearly identified", which means always.
  //
  // Required, not optional. This gates the one irreversible action in the app, and a
  // producer that forgets it should fail to compile rather than quietly report a month
  // as ready that six departments have not looked at.
  incompleteDepartments: string[];
};

// How many issues travel to the client. A month with 200 unfilled cells does not
// need 200 rows in a dialog — it needs the first screenful and the true count.
export const MAX_REPORTED_ISSUES = 25;

// ── Which of a month's entries submission actually validates (§68) ──────────
//
// A month's EtcEntry rows and the jobs the Monthly ETC grid RENDERS are not the same
// set. The grid's universe is `etcActiveJobFilter` (Active, not complete, billable,
// valid type) for the live month, but entries already seeded for a job survive that
// job changing status — going non-billable, being set to HeadStart, or completing. Those
// leftovers are exactly what the "Hours off the grid" KPI reports, and they are pruned
// by the next Refresh Data.
//
// Validation must not demand a New ETC for them. The cell is not on screen for anyone to
// fill in, so a month with one could never be submitted — the reported symptom was
// `Monthly ETC · Job 1155 · Parts Cost · New ETC` blocking submission for a job that had
// left the grid. §68's rule: readiness applies only to jobs eligible for the grid.
//
// It lives here, in the dependency-free module, for the reason the department issues do:
// `validateMonthlyReport` can only run inside Next, so the one judgement in it that is a
// RULE rather than a query is kept where `tsx --test` can reach it. The eligible set is
// supplied by the caller from getEtcMonthJobWhere — the single source of truth the grid
// itself renders from — so this function cannot invent a second definition of "eligible".
//
// Scope note: this is READINESS only. submitEtcEntriesInTx still freezes every row the
// month contains, and the off-grid hours stay in the KPI, the drill-through, the audit
// trail and data-quality review. §68 is explicit that the exclusion must not hide them.
export function entriesInSubmissionScope<T extends { job: { id: number } }>(
  entries: readonly T[],
  eligibleJobIds: ReadonlySet<number>,
): T[] {
  return entries.filter((e) => eligibleJobIds.has(e.job.id));
}

// ── The seven states (§26.7) ────────────────────────────────────────────────

export type SubmitPhase =
  // Readiness has not come back from the server yet. Distinct from "blocked":
  // we do not yet know, and saying "438 items" before asking would be a guess.
  | "checking"
  | "ready"
  | "blocked"
  | "confirming"
  | "validating"
  | "submitting"
  | "submitted"
  | "failed";

// Everything the button needs to decide what it says and whether it may be
// pressed. One object, so a new input cannot be added to one rule and forgotten
// in another.
export type SubmitContext = {
  phase: SubmitPhase;
  monthName: string;
  // Server-decided (§26.14). The button is not rendered at all when this is
  // false, but every rule here still respects it — a component that renders it
  // by mistake must not offer a working click.
  permitted: boolean;
  validation: MonthlyReportValidation | null;
  // Edits still on the autosave debounce. Not a block: the submission flushes
  // and waits for them (§26.6). It is worth saying out loud, though.
  pendingSaves: boolean;
};

// ── The readiness line above the button (§26.4) ─────────────────────────────

export type ReadinessTone = "ok" | "blocked" | "neutral";
export type ReadinessLine = { tone: ReadinessTone; text: string; detail?: string };

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

// "Ready to submit" / "438 items still require attention" / "Submission blocked:
// 12 required New ETC values are missing" — the three shapes §26.4 asks for, in
// that order of specificity. The missing-New-ETC count leads when there is one,
// because it is the block managers actually hit and the grid paints those cells
// yellow for them.
export function readinessLine(ctx: SubmitContext): ReadinessLine {
  if (!ctx.permitted) {
    return { tone: "blocked", text: "You do not have permission to submit this report." };
  }
  if (ctx.phase === "submitted") {
    return { tone: "ok", text: `${ctx.monthName} report submitted.` };
  }
  if (ctx.validation == null) {
    return { tone: "neutral", text: `Checking whether ${ctx.monthName} is ready to submit…` };
  }

  const v = ctx.validation;
  if (v.ok) {
    return {
      tone: "ok",
      text: "Ready to submit",
      detail:
        `${v.counts.entries} ETC ${plural(v.counts.entries, "entry", "entries")} across ${v.counts.jobs} ` +
        `${plural(v.counts.jobs, "job")}, and ${v.counts.standardJobs} ${plural(v.counts.standardJobs, "job")} ` +
        `in the Standard Fees allocation.`,
    };
  }

  // ── The department sign-off leads (§50) ───────────────────────────────────
  //
  // Ahead of the missing-New-ETC count, and that order is a judgement: an unfinished
  // department is a message to send to a person, where a missing cell is something to go
  // and type. The first is the longer pole, so it is the one to see first — and unlike
  // the cell count it names exactly who is being waited on.
  //
  // Any remaining issues ride along in `detail` rather than being hidden behind the
  // headline, for the same reason the missing-New-ETC branch does it: chasing the last
  // department, then finding the button still refused, is the exact frustration §26.4
  // was written about.
  const depts = v.incompleteDepartments ?? [];
  if (depts.length > 0) {
    const verb = depts.length === 1 ? "has" : "have";
    const others = v.totalIssues;
    return {
      tone: "blocked",
      text: `Submission blocked: ${joinNames(depts)} ${verb} not completed their ETC review.`,
      detail:
        others > 0
          ? `And ${others} other ${plural(others, "item")} still ${plural(others, "requires", "require")} attention.`
          : "Every other check has passed — the report submits as soon as they tick their box.",
    };
  }

  const missing = v.counts.missingNewEtc;
  if (missing > 0) {
    // Other issues (a stale pool, an unreadable hours figure) ride along rather
    // than being hidden behind the headline — fixing only the New ETC cells and
    // finding the button still refused is the exact frustration §26.4 is about.
    const others = v.totalIssues - missing;
    return {
      tone: "blocked",
      text: `Submission blocked: ${missing} required New ETC ${plural(missing, "value")} ${missing === 1 ? "is" : "are"} missing`,
      detail: others > 0 ? `And ${others} other ${plural(others, "item")} still ${plural(others, "requires", "require")} attention.` : undefined,
    };
  }

  return {
    tone: "blocked",
    text: `${v.totalIssues} ${plural(v.totalIssues, "item")} still ${plural(v.totalIssues, "requires", "require")} attention`,
  };
}

// ── Labels (§26.1, §26.7, §26.8) ────────────────────────────────────────────
//
// Every one of these carries the month name, and the month name comes from the
// picker — so the label always names the month it would actually freeze.

export function submitButtonLabel(ctx: SubmitContext): string {
  switch (ctx.phase) {
    case "validating":
      return `Validating ${ctx.monthName} report…`;
    case "submitting":
      return `Submitting ${ctx.monthName} report…`;
    case "submitted":
      return `${ctx.monthName} Report Submitted`;
    case "failed":
      // A retry that re-uses the same submission id (§26.9): the wording says the
      // click is safe, and the id is what makes it so.
      return `Retry ${ctx.monthName} Report`;
    default:
      return `Submit ${ctx.monthName} Report`;
  }
}

export function confirmTitle(monthName: string): string {
  return `Submit ${monthName} Report?`;
}

export function confirmBody(monthName: string): string {
  return (
    `Are you sure you want to submit the complete ${monthName} report? This will finalize the Monthly ETC, ` +
    `Standard Sheet, Standard Card, Standard Fees, hours, parts-cost, and all other required monthly data.`
  );
}

// §26.12 — the text above the button in the Standard Fees card. Says where the
// button is (here) rather than where it used to be (the toolbar), and says that
// the confirmation step exists so the click is not a surprise.
export function standardFeesSubmitBlurb(monthName: string): string {
  return (
    `These Standard Fees figures are saved automatically. Use the button below to submit the complete ${monthName} ` +
    `report, including Monthly ETC, Standard Sheet, Standard Card, Standard Fees, hours, and parts-cost data. ` +
    `You will be asked to confirm before the report is finalized.`
  );
}

// ── What may be clicked (§26.7) ─────────────────────────────────────────────

// The button that OPENS the dialog. Refused for anything that would let an
// invalid or already-running submission reach a confirmation screen (§26.16 #6:
// "invalid or incomplete reports cannot open a valid submission flow").
export function canOpenConfirm(ctx: SubmitContext): boolean {
  if (!ctx.permitted) return false;
  switch (ctx.phase) {
    case "ready":
    case "failed":
      return ctx.validation != null && ctx.validation.ok;
    default:
      // checking / blocked / confirming / validating / submitting / submitted
      return false;
  }
}

export function isSubmitButtonDisabled(ctx: SubmitContext): boolean {
  return !canOpenConfirm(ctx);
}

// The `Yes, Submit Report` button INSIDE the dialog. Disabled the moment it is
// clicked once — the phase moves to validating and never comes back to
// confirming — which is what makes a double-click a no-op rather than a race
// the idempotency key has to catch (§26.7).
export function canConfirmSubmit(ctx: SubmitContext): boolean {
  return ctx.permitted && ctx.phase === "confirming" && ctx.validation != null && ctx.validation.ok;
}

// Escape, the backdrop and Cancel are all the same question: may the dialog be
// dismissed right now? Only while it is genuinely just a question — once
// validation or the submission is running, dismissing it would hide a
// transaction the user cannot see the outcome of (§26.5).
export function canDismissDialog(phase: SubmitPhase): boolean {
  return phase === "confirming" || phase === "failed" || phase === "submitted";
}

// ── Staleness (§26.6, §26.13) ───────────────────────────────────────────────
//
// The dialog can sit open indefinitely. Two things can move underneath it: the
// month picker (this tab) and other people's saves (every other tab). Both must
// stop the submission rather than freeze whatever is now on screen.

// `seen` is the fingerprint the readiness check returned when the dialog opened;
// `current` is what the server has now. A MISSING `seen` counts as stale: it
// means the confirmation was opened without a known-good reading, and guessing
// in the safe direction costs one extra click.
export function isMonthDataStale(seen: string | null, current: string | null): boolean {
  if (seen == null || current == null) return true;
  return seen !== current;
}

export function didMonthChange(openedFor: string, current: string): boolean {
  return openedFor !== current;
}

// What the dialog says when either of the above fires. Deliberately not an
// error: nothing went wrong, the data simply moved, and the answer is to look
// and confirm again (§26.6).
export function staleDialogMessage(monthName: string, cause: "month" | "data"): string {
  return cause === "month"
    ? `The selected month changed while this window was open, so nothing was submitted. Review the month on screen and submit again.`
    : `${monthName} changed while this window was open — somebody else saved since you opened it. Nothing was submitted. Review the latest figures and confirm again.`;
}

// ── Failure, said in a way that names the cause (§26.9) ─────────────────────

// The reasons the server action can return, plus the three the browser can decide
// on its own (`network`, `pendingSave`, `browser`). One union, both sides.
export type SubmitFailureReason =
  | "validation"
  | "pendingSave"
  | "conflict"
  | "permission"
  | "network"
  | "duplicate"
  | "month"
  // The submission could not even be STARTED by this browser — it never became a
  // request, so the server has never heard of it. Distinct from `network` (which
  // means it was sent and the reply did not arrive) and from `error` (which is the
  // backend failing), because the corrective action is completely different: this
  // one is about the browser or the page, not the data and not the server. The one
  // real instance was `crypto.randomUUID()` being undefined on this app's
  // non-secure origin, which threw in the click handler and made the button do
  // nothing at all — see lib/client-uuid.ts.
  | "browser"
  | "error";

export type FailureExplanation = {
  reason: SubmitFailureReason;
  // The category, in the user's words — "Missing or invalid data", "Conflict"…
  category: string;
  text: string;
  // May the same click be repeated safely? A retry re-uses the submission id,
  // so "yes" here never means "risk submitting twice".
  retryable: boolean;
};

export function failureExplanation(reason: SubmitFailureReason, message: string): FailureExplanation {
  switch (reason) {
    case "validation":
      return {
        reason,
        category: "Missing or invalid data",
        text: `${message} Nothing was submitted, and every figure you have entered is still saved.`,
        // Retrying the same data would be refused again; the list above the
        // button is the thing to act on.
        retryable: false,
      };
    case "pendingSave":
      return {
        reason,
        category: "Pending save",
        text: `${message} Nothing was submitted — the month would have been frozen without that edit in it.`,
        retryable: true,
      };
    case "conflict":
      return { reason, category: "Conflict", text: message, retryable: true };
    case "permission":
      return {
        reason,
        category: "Permission",
        text: `${message} Nothing was submitted.`,
        retryable: false,
      };
    case "network":
      return {
        reason,
        category: "Network",
        text: `${message} Your saved work is untouched — nothing needs to be re-entered.`,
        retryable: true,
      };
    case "browser":
      return {
        reason,
        category: "Browser",
        // Not retryable: the same click in the same page will fail the same way, and
        // "press it again" is the advice that wastes the most time when the button
        // is the thing that is broken. Reloading is what can actually change the
        // outcome (a stale bundle), so that is what it says.
        text:
          `${message} Nothing was submitted and every figure you have entered is still saved. ` +
          `Reload the page and try again; if it happens again, report it — the browser console has the detail.`,
        retryable: false,
      };
    case "duplicate":
      return {
        reason,
        category: "Already submitted",
        text: message,
        retryable: false,
      };
    case "month":
      return { reason, category: "Invalid month", text: message, retryable: false };
    default:
      return {
        reason: "error",
        category: "Backend failure",
        text: `${message} The month was left exactly as it was — nothing is half-submitted, and no saved data was lost.`,
        retryable: true,
      };
  }
}

// ── The receipt (§26.8) ─────────────────────────────────────────────────────

export type SubmissionReceipt = {
  month: string; // "2026-07"
  monthName: string; // "July"
  year: number;
  userName: string;
  submittedAt: string; // ISO
  submissionId: string;
  entriesSubmitted: number;
  standardRows: number;
};

// Month, year, who, when, and the id — the five things §26.8 asks to be shown,
// formatted once so the toast and the panel cannot disagree.
export function receiptLines(r: SubmissionReceipt): { label: string; value: string }[] {
  const at = new Date(r.submittedAt);
  return [
    { label: "Month", value: `${r.monthName} ${r.year}` },
    { label: "Submitted by", value: r.userName },
    {
      label: "Submitted at",
      value: Number.isNaN(at.getTime())
        ? r.submittedAt
        : at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
    },
    { label: "Submission ID", value: r.submissionId },
  ];
}

export function receiptHeadline(r: SubmissionReceipt): string {
  return `${r.monthName} Report was submitted successfully.`;
}
