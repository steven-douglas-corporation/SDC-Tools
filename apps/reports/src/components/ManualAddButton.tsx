"use client";

import { useState, useTransition } from "react";
import { manualAddPerson } from "@/lib/employee-actions";

// "Manual add" on an Org chart team card (2026-10-29; replaces Cards' "Add
// member"): adds someone not in Paylocity, a contractor, to that card. A row at
// the card's foot, after Contractors and above the open positions, the same
// shape as "Request a hire" beneath it; it opens into a name field in place. (It
// was a "+" in the card header first, which read as unclear.)
//
// The card supplies the team and the supervisor that places them
// (manualAddPerson). Shown only to someone with employees:edit. The page
// refreshes itself afterwards (the action revalidates /employees), so the new
// person appears under the card's Contractors.
export function ManualAddButton({ team, teamTitle, supervisorId }: { team: string; teamTitle: string; supervisorId: number }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Left showing after the form closes: the person IS in Reports, and this is
  // the one place that says the Scheduler half didn't take.
  const [notice, setNotice] = useState<string | null>(null);

  function submit() {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setError(null);
    startTransition(async () => {
      const result = await manualAddPerson(team, supervisorId, trimmed);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName("");
      setOpen(false);
      setNotice(result.schedulerSynced ? null : `Added ${trimmed} — couldn't reach Scheduler, so they aren't on its board yet.`);
    });
  }

  function cancel() {
    setOpen(false);
    setName("");
    setError(null);
  }

  return (
    <div className="border-t border-dashed border-sdc-border">
      {open ? (
        <div className="px-3 py-2">
          <p className="mb-1.5 text-note text-sdc-muted">Someone not in Paylocity, such as a contractor. They go under Contractors on this card.</p>
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
              aria-label={`Full name of the person to add to ${teamTitle}`}
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
          {error && <p className="mt-1 text-xs text-sdc-red-text">{error}</p>}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            setOpen(true);
          }}
          title={`Add someone not in Paylocity, such as a contractor, to ${teamTitle}`}
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs font-semibold text-sdc-muted hover:bg-sdc-gray-50 hover:text-sdc-navy"
        >
          <span aria-hidden="true">+</span>
          <span>Manual add</span>
        </button>
      )}
      {notice && !open && <p className="px-3 pb-1.5 text-xs text-sdc-muted">{notice}</p>}
    </div>
  );
}
