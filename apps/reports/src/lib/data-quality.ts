import "server-only";
import { prisma } from "@/lib/prisma";
import { customerAliasFindings, type CustomerAliasGroup } from "@/lib/customer-canonical";

// The Power BI report's "Data Quality" page, rebuilt against the app's own data.
//
// Not invented here — the rules are lifted from the semantic model so the two
// agree on what counts as a bad punch. `Hours Actual[Is Punch Valid]` /
// `[Is Punch Valid Reason]` in Job Hours Report - Management Level.SemanticModel
// evaluate, in this order:
//
//   1. punch date  > Hours Refreshed Thru        -> invalid, "Future"
//   2. job id      = "4000"                      -> VALID (the standing internal
//                                                   job; always allowed)
//   3. job id      = "Not defined"               -> invalid, "Job Id Not Defined"
//   4. job Complete AND section in {70,80,90}    -> VALID (warranty/service work
//                                                   after handover is expected)
//   5. job Complete AND punch after Complete Date
//      AND section NOT in {70,80,90}             -> invalid, "Completed Job and
//                                                   Not Sections 70, 80, 90"
//   6. Function Hierarchy[Is Valid] = FALSE      -> invalid, "Section-Function
//                                                   Exception"
//
// Rules 1, 4 and 5 are reproduced exactly below. Rule 6 is not (yet) — `Is Valid`
// is a source column on an upstream Function Hierarchy list, and this file has no
// query for it. That is no longer because the row is missing: the app's hours
// import used to drop punches on codes it doesn't model before they ever reached
// the database, but as of 2026-08-21 (see mapPunchToColumns's own header in
// sections.ts) it never does — every punch reaches JobHoursDetail under its own
// raw code, standardized or not, and HOURS_IMPORT_CODES.has(section) is exactly
// the local equivalent of `Is Valid = FALSE` this rule would need. Implementing
// Rule 6 here is still a separate, unscoped change (a new finding on this page),
// not a follow-on to the ingestion fix — just no longer blocked by "there's no
// row left to flag."
//
// Rule 3 ("Job Id Not Defined") used to be reproduced here too, as a "Hours booked
// to a non-job" finding — moved to the ETC page's "Data Quality — Undefined Hours"
// card (2026-08-20, by request): the same HoursImportIssue rows were surfacing on
// both this tab and that page under two different names. See
// lib/unattributed-hours.ts and lib/undefined-hours-rules.ts.
//
// "Undefined Employees" and "Hours Logged in Future" are the page's two dedicated
// tables, with the same filters it uses.

// Sections whose work legitimately continues after a job is handed over.
const POST_COMPLETION_SECTIONS = new Set(["70", "80", "90"]);
// The standing internal job. Exempt by rule 2 — hours land on it by design.
const ALWAYS_VALID_JOB_ID = "4000";
// Rows kept per check. Enough to work through, bounded so the dashboard can't be
// dragged down by a bad import.
const SAMPLE_LIMIT = 200;

export type PunchIssue = {
  date: string; // YYYY-MM-DD
  employee: string;
  employeeId: string;
  department: string;
  jobId: string;
  jobName: string;
  jobStatus: string;
  section: string;
  hours: number;
  completeDate: string | null;
};

/**
 * Customers stored under more than one name.
 *
 * A finding, not a footnote: the Dashboard's customer chart now COMBINES these
 * (lib/customer-canonical.ts), which fixes the chart and would otherwise hide
 * the problem completely — the Customer field on the Projects page is still
 * carrying seven spellings of one customer, and no amount of grouping
 * downstream makes that a good state for the source data to be in.
 *
 * Reported over EVERY job, not just active ones: standardizing a name is worth
 * doing once for the whole book, and a completed job's customer is what the next
 * report of history reads.
 */
export type CustomerNaming = {
  /** Canonical customers that combined two or more stored spellings. */
  groups: CustomerAliasGroup[];
  /** How many distinct stored spellings are involved across all of them. */
  storedNames: number;
  /**
   * Merges that rest on a REVIEWED HUMAN DECISION rather than on a source
   * identifier — worth re-checking when the underlying accounts change, and the
   * first thing to look at if a total ever looks wrong.
   */
  reviewedWithoutSourceEvidence: { canonicalCustomerName: string; note: string }[];
  /** Company records deliberately kept OUT of their accounting account's group, with why. */
  detachedFromAccount: { companyId: number; reason: string }[];
};

export type DataQuality = {
  // The watermark everything is judged against — the same [Hours Refreshed Thru]
  // the report's header card shows. Null when the hours feed has never run.
  refreshedThrough: string | null;
  future: { count: number; hours: number; rows: PunchIssue[] };
  afterCompletion: { count: number; hours: number; rows: PunchIssue[] };
  undefinedEmployees: { count: number; hours: number; ids: { employeeId: string; rows: number; hours: number }[] };
  /** Customers stored under more than one name — see CustomerNaming. */
  customerNaming: CustomerNaming;
  // True when a check had more rows than SAMPLE_LIMIT, so the table can say the
  // list is partial rather than implying the count and the list agree.
  truncated: boolean;
};

export async function getDataQuality(): Promise<DataQuality> {
  const [freshness, employees, customerJobs] = await Promise.all([
    prisma.powerBiFreshness.findUnique({ where: { source: "hours_actual" }, select: { refreshedThrough: true } }).catch(() => null),
    prisma.employee.findMany({ select: { paylocityId: true, name: true, department: true } }),
    // Every job's customer identity, for the naming check below. One narrow read
    // of a few hundred rows on a page that already does several — and the whole
    // book on purpose, not just the active slice (see CustomerNaming).
    prisma.job.findMany({
      select: {
        jobId: true,
        status: true,
        customer: true,
        totEtoCompanyId: true,
        totEtoAccountId: true,
        customerManuallyEdited: true,
      },
    }),
  ]);
  const refreshedThrough = freshness?.refreshedThrough ?? null;

  const byPaylocityId = new Map(employees.filter((e) => e.paylocityId).map((e) => [e.paylocityId!, e]));

  // One pass over the punches, filtered to the ones that could possibly be a
  // problem. Deliberately NOT every punch: the checks below are all "after some
  // date" or "employee not on the roster", so the query can do most of the work.
  const [futureRaw, completedJobPunches, allEmployeeIds] = await Promise.all([
    // 1. Dated beyond the refresh watermark. `Is Future Date` in the model is
    //    date > Hours Refreshed Thru, NOT date > today — a punch can be in the
    //    future relative to what payroll has published without being in the
    //    future relative to the calendar.
    refreshedThrough
      ? prisma.jobHoursDetail.findMany({
          where: { workDate: { gt: refreshedThrough }, hours: { gt: 0 } },
          select: { workDate: true, employeeId: true, section: true, hours: true, job: { select: { jobId: true, jobName: true, status: true, completeDate: true } } },
          orderBy: { workDate: "desc" },
          take: SAMPLE_LIMIT + 1,
        })
      : Promise.resolve([]),
    // 5. On a Complete job, after its Complete Date. The section test can't go in
    //    the query (it's a prefix of a string column), so it's applied below.
    prisma.jobHoursDetail.findMany({
      where: { hours: { gt: 0 }, job: { status: "Complete", completeDate: { not: null }, jobId: { not: ALWAYS_VALID_JOB_ID } } },
      select: { workDate: true, employeeId: true, section: true, hours: true, job: { select: { jobId: true, jobName: true, status: true, completeDate: true } } },
      orderBy: { workDate: "desc" },
    }),
    // Every employee id that appears on a punch, to find the ones the roster
    // can't resolve — the page's "Undefined Employees" table.
    prisma.jobHoursDetail.groupBy({ by: ["employeeId"], _count: { _all: true }, _sum: { hours: true } }),
    // Rule 3 "Job Id Not Defined" — hours whose job cell matched no job at all, so they
    // never became punch rows — used to have its own finding here too (HoursImportIssue,
    // "Hours booked to a non-job"). Consolidated onto the ETC page's own "Data Quality —
    // Undefined Hours" card and drill instead (2026-08-20, by request): the same rows
    // were showing up in both places under different names. See
    // lib/unattributed-hours.ts.
  ]);

  const toIssue = (d: {
    workDate: Date;
    employeeId: string;
    section: string;
    hours: unknown;
    job: { jobId: string; jobName: string; status: string; completeDate: Date | null };
  }): PunchIssue => {
    const emp = byPaylocityId.get(d.employeeId);
    return {
      date: d.workDate.toISOString().slice(0, 10),
      // Falling back to the raw id rather than a blank: an id is actionable,
      // and an unresolved one is itself a finding (see undefinedEmployees).
      employee: emp?.name ?? `#${d.employeeId}`,
      employeeId: d.employeeId,
      department: emp?.department?.trim() || "—",
      jobId: d.job.jobId,
      jobName: d.job.jobName,
      jobStatus: d.job.status,
      section: d.section,
      hours: Number(d.hours),
      completeDate: d.job.completeDate ? d.job.completeDate.toISOString().slice(0, 10) : null,
    };
  };

  // Rule 2: job 4000 is valid whatever else is true of the punch.
  const futureAll = futureRaw.filter((d) => d.job.jobId !== ALWAYS_VALID_JOB_ID).map(toIssue);
  const future = futureAll.slice(0, SAMPLE_LIMIT);

  const afterAll = completedJobPunches
    .filter((d) => {
      const completeDate = d.job.completeDate!;
      if (d.workDate <= completeDate) return false;
      return !POST_COMPLETION_SECTIONS.has(d.section.slice(0, 2)); // rule 4 exempts these
    })
    .map(toIssue);
  const after = afterAll.slice(0, SAMPLE_LIMIT);

  const unresolved = allEmployeeIds
    // "0" is excluded on the report's own table too — it's the placeholder id,
    // not a person anyone can go and ask about.
    .filter((r) => r.employeeId && r.employeeId !== "0" && !byPaylocityId.has(r.employeeId))
    .map((r) => ({ employeeId: r.employeeId, rows: r._count._all, hours: Number(r._sum.hours ?? 0) }))
    .sort((a, b) => b.hours - a.hours);

  const sum = (rows: { hours: number }[]) => rows.reduce((s, r) => s + r.hours, 0);

  const customerNaming = customerAliasFindings(customerJobs);

  return {
    refreshedThrough: refreshedThrough ? refreshedThrough.toISOString().slice(0, 10) : null,
    future: { count: futureAll.length, hours: sum(futureAll), rows: future },
    afterCompletion: { count: afterAll.length, hours: sum(afterAll), rows: after },
    undefinedEmployees: { count: unresolved.length, hours: sum(unresolved), ids: unresolved },
    customerNaming,
    truncated: futureAll.length > SAMPLE_LIMIT || afterAll.length > SAMPLE_LIMIT,
  };
}

// ── The report page's punch explorer ────────────────────────────────────────
// The findings above answer "is anything wrong". This answers the question the
// report's main table is for: "show me the punches, let me slice them". Same
// columns, same slicers (date range, employee, function id, month-to-date), same
// Is Punch Valid / Reason on every row.
//
// Deliberately a SEPARATE call from getDataQuality: it reads every punch in the
// window to classify it, so it only runs when the Data Quality tab is actually
// open (see the ?tab= check in the dashboard). The dashboard's landing view must
// not pay for it.

export type PunchRow = PunchIssue & { valid: boolean; reason: string };

export type PunchExplorer = {
  kpis: { refreshedThrough: string | null; lastImported: string | null; totalHours: number; totalPunches: number };
  rows: PunchRow[];
  truncated: boolean;
  // Hours by employee department, split per employee — the report's stacked
  // column chart. Departments ordered biggest first.
  byDepartment: { department: string; total: number; employees: { name: string; hours: number }[] }[];
  options: { employees: { id: string; name: string }[]; functionIds: string[] };
  invalidCount: number;
};

export type PunchFilters = {
  from?: string; // YYYY-MM-DD
  to?: string;
  employeeId?: string;
  functionId?: string; // the part after the dash in a Section-Function Code
  monthToDate?: boolean;
};

const EXPLORER_MAX_ROWS = 3000;

export async function getPunchExplorer(filters: PunchFilters): Promise<PunchExplorer> {
  const [freshness, employees, latest] = await Promise.all([
    prisma.powerBiFreshness.findUnique({ where: { source: "hours_actual" }, select: { refreshedThrough: true, checkedAt: true } }).catch(() => null),
    prisma.employee.findMany({ select: { paylocityId: true, name: true, department: true } }),
    prisma.jobHoursDetail.findFirst({ orderBy: { syncedAt: "desc" }, select: { syncedAt: true } }).catch(() => null),
  ]);
  const refreshedThrough = freshness?.refreshedThrough ?? null;
  const byPaylocityId = new Map(employees.filter((e) => e.paylocityId).map((e) => [e.paylocityId!, e]));

  // Month-to-date wins over an explicit range, exactly like the report's
  // checkbox sitting above its date pickers.
  let from = filters.from ? new Date(`${filters.from}T00:00:00Z`) : undefined;
  let to = filters.to ? new Date(`${filters.to}T23:59:59Z`) : undefined;
  if (filters.monthToDate && refreshedThrough) {
    from = new Date(Date.UTC(refreshedThrough.getUTCFullYear(), refreshedThrough.getUTCMonth(), 1));
    to = refreshedThrough;
  }

  const punches = await prisma.jobHoursDetail.findMany({
    where: {
      ...(from || to ? { workDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
      ...(filters.functionId ? { section: { endsWith: `-${filters.functionId}` } } : {}),
    },
    select: {
      workDate: true, employeeId: true, section: true, hours: true,
      job: { select: { jobId: true, jobName: true, status: true, completeDate: true } },
    },
    orderBy: [{ workDate: "desc" }],
  });

  // Is Punch Valid / Is Punch Valid Reason, in the model's own order.
  const classify = (p: (typeof punches)[number]): { valid: boolean; reason: string } => {
    if (refreshedThrough && p.workDate > refreshedThrough) return { valid: false, reason: "Future" };
    if (p.job.jobId === ALWAYS_VALID_JOB_ID) return { valid: true, reason: "Valid" };
    const sectionId = p.section.slice(0, 2);
    if (p.job.status === "Complete") {
      if (POST_COMPLETION_SECTIONS.has(sectionId)) return { valid: true, reason: "Valid" };
      if (p.job.completeDate && p.workDate > p.job.completeDate) {
        return { valid: false, reason: "Completed Job and Not Sections 70, 80, 90" };
      }
    }
    return { valid: true, reason: "Valid" };
  };

  const all: PunchRow[] = punches.map((p) => {
    const emp = byPaylocityId.get(p.employeeId);
    const { valid, reason } = classify(p);
    return {
      date: p.workDate.toISOString().slice(0, 10),
      employee: emp?.name ?? "(undefined)",
      employeeId: p.employeeId,
      department: emp?.department?.trim() || "(undefined)",
      jobId: p.job.jobId,
      jobName: p.job.jobName,
      jobStatus: p.job.status,
      section: p.section,
      hours: Number(p.hours),
      completeDate: p.job.completeDate ? p.job.completeDate.toISOString().slice(0, 10) : null,
      valid,
      reason,
    };
  });

  // The chart is built from EVERY row in the window, not just the ones the table
  // can show — a chart that silently described the first 3,000 punches would be
  // worse than no chart.
  const deptMap = new Map<string, Map<string, number>>();
  for (const r of all) {
    let emps = deptMap.get(r.department);
    if (!emps) deptMap.set(r.department, (emps = new Map()));
    emps.set(r.employee, (emps.get(r.employee) ?? 0) + r.hours);
  }
  const byDepartment = [...deptMap.entries()]
    .map(([department, emps]) => ({
      department,
      total: [...emps.values()].reduce((s, h) => s + h, 0),
      employees: [...emps.entries()].map(([name, hours]) => ({ name, hours })).sort((a, b) => b.hours - a.hours),
    }))
    .sort((a, b) => b.total - a.total);

  const seenEmployees = new Map<string, string>();
  const functionIds = new Set<string>();
  for (const r of all) {
    seenEmployees.set(r.employeeId, r.employee);
    const fn = r.section.split("-")[1];
    if (fn) functionIds.add(fn);
  }

  return {
    kpis: {
      refreshedThrough: refreshedThrough ? refreshedThrough.toISOString().slice(0, 10) : null,
      lastImported: latest?.syncedAt ? latest.syncedAt.toISOString().slice(0, 16).replace("T", " ") : null,
      totalHours: all.reduce((s, r) => s + r.hours, 0),
      totalPunches: all.length,
    },
    rows: all.slice(0, EXPLORER_MAX_ROWS),
    truncated: all.length > EXPLORER_MAX_ROWS,
    byDepartment,
    options: {
      employees: [...seenEmployees.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      functionIds: [...functionIds].sort(),
    },
    invalidCount: all.filter((r) => !r.valid).length,
  };
}
