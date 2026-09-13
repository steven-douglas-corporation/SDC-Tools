"use client";

import { useEffect, useRef } from "react";
import { useAutosave } from "@/components/useAutosave";
import { SaveStatusChip } from "@/components/SaveStatusChip";
import { useStandardPoolDirty } from "@/components/EtcStandardColumns";
import { registerPoolAutosaveFlush } from "@/lib/etc-dirty-tracker";

// Autosave for the Standard Fees panel's two manual cells (Hours being pulled, Rate).
//
// ── Why this exists (§17, 2026-08-04) ────────────────────────────────────────
//
// These were the last cells in the app behind a manual Save. The panel had a "Save
// Pool Cells" button, and until it was pressed the figures on screen — which the whole
// grid's Standard Fees are computed FROM, live — were not in the database. Two
// consequences, both bad:
//
//   * A manager could set a pool, watch every job's fee move, walk away, and lose it.
//   * The old "Submit Standard Sheet" button had to be DISABLED while the panel was
//     dirty, because it froze the saved values rather than the shown ones. So the last
//     manual save was also the thing blocking the submission.
//
// Both are gone: edits persist on their own ~0.8s after the last keystroke, and the
// one submission flushes anything outstanding before it reads the month.
//
// Deliberately the same machinery as the grid (useAutosave + SaveStatusChip), not a
// second implementation — one debounce rule, one in-flight rule, one status vocabulary.
// `savePools` is idempotent (it writes the values currently in the form), so a retry
// cannot double-apply anything.
export function PoolAutosave({
  formId,
  saveAction,
}: {
  formId: string;
  saveAction: (formData: FormData) => Promise<void>;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const dirty = useStandardPoolDirty();
  // The hook reads through a ref so the delegated listener below never closes over a
  // stale value — same reason as EtcAutosave.
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    const el = document.getElementById(formId);
    formRef.current = el instanceof HTMLFormElement ? el : null;
  }, [formId]);

  const { status, schedule, retry } = useAutosave({
    enabled: true,
    // The provider owns the live pool cells, so IT is the authority on whether
    // anything differs from what the server sent — not a DOM diff.
    hasChanges: () => dirtyRef.current,
    save: async () => {
      const form = formRef.current;
      if (!form) return false;
      try {
        await saveAction(new FormData(form));
        return true;
      } catch {
        return false;
      }
    },
  });

  // Delegated at the form: the pool cells re-render on every keystroke (they feed the
  // grid's live fees), so per-input handlers would have to be threaded through the
  // provider for no gain.
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const onEdit = () => schedule();
    form.addEventListener("input", onEdit);
    return () => form.removeEventListener("input", onEdit);
  }, [schedule]);

  // Let `Submit {Month} Report` wait for a pending pool save before it reads the
  // month's CategoryPool rows out of the database — the other half of the flush
  // EtcAutosave.tsx registers for the grid's New ETC cells.
  useEffect(() => registerPoolAutosaveFlush(() => retry()), [retry]);

  return (
    <div className="flex items-center justify-center px-3 py-2">
      <SaveStatusChip status={status} onRetry={retry} />
    </div>
  );
}
