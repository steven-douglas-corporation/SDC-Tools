import "server-only";
import { prisma } from "@/lib/prisma";
import { SECTIONS, ETC_TRACKED_CODES, mapPunchToColumns } from "@/lib/sections";

// "Hours Detail" — the punch-level rows behind a job's Actual hours, recreating
// the Power BI report's drillthrough page: one line per employee per day per
// section, with a total that reconciles to the section bars above it.
//
// Whole job with a Section column (rather than only the section that was
// clicked), per Dan: the useful question is usually "who has been on this job",
// and a section filter on top of the full list answers both.

import { punchIdentity, type PunchIdentity } from "@/lib/hours-filters";

const SECTION_NAME = new Map(SECTIONS.map((s) => [s.code, s.name]));

export type HoursDetailRow = {
  date: string; // YYYY-MM-DD
  employee: string; // resolved name, or the raw Paylocity id
  department: string;
  section: string; // getJobHoursDetail: the RAW pair (== rawSection-rawFunction). getEtcMonthHoursDetail: the ETC-grid column this raw punch was folded/allocated onto for that scoped view — see each function.
  sectionName: string;
  hours: number;
  // Only set when the detail spans more than one job — the Monthly ETC month
  // view, or a multi-job selection on the Job Hour Details slicer. Absent on a
  // single-job drill, where a Job column would repeat the page heading on
  // every row.
  job?: string;
} & PunchIdentity;
// ^ Section and Function as SEPARATE raw/standardized fields (2026-08-21), from the
// one shared projection in hours-filters.ts. Intersected rather than re-declared so
// this page, the Hours page and Monthly ETC cannot drift: they all show the same
// values for the same punch because they all call punchIdentity().

export type JobHoursDetail = {
  rows: HoursDetailRow[];
  total: number;
  // Sections present in the data, for the panel's filter. Only what's actually
  // there — offering an empty section would filter to nothing.
  sections: { code: string; name: string; hours: number }[];
  // True when the row cap below cut the list, so the UI can say so rather than
  // quietly showing a partial total.
  truncated: boolean;
};

// A job with years of history could carry thousands of punches, and this payload
// crosses the server→client boundary on every page load. 4,000 is far above any
// real job (the largest on 2026-07-30 was well under 1,000) while still bounding
// the worst case.
const MAX_ROWS = 4000;

export async function getJobHoursDetail(jobPks: number[]): Promise<JobHoursDetail> {
  const empty: JobHoursDetail = { rows: [], total: 0, sections: [], truncated: false };
  if (jobPks.length === 0) return empty;

  const [detail, employees] = await Promise.all([
    prisma.jobHoursDetail.findMany({
      where: { jobId: { in: jobPks } },
      select: { section: true, rawSection: true, rawFunction: true, workDate: true, employeeId: true, hours: true, job: { select: { jobId: true, jobName: true } } },
      // Newest first, like the report's page (its Date column sorts descending).
      orderBy: [{ workDate: "desc" }, { section: "asc" }],
      take: MAX_ROWS + 1, // one extra, purely to detect truncation
    }),
    prisma.employee.findMany({
      where: { paylocityId: { not: null } },
      select: { paylocityId: true, name: true, department: true },
    }),
  ]);

  const byPaylocityId = new Map(employees.map((e) => [e.paylocityId!, e]));

  const truncated = detail.length > MAX_ROWS;
  const kept = truncated ? detail.slice(0, MAX_ROWS) : detail;

  // The Job column appears only when the selection actually spans jobs. On a
  // single-job drill it would repeat the page heading on every row; across a
  // multi-job selection its absence leaves punches from several jobs stacked
  // together with no way to tell them apart. The panel keys off this field
  // being present, so deciding it here is the whole switch.
  const showJob = jobPks.length > 1;

  const rows: HoursDetailRow[] = kept.map((d) => {
    const emp = byPaylocityId.get(d.employeeId);
    // `section` IS the raw pair now, so SECTION_NAME (keyed by the 17 ETC-fold codes)
    // rarely has an entry for it. Fall back to the rule book's own verdict —
    // "10-413 — Manufacturing", "35-211 — Undefined" — rather than repeating the
    // raw code as its own name.
    const id = punchIdentity(d.rawSection, d.rawFunction);
    return {
      ...(showJob ? { job: `${d.job.jobId} — ${d.job.jobName}` } : {}),
      date: d.workDate.toISOString().slice(0, 10),
      // Falling back to the raw id rather than "(undefined)" (which is what the
      // Power BI page shows): an id is actionable — someone can look it up —
      // where "(undefined)" only says the join failed. Two of 69 ids on the
      // export didn't match the roster on 2026-07-30, both likely leavers.
      employee: emp?.name ?? (d.employeeId ? `#${d.employeeId}` : "—"),
      department: emp?.department?.trim() || "—",
      section: d.section,
      sectionName: SECTION_NAME.get(d.section) ?? id.standardTaskDescription,
      hours: Number(d.hours),
      ...id,
    };
  });

  // Section totals from the KEPT rows, so the filter's numbers always agree with
  // what the table can actually show.
  const bySection = new Map<string, number>();
  for (const r of rows) bySection.set(r.section, (bySection.get(r.section) ?? 0) + r.hours);

  return {
    rows,
    total: rows.reduce((s, r) => s + r.hours, 0),
    sections: [...bySection.entries()]
      .map(([code, hours]) => ({ code, name: SECTION_NAME.get(code) ?? code, hours }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    truncated,
  };
}

// Month-scoped variant, for the Monthly ETC page's KPI drill-through: every
// punch in one ETC month across the jobs the grid is showing, with a Job column.
//
// Shares the row shape (and so the whole panel component) with the per-job drill
// above. Deliberately the same table and the same name resolution — the KPI cards
// count people out of these very rows, so the drill can't disagree with the card
// that opened it.
export async function getEtcMonthHoursDetail(month: string, jobPks: number[]): Promise<JobHoursDetail> {
  const empty: JobHoursDetail = { rows: [], total: 0, sections: [], truncated: false };
  if (jobPks.length === 0) return empty;

  const [detail, employees] = await Promise.all([
    prisma.jobHoursDetail.findMany({
      // NOT filtered by section at the DB level any more (2026-08-21): `section` is the
      // RAW pair now, and a raw pair like "10-311" or "10-414" does not literally equal
      // any ETC_TRACKED_CODES entry even though it folds onto one (10-312/10-313,
      // 10-413). Filtering here would silently drop every punch that needs folding —
      // exactly the class of bug this migration exists to prevent. So every row for
      // the month/jobs is fetched, then folded and filtered in JS below.
      where: { month, jobId: { in: jobPks } },
      select: {
        section: true,
        rawSection: true,
        rawFunction: true,
        workDate: true,
        employeeId: true,
        hours: true,
        job: { select: { jobId: true, jobName: true } },
      },
      orderBy: [{ workDate: "desc" }, { section: "asc" }],
      take: MAX_ROWS + 1,
    }),
    prisma.employee.findMany({
      where: { paylocityId: { not: null } },
      select: { paylocityId: true, name: true, department: true },
    }),
  ]);

  const byPaylocityId = new Map(employees.map((e) => [e.paylocityId!, e]));
  const truncated = detail.length > MAX_ROWS;
  const kept = truncated ? detail.slice(0, MAX_ROWS) : detail;

  // ── Fold each raw punch onto the ETC grid's fixed columns, HERE, in memory ────
  //
  // The fold (and the 10-311 30/70 split) is computed on the fly, exactly as
  // sync-actuals.ts's syncHoursWorked does for the same grid. `section`/`sectionName`
  // on the resulting row are the ETC-column destination — correct for THIS view,
  // whose entire purpose is "what does the ETC grid show" — while `rawSection`/
  // `rawFunction` (via punchIdentity, spread below) stay the untouched original punch.
  // A 10-311 punch therefore renders as two allocation rows here, each one still
  // showing raw Section=10/Function=311 and together summing back to the punch.
  const rows: HoursDetailRow[] = kept.flatMap((d) => {
    const emp = byPaylocityId.get(d.employeeId);
    return mapPunchToColumns(d.section, Number(d.hours))
      .filter((col) => ETC_TRACKED_CODES.has(col.section))
      .map((col) => ({
        date: d.workDate.toISOString().slice(0, 10),
        employee: emp?.name ?? (d.employeeId ? `#${d.employeeId}` : "—"),
        department: emp?.department?.trim() || "—",
        section: col.section,
        sectionName: SECTION_NAME.get(col.section) ?? col.section,
        hours: col.hours,
        job: `${d.job.jobId} — ${d.job.jobName}`,
        ...punchIdentity(d.rawSection, d.rawFunction),
      }));
  });

  const bySection = new Map<string, number>();
  for (const r of rows) bySection.set(r.section, (bySection.get(r.section) ?? 0) + r.hours);

  return {
    rows,
    total: rows.reduce((s, r) => s + r.hours, 0),
    sections: [...bySection.entries()]
      .map(([code, hours]) => ({ code, name: SECTION_NAME.get(code) ?? code, hours }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    truncated,
  };
}
