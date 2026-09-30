// ── The Hours page's "Hours by source" band (2026-09-30) ────────────────────
//
// The Hours page lists Paylocity punches only (era 3 of the three-era model in
// lib/actual-hours.ts), so for any job with history its total sits below the
// Actual Hours every other report shows. This band puts the other two eras beside
// the punches and reconciles them to one total, so the gap is explained on the
// page instead of only in the export.
//
// Pure, so the arithmetic — especially the overlap — is testable without a
// database (tests/hours-by-source.test.ts). lib/actual-hours.ts loads the figures.
//
// ── The overlap, and why nothing is subtracted from the punches ─────────────
//
// The migration snapshot runs THROUGH 2025-01-31 and the punch feed starts
// 2025-01-06, so for a job that has a snapshot its January 2025 punches are
// already inside it. The snapshot is a LIFETIME total per job/section, so there is
// no way to know which part of it was January — subtracting anything from it
// would be a guess. The rule every report already uses (supersededBySnapshot) is
// the other way round: for a job WITH a snapshot, its punches up to
// SNAPSHOT_THROUGH_MONTH don't count; for a job WITHOUT one, they are the only
// record and do.
//
// On this page those punches stay in the table — they are real punches, with an
// employee and a date, and hiding them would make the table disagree with
// Paylocity. They are shown as their own "already in the snapshot" line and left
// out of the combined total, so the total matches loadActualHoursBySection.

export type HoursBySourceInput = {
  /** Every punch the page's filters match — the table's own total. */
  punches: number;
  /** Of those, punches on jobs with a snapshot dated up to SNAPSHOT_THROUGH_MONTH. */
  overlap: number;
  /** Migration snapshot hours in scope, or null when this source can't apply to the filters. */
  snapshot: number | null;
  /** Frozen ETC hours in scope, or null when this source can't apply to the filters. */
  frozen: number | null;
};

export type HoursBySource = {
  punches: number;
  overlap: number;
  /** Punches that count toward the combined total (punches − overlap). */
  punchesCounted: number;
  snapshot: number | null;
  frozen: number | null;
  /** Punches counted + snapshot + frozen. Null when either other source is unavailable. */
  total: number | null;
};

export function combineHourSources(i: HoursBySourceInput): HoursBySource {
  // The overlap is a subset of the punches by construction; clamp anyway so a
  // rounding difference can never show negative counted hours.
  const overlap = Math.min(Math.max(i.overlap, 0), i.punches);
  const punchesCounted = i.punches - overlap;
  const total = i.snapshot === null || i.frozen === null ? null : punchesCounted + i.snapshot + i.frozen;
  return { punches: i.punches, overlap, punchesCounted, snapshot: i.snapshot, frozen: i.frozen, total };
}

/**
 * Why the two pre-punch sources can't be shown for these filters, or null when
 * they can. Neither has an employee (so no employee or department filter can
 * narrow it); the snapshot also has no date, only "everything through
 * SNAPSHOT_THROUGH_MONTH".
 */
export function olderSourcesUnavailable(f: { employeeIds?: string[]; departments?: string[] }): string | null {
  if (f.employeeIds?.length || f.departments?.length) {
    return "The migration snapshot and frozen ETC months have no employee or department, so they can't be filtered that way.";
  }
  return null;
}

/** True when the date range starts after the snapshot's last month, so none of it is in range. */
export function snapshotBeforeRange(fromMonth: string | undefined, snapshotThroughMonth: string): boolean {
  return fromMonth !== undefined && fromMonth > snapshotThroughMonth;
}
