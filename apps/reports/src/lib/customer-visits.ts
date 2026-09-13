// ── Customer Visits: a declared gap, not a feature (2026-08-27) ─────────────
//
// The dashboard asks for a planned Customer Visits section. Before building one,
// every candidate source was checked for an existing Customer Visit field or
// event. The finding, in full:
//
//   * SDC Scheduler MySQL (sdc_scheduler) — no visit table, no visit column.
//     `projects` carries only (name, status, is_template, job_number,
//     workspace); `tasks` carries no visit flag. The only visit-shaped rows in
//     the entire database are two ad-hoc TASK NAMES a scheduler happened to
//     type — "Stuller Onsite Visit" (2026-09-02) and "Customer Onsite for
//     Pre-FAT" (2026-07-28). Two free-text rows out of ~2,300 tasks.
//   * This app's own schema (prisma/schema.prisma) — no visit model, and
//     nothing on `Job` or `ProjectRelease` records a customer coming on site.
//   * `ProjectRelease.details` (the parsed Project Release doc) — carries
//     jobNumber, buyer, quote, PO number, customer contact, warranty,
//     commercial cost and budget lines. No visit date.
//
// So there is no source. The two task names above are deliberately NOT read as
// one: inferring visits from free-text task names would mean a dashboard number
// that silently changes meaning the first time somebody words a task
// differently, and it would under-report every visit nobody wrote a task for.
// A count that is wrong in an unknowable direction is worse than an honest gap.
//
// This module is the BOUNDARY. The section renders as an explicit
// "awaiting a data source" panel until `CUSTOMER_VISIT_SOURCE` names a real one,
// and `getCustomerVisits()` is the single seam the eventual implementation
// plugs into — the dashboard already calls it, already lays the panel out, and
// already filters by the selected month, so wiring a real source is a change to
// this file alone.
//
// Open question for Mike (as of 2026-08-27): where should a Customer Visit be
// ENTERED in the Scheduler? The two shapes that fit its existing model are
//   (a) a first-class milestone type on `tasks` (a `visit` phase_group or a
//       dedicated `is_visit` flag), which keeps visits on the project timeline
//       and inherits the Scheduler's date cascade; or
//   (b) a project-level `customer_visit_date` column, if a visit is one date per
//       job rather than an event that can recur.
// Until that is decided, nothing here guesses.

/**
 * Where Customer Visits come from. `null` means "nowhere yet" — the audited
 * state above. Set this (and implement the branch in `getCustomerVisits`) once
 * the Scheduler has a defined field; every consumer reads the status off the
 * returned object rather than testing this constant, so no call site changes.
 */
export const CUSTOMER_VISIT_SOURCE: "scheduler-task" | "scheduler-project" | null = null;

export type CustomerVisit = {
  /** "YYYY-MM-DD" */
  date: string;
  customer: string;
  jobNumber: string | null;
  jobName: string | null;
  owner: string | null;
  note: string | null;
};

export type CustomerVisitsResult =
  | { configured: false; visits: never[]; source: null }
  | { configured: true; visits: CustomerVisit[]; source: NonNullable<typeof CUSTOMER_VISIT_SOURCE> };

/**
 * Customer visits falling inside `month` ("YYYY-MM").
 *
 * Returns `configured: false` while no source is defined — NOT an empty visit
 * list, which the UI would be entitled to render as "no visits planned this
 * month". The distinction between "none scheduled" and "we do not record this"
 * is the whole point of the boundary.
 *
 * Async today despite doing no I/O: both candidate sources are database reads,
 * so the signature that a real implementation needs is the signature callers
 * are written against from the start.
 */
export async function getCustomerVisits(month: string): Promise<CustomerVisitsResult> {
  void month;
  if (CUSTOMER_VISIT_SOURCE === null) return { configured: false, visits: [], source: null };
  // Unreachable until a source is defined; left as the explicit seam.
  throw new Error(`Customer visit source "${CUSTOMER_VISIT_SOURCE}" is named but not implemented.`);
}
