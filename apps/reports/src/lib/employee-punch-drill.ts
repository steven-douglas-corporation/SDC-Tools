import "server-only";
import { prisma } from "@/lib/prisma";
import { SECTIONS } from "@/lib/sections";
import {
  classifyUtilizationPunch,
  loadEffectiveCloseDates,
  type PunchBucket,
} from "@/lib/department-utilization";

// ── One employee's punches for one month (2026-08-28) ───────────────────────
//
// Behind a click on an employee row in Department Utilization: the actual punch
// rows behind that person's Actual / Billable / Utilization % figures.
//
// ── Why this is month-scoped, and not getEmployeePunches ────────────────────
//
// data-quality-actions.ts already has getEmployeePunches, and it is the right
// function for what IT does — "every punch this person ever booked", newest
// 500, for chasing a bad-looking row. It is the wrong function here: an
// all-time list cannot reconcile against a row that says "102h in August", and
// a drill whose total disagrees with the number it hangs off is worse than no
// drill. So this one takes the month, and its total is the row's Actual hours
// by construction.
//
// ── Each punch carries the bucket the utilization maths put it in ───────────
//
// Which is the actual question an employee row raises. "Richard Dula 75%" is
// not answerable from a list of hours; it is answerable from seeing that 41 of
// his 165 hours went to a non-billable job. The bucket comes from
// classifyUtilizationPunch — the SAME function the department table sums — so
// the drill cannot tell a different story from the row above it.

const SECTION_NAME = new Map(SECTIONS.map((s) => [s.code, s.name]));

/** Human labels for the buckets, so the UI does not invent its own vocabulary. */
export const BUCKET_LABEL: Record<PunchBucket, string> = {
  billableActive: "Billable",
  warranty: "Warranty",
  service: "Service",
  spareParts: "Spare Parts",
  bellco: "Bellco",
  nonBillable: "Non-Billable",
};

export type EmployeeMonthPunch = {
  date: string;
  jobId: string;
  jobName: string;
  section: string;
  sectionName: string;
  hours: number;
  bucket: PunchBucket;
  /** True for everything the utilization maths counts as billable. */
  billable: boolean;
};

export type EmployeeMonthPunches = {
  employeeId: string;
  month: string;
  name: string | null;
  department: string | null;
  rows: EmployeeMonthPunch[];
  /** Σ hours — equals the employee row's Actual by construction. */
  totalHours: number;
  /** Σ billable hours — equals its Billable. */
  billableHours: number;
  /** Per-bucket totals, for the summary strip. */
  byBucket: { bucket: PunchBucket; label: string; hours: number }[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function getEmployeeMonthPunches(employeeId: string, month: string): Promise<EmployeeMonthPunches> {
  const [employee, punches, closeDates] = await Promise.all([
    prisma.employee.findFirst({ where: { paylocityId: employeeId }, select: { name: true, department: true } }),
    prisma.jobHoursDetail.findMany({
      where: { employeeId, month },
      select: {
        workDate: true,
        section: true,
        rawSection: true,
        hours: true,
        job: { select: { jobId: true, jobName: true } },
      },
      // Newest first, then by job, so a day's work reads together.
      orderBy: [{ workDate: "desc" }, { section: "asc" }],
    }),
    loadEffectiveCloseDates(),
  ]);

  let totalHours = 0;
  let billableHours = 0;
  const bucketTotals = new Map<PunchBucket, number>();

  const rows: EmployeeMonthPunch[] = punches.map((p) => {
    const hours = Number(p.hours);
    const bucket = classifyUtilizationPunch({
      jobNumber: p.job.jobId,
      rawSection: p.rawSection,
      workDate: p.workDate,
      effectiveCloseDate: closeDates.get(p.job.jobId) ?? null,
    });
    // Same partition the department table sums: everything except Bellco and
    // Non-Billable counts toward Billable.
    const billable = bucket !== "nonBillable" && bucket !== "bellco";
    totalHours += hours;
    if (billable) billableHours += hours;
    bucketTotals.set(bucket, (bucketTotals.get(bucket) ?? 0) + hours);

    return {
      date: p.workDate.toISOString().slice(0, 10),
      jobId: p.job.jobId,
      jobName: p.job.jobName,
      section: p.section,
      sectionName: SECTION_NAME.get(p.section) ?? p.section,
      hours,
      bucket,
      billable,
    };
  });

  const byBucket = [...bucketTotals.entries()]
    .map(([bucket, hours]) => ({ bucket, label: BUCKET_LABEL[bucket], hours: round2(hours) }))
    .sort((a, b) => b.hours - a.hours);

  return {
    employeeId,
    month,
    name: employee?.name ?? null,
    department: employee?.department ?? null,
    rows,
    totalHours: round2(totalHours),
    billableHours: round2(billableHours),
    byBucket,
  };
}
