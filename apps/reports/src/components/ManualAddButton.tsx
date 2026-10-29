"use client";

import { useState, useTransition } from "react";
import { manualAddPerson } from "@/lib/employee-actions";

// The "+" in an Org chart team card's header (2026-10-29; replaces Cards' "Add
// member"): adds someone not in Paylocity, a contractor, to that card. The card
// supplies the team and the supervisor that places them (manualAddPerson). Shown
// only to someone with employees:edit. The page refreshes itself afterwards
// (the action revalidates /employees), so the new person appears under the
// card's Contractors.
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
    <>
      <button
        type="button"
        onClick={() => (open ? cancel() : setOpen(true))}
        title="Manual add"
        aria-label={`Manual add to ${teamTitle}`}
        aria-expanded={open}
        className="grid size-5 shrink-0 place-items-center rounded text-base leading-none opacity-60 motion-interactive hover:bg-white/40 hover:opacity-100"
      >
        +
      </button>
      {(open || error || notice) && (
        // Drops down over the card's first rows, inside the card's width.
        <div className="absolute inset-x-1.5 top-full z-10 mt-1 rounded-lg border border-sdc-border bg-white p-2 text-sdc-navy shadow-lg">
          {open && (
            <>
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
                  aria-label="Full name"
                  disabled={pending}
                  className="min-w-0 flex-1 rounded-md border border-sdc-border px-2 py-1 text-sm font-normal text-sdc-navy outline-none focus:border-sdc-blue disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={submit}
                  disabled={pending || !name.trim()}
                  className="shrink-0 rounded-md bg-sdc-blue px-2 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pending ? "Adding…" : "Add"}
                </button>
                <button type="button" onClick={cancel} disabled={pending} className="shrink-0 text-xs font-normal text-sdc-muted hover:text-sdc-navy">
                  Cancel
                </button>
              </div>
            </>
          )}
          {error && <p className="mt-1 text-xs font-normal text-sdc-red-text">{error}</p>}
          {notice && !open && (
            <p className="flex items-start gap-2 text-xs font-normal text-sdc-muted">
              <span className="flex-1">{notice}</span>
              <button type="button" onClick={() => setNotice(null)} className="shrink-0 text-sdc-blue hover:underline">
                OK
              </button>
            </p>
          )}
        </div>
      )}
    </>
  );
}
