import "server-only";
import { prisma } from "@/lib/prisma";
import { ACTIVE_JOB_WHERE, NO_CUSTOMER, compareJobIds } from "@/lib/job-filters";
import { canonicalCustomerKey, pickCanonicalName } from "@/lib/customer-canonical";
import { fetchSchedulerFatEvents, fetchSchedulerJobDisciplineOwners } from "@/lib/scheduler-db";

// ── The Dashboard's inline job drill-through (2026-08-28) ───────────────────
//
// Behind a click on a bar in "Active Jobs by Customer" or "Active Jobs by
// Project Type": the actual jobs that bar counted, opened in a panel under the
// chart rather than by navigating to /jobs.
//
// ── Why the count cannot drift from the bar ─────────────────────────────────
//
// The single risk with a drill-through is that it answers a slightly different
// question from the number it hangs off, so the bar says 12 and the table shows
// 11. That is prevented structurally, not by care: the job universe here is
// ACTIVE_JOB_WHERE (job-filters.ts) — literally the same exported constant
// dashboard-overview.ts builds its `activeJobs` array from — plus exactly one
// additional equality on customer or type, which is the same field the chart
// grouped on. There is no second notion of "active" to get out of step.
//
// Customer matching in particular runs canonicalCustomerKey() — the SAME
// function the chart groups by (lib/customer-canonical.ts). Since 2026-08-31
// that is a canonical customer id, not the stored string: the book contains
// "FIRST SOLAR, INC.", "FIRST SOLAR INC.", "First Solar Inc.", "First Solar",
// "First Solar, Inc." and two site records, which are one customer with 24
// active jobs. Both sides resolving through one function is what keeps a 24-bar
// opening a 24-row table — normalizing on one side only is exactly how this
// broke before (a 12-bar opened 13 rows; see the collation note below).
//
// The rows still SHOW the stored spelling, in their own column, so a merge can
// be checked against the source and the naming problem stays visible instead of
// being papered over.
//
// ── Fetched on click, not shipped with the page ─────────────────────────────
//
// Same reasoning as every other drill in this app (tm-drill-actions,
// hours-detail-actions, cash-flow-drill-actions): the enrichment below is two
// extra database reads plus two Scheduler reads, and 26 customers x that is a
// lot of work for the one panel a session actually opens. The client caches
// each result for the session, so re-opening a bar is free.

/**
 * What the panel is currently showing. For `type`, `value` is the project type.
 * For `customer` it is a CANONICAL CUSTOMER ID (customer-canonical.ts), not a
 * customer name — the chart hands over what it grouped by, so no name has to
 * survive a round trip through the client to identify the bar again.
 */
export type JobDrillFilter = { kind: "customer" | "type"; value: string };

export type JobDrillRow = {
  jobId: string;
  jobName: string;
  /** The canonical customer this job counted under — the bar's own label. */
  customer: string;
  /**
   * The customer string as actually STORED on the job. Shown beside `customer`
   * whenever the two differ, so a combined bar can be reconciled against the
   * source rows and the underlying naming inconsistency stays visible — it is
   * a data-quality problem to fix upstream, not one to hide.
   */
  rawCustomer: string;
  type: string;
  status: string;
  /** PO start, else the planned start. ISO date, or null when neither is set. */
  startDate: string | null;
  /** Earliest FAT the Scheduler has for this job, ISO. Null when the Scheduler has none or is unreachable. */
  fatDate: string | null;
  /** Named mech / controls engineers on the job's Scheduler tasks. This app carries no PM field. */
  meOwners: string[];
  ceOwners: string[];
  /** Σ EstimatedHours for the job. Null when the job has no estimate rows at all — not 0, which would read as "quoted nothing". */
  quotedHours: number | null;
  actualHours: number | null;
  etcHours: number | null;
};

export type JobDrillResult = {
  filter: JobDrillFilter;
  rows: JobDrillRow[];
  /** True when the Scheduler was unreachable, so the UI can say that instead of showing empty FAT cells as fact. */
  schedulerAvailable: boolean;
};

const iso = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

/**
 * The chart's own bucket label for a job — the SAME expression
 * dashboard-overview.ts groups customers by. Exported so the two cannot drift.
 */
export function customerBucket(customer: string | null): string {
  return customer?.trim() || NO_CUSTOMER;
}

/**
 * A single job's canonical customer label, for a drill that spans customers (the
 * project-type charts). The reviewed registry name when there is one, else the
 * stored spelling — a type drill has no view of the other spellings on a
 * canonical group, so it cannot pick a dominant one and does not pretend to. The
 * `rawCustomer` column carries the stored value either way.
 */
function rowCustomerLabel(job: Parameters<typeof canonicalCustomerKey>[0] & { customer: string | null }): string {
  return canonicalCustomerKey(job).registryName ?? customerBucket(job.customer);
}

export async function fetchActiveJobDrill(filter: JobDrillFilter): Promise<JobDrillResult> {
  // ── Why the customer match is NOT done in SQL (2026-08-28) ────────────────
  //
  // It was, as `where: { customer: filter.value }`, and it silently over-matched:
  // MySQL's default collation is case- and trailing-space-insensitive, so
  // `customer = 'FIRST SOLAR, INC.'` also returned the rows stored as
  // 'First Solar, Inc.' and 'First Solar Inc.'. The chart groups in JS, which is
  // case-SENSITIVE, so it draws those as three separate bars — and a 12-bar
  // opened a 13-row table. Across the whole book the drill returned 79 rows for
  // 59 active jobs.
  //
  // Rather than reach for a COLLATE clause (which needs raw SQL and leaves the
  // same trap set for the next filter added here), the row set is narrowed in JS
  // using canonicalCustomerKey() — literally the function the chart groups by.
  // The grouping cannot disagree with itself. The cost is reading the active job
  // list rather than one customer's slice, which is ~59 rows on today's book and
  // the same read the Dashboard already does for the charts themselves.
  //
  // Canonical grouping made that choice load-bearing rather than merely tidy: a
  // canonical customer spans several stored spellings AND several TotalETO
  // company records, so there is no `where` clause on one column that could
  // express it at all.
  const all = await prisma.job.findMany({
    where: ACTIVE_JOB_WHERE,
    select: {
      id: true,
      jobId: true,
      jobName: true,
      customer: true,
      type: true,
      status: true,
      poStartDate: true,
      startDate: true,
      // The customer-identity inputs, so this narrows by the same key the chart
      // grouped by rather than by a name.
      totEtoCompanyId: true,
      totEtoAccountId: true,
      customerManuallyEdited: true,
    },
  });

  const jobs =
    filter.kind === "type"
      ? all.filter((j) => j.type === filter.value)
      : all.filter((j) => canonicalCustomerKey(j).canonicalCustomerId === filter.value);

  if (jobs.length === 0) {
    return { filter, rows: [], schedulerAvailable: true };
  }

  const [hours, fatEvents, owners] = await Promise.all([
    prisma.estimatedHours.groupBy({
      by: ["jobId"],
      where: { jobId: { in: jobs.map((j) => j.id) } },
      _sum: { quotedHours: true, actualHistoricalHours: true, estimateToCompleteHours: true },
    }),
    fetchSchedulerFatEvents(),
    fetchSchedulerJobDisciplineOwners(),
  ]);

  const hoursByJob = new Map(hours.map((h) => [h.jobId, h._sum]));

  // Earliest real FAT per job. Pre-FATs are excluded for the same reason the
  // Dashboard's FAT KPI excludes them — a pre-FAT is a rehearsal, not the date
  // anybody plans around.
  const fatByJob = new Map<string, string>();
  for (const e of fatEvents ?? []) {
    if (e.kind !== "fat") continue;
    const prior = fatByJob.get(e.jobNumber);
    if (!prior || e.date < prior) fatByJob.set(e.jobNumber, e.date);
  }

  // The heading every row in a CUSTOMER drill agrees on. Derived the same way
  // the chart derives it — the registry name when there is one, else the
  // dominant stored spelling among these very rows — so the panel's label and
  // the bar's label cannot differ. A type drill keeps each row's own customer.
  const rawCounts = new Map<string, number>();
  for (const j of jobs) {
    const raw = customerBucket(j.customer);
    rawCounts.set(raw, (rawCounts.get(raw) ?? 0) + 1);
  }
  const rawNames = [...rawCounts.entries()].map(([name, count]) => ({ name, count }));
  const registryName = jobs.length > 0 ? canonicalCustomerKey(jobs[0]).registryName : null;
  const customerDrillLabel = registryName ?? pickCanonicalName(rawNames);

  const rows: JobDrillRow[] = jobs.map((j) => {
    const h = hoursByJob.get(j.id);
    const num = (v: unknown): number | null => (v == null ? null : Number(v));
    return {
      jobId: j.jobId,
      jobName: j.jobName,
      // The canonical label, so every row in a combined table agrees with the
      // bar's heading…
      customer: filter.kind === "customer" ? customerDrillLabel : rowCustomerLabel(j),
      // …and the stored spelling next to it, so the merge is auditable.
      rawCustomer: customerBucket(j.customer),
      type: j.type ?? "—",
      status: j.status,
      startDate: iso(j.poStartDate ?? j.startDate),
      fatDate: fatByJob.get(j.jobId) ?? null,
      meOwners: owners.me.get(j.jobId) ?? [],
      ceOwners: owners.controls.get(j.jobId) ?? [],
      quotedHours: num(h?.quotedHours),
      actualHours: num(h?.actualHistoricalHours),
      etcHours: num(h?.estimateToCompleteHours),
    };
  });

  rows.sort((a, b) => compareJobIds(a.jobId, b.jobId));

  return { filter, rows, schedulerAvailable: fatEvents !== null };
}
