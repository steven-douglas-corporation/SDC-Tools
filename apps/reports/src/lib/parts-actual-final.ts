// ── Jobs whose Parts Cost Actual is FINAL, not synced (2026-10-28, by request) ─────────────────
//
// Every job below 1100 is closed, and its Parts Cost Actual was loaded from the Sage job ledger
// ("Jobs summarized by GL account", Net DR/CR per job) by scripts/import-final-parts-actual.ts, because
// Total ETO's history for those jobs is incomplete or wrong. Job.costActualHistorical holds that figure.
//
// From 1100 up the figure is pulled from Total ETO exactly as before (syncPartsCostActual).
//
// This is the ONE definition of the cutoff. Everything that would otherwise reach past the stored figure to
// a live Total ETO read for such a job asks it: the sync (must not overwrite), the Job Cost Explorer's
// Parts Invoiced column, and the Projects export's "excl. SDC" block. Kept free of `server-only` so it can
// be unit-tested without a database.

/** Jobs numbered below this carry a final, imported Parts Cost Actual. */
export const FINAL_PARTS_ACTUAL_BELOW_JOB = 1100;

/** True for a plain numeric job id under the cutoff. A non-numeric id is never final: it stays on Total ETO. */
export function hasFinalPartsActual(jobId: string): boolean {
  const id = jobId.trim();
  return /^\d+$/.test(id) && Number(id) < FINAL_PARTS_ACTUAL_BELOW_JOB;
}
