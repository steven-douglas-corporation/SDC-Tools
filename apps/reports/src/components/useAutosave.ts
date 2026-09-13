"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AUTOSAVE_DELAY_MS,
  beginSaveTracking,
  endSaveTracking,
  needsFollowUpSave,
  shouldAutosave,
  type AutosaveStatus,
} from "@/lib/autosave";

// Debounce + coalesce + status for the two grids' autosave. The RULES live in
// lib/autosave.ts (pure, tested); this is the timer and the React state around
// them.
//
// `save` must resolve true on success. It is called at most once at a time —
// edits made mid-flight schedule exactly one follow-up rather than stacking.
type Deps = {
  enabled: boolean;
  save: () => Promise<boolean>;
  hasChanges: () => boolean;
  hasUnsavedNewRows: () => boolean;
};

export function useAutosave({
  enabled,
  save,
  hasChanges,
  hasUnsavedNewRows = () => false,
  delayMs = AUTOSAVE_DELAY_MS,
}: {
  enabled: boolean;
  save: () => Promise<boolean>;
  hasChanges: () => boolean;
  hasUnsavedNewRows?: () => boolean;
  delayMs?: number;
}) {
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const changedDuringSave = useRef(false);

  // One "latest props" ref, written in an effect rather than during render
  // (the repo lints ref writes in render, and rightly — a render that is
  // thrown away would still have mutated it). The consumers install a single
  // delegated DOM listener that lives for the life of the page, so it must not
  // close over the first render's props.
  const latest = useRef<Deps>({ enabled, save, hasChanges, hasUnsavedNewRows });
  useEffect(() => {
    latest.current = { enabled, save, hasChanges, hasUnsavedNewRows };
  });

  // A loop, not recursion: the follow-up save for edits made mid-flight is
  // just "go round again", and calling run() from inside itself would be a
  // self-referencing useCallback (which this repo's lint rejects, and which
  // captures a stale binding anyway).
  const run = useCallback(async () => {
    for (;;) {
      const { enabled: on, save: doSave, hasChanges: dirty, hasUnsavedNewRows: newRows } = latest.current;
      if (!shouldAutosave({ enabled: on, hasChanges: dirty(), inFlight: inFlight.current, hasUnsavedNewRows: newRows() })) {
        // Not saving, but there IS something unsaved — say so rather than
        // sitting on a stale "All changes saved".
        if (on && dirty()) setStatus("pending");
        // Nothing left to save. An edit that was UNDONE — typed and retyped, or
        // cancelled with Escape (ExcelCellFocus) — leaves the grid exactly as it
        // loaded, so there is nothing pending and the chip must stop saying there
        // is. Found live 2026-08-04: reverting a cell left "Unsaved changes" on
        // screen indefinitely, because schedule() had set `pending` and the run
        // that would have cleared it declined to save and returned.
        //
        // Only `pending` is cleared: a real "All changes saved" or a failed save
        // must survive a no-op pass.
        else setStatus((s) => (s === "pending" ? "idle" : s));
        return;
      }

      inFlight.current = true;
      changedDuringSave.current = false;
      setStatus("saving");
      // Tab-wide, so LiveRefresh doesn't re-render the route out from under a
      // write that hasn't committed yet. In a finally, because a save that throws
      // must not leave the counter raised and background refreshes off for the
      // rest of the session.
      beginSaveTracking();
      let ok = false;
      try {
        ok = await doSave();
      } catch {
        ok = false;
      } finally {
        endSaveTracking();
      }
      inFlight.current = false;
      setStatus(ok ? "saved" : "error");

      // Terminates: the next pass re-runs shouldAutosave, which needs
      // hasChanges() to still be true — and a successful save is what makes it
      // false. A failed save exits here rather than retrying (see
      // needsFollowUpSave).
      if (!needsFollowUpSave({ changedDuringSave: changedDuringSave.current, lastSaveOk: ok })) return;
    }
  }, []);

  // Call on every edit.
  const schedule = useCallback(() => {
    if (!latest.current.enabled) return;
    if (inFlight.current) {
      // Remember, so run() fires again once the current save lands. Without
      // this the edit would wait for the next keystroke that never comes.
      changedDuringSave.current = true;
      return;
    }
    setStatus("pending");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), delayMs);
  }, [run, delayMs]);

  // Save NOW, skipping the debounce — used when the tab is being hidden, where
  // waiting out the timer would lose the edit. Also backs the chip's Retry.
  //
  // Returns the promise so a caller can WAIT for it. `Submit {Month} Report` does:
  // it reads the month from the database, so a draft still on the debounce would be
  // missing from the month it freezes. Callers that don't care can ignore it.
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    return run();
  }, [run]);

  useEffect(() => {
    const t = timer;
    return () => {
      if (t.current) clearTimeout(t.current);
    };
  }, []);

  // A backgrounded or closing tab is the one case where the debounce is
  // actively harmful. visibilitychange fires reliably on tab switches and on
  // mobile, where beforeunload does not.
  useEffect(() => {
    if (!enabled) return;
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [enabled, flush]);

  return { status, schedule, flush, retry: flush };
}
