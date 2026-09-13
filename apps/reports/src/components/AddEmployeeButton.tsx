"use client";

import { useState, useTransition } from "react";
import { addTeamMember } from "@/lib/employee-actions";

// The dashed "+ Add member" control at the bottom of a department card —
// matching Scheduler's own board control, wired to a real write this time
// (2026-08-18): addTeamMember() creates the person in Reports AND pushes them
// to Scheduler's team_members table, so they show up on both boards. Only
// rendered for ELT (see EmployeesCards.tsx — same permission addTeamMember
// itself enforces server-side, this is just the UI not offering a control
// that would be refused).
export function AddEmployeeButton({ disciplineCode }: { disciplineCode: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Not cleared on the next open/close — a Scheduler-push failure is worth
  // leaving visible under the button until the next successful add, since the
  // person IS in Reports already and this is the one place that says so.
  const [notice, setNotice] = useState<string | null>(null);

  function submit() {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setError(null);
    startTransition(async () => {
      const result = await addTeamMember(disciplineCode, trimmed);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName("");
      setOpen(false);
      setNotice(result.schedulerSynced ? null : "Added to Reports — couldn't reach Scheduler, use Reconcile later.");
    });
  }

  function cancel() {
    setOpen(false);
    setName("");
    setError(null);
  }

  return (
    <div className="m-1.5">
      {open ? (
        <div className="flex items-center gap-1.5">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape") cancel();
            }}
            placeholder="Full name"
            disabled={pending}
            className="min-w-0 flex-1 rounded-md border border-sdc-border px-2 py-1 text-sm text-sdc-navy outline-none focus:border-sdc-blue disabled:opacity-60"
          />
          <button
            type="button"
            onClick={submit}
            disabled={pending || !name.trim()}
            className="shrink-0 rounded-md bg-sdc-blue px-2 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Adding…" : "Add"}
          </button>
          <button type="button" onClick={cancel} disabled={pending} className="shrink-0 text-xs text-sdc-muted hover:text-sdc-navy">
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full rounded-md border border-dashed border-sdc-border px-2 py-1.5 text-center text-xs text-sdc-muted hover:border-sdc-blue hover:text-sdc-blue"
        >
          + Add member
        </button>
      )}
      {error && <p className="mt-1 text-xs text-sdc-red-text">{error}</p>}
      {notice && <p className="mt-1 text-xs text-sdc-muted">{notice}</p>}
    </div>
  );
}
