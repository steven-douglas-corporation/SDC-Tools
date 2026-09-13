"use server";

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { logAudit } from "@/lib/audit";
import { recordChanges } from "@/lib/change-log";
import { matchesButtonPassword } from "@/lib/button-password";
import { isStandardSheetUnlocked } from "@/lib/standard-sheet-gate";
import { hasPermission } from "@/lib/permissions";
import { assertActionPermission } from "@/lib/require-permission";
import { isValidMonth } from "@/lib/etc";
import { cascadePriorEtcForward, derivePriorEtcForMonth } from "@/lib/etc-prior-etc";
import {
  validateMonthlyReport,
  submitEtcEntriesInTx,
  loadStandardSheetRows,
  recordSubmission,
  readSubmission,
  readLatestSubmissionForMonth,
  monthDataFingerprint,
  type MonthlyReportValidation,
  type ReportSection,
} from "@/lib/monthly-report";
import { isMonthDataStale, type SubmissionReceipt, type SubmitFailureReason } from "@/lib/monthly-report-flow";

// ── `Submit {Month} Report` — the single finalising action ───────────────────
//
// Replaces "Submit ETC" and "Submit Standard Sheet", which were two independent
// buttons freezing two tables with nothing tying them together (see lib/monthly-report.ts
// for why that was the real problem and not just a UI wart).
//
// Everything it needs comes from the DATABASE. There is no form payload: autosave has
// already persisted every edit, so the freshest truth is in MySQL. That removes the
// whole class of failure the old path had — a stale tab freezing its own DOM snapshot
// over colleagues' saved work, and a Columns filter making the month unsubmittable
// because the hidden sections' inputs were not in the form.

export type SubmitReportResult =
  | { ok: true; duplicate: boolean; receipt: SubmissionReceipt }
  | { ok: false; reason: SubmitFailureReason; message: string; validation?: MonthlyReportValidation; submissionId?: string };

const SECTIONS: ReportSection[] = ["Monthly ETC", "Standard Sheet", "Standard Card"];

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long" })} ${y}`;
}

function monthNameOnly(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long" });
}

// ── Who may submit (§26.14) ──────────────────────────────────────────────────
//
// The password FIELD is gone. It used to sit in the submission popover, which meant
// the one irreversible action on the page was guarded by a phrase typed at the moment
// of the click — and §26.14 asks for a permission the BACKEND enforces instead, with
// no frontend prompt.
//
// The permission is the Standard Sheet unlock, and it is the natural one now that the
// button lives inside the Standard Fees card (§26.1): whoever can see that card can
// submit the month, and nobody else can. It is checked server-side against an HMAC
// cookie (lib/standard-sheet-gate.ts), so it is not a phrase shipped to the browser,
// and a signed-out or locked caller is refused here — which is what stops a captured
// server-action id from submitting a month straight from a console (§26.14).
//
// Same function decides whether the BUTTON is rendered and whether the SUBMISSION is
// allowed, so the two can never disagree.
export async function canSubmitMonthlyReport(): Promise<boolean> {
  const session = await auth();
  if (!session?.user) return false;
  // BOTH, not either (2026-09-01). The Standard Sheet unlock stays exactly as
  // it was — an HMAC cookie, re-entered every time, which is what stops a
  // captured server-action id from finalising a month from a console. The role
  // check is a second, independent question: is finalising the month something
  // this role is allowed to do at all?
  //
  // Before this, the answer was "anyone signed in who can unlock the Standard
  // Fees card", which included the base ALL role. The migration seeds
  // monthly-etc:submit ON wherever monthly-etc:view was already on, so nobody
  // loses the ability on deploy — narrowing it is a deliberate untick on the
  // Role Permissions page. PM is seeded OFF: a PM fills the grid in, somebody
  // with submit rights closes the month.
  if (!hasPermission(session.user.role, "monthly-etc:submit")) return false;
  return isStandardSheetUnlocked();
}

// What the readiness line above the button is computed from (§26.4), and what the
// confirmation dialog is checked against when it is finally confirmed (§26.6).
export type MonthlyReportStatus = {
  validation: MonthlyReportValidation;
  // See monthDataFingerprint: the browser hands this back on confirm, and a
  // fingerprint that has moved stops the submission.
  fingerprint: string | null;
  permitted: boolean;
  // A month somebody has already finalised — including one finalised by another
  // user while this tab sat on the readiness it fetched at page load (§26.13).
  submitted: SubmissionReceipt | null;
};

// One round trip, because this is called on every realtime change event for every
// tab with the Standard Fees card open.
export async function checkMonthlyReport(month: string): Promise<MonthlyReportStatus> {
  const [validation, fingerprint, permitted, existing] = await Promise.all([
    validateMonthlyReport(month),
    monthDataFingerprint(month),
    canSubmitMonthlyReport(),
    readLatestSubmissionForMonth(month),
  ]);
  return { validation, fingerprint, permitted, submitted: existing ? toReceipt(existing) : null };
}

function toReceipt(r: {
  submissionId: string; month: string; year: number; userName: string; at: string;
}, counts?: { entriesSubmitted: number; standardRows: number }): SubmissionReceipt {
  return {
    month: r.month,
    monthName: monthNameOnly(r.month),
    year: r.year,
    userName: r.userName,
    submittedAt: r.at,
    submissionId: r.submissionId,
    entriesSubmitted: counts?.entriesSubmitted ?? 0,
    standardRows: counts?.standardRows ?? 0,
  };
}

export async function submitMonthlyReport(
  month: string,
  input: {
    submissionId: string;
    // The fingerprint the browser last saw. Compared against the month as it is NOW;
    // a mismatch means somebody saved while the dialog was open (§26.6).
    fingerprint: string | null;
    // When "Yes, Submit Report" was pressed, for the audit record (§26.15).
    confirmedAt?: string;
  },
): Promise<SubmitReportResult> {
  const startedAt = new Date();
  const confirmedAt = input.confirmedAt ? new Date(input.confirmedAt) : null;

  if (!isValidMonth(month)) {
    return { ok: false, reason: "month", message: `"${month}" is not a valid month.` };
  }

  // ── Idempotency, before anything else ─────────────────────────────────────
  //
  // The client generates the id once per attempt and re-sends it on a retry, so a
  // double-click that beat the disabled state — or a retried request after a network
  // blip — lands here with an id that has already been recorded. Return that outcome
  // instead of submitting the month twice.
  const existing = await readSubmission(input.submissionId);
  if (existing) {
    if (existing.status === "submitted") {
      return { ok: true, duplicate: true, receipt: toReceipt(existing) };
    }
    // A previously FAILED attempt with the same id is allowed to be retried: nothing
    // was written, so there is nothing to duplicate. Fall through.
  }

  // ── Permission, server-side (§26.14) ──────────────────────────────────────
  //
  // Before anything is read or written, and independent of what the browser
  // rendered: a server action is an HTTP endpoint, so "the button was not shown"
  // is not a check.
  if (!(await canSubmitMonthlyReport())) {
    return {
      ok: false,
      reason: "permission",
      message: "You are not authorised to submit this report — the Standard Fees card is locked for this session.",
    };
  }

  // ── Somebody else already finalised this month (§26.6, §26.13) ────────────
  //
  // A different id, the same month. Two managers can be looking at the same open
  // dialog; the second one to confirm must be told that, by name, rather than
  // getting "this month is already submitted and locked" out of the transaction.
  const alreadySubmitted = await readLatestSubmissionForMonth(month);
  if (alreadySubmitted) {
    return {
      ok: false,
      reason: "duplicate",
      message:
        `${monthLabel(month)} was already submitted by ${alreadySubmitted.userName} ` +
        `at ${new Date(alreadySubmitted.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}. ` +
        `Nothing was submitted twice.`,
    };
  }

  // ── Did the month move while the dialog was open? (§26.6, §26.16 #15/#16) ─
  //
  // Checked AFTER the flush the button performs on the browser side, so this
  // user's own pending saves have already landed and cannot read as somebody
  // else's change.
  const currentFingerprint = await monthDataFingerprint(month);
  if (isMonthDataStale(input.fingerprint, currentFingerprint)) {
    return {
      ok: false,
      reason: "conflict",
      message:
        `${monthLabel(month)} changed while the confirmation window was open, so nothing was submitted. ` +
        `Review the latest figures and submit again — your own edits are saved.`,
    };
  }

  const session = await auth();
  const user = session?.user as { id?: string; name?: string | null; email?: string | null } | undefined;
  const userId = user?.id ? Number(user.id) : null;
  const userName = user?.name?.trim() || user?.email?.split("@")[0] || "Unknown user";

  // ── Validate the whole package first ──────────────────────────────────────
  const validation = await validateMonthlyReport(month);
  if (!validation.ok) {
    // A refused attempt is still an attempt, and "why could I not submit at 4pm" is
    // exactly what the record is for.
    await recordSubmission({
      submissionId: input.submissionId,
      month,
      userId,
      userName,
      status: "failed",
      sections: validation.sections,
      validation,
      failureReason: `${validation.totalIssues} validation issue(s)`,
      confirmedAt, startedAt, completedAt: new Date(),
    });
    return {
      ok: false,
      reason: "validation",
      message:
        validation.counts.missingNewEtc > 0
          ? `${validation.counts.missingNewEtc} New ETC value${validation.counts.missingNewEtc === 1 ? "" : "s"} still needed before ${monthLabel(month)} can be submitted.`
          : `${monthLabel(month)} is not ready to submit.`,
      validation,
      submissionId: input.submissionId,
    };
  }

  // Read the Standard rows BEFORE the transaction: they are pure reads (and one of
  // them crosses into the pool ledger), and holding row locks while computing fees
  // would keep the grid waiting for no reason.
  let standardRows: Awaited<ReturnType<typeof loadStandardSheetRows>>;
  try {
    standardRows = await loadStandardSheetRows(month);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not compute the Standard Sheet rows.";
    await recordSubmission({
      submissionId: input.submissionId, month, userId, userName, status: "failed",
      sections: SECTIONS, validation, failureReason: message,
      confirmedAt, startedAt, completedAt: new Date(),
    });
    return { ok: false, reason: "error", message, submissionId: input.submissionId };
  }

  // ── One transaction, every section ────────────────────────────────────────
  //
  // Either the month is finalised or nothing is. This is the property the two old
  // buttons could not have: an ETC freeze that succeeded while the fee snapshot failed
  // used to leave the month permanently half-submitted, and no later action noticed.
  let entriesSubmitted = 0;
  try {
    await prisma.$transaction(
      async (tx) => {
        entriesSubmitted = await submitEtcEntriesInTx(tx, month, userId);
        await tx.standardSheetSnapshot.deleteMany({ where: { month } });
        if (standardRows.length > 0) {
          await tx.standardSheetSnapshot.createMany({
            data: standardRows.map((r) => ({ ...r, submittedById: userId ?? null })),
          });
        }
      },
      { timeout: 30_000 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "The submission could not be completed.";
    await recordSubmission({
      submissionId: input.submissionId, month, userId, userName, status: "failed",
      sections: SECTIONS, validation, failureReason: message,
      confirmedAt, startedAt, completedAt: new Date(),
    });
    return { ok: false, reason: "error", message, submissionId: input.submissionId };
  }

  // Recorded AFTER the writes commit, so a row in this table means the month really is
  // frozen. (The idempotency check above therefore also protects against a retry that
  // arrives while the first transaction is still running — the second one blocks on the
  // same rows and then finds the month already locked, which submitEtcEntriesInTx
  // refuses outright.)
  const completedAt = new Date();
  await recordSubmission({
    submissionId: input.submissionId,
    month,
    userId,
    userName,
    status: "submitted",
    sections: SECTIONS,
    validation,
    failureReason: null,
    confirmedAt, startedAt, completedAt,
  });

  // Push the freshly-locked New ETC values into the months that derive their Prior ETC
  // from them. A no-op on the current month; on a reopened historical month it is the
  // whole point of the correction.
  //
  // Best-effort past this point, the same way recordChanges/logAudit already are — and
  // for the same reason: the month IS submitted. The transaction above committed and
  // recordSubmission just wrote status "submitted", so a throw here must not propagate
  // out of this function the way it used to. It would reach the client's catch block as
  // a "the submission could not reach the server" network failure — reporting a real,
  // committed submission as a failure, with no receipt, while the database already has
  // the month locked. (A retry used to half-recover, since checkMonthlyReport's
  // `submitted` lookup would find it — but only on a SECOND click, after the first one
  // told the user it failed.)
  let cascade: Awaited<ReturnType<typeof cascadePriorEtcForward>> = {
    monthsUpdated: [],
    entriesUpdated: 0,
    stoppedAtLockedMonth: null,
  };
  let cascadeError: string | null = null;
  try {
    cascade = await cascadePriorEtcForward(month);
  } catch (err) {
    cascadeError = err instanceof Error ? err.message : String(err);
    console.error("[monthly-report] cascade to later months failed after a successful submission", month, err);
  }

  // Announced to every connected browser: no cellKey, so each tab takes the throttled
  // route refresh (LiveRefresh) — which is right here, because a submission changes
  // every figure on the page rather than one cell.
  await recordChanges(
    [
      {
        tab: "Monthly Report",
        rowRef: monthLabel(month),
        columnName: "Submission",
        previousValue: "open",
        newValue: "submitted",
        changeType: "edited",
        entityType: "MonthlyReportSubmission",
        entityId: input.submissionId,
      },
    ],
    { action: "report.submitMonth" },
  );

  await logAudit({
    action: "report.submitMonth",
    entityType: "MonthlyReportSubmission",
    entityId: month,
    summary:
      `Submitted ${monthLabel(month)} report — ${entriesSubmitted} ETC entr${entriesSubmitted === 1 ? "y" : "ies"}, ` +
      `${standardRows.length} Standard Sheet row(s)` +
      (cascade.entriesUpdated > 0 ? ` — carried forward into ${cascade.monthsUpdated.join(", ")}` : "") +
      (cascadeError ? ` — WARNING: cascade to later months failed (${cascadeError}); re-run it for ${month} manually` : ""),
    // §26.15 — everything the audit record is asked to carry that is not already a
    // column on MonthlyReportSubmission (which holds month, year, userId, userName,
    // status, appVersion, the validation result and the three timestamps).
    metadata: {
      submissionId: input.submissionId,
      sections: SECTIONS,
      cascade,
      cascadeError,
      counts: validation.counts,
      validationOk: validation.ok,
      confirmedAt: confirmedAt?.toISOString() ?? null,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
    },
  });

  revalidatePath("/etc");
  return {
    ok: true,
    duplicate: false,
    receipt: {
      month,
      monthName: monthNameOnly(month),
      year: Number(month.slice(0, 4)),
      userName,
      submittedAt: completedAt.toISOString(),
      submissionId: input.submissionId,
      entriesSubmitted,
      standardRows: standardRows.length,
    },
  };
}

// ── Reopening is unified too ─────────────────────────────────────────────────
//
// It has to be. If submission is atomic across both sections, a reopen that unfroze
// only the ETC side would recreate by hand exactly the half-submitted month the
// consolidation exists to prevent — ETC editable while the fees derived from it stay
// frozen. One action, both tables.
export async function reopenMonthlyReport(month: string, formData: FormData): Promise<void> {
  // Same permission as submitting — reopening undoes a submission. Additional
  // to the password below, never a replacement for it.
  await assertActionPermission("monthly-etc:submit");
  if (!isValidMonth(month)) throw new Error(`"${month}" is not a valid month.`);
  if (!matchesButtonPassword(String(formData.get("reopenPassword") ?? ""), "submit")) {
    throw new Error("Incorrect password — the month was not reopened.");
  }

  let entriesReopened = 0;
  let snapshotsDropped = 0;
  await prisma.$transaction(async (tx) => {
    entriesReopened = (await tx.etcEntry.updateMany({ where: { month }, data: { needsReview: true } })).count;
    snapshotsDropped = (await tx.standardSheetSnapshot.deleteMany({ where: { month } })).count;
  });

  // Re-derive Prior ETC on the way back in: a correction made to an EARLIER month
  // while this one was locked could not be pushed into it (cascadePriorEtcForward
  // refuses to write to a locked month), so the balance it reopens with must be
  // recomputed rather than trusted. See lib/etc-prior-etc.ts and DEVLOG §13.
  const rederived = await derivePriorEtcForMonth(month);

  await logAudit({
    action: "report.reopenMonth",
    entityType: "MonthlyReportSubmission",
    entityId: month,
    summary:
      `Reopened ${monthLabel(month)} report — ${entriesReopened} ETC entr${entriesReopened === 1 ? "y" : "ies"} unfrozen, ` +
      `${snapshotsDropped} Standard Sheet row(s) dropped` +
      (rederived.entriesUpdated > 0 ? `, ${rederived.entriesUpdated} Prior ETC re-derived` : ""),
    metadata: { entriesReopened, snapshotsDropped, rederived },
  });

  await recordChanges(
    [
      {
        tab: "Monthly Report",
        rowRef: monthLabel(month),
        columnName: "Submission",
        previousValue: "submitted",
        newValue: "open",
        changeType: "edited",
        entityType: "MonthlyReportSubmission",
        entityId: month,
      },
    ],
    { action: "report.reopenMonth" },
  );

  revalidatePath("/etc");
}
