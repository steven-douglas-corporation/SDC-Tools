"use server";

import { prisma } from "@/lib/prisma";
import { SECTIONS } from "@/lib/sections";

// Employee drill-through for the Data Quality tab.
//
// The Power BI report drills two ways: on Job (its "Job Detail" pages, keyed on
// Job Id) and on Employee Name (its "Hours Detail" page). The job drill has a
// destination here already — /job-hours takes a ?jobs= deep link — so only the
// employee side needed anything new: every punch this person booked, across all
// their jobs, which is the question a bad-looking row actually raises.
//
// Fetched on demand rather than shipped with the page: it's one person at a
// time, and pre-loading it for every row on the tab would mean thousands of
// punch rows crossing the wire for the handful anyone opens.

const SECTION_NAME = new Map(SECTIONS.map((s) => [s.code, s.name]));
// A year's worth of punches is far more than anyone reads in a drill, and bounds
// the payload for someone who has been here a decade.
const MAX_ROWS = 500;

export type EmployeePunch = {
  date: string;
  jobId: string;
  jobName: string;
  jobStatus: string;
  section: string;
  sectionName: string;
  hours: number;
};

export type EmployeePunchDetail = {
  employeeId: string;
  // Resolved name, or null when this is one of the unrecognised IDs — which is
  // itself the finding, so the panel says so rather than showing a blank.
  name: string | null;
  department: string | null;
  rows: EmployeePunch[];
  total: number;
  truncated: boolean;
};

export async function getEmployeePunches(employeeId: string): Promise<EmployeePunchDetail> {
  const [employee, punches] = await Promise.all([
    prisma.employee.findFirst({ where: { paylocityId: employeeId }, select: { name: true, department: true } }),
    prisma.jobHoursDetail.findMany({
      where: { employeeId },
      select: { workDate: true, section: true, hours: true, job: { select: { jobId: true, jobName: true, status: true } } },
      orderBy: [{ workDate: "desc" }],
      take: MAX_ROWS + 1,
    }),
  ]);

  const truncated = punches.length > MAX_ROWS;
  const kept = truncated ? punches.slice(0, MAX_ROWS) : punches;

  const rows: EmployeePunch[] = kept.map((p) => ({
    date: p.workDate.toISOString().slice(0, 10),
    jobId: p.job.jobId,
    jobName: p.job.jobName,
    jobStatus: p.job.status,
    section: p.section,
    sectionName: SECTION_NAME.get(p.section) ?? p.section,
    hours: Number(p.hours),
  }));

  return {
    employeeId,
    name: employee?.name ?? null,
    department: employee?.department?.trim() || null,
    rows,
    total: rows.reduce((s, r) => s + r.hours, 0),
    truncated,
  };
}
