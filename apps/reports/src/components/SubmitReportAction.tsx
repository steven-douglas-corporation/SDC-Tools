"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { submitMonthlyReport, checkMonthlyReport, type MonthlyReportStatus } from "@/lib/monthly-report-actions";
import { flushEtcAutosave, flushPoolAutosave, isEtcDirty } from "@/lib/etc-dirty-tracker";
import { randomId } from "@/lib/client-uuid";
import { useRealtimeChanges } from "@/components/RealtimeProvider";
import {
  readinessLine,
  submitButtonLabel,
  confirmTitle,
  confirmBody,
  standardFeesSubmitBlurb,
  canOpenConfirm,
  canConfirmSubmit,
  canDismissDialog,
  didMonthChange,
  staleDialogMessage,
  failureExplanation,
  receiptLines,
  receiptHeadline,
  type SubmitContext,
  type SubmitPhase,
  type SubmissionReceipt,
  type FailureExplanation,
} from "@/lib/monthly-report-flow";

// ── `Submit {Month} Report`, at the bottom of the Standard Fees card (§26) ────
//
// Moved out of the Monthly ETC toolbar, where it sat between the filters and the Refresh
// button — beside the controls people press dozens of times an hour, which is the wrong
// neighbourhood for the one irreversible action on the page. It now lives under the
// figures it finalises, after the totals and the explanatory text.
//
// Three things it does that the toolbar version did not:
//   * READINESS, stated above the button and refreshed as data changes, so "can this
//     month be submitted" is answered before anybody clicks (§26.4).
//   * A CONFIRMATION dialog — an accessible in-app modal, not window.confirm (§26.5).
//   * A STALENESS check on confirm: the month is re-validated AND fingerprinted, so a
//     dialog left open while the month or the data moved refuses to submit (§26.6).
//
// The password prompt is gone with the move (§26.14). Authorization is now the Standard
// Sheet unlock — whoever can see this card can submit the month — and it is decided by
// `canSubmitMonthlyReport()` on the SERVER, both for whether this renders and for
// whether the action runs. A phrase typed into the browser was never an access control.
//
// The rules this component obeys — which of the seven states may click what, what the
// label says, how a failure is categorised — are NOT written here. They live in
// lib/monthly-report-flow.ts so they can be tested (tests/monthly-report-submit.test.ts);
// this file is the markup and the effects.

export function SubmitReportAction({
  month,
  monthName,
  // Read on the server so the first paint already knows whether the month is ready,
  // who may submit it, and what the data currently fingerprints to. Re-checked on
  // mount, on a month switch, and on every realtime change.
  initialStatus,
  locked,
}: {
  month: string;
  monthName: string;
  initialStatus: MonthlyReportStatus | null;
  locked: boolean;
}) {
  const [phase, setPhase] = useState<SubmitPhase>(initialStatus ? "ready" : "checking");
  const [status, setStatus] = useState<MonthlyReportStatus | null>(initialStatus);
  const [rechecking, setRechecking] = useState(false);
  const [failure, setFailure] = useState<FailureExplanation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(initialStatus?.submitted ?? null);
  const [pending, startTransition] = useTransition();
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  // The month the dialog was opened FOR, and the fingerprint the month had at that
  // moment. Both are what "stale" is measured against (§26.6).
  const dialogMonth = useRef<string | null>(null);
  const dialogFingerprint = useRef<string | null>(null);
  const confirmedAt = useRef<string | null>(null);

  // ── One id per ATTEMPT, not per click ─────────────────────────────────────
  //
  // The server is idempotent on this id: a retry that carries the same one returns
  // the first outcome instead of freezing the month twice. Generating a fresh id on
  // every confirm would throw that away — the retry would look like a brand-new
  // submission to the server, which is exactly the duplicate §26.16 #17 forbids.
  // Cleared only when an attempt reaches a terminal, non-retryable end.
  const attemptId = useRef<string | null>(null);

  const refreshStatus = useCallback(
    async (opts?: { showSpinner?: boolean }): Promise<MonthlyReportStatus | null> => {
      if (opts?.showSpinner) setRechecking(true);
      try {
        const s = await checkMonthlyReport(month);
        setStatus(s);
        if (s.submitted) setReceipt(s.submitted);
        return s;
      } catch {
        // A failed check is not a failed submission — leave the last known readiness
        // on screen rather than blanking it, and let the caller decide.
        return null;
      } finally {
        if (opts?.showSpinner) setRechecking(false);
      }
    },
    [month],
  );

  // On mount and whenever the month changes. Cancel-safe: a month switch must not let
  // an in-flight answer for the OLD month land on the new one.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const s = await checkMonthlyReport(month).catch(() => null);
      if (!alive) return;
      if (s) {
        setStatus(s);
        if (s.submitted) setReceipt(s.submitted);
      }
      // A month switch resets the workflow — the previous month's success banner or
      // error must not sit over a different month's figures.
      setPhase(s ? "ready" : "checking");
      setFailure(null);
      setNotice(null);
      attemptId.current = null;
    })();
    return () => {
      alive = false;
    };
  }, [month]);

  // ── Live readiness (§26.4 / §26.13) ───────────────────────────────────────
  //
  // Re-checked when the realtime feed reports ANY change, because a colleague filling in
  // the last outstanding New ETC cell is exactly the event that should turn this from
  // blocked to ready without anybody reloading. Keyed on the queue length rather than the
  // contents: this only needs "something changed", and the server is the judge of what.
  //
  // This is also how a submission by ANOTHER user reaches this tab: submitMonthlyReport
  // announces itself through the same feed, so every open card picks up the receipt and
  // stops offering a button (§26.13).
  const changes = useRealtimeChanges();
  const lastSeenChanges = useRef(changes.length);
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    if (changes.length === lastSeenChanges.current) return;
    lastSeenChanges.current = changes.length;
    let alive = true;
    void (async () => {
      // Mid-flight: the submission re-validates on its own, and moving the status line
      // under it would be noise.
      if (phaseRef.current === "submitting" || phaseRef.current === "validating") return;
      const s = await checkMonthlyReport(month).catch(() => null);
      if (!alive || !s) return;
      setStatus(s);
      if (s.submitted) {
        setReceipt(s.submitted);
        setPhase("submitted");
      }
    })();
    return () => {
      alive = false;
    };
  }, [changes.length, month]);

  // useCallback so the Escape/Tab effect below can depend on it honestly rather than
  // capturing a stale copy of `status`.
  const closeDialog = useCallback((reason: "cancelled" | "stale") => {
    dialogMonth.current = null;
    dialogFingerprint.current = null;
    // Cancel submits nothing and is not a failure — clear any leftover message so the
    // card goes back to plain readiness (§26.16 #10).
    if (reason === "cancelled") {
      setFailure(null);
      setNotice(null);
    }
    setPhase(status?.validation.ok ? "ready" : "blocked");
    // Return focus where it came from, or a keyboard user is stranded.
    openerRef.current?.focus();
  }, [status]);

  // ── The page behind the modal holds still (§36.11) ────────────────────────
  //
  // "Prevent background interaction while open" was only half true: the fixed overlay
  // swallowed clicks, but the wheel still scrolled the Monthly ETC grid underneath — so
  // the figures the dialog is asking about slid away behind it, and closing the dialog
  // left the page somewhere else than where it was opened.
  //
  // The scrollbar's width is compensated with padding-right rather than left alone,
  // because removing a 15px scrollbar reflows the whole page one notch wider — a layout
  // shift on every open and close, which is exactly what §36.14 is about.
  useEffect(() => {
    if (phase !== "confirming" && phase !== "submitting") return;
    const { body } = document;
    const previousOverflow = body.style.overflow;
    const previousPadding = body.style.paddingRight;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (gap > 0) body.style.paddingRight = `${gap}px`;
    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPadding;
    };
  }, [phase]);

  // ── Keyboard behaviour inside the dialog (§26.5) ──────────────────────────
  //
  // Escape closes — but only while the dialog is still just a question. Tab is trapped,
  // because a modal a keyboard user can tab out of is a modal in name only.
  useEffect(() => {
    if (phase !== "confirming") return;
    // Focus the DIALOG, not either button. Two reasons: a screen reader then reads the
    // title and body it is labelled by, and Enter does nothing until the user has
    // deliberately tabbed to an action — which is exactly what §26.5 asks for ("Enter
    // must not accidentally submit unless the confirmation action is clearly focused").
    headingRef.current?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeDialog("cancelled");
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === headingRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase, closeDialog]);

  // ── Opening the dialog (§26.6, "before opening") ──────────────────────────
  //
  // Eligibility, validation, pending saves and permission are all confirmed BEFORE the
  // question is asked. A dialog that opens on a month it cannot actually submit is a
  // dialog that will fail after the user has committed to it.
  function openDialog() {
    setFailure(null);
    setNotice(null);
    setPhase("validating");
    startTransition(async () => {
      // A draft still on the autosave debounce would simply not be in the month the
      // submission freezes — it reads the database, not this form. Both grids: the
      // ETC cells and the Standard Fees pool cells debounce independently.
      if (isEtcDirty()) await flushEtcAutosave();
      await flushPoolAutosave();

      const fresh = await refreshStatus({ showSpinner: true });
      if (fresh === null) {
        setPhase("failed");
        setFailure(failureExplanation("network", `Could not check whether ${monthName} is ready to submit.`));
        return;
      }
      if (!fresh.permitted) {
        setPhase("blocked");
        setFailure(failureExplanation("permission", "You are not authorised to submit this report."));
        return;
      }
      if (fresh.submitted) {
        setReceipt(fresh.submitted);
        setPhase("submitted");
        return;
      }
      if (!fresh.validation.ok) {
        // The button is disabled in this state anyway; this covers the case where the
        // data moved between the last readiness check and the click.
        setPhase("blocked");
        setNotice(`${monthName} is not ready to submit — see the outstanding items above.`);
        return;
      }
      dialogMonth.current = month;
      dialogFingerprint.current = fresh.fingerprint;
      setPhase("confirming");
    });
  }

  // ── Confirming (§26.6, "before processing the confirmed submission") ──────
  //
  // ── The whole synchronous prelude is guarded, deliberately ────────────────
  //
  // This handler used to mint the submission id with a bare `crypto.randomUUID()`,
  // which is undefined on this app's own origin (plain HTTP on a LAN hostname is
  // not a secure context — see lib/client-uuid.ts). It threw right here, ABOVE
  // `setPhase("submitting")` and ABOVE `startTransition`, and outside the
  // try/catch that guards the request itself. The result was the worst failure a
  // button can have: the click did nothing whatsoever — no request, no
  // "Submitting…", no error on screen, nothing in the server log — and the dialog
  // sat there looking perfectly functional.
  //
  // `randomId()` is now contracted never to throw, so this catch should be
  // unreachable. It stays because that is exactly what was assumed last time. Any
  // synchronous fault before `startTransition` means NOTHING was sent, so the one
  // correct response is to say so where the user is already looking, rather than
  // to fail silently and leave them clicking a dead control.
  function confirmSubmit() {
    if (pending) return; // one confirm, one submission
    // The month cannot have changed without this component re-rendering with a new
    // prop, so a mismatch means the dialog belongs to a month nobody is looking at.
    if (dialogMonth.current == null || didMonthChange(dialogMonth.current, month)) {
      setNotice(staleDialogMessage(monthName, "month"));
      closeDialog("stale");
      return;
    }

    // Guarded because reaching `startTransition` is what makes the click visible:
    // anything that throws above it leaves the user staring at a dead button.
    let submissionId: string;
    try {
      confirmedAt.current = new Date().toISOString();
      if (!attemptId.current) attemptId.current = randomId();
      submissionId = attemptId.current;
    } catch (err) {
      // Nothing has been sent, so the month is untouched and every figure is still
      // saved — `browser` says exactly that. Logged as well as shown, because the
      // console is where the last instance of this was ultimately found.
      console.error("[submit-report] could not prepare the submission in this browser", err);
      setPhase("failed");
      dialogMonth.current = null;
      setFailure(
        failureExplanation("browser", "This browser could not start the submission."),
      );
      return;
    }

    const fingerprint = dialogFingerprint.current;
    setPhase("submitting");

    startTransition(async () => {
      // Pending saves again: an edit could have landed while the dialog was open. This
      // runs BEFORE the staleness check on the server, so this user's own unsaved work
      // cannot read as somebody else's change.
      if (isEtcDirty()) await flushEtcAutosave();
      await flushPoolAutosave();

      let result: Awaited<ReturnType<typeof submitMonthlyReport>>;
      try {
        result = await submitMonthlyReport(month, {
          submissionId,
          fingerprint,
          confirmedAt: confirmedAt.current ?? undefined,
        });
      } catch {
        // Either the request never reached the server, or it did and something AFTER
        // the commit threw on the way back (a downstream step in submitMonthlyReport —
        // see the guard added there, kept here as a second line of defence for any
        // failure mode like it). Those two look identical from here: a rejected
        // promise, no response. Ask the server what actually happened before
        // reporting a failure — the whole point of the idempotency key is that a
        // submission which DID land is discoverable by month, not just by this one
        // response. Guessing "network" without checking is how a real, committed
        // submission got told to the user as a failure, with no receipt, while the
        // database already had the month locked.
        const recheck = await refreshStatus().catch(() => null);
        if (recheck?.submitted) {
          attemptId.current = null;
          dialogMonth.current = null;
          setReceipt(recheck.submitted);
          setPhase("submitted");
          setFailure(null);
          setNotice(null);
          return;
        }
        // The attempt id is deliberately KEPT: if the submission did land after all
        // (this recheck itself failed, say), the retry will find it and report the
        // first outcome rather than freezing the month a second time (§26.9).
        setPhase("failed");
        dialogMonth.current = null;
        setFailure(failureExplanation("network", "The submission could not reach the server."));
        return;
      }

      if (result.ok) {
        attemptId.current = null;
        dialogMonth.current = null;
        setReceipt(result.receipt);
        setPhase("submitted");
        setFailure(null);
        setNotice(
          result.duplicate
            ? "That request had already been submitted — nothing was submitted twice."
            : null,
        );
        return;
      }

      // Refused. The dialog closes either way — leaving it open over a message the
      // user has to read behind it helps nobody — and the reason lands next to the
      // button, where the readiness line is (§26.9).
      dialogMonth.current = null;
      setPhase("failed");
      setFailure(failureExplanation(result.reason, result.message));
      // A retry of these would be refused for the same reason; a fresh attempt after
      // fixing the data deserves a fresh id.
      if (result.reason === "validation" || result.reason === "duplicate" || result.reason === "permission") {
        attemptId.current = null;
      }
      // Re-read rather than patching from the response: for a conflict or a duplicate
      // the whole point is that the server knows something this tab did not.
      await refreshStatus();
    });
  }

  // ── Nothing to render at all without permission (§26.14) ──────────────────
  //
  // The server decides. Rendering a disabled button for someone who may never use it
  // is noise in a 320px panel.
  if (status && !status.permitted && !locked) return null;

  const ctx: SubmitContext = {
    phase,
    monthName,
    permitted: status?.permitted ?? true,
    validation: status?.validation ?? null,
    pendingSaves: false,
  };
  const readiness = readinessLine(ctx);
  const canOpen = canOpenConfirm(ctx);
  const busy = phase === "validating" || phase === "submitting" || pending;

  // ── Submitted: the receipt, in the place they were looking (§26.8) ────────
  if (locked || phase === "submitted") {
    return (
      <div className="flex flex-col gap-1.5 border-t border-sdc-border bg-sdc-gray-50 px-3 py-3">
        <p aria-live="polite" className="text-note font-semibold text-sdc-green-text">
          {receipt ? receiptHeadline(receipt) : `${monthName} Report Submitted`}
        </p>
        {notice && <p className="text-label leading-relaxed text-sdc-gray-600">{notice}</p>}
        {receipt && (
          <dl className="space-y-0.5 text-label leading-snug text-sdc-gray-600">
            {receiptLines(receipt).map((l) => (
              <div key={l.label} className="flex justify-between gap-2">
                <dt className="shrink-0 text-sdc-muted">{l.label}</dt>
                <dd className={`truncate text-right ${l.label === "Submission ID" ? "font-mono text-micro text-sdc-gray-400" : ""}`} title={l.value}>
                  {l.value}
                </dd>
              </div>
            ))}
            {receipt.entriesSubmitted > 0 && (
              <div className="flex justify-between gap-2">
                <dt className="shrink-0 text-sdc-muted">Frozen</dt>
                <dd className="text-right">
                  {receipt.entriesSubmitted} ETC entries · {receipt.standardRows} Standard Fees rows
                </dd>
              </div>
            )}
          </dl>
        )}
        <p className="text-label leading-relaxed text-sdc-muted">
          Use &ldquo;Reopen for editing&rdquo; in the toolbar above if a correction is needed — it unfreezes the whole month.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-sdc-border bg-sdc-gray-50 px-3 py-3">
      {/* §26.12: says what the button does and names the month, and no longer points at
          a toolbar button that has moved here. */}
      <p className="text-note leading-relaxed text-sdc-gray-600">{standardFeesSubmitBlurb(monthName)}</p>

      {/* Readiness, immediately above the button (§26.4). aria-live so a screen reader
          hears it change when a colleague clears the last outstanding cell. */}
      <div aria-live="polite">
        <p
          className={`text-note font-medium ${
            readiness.tone === "ok" ? "text-sdc-green-text" : readiness.tone === "blocked" ? "text-sdc-red-text" : "text-sdc-gray-600"
          }`}
        >
          {readiness.text}
          {rechecking && status ? " (re-checking…)" : ""}
        </p>
        {readiness.detail && <p className="text-label leading-relaxed text-sdc-gray-600">{readiness.detail}</p>}
      </div>

      {/* The affected tab, project, row and field — enough to go and fix it (§26.4). */}
      {status && !status.validation.ok && status.validation.issues.length > 0 && (
        <ul className="styled-scrollbar max-h-32 space-y-1 overflow-auto rounded border border-sdc-red-border bg-sdc-red-bg p-1.5">
          {status.validation.issues.slice(0, 8).map((iss, i) => (
            <li key={i} className="text-label leading-snug text-sdc-red-text">
              <span className="font-semibold">{iss.section}</span>
              {" · "}
              {iss.rowRef}
              {iss.department && ` · ${iss.department}`}
              {iss.column && ` · ${iss.column}`}
            </li>
          ))}
          {status.validation.totalIssues > 8 && (
            <li className="text-label text-sdc-gray-600">
              …and {status.validation.totalIssues - 8} more (the yellow cells in the grid are the full list).
            </li>
          )}
        </ul>
      )}

      <button
        ref={openerRef}
        type="button"
        disabled={!canOpen || busy}
        onClick={openDialog}
        title={
          canOpen
            ? `Finalize the whole ${monthName} report. You will be asked to confirm.`
            : "Fix the outstanding items above before submitting."
        }
        // w-full, so the label changing between "Submit July 2026 Report", "Checking…"
        // and "Submitting…" cannot resize it (§36.3). truncate rather than wrap, so a
        // long month name in a narrow panel clips instead of growing the button's height.
        className="motion-interactive w-full truncate rounded-md bg-sdc-blue px-3 py-2 text-xs font-semibold text-white hover:bg-sdc-blue-dark disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitButtonLabel(ctx)}
      </button>

      {/* Failure and stale-confirmation messages, near the button (§26.8/§26.9). */}
      {failure && (
        <p aria-live="assertive" className="text-label leading-relaxed font-medium text-sdc-red-text">
          <span className="font-semibold">{failure.category}:</span> {failure.text}
          {failure.retryable && " Press the button again to retry — it is safe."}
        </p>
      )}
      {notice && !failure && <p aria-live="polite" className="text-label leading-relaxed text-sdc-gray-600">{notice}</p>}

      {/* ── The confirmation dialog (§26.5) ────────────────────────────────────
          An in-app modal, not window.confirm: it has to name the month, list what is
          being finalized, be keyboard-navigable, and be dismissable by Escape or by
          clicking outside — none of which a native confirm can do. The backdrop click
          CANCELS; there is no path from it to a submission. */}
      {(phase === "confirming" || phase === "submitting") && (
        <div
          // motion-overlay/motion-dialog: a fade on the scrim and a 4px rise on the
          // panel, both at --motion-panel. Deliberately no scale and no bounce — §36.11
          // names both — and nothing here animates a size, so the page behind does not
          // reflow. Closing is instant, which §36.11 also asks for outright ("close
          // immediately when cancelled"): a cancel that lingers reads as a click that
          // did not register.
          className="motion-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => {
            // Outside the panel only, and it cancels — never submits (§26.16 #11).
            // Refused mid-submission, so the modal cannot be dismissed out from under a
            // transaction whose outcome the user has no other way to see.
            if (!canDismissDialog(phase)) return;
            if (!dialogRef.current?.contains(e.target as Node)) closeDialog("cancelled");
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="submit-report-title"
            aria-describedby="submit-report-body"
            className="motion-dialog w-full max-w-md rounded-xl border border-sdc-border bg-white p-5 shadow-xl"
          >
            {/* tabIndex -1 so focus can land on the heading without it being a tab stop:
                the screen reader reads the dialog, and Enter has nothing to activate. */}
            <h2 ref={headingRef} tabIndex={-1} id="submit-report-title" className="mb-2 text-sm font-semibold text-sdc-navy outline-none">
              {confirmTitle(monthName)}
            </h2>
            <p id="submit-report-body" className="mb-4 text-xs leading-relaxed text-sdc-gray-600">
              {confirmBody(monthName)}
            </p>
            {/* The progress line's ROW is always here, empty until there is something to
                say (§36.11: "avoid shifting the page", §36.14: "do not change element
                height during loading"). It used to be mounted only while busy, so
                confirming grew the dialog by a line and re-centred it in the viewport at
                the exact moment the user was watching for a result. min-h, not a
                non-breaking space: the height comes from the line-height the text will
                actually use. */}
            <p aria-live="polite" className="mb-3 min-h-[1.1rem] text-note font-medium text-sdc-gray-600">
              {busy ? submitButtonLabel(ctx) : ""}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => closeDialog("cancelled")}
                disabled={!canDismissDialog(phase)}
                className="motion-interactive rounded-md px-3 py-1.5 text-sm text-sdc-gray-600 hover:bg-sdc-gray-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmSubmit}
                // Disabled the moment it is clicked (§26.7): the phase leaves `confirming`
                // and never returns to it, so the second click of a double-click lands on
                // a dead control. The server's idempotency key is the backstop, not the
                // first line of defence.
                disabled={!canConfirmSubmit(ctx) || busy}
                className="motion-interactive inline-flex items-center gap-1.5 rounded-md bg-sdc-blue px-3 py-1.5 text-sm font-semibold text-white hover:bg-sdc-blue-dark disabled:cursor-not-allowed disabled:opacity-50"
              >
                {/* The LABEL no longer changes (§36.3: "button labels must not shift
                    unexpectedly"). It used to become `Submitting July 2026 report…` — half
                    again as wide as "Yes, Submit Report" — which moved Cancel sideways
                    under a cursor that had just left it. A spinner takes the width it
                    needs beside the unchanged label, and the line above already states
                    the phase in words. */}
                {busy && (
                  <svg viewBox="0 0 16 16" width="12" height="12" className="shrink-0 animate-spin" aria-hidden>
                    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
                    <path d="M8 2 a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                )}
                Yes, Submit Report
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
