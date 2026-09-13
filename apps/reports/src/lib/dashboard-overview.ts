import "server-only";
import { prisma } from "@/lib/prisma";
import { validJobTypeFilter, VALID_JOB_TYPES, isSdcCustomer, compareJobIds, ACTIVE_JOB_WHERE } from "@/lib/job-filters";
import { resolveEmployeeGroup } from "@/lib/employee-card-theme";
import { workforceGroupForCardKey, rollupGroup } from "@/lib/employee-workforce-groups";
import { monthlyCapacityHours, hasYearPolicy } from "@/lib/workforce-capacity-policy";
import { fetchSchedulerFatEvents, dedupeFats } from "@/lib/scheduler-db";
import { getCustomerVisits, type CustomerVisitsResult } from "@/lib/customer-visits";
import { isValidMonth } from "@/lib/etc";
import { mapPunchToColumns, billingGroupForSection } from "@/lib/sections";
import { getDepartmentUtilization, type DepartmentUtilizationResult } from "@/lib/department-utilization";
import { customerBucket } from "@/lib/dashboard-job-drill";
import {
  canonicalCustomerKey,
  pickCanonicalName,
  type CanonicalCustomerKey,
} from "@/lib/customer-canonical";
import { getExecutionCalendar, type ExecutionCalendar } from "@/lib/dashboard-calendar";
import { getKeyDates, type KeyDatesResult } from "@/lib/dashboard-key-dates";

// ── One query pass for the whole dashboard (2026-08-27) ─────────────────────
//
// Every figure on the Dashboard is produced here, in ONE parallel pass, and the
// page renders what it is handed. That is a requirement of the redesign ("avoid
// separate unnecessary API calls per card", "do not duplicate business logic in
// the dashboard") and it is also what keeps the numbers reconcilable: the type
// breakdown, the customer cards and the Active Jobs KPI are three views of the
// SAME `jobs` array, read once, so they cannot disagree the way three separate
// count queries could.
//
// Nothing here defines new business rules. The job universe is job-filters.ts's
// `validJobTypeFilter` plus JOB_STATUSES (the same gate every other page uses),
// the department mapping is resolveEmployeeGroup -> workforceGroupForCardKey ->
// rollupGroup (the Employees tab's own chain), the capacity hours are
// workforce-capacity-policy.ts's published calendar, the actual hours are
// JobHoursDetail.standardDepartment (the Paylocity punch classification), and
// the FAT dates are the Scheduler's. Power BI is not read anywhere.

export type JobTypeBreakdown = { type: string; count: number; pct: number };

export type CustomerSummary = {
  /**
   * What the chart groups by and what the drill-through filters on — a canonical
   * customer id from customer-canonical.ts, NOT the stored customer string. The
   * two are different things now: 24 First Solar jobs reach one row under five
   * different spellings plus two site names.
   */
  canonicalCustomerId: string;
  /** The label to draw. From the reviewed registry when there is an entry, else the dominant raw spelling. */
  name: string;
  /** SDC's own internal work, per job-filters.ts's isSdcCustomer — never a real customer. */
  internal: boolean;
  activeCount: number;
  /** Type -> count, only the types this customer actually has. */
  byType: JobTypeBreakdown[];
  jobIds: string[];
  /**
   * Every stored spelling this row combined, with how many active jobs each
   * contributed, most-used first. Deliberately carried onto the chart rather
   * than hidden inside the resolver: a bar that silently merges names is a bar
   * nobody can check. One entry (equal to `name`) when nothing was merged.
   */
  rawNames: { name: string; count: number }[];
  /** How this group was arrived at, so a merge is always traceable to its evidence. */
  matchedBy: CanonicalCustomerKey["matchedBy"];
};

export type WorkforceCard = {
  key: "engineering" | "shop";
  title: string;
  headcount: number;
  /** Headcount x the month's net available hours (published holiday calendar). Null when the year has no policy yet. */
  capacityHours: number | null;
  /** Hours actually booked to this department in the month, from punch data. Null when the month has no punch rows at all. */
  bookedHours: number | null;
  /** Team code -> headcount, so a card can show its mix (ME/CE/Service, Build/Wire/MFG). */
  teams: { code: string; name: string; count: number }[];
};

export type DashboardOverview = {
  month: string;
  /** True when `month` is the month we are actually in — the only month whose booked hours are legitimately partial. */
  isCurrentMonth: boolean;
  monthInFuture: boolean;
  activeTotal: number;
  headStartTotal: number;
  byType: JobTypeBreakdown[];
  customers: CustomerSummary[];
  /**
   * The two FAT figures the top KPI strip shows, and nothing else.
   *
   * The per-FAT rows and the ME/CE breakdown were removed on 2026-08-31 with the
   * FAT summary cards that were their only reader — see the FAT block in
   * getDashboardOverview below.
   */
  fats: {
    /** False when the Scheduler is unconfigured or unreachable — so the UI can say that instead of "0 FATs". */
    available: boolean;
    /** Real FATs (pre-FATs excluded) dated inside `month`. */
    monthTotal: number;
    /** Pre-FATs dated inside `month` — readiness runs, not the FAT. */
    monthPreFats: number;
  };
  workforce: WorkforceCard[];
  visits: CustomerVisitsResult;
  // ── Department / Employee Utilization ─────────────────────────────────────
  //
  // A native rebuild of the Job Hours Report's utilization visuals — see
  // department-utilization.ts for the rules and for why its theoretical hours
  // legitimately differ from `workforce` above (that one is holiday-aware
  // capacity, this one is the report's holiday-agnostic Working Days x 8).
  // Both are on the page on purpose; they answer different questions.
  utilization: DepartmentUtilizationResult;
  /** FATs, Pre-FATs and Customer Visits for `month`, in one normalized event array. */
  calendar: ExecutionCalendar;
  /**
   * The Key Dates timeline's FIRST paint. The component refetches through its own
   * action whenever the chips or the month range move, so this only has to be a
   * sensible opening view — the default anchor and this month through +2, which
   * is the Scheduler's own default for the same view.
   */
  keyDates: KeyDatesResult;
};

/** The month the dashboard defaults to, and the one every month-scoped figure is measured in. */
export function dashboardMonth(raw: string | undefined, now: Date = new Date()): string {
  if (raw && isValidMonth(raw)) return raw;
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function pct(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 1000) / 10;
}

export async function getDashboardOverview(month: string, now: Date = new Date()): Promise<DashboardOverview> {
  const [year, monthNo] = month.split("-").map(Number);
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const [jobs, employees, hoursRows, fatEvents, visits, utilization, calendar, keyDates] = await Promise.all([
    // The whole live job population in one read (a few hundred rows). Active and
    // HeadStart are split in memory rather than by two counts, so the KPI, the
    // type strip and the customer cards are provably the same set of jobs.
    prisma.job.findMany({
      where: { status: { in: ["Active", "HeadStart"] }, ...validJobTypeFilter },
      // totEtoCompanyId / totEtoAccountId / customerManuallyEdited are the inputs
      // customer-canonical.ts groups on — three more columns on a read this pass
      // already does, not a second query.
      select: {
        jobId: true,
        jobName: true,
        customer: true,
        type: true,
        status: true,
        totEtoCompanyId: true,
        totEtoAccountId: true,
        customerManuallyEdited: true,
      },
    }),
    prisma.employee.findMany({
      where: { active: true },
      select: { team: true, department: true, discipline: true },
    }),
    // Actual hours booked in the month, grouped by RAW section pair — folded onto
    // the app's columns below, then bucketed by billing group. Filtered on the
    // denormalised `month`, so this is one grouped scan, not a per-card query.
    //
    // ── Why not `standardDepartment` any more (2026-09-02) ──────────────────
    //
    // This grouped by that stored column, which is the rule book's verdict on the
    // RAW pair — so a punch coded 13-211 or 11-211 reads "Undefined" and was
    // counted in NEITHER card, while Job Hour Details, Projects and Job Cost fold
    // those same punches onto 10-211 and count them as Engineering. Measured:
    // 13,429 hours classified differently by the two screens, led by 10-311
    // (4,347h across its 30/70 split), 13-211 (1,640h) and 11-211 (1,331h).
    //
    // Two screens disagreeing about "Engineering hours this month" is worse than
    // either answer being imperfect, so this now uses the same rule as every
    // other hours surface: fold the raw pair, then read the column's billing
    // group.
    prisma.jobHoursDetail.groupBy({
      by: ["section"],
      where: { month },
      _sum: { hours: true },
    }),
    fetchSchedulerFatEvents(),
    getCustomerVisits(month),
    // Punch-grain, so it does its own reads rather than reusing the grouped
    // `hoursRows` above — but it is one awaited unit inside THIS pass, not a
    // fetch the card makes for itself. The one-data-pass rule is about the page
    // never firing per-card requests, not about forbidding a second query.
    getDepartmentUtilization(month),
    getExecutionCalendar(month),
    // The timeline's opening view: the Scheduler's own default for Key Dates —
    // Mech 1, this month through +2. `today` is the server's, so done/late are
    // the same for everyone rather than following a client clock.
    getKeyDates({
      from: currentMonthKey,
      to: `${new Date(now.getFullYear(), now.getMonth() + 2, 1).getFullYear()}-${String(new Date(now.getFullYear(), now.getMonth() + 2, 1).getMonth() + 1).padStart(2, "0")}`,
      anchors: ["mech_release_1"],
      today: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
    }),
  ]);

  // Split off the SAME status the drill-through queries by, read from the shared
  // constant rather than re-typed as a literal here — the charts and the table a
  // click on them opens have to mean the identical thing by "active". The query
  // above already restricted `type` to validJobTypeFilter, which is the other
  // half of ACTIVE_JOB_WHERE.
  const activeJobs = jobs.filter((j) => j.status === ACTIVE_JOB_WHERE.status);
  const headStartTotal = jobs.filter((j) => j.status === "HeadStart").length;
  const activeTotal = activeJobs.length;

  // Every valid type gets a row even at zero, so the strip's shape doesn't change
  // as work moves between types — and the rows provably sum to activeTotal,
  // because the query already restricted `type` to this same list.
  const byType: JobTypeBreakdown[] = VALID_JOB_TYPES.map((type) => {
    const count = activeJobs.filter((j) => j.type === type).length;
    return { type, count, pct: pct(count, activeTotal) };
  });

  // ── Customers, grouped by CANONICAL customer (2026-08-31) ─────────────────
  //
  // This used to group on the customer string exactly as stored, with a comment
  // arguing that no spelling rule belonged on the dashboard. The rule still does
  // not live here — it lives in lib/customer-canonical.ts, which imports neither
  // prisma nor any component and is therefore usable by any page — but the chart
  // does now apply it, because the alternative was a top bar reading 12 for a
  // customer with 24 active jobs.
  //
  // canonicalCustomerKey, not a re-typed expression: the drill-through narrows
  // its rows with this exact function, so a bar and the table it opens cannot
  // group differently. (They did once — see the collation note in
  // dashboard-job-drill.ts.) Every job resolves to exactly ONE key, so the groups
  // partition activeJobs and provably still sum to activeTotal — no job can be
  // lost or counted twice by a merge.
  const byCustomer = new Map<string, { key: CanonicalCustomerKey; jobs: typeof activeJobs }>();
  for (const j of activeJobs) {
    const key = canonicalCustomerKey(j);
    const group = byCustomer.get(key.canonicalCustomerId) ?? { key, jobs: [] };
    group.jobs.push(j);
    byCustomer.set(key.canonicalCustomerId, group);
  }

  const customers: CustomerSummary[] = [...byCustomer.entries()]
    .map(([canonicalCustomerId, { key, jobs: list }]) => {
      // The stored spellings this row combined. Built here rather than in the
      // resolver because the resolver sees one job at a time and so cannot know
      // which spelling dominates.
      const rawCounts = new Map<string, number>();
      for (const j of list) {
        const raw = customerBucket(j.customer);
        rawCounts.set(raw, (rawCounts.get(raw) ?? 0) + 1);
      }
      const rawNames = [...rawCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

      return {
        canonicalCustomerId,
        // A reviewed registry entry names itself; a group formed by a bare
        // account id or by formatting alone is labelled with its dominant
        // spelling, which is deterministic and so cannot reshuffle on refresh.
        name: key.registryName ?? pickCanonicalName(rawNames),
        // Tested against EVERY spelling in the group, not just the label: the
        // "SDC" jobs and the "Steven Douglas Corp." jobs are one row now, and
        // that row is internal whichever spelling won the label.
        internal: rawNames.some((r) => isSdcCustomer(r.name)),
        activeCount: list.length,
        byType: VALID_JOB_TYPES.map((type) => {
          const count = list.filter((j) => j.type === type).length;
          return { type, count, pct: pct(count, list.length) };
        }).filter((t) => t.count > 0),
        jobIds: list.map((j) => j.jobId).sort(compareJobIds),
        rawNames,
        matchedBy: key.matchedBy,
      };
    })
    // Most active work first, on the COMBINED total — which is the point of the
    // merge: First Solar goes from a 12-job top bar to a 24-job one, and Steven
    // Douglas Corp. goes from two rows of 5 to one row of 10, overtaking four
    // customers. Real customers ahead of SDC's own internal work at equal
    // counts, since the section is about customer work.
    .sort(
      (a, b) =>
        b.activeCount - a.activeCount || Number(a.internal) - Number(b.internal) || a.name.localeCompare(b.name),
    );

  // ── Workforce cards ───────────────────────────────────────────────────────
  //
  // Headcount runs the Employees tab's own chain — resolveEmployeeGroup gives a
  // department CARD key, workforceGroupForCardKey maps it to a workforce group,
  // rollupGroup credits General Engineering to Engineering — so a mapping change
  // there moves this card too, and there is no second department table here.
  const teamCounts = new Map<string, { name: string; count: number; group: string }>();
  for (const e of employees) {
    const group = resolveEmployeeGroup(e);
    if (!group) continue;
    const wf = rollupGroup(workforceGroupForCardKey(group.key));
    const row = teamCounts.get(group.key) ?? { name: group.title, count: 0, group: wf };
    row.count += 1;
    teamCounts.set(group.key, row);
  }

  // Raw pair -> app column(s) -> billing group. billingGroupForSection returns
  // null for PM and for anything with no column (Service 80-*, Spare Parts 90-*,
  // unmappable pairs); those hours are real but are neither Engineering nor Shop,
  // so they are deliberately in neither card rather than guessed into one.
  const bookedByDept = new Map<string, number>();
  for (const r of hoursRows) {
    for (const col of mapPunchToColumns(r.section, Number(r._sum.hours ?? 0))) {
      const group = billingGroupForSection(col.section);
      if (group) bookedByDept.set(group, (bookedByDept.get(group) ?? 0) + col.hours);
    }
  }
  // "No punch rows for this month at all" is a different thing from "zero hours
  // in this department", and only the first justifies hiding the figure. A future
  // month has no rows; a month that has been worked always has some.
  const monthHasHours = hoursRows.length > 0;
  const capacityPerHead = hasYearPolicy(year) ? monthlyCapacityHours(year, monthNo) : null;

  const workforce: WorkforceCard[] = (["engineering", "shop"] as const).map((key) => {
    const teams = [...teamCounts.entries()]
      .filter(([, v]) => v.group === key)
      .map(([code, v]) => ({ code, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const headcount = teams.reduce((s, t) => s + t.count, 0);
    return {
      key,
      title: key === "engineering" ? "Engineering" : "Shop",
      headcount,
      capacityHours: capacityPerHead == null ? null : Math.round(headcount * capacityPerHead),
      // `standardDepartment` uses the same two words — "Engineering" / "Shop" —
      // as the workforce groups, which is why no translation table is needed.
      bookedHours: monthHasHours
        ? Math.round(bookedByDept.get(key === "engineering" ? "Engineering" : "Shop") ?? 0)
        : null,
      teams,
    };
  });

  // ── FATs (2026-08-31: reduced to the two KPI-strip figures) ───────────────
  //
  // Two counts survive, both on the top KPI strip: real FATs dated in `month`,
  // and pre-FATs.
  //
  // What went, and why nothing here computes it any more: the FAT SUMMARY CARDS
  // beside the Execution Calendar — "Involving ME", "Involving CE" and the note
  // about placeholder seats and unstaffed FATs — were removed by request, and
  // they were the only readers of per-FAT owner data. So this no longer builds a
  // FatRow[], and it no longer calls fetchSchedulerJobDisciplineOwners() at all,
  // which takes one Scheduler round-trip off every Dashboard load. (That function
  // is still live — the inline job drill-through uses it; see
  // dashboard-job-drill.ts.)
  //
  // `upcoming` and `monthRows` went with them. Both were ALREADY unread before
  // this change: the FAT list they fed was replaced by the Execution Calendar
  // (see this file's Execution Calendar note), and nothing picked them up.
  //
  // The calendar is untouched by any of this — getExecutionCalendar(month) does
  // its own read and never depended on these rows.
  const jobByNumber = new Map(jobs.map((j) => [j.jobId, j]));
  const available = fatEvents !== null;

  // Only FATs on jobs this app still considers live work. That keeps stale and
  // test schedules ("1101_Steris_Test") out of a count managers act on, and it
  // ties the FAT figures to the same population the rest of the page reports —
  // so "FATs this month" cannot describe jobs the Active Jobs KPI has never
  // heard of. dedupeFats first, so one FAT with several Scheduler tasks counts
  // once — exactly as before.
  const monthFatEvents = dedupeFats(fatEvents ?? []).filter(
    (e) => jobByNumber.has(e.jobNumber) && e.date.startsWith(`${month}-`),
  );

  return {
    month,
    isCurrentMonth: month === currentMonthKey,
    monthInFuture: month > currentMonthKey,
    activeTotal,
    headStartTotal,
    byType,
    customers,
    fats: {
      available,
      monthTotal: monthFatEvents.filter((e) => e.kind === "fat").length,
      monthPreFats: monthFatEvents.filter((e) => e.kind === "pre").length,
    },
    workforce,
    visits,
    utilization,
    calendar,
    keyDates,
  };
}
