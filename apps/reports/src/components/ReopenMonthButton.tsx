"use client";

import { useEffect, useRef, useState } from "react";

// Reopening a submitted month unfreezes numbers that are already history, so it is
// gated behind a password prompt — the same "are you sure" gesture as the report
// submission, and the same phrase. The real check is server-side in
// reopenMonthlyReport, which unfreezes the ETC entries AND drops the Standard Sheet
// snapshot in one transaction; this only collects the answer.
//
// Deliberately NOT the session-cookie treatment that Save gets
// (etc-edit-gate.ts): Save is a thing you do dozens of times an hour, this is
// a thing you should have to mean each time.
//
// A popover rather than window.prompt() to match SubmitMonthReportButton and
// EtcRatesButton. Unlike that one — which calls a server action directly — this owns
// its own form, since reopening posts nothing but the password.
export function ReopenMonthButton({
  action,
  month,
  className,
  label = "Reopen for editing",
  hint,
  // The Standard Fees panel is 320px wide and this button sits at its left
  // edge, so a w-72 popover anchored left would hang off the card.
  align = "left",
}: {
  action: (formData: FormData) => Promise<void>;
  month: string;
  className?: string;
  label?: string;
  hint?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  // One click, one reopen (2026-08-04). Reopening unfreezes a month and re-derives its
  // Prior ETC chain; two submissions racing each other is not something to leave to an
  // impatient double-click or a repeated Enter key. Same guard as Submit ETC.
  const [submitting, setSubmitting] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function confirm() {
    if (password.length === 0 || submitting) return;
    setSubmitting(true);
    // Submit before clearing: closing the popover unmounts the form, and a
    // requestSubmit() on a form that's already gone silently does nothing.
    formRef.current?.requestSubmit();
    // The popover stays open, showing "Reopening…", until the action navigates. It
    // used to close immediately, which left nothing on screen acknowledging the
    // click — the same "it worked but nothing said so" complaint Save had.
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        className={className}
        disabled={submitting}
        title={`Unfreeze ${month} so its entries can be corrected.`}
        onClick={() => {
          setPassword("");
          setOpen((v) => !v);
        }}
      >
        {submitting ? "Reopening…" : label}
      </button>
      {open && (
        <div className={`absolute top-full z-30 mt-1 w-72 rounded-lg border border-sdc-border bg-white p-3 shadow-lg ${align === "right" ? "right-0" : "left-0"}`}>
          <p className="mb-1 text-xs font-semibold text-sdc-navy">Enter password to reopen {month}</p>
          {/* Says what reopening actually costs. The carry-forward is the part
              people don't expect, and it's the reason this isn't reversible by
              just locking the month again. */}
          <p className="mb-2 text-note leading-relaxed text-sdc-muted">
            {hint ??
              "This unfreezes every entry in the month. Re-submitting it afterwards carries the corrected New ETC forward into the next month's Prior ETC."}
          </p>
          <form ref={formRef} action={action}>
            <input type="hidden" name="reopenPassword" value={password} />
            <input
              ref={inputRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  // The hidden field already carries the value; let the click
                  // path do the submitting so both routes behave identically.
                  e.preventDefault();
                  confirm();
                }
              }}
              placeholder="Password"
              aria-label="Reopen month password"
              className="w-full rounded-md border border-sdc-border px-2 py-1.5 text-sm outline-none focus:border-sdc-blue"
            />
          </form>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-sm text-sdc-gray-600 hover:bg-sdc-gray-100"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={password.length === 0 || submitting}
              className="rounded-md bg-sdc-blue px-3 py-1.5 text-sm font-semibold text-white hover:bg-sdc-blue-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Reopening…" : "Reopen"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
