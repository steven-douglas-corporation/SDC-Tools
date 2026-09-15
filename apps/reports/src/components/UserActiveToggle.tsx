"use client";

import { useState, useTransition } from "react";

// Activate / deactivate an account from the Users & Roles page.
//
// Self-registered accounts are created INACTIVE (2026-09-14: anyone who could reach
// the login page could otherwise claim any company address with no proof they own
// it), so this control is the only in-app way such an account ever gets in. The
// server action refuses self-deactivation and bumps tokenVersion on deactivate so
// the person's existing sessions end at once — see lib/user-role-actions.ts.
export function UserActiveToggle({
  userId,
  active,
  isSelf,
  action,
}: {
  userId: number;
  active: boolean;
  isSelf: boolean;
  action: (userId: number, active: boolean) => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const label = active ? "Active" : "Pending activation";

  if (isSelf) {
    return (
      <span className="text-sdc-gray-600" title="You can't deactivate your own account.">
        {label} (you)
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span className={active ? "text-sdc-gray-600" : "font-medium text-amber-700"}>{label}</span>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            try {
              await action(userId, !active);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not update the account.");
            }
          });
        }}
        className="rounded-md border border-sdc-border px-2 py-0.5 text-xs hover:bg-sdc-gray-50 disabled:opacity-60"
      >
        {pending ? "Saving…" : active ? "Deactivate" : "Activate"}
      </button>
      {error ? <span className="text-xs text-red-700">{error}</span> : null}
    </span>
  );
}
