import "server-only";
import { prisma } from "@/lib/prisma";
import { workingDaysInMonth } from "@/lib/etc";
import { resolveEmployeeGroup } from "@/lib/employee-card-theme";
import { workforceGroupForCardKey, workforceGroupTitle, type WorkforceGroupKey } from "@/lib/employee-workforce-groups";
import { isEtcCapacityCardKey, etcCapacityOrderRank } from "@/lib/etc-capacity-departments";

// ── Department / Employee Utilization (2026-08-28) ──────────────────────────
//
// A native reproduction of the Job Hours Report's `Department Utilization` and
// `Employee Utilization, Bottom 10` visuals (Power BI page "Project Portfolio"),
// computed here against THIS app's authoritative data rather than read back out
// of Power BI at runtime. Power BI was used once, to recover the business rules
// below; nothing on this path talks to it. That is the standing rule for hours
// in every SDC app — see the note at the top of hours-feed.ts.
//
// Every rule here was lifted from the report's own DAX, not inferred from a
// screenshot, and each measure carries the DAX it reproduces so the two can be
// diffed when either moves. The four rules that actually decide the numbers:
//
//   1. A punch is BILLABLE if its job was still open on the punch date, its
//      section is not 98 (Invalid), and its job is not one of the four overhead
//      jobs. After a job's close date only Warranty/Service/Spare Parts (70/80/90)
//      stay billable — everything else booked to a closed job is Non-Billable.
//   2. "Open on the punch date" is Job[Effective Close Date]: blank for any job
//      that is not Complete; otherwise its completeDate; otherwise (Complete but
//      no date recorded) the job's last valid punch, as a proxy.
//   3. Bellco (job 6000) is carved out of both Billable and Non-Billable and
//      reported on its own.
//   4. Utilization % is billable hours over ACTUAL hours worked — not over
//      theoretical hours. Theoretical hours drive Available Hours % instead.
//
// ── Where this deliberately differs from the report ─────────────────────────
//
// DEPARTMENTS. The report filters five literal department names — Mechanical
// Engineering, Controls Engineering, Machine Building, Machine Wiring,
// Manufacturing — that come from a SharePoint workbook this app does not read.
// This app's own department vocabulary is different ("Electrical Build",
// "Mechanical Build / Manufacturing", "Manufacturing Operations", ...), so a
// literal port of that filter would have silently dropped most of the Shop.
// Instead we use the app's standardized mapping (resolveEmployeeGroup ->
// workforceGroupForCardKey, the Employees tab's own chain) and scope to the team
// codes that mean the same five departments: mech + controls (Engineering, minus
// Service) and build + wire + mfgops (all of Shop). Service Engineering and PM
// are outside the report's five and stay outside here — they still appear as
// rows, they just carry no Utilization %.
//
// THEORETICAL HOURS are holiday-AGNOSTIC here, matching the report's `Working
// Days` measure (a plain non-weekend count). That is why this uses etc.ts's
// workingDaysInMonth() and NOT workforce-capacity-policy.ts, whose whole purpose
// is to be holiday/vacation/sick-AWARE for a different question. The Dashboard
// shows both; they are different numbers on purpose and must not be reconciled
// into one. See workforce-capacity-policy.ts's own header, which says so first.
//
// ── ROWS: the ETC tab's own departments (2026-08-31, by request) ─────────
//
// `departments` and `total` cover the departments the ETC/execution workflow
// actually books hours through — Engineering AND Shop:
//
//   Mechanical Engineering, Controls Engineering, General Engineering,
//   Mechanical Build, Electrical Build
//
// in the ETC tab's own column order. The back office is out (Finance, Sales,
// Executive Leadership, Growth, Operations, No department), and so are the three
// departments the ETC grid itself has no column for (PM, Manufacturing
// Operations, Service Engineering) — see etc-capacity-departments.ts, which
// derives all of this from ETC_SECTIONS rather than listing it.
//
// This got it wrong once in the other direction: a first pass filtered on the
// app's ORGANISATIONAL grouping (Engineering + PM, excluding Shop because Shop
// rolls up under Operations) and dropped Mechanical Build and Electrical Build,
// which are core ETC departments. Whether a department sits under an Operations
// organisation says nothing about whether it books ETC hours. That is why the
// filter is the ETC section structure and not a team or group predicate.
//
// Two consequences worth being blunt about, since everything above this line is
// about reproducing the report faithfully:
//
//   1. `total` IS NO LONGER THE REPORT'S GRAND TOTAL. The report foots the five
//      billable departments (UTILIZATION_TEAM_CODES); this foots the rows the
//      card actually shows. The two sets overlap heavily — mech, controls, build
//      and wire are in both — and differ by Manufacturing Operations, which the
//      report counts and the ETC grid has no column for. So the figure is close
//      to the report's but not identical, by request.
//   2. Every PER-ROW measure is untouched. The billable rule, the close-date
//      pivot, theoretical hours, Available % and Utilization % are computed
//      exactly as before for the rows that remain. General Engineering carries no
//      Utilization % — it is outside UTILIZATION_TEAM_CODES — and no employees
//      today, so it renders no row at all.
//
// `employees` stays UNFILTERED — it feeds the peer "Employee Utilization" panel,
// which has its own All/Billable/per-department selector and was not part of the
// request. That is the one place the two halves of this result deliberately
// disagree about scope.
//
// The filter and the row order both come from etc-capacity-departments.ts
// (isEtcCapacityCardKey / etcCapacityOrderRank), which derives them from the ETC
// grid's own columns — so there is no dashboard-specific department list here to
// drift from the ETC tab.

/**
 * The team codes whose people the report counts as billable-utilization staff —
 * the app-vocabulary equivalent of its five literal department names. `service`
 * and `pm` are deliberately absent (see this file's header).
 */
export const UTILIZATION_TEAM_CODES: readonly string[] = ["mech", "controls", "build", "wire", "mfgops"];

/** Overhead jobs the report excludes from every billable measure. Bellco (6000) is handled separately. */
export const OVERHEAD_JOB_IDS: readonly string[] = ["4000", "1083", "7000", "10000"];
export const BELLCO_JOB_ID = "6000";

/**
 * Section prefixes with a meaning in the billable rules. The report reads these as
 * LEFT(Section-Function Code, 2); this app already stores the section half split out
 * and normalized ("010" -> "10"), so `rawSection` IS that value and no string slicing
 * is needed. The two agree for every 2-digit section, and for a 1-digit one ("1-311")
 * PBI's LEFT gives "1-", which matches none of these — same outcome as comparing "1".
 */
const SECTION_WARRANTY = "70";
const SECTION_SERVICE = "80";
const SECTION_SPARE_PARTS = "90";
const SECTION_INVALID = "98";
const CLOSED_JOB_STILL_BILLABLE = new Set([SECTION_WARRANTY, SECTION_SERVICE, SECTION_SPARE_PARTS]);

/** Hours per working day, the report's own constant in `Theoretical Total Hours`. */
export const HOURS_PER_WORKING_DAY = 8;
/** A day's hours above this count as overtime, per the report's `Overtime Hours`. */
const OVERTIME_DAILY_THRESHOLD = 8;

export type UtilizationMeasures = {
  /** Headcount in scope for the row. `Employees` = count(Employee[Employee Id]). */
  employees: number;
  /** `Theoretical Total Hours` = Employees x Working Days x 8. */
  theoreticalHours: number;
  /** `Hours Actual` — every hour booked, billable or not. Shown as "Total Hours". */
  actualHours: number;
  /** `Available Hours %` = Hours Actual / Theoretical Total Hours. Null when theoretical is 0. */
  availablePct: number | null;
  /** `Utilization %` = Hours Actual Billable / Hours Actual (in-scope only). Null out of scope. */
  utilizationPct: number | null;
  /** `Hours Actual Billable` — the whole billable rule, close-date pivot included. */
  billableTotal: number;
  /** `Hours Actual Billable Active` — billable work that is NOT warranty/service/spare parts. */
  billableActive: number;
  /** `Hours Actual Billable Warranty` — section 70. */
  warranty: number;
  /** `Hours Actual Billable Service` — section 80. */
  billableService: number;
  /** `Hours Actual Billable Spare Parts` — section 90. */
  billableSpareParts: number;
  /** `Hours Actual Billable Bellco` — job 6000, reported on its own. */
  bellco: number;
  /** `Hours Actual Non-Billable` — overhead jobs, section 98, and post-close non-70/80/90. */
  nonBillable: number;
  /** `Hours Actual Travel`. NULL (not 0) when no punch in range carried travel data — see JobHoursDetail.travelHours. */
  travelHours: number | null;
  /** `Hours Actual Travel %` = Travel / Hours Actual. Null when travel is unknown or there are no hours. */
  travelPct: number | null;
  /** `Overtime Hours` — per employee per day, the hours above 8. */
  overtimeHours: number;
};

export type EmployeeUtilizationRow = UtilizationMeasures & {
  employeeId: string;
  name: string;
  departmentKey: string;
  departmentTitle: string;
  billingGroup: string;
  /** False for Service/PM/back-office — they show hours but no Utilization %. */
  inUtilizationScope: boolean;
  /** False for a leaver kept in the month because they booked hours in it. */
  active: boolean;
};

export type DepartmentUtilizationRow = UtilizationMeasures & {
  key: string;
  title: string;
  /** The rolled-up billing group this department sits under ("Engineering" / "Shop" / ...). */
  billingGroup: string;
  inUtilizationScope: boolean;
  employeeRows: EmployeeUtilizationRow[];
};

export type DepartmentUtilizationResult = {
  month: string;
  workingDays: number;
  /** True once at least one punch in the month carried travel data — drives "—" vs 0 in the UI. */
  travelKnown: boolean;
  /**
   * The ETC tab's departments only, in the ETC tab's own column order
   * (Mechanical Engineering → Controls Engineering → General Engineering →
   * Mechanical Build → Electrical Build). Never sorted alphabetically — see this
   * file's header.
   */
  departments: DepartmentUtilizationRow[];
   /**
   * EVERY employee with hours or headcount, in an ETC department or not,
   * flattened for the peer "Employee Utilization" ranked list. Deliberately NOT
   * narrowed: that panel is a separate card with its own department selector.
   */
  employees: EmployeeUtilizationRow[];
  /** The total across `departments` — the ETC department set, NOT the report's grand total. See the header. */
  total: UtilizationMeasures;
};

type PunchRow = {
  employeeId: string;
  jobNumber: string;
  rawSection: string;
  workDate: Date;
  hours: number;
  travelHours: number | null;
  effectiveCloseDate: Date | null;
};

function emptyMeasures(): UtilizationMeasures {
  return {
    employees: 0,
    theoreticalHours: 0,
    actualHours: 0,
    availablePct: null,
    utilizationPct: null,
    billableTotal: 0,
    billableActive: 0,
    warranty: 0,
    billableService: 0,
    billableSpareParts: 0,
    bellco: 0,
    nonBillable: 0,
    travelHours: null,
    travelPct: null,
    overtimeHours: 0,
  };
}

/**
 * Which of the report's buckets a single punch falls in. Pure, and exported so the
 * test suite can assert the rule table directly rather than through a database.
 *
 * Reproduces `Hours Actual Billable` / `... Active` / `... Warranty` / `... Service`
 * / `... Spare Parts` / `... Bellco` / `Hours Actual Non-Billable` as ONE decision,
 * which is the point: in the report those are seven independent CALCULATE filters
 * that happen to partition the data, and any drift between them is invisible there.
 * Here a punch lands in exactly one bucket by construction, so Billable + Non-Billable
 * + Bellco always foots back to Hours Actual.
 */
export type PunchBucket = "billableActive" | "warranty" | "service" | "spareParts" | "bellco" | "nonBillable";

export function classifyUtilizationPunch(p: {
  jobNumber: string;
  rawSection: string;
  workDate: Date;
  effectiveCloseDate: Date | null;
}): PunchBucket {
  if (p.jobNumber === BELLCO_JOB_ID) return "bellco";
  if (OVERHEAD_JOB_IDS.includes(p.jobNumber)) return "nonBillable";
  if (p.rawSection === SECTION_INVALID) return "nonBillable";

  // Open on the punch date? Blank close date means the job was never closed.
  const closed = p.effectiveCloseDate !== null && p.workDate.getTime() > p.effectiveCloseDate.getTime();
  if (closed && !CLOSED_JOB_STILL_BILLABLE.has(p.rawSection)) return "nonBillable";

  if (p.rawSection === SECTION_WARRANTY) return "warranty";
  if (p.rawSection === SECTION_SERVICE) return "service";
  if (p.rawSection === SECTION_SPARE_PARTS) return "spareParts";
  return "billableActive";
}

/** Adds one punch's hours into a measures accumulator. */
function accumulate(m: UtilizationMeasures, p: PunchRow): void {
  m.actualHours += p.hours;
  if (p.travelHours !== null) m.travelHours = (m.travelHours ?? 0) + p.travelHours;

  switch (classifyUtilizationPunch(p)) {
    case "bellco":
      m.bellco += p.hours;
      break;
    case "nonBillable":
      m.nonBillable += p.hours;
      break;
    case "warranty":
      m.warranty += p.hours;
      m.billableTotal += p.hours;
      break;
    case "service":
      m.billableService += p.hours;
      m.billableTotal += p.hours;
      break;
    case "spareParts":
      m.billableSpareParts += p.hours;
      m.billableTotal += p.hours;
      break;
    case "billableActive":
      m.billableActive += p.hours;
      m.billableTotal += p.hours;
      break;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Rounds the hour figures once, at the end, so intermediate sums stay exact. */
function finalize(m: UtilizationMeasures, opts: { employees: number; workingDays: number; inScope: boolean }): void {
  m.employees = opts.employees;
  m.theoreticalHours = opts.employees * opts.workingDays * HOURS_PER_WORKING_DAY;

  m.actualHours = round2(m.actualHours);
  m.billableTotal = round2(m.billableTotal);
  m.billableActive = round2(m.billableActive);
  m.warranty = round2(m.warranty);
  m.billableService = round2(m.billableService);
  m.billableSpareParts = round2(m.billableSpareParts);
  m.bellco = round2(m.bellco);
  m.nonBillable = round2(m.nonBillable);
  m.overtimeHours = round2(m.overtimeHours);
  if (m.travelHours !== null) m.travelHours = round2(m.travelHours);

  m.availablePct = m.theoreticalHours > 0 ? m.actualHours / m.theoreticalHours : null;
  // DIVIDE(..., BLANK()) — the report shows nothing rather than 0% for a row with no
  // hours, and Utilization % is only meaningful for the in-scope departments.
  m.utilizationPct = opts.inScope && m.actualHours > 0 ? m.billableTotal / m.actualHours : null;
  m.travelPct = m.travelHours !== null && m.actualHours > 0 ? m.travelHours / m.actualHours : null;
}

/**
 * Per-job effective close date, reproducing Job[Effective Close Date] — a CALCULATED
 * COLUMN in the model, so its MAX() runs over the job's whole punch history and is
 * NOT narrowed by the month being viewed. Computing it per month would move a
 * close-date proxy every time somebody changed the month filter.
 */
export async function loadEffectiveCloseDates(): Promise<Map<string, Date | null>> {
  const jobs = await prisma.job.findMany({ select: { id: true, jobId: true, status: true, completeDate: true } });

  const needProxy = jobs.filter((j) => j.status === "Complete" && j.completeDate === null).map((j) => j.id);
  const proxy = new Map<number, Date>();
  if (needProxy.length > 0) {
    const rows = await prisma.jobHoursDetail.groupBy({
      by: ["jobId"],
      where: { jobId: { in: needProxy }, rawSection: { not: SECTION_INVALID } },
      _max: { workDate: true },
    });
    for (const r of rows) if (r._max.workDate) proxy.set(r.jobId, r._max.workDate);
  }

  const out = new Map<string, Date | null>();
  for (const j of jobs) {
    if (j.status !== "Complete") out.set(j.jobId, null);
    else if (j.completeDate) out.set(j.jobId, j.completeDate);
    else out.set(j.jobId, proxy.get(j.id) ?? null);
  }
  return out;
}

/** Paylocity ids that booked any hours in the month — see the population note in getDepartmentUtilization. */
async function monthEmployeeIds(month: string): Promise<string[]> {
  const rows = await prisma.jobHoursDetail.groupBy({ by: ["employeeId"], where: { month } });
  return rows.map((r) => r.employeeId);
}

/**
 * The whole section's figures for one month, in one pass.
 *
 * Called from getDashboardOverview's parallel batch — it does its own reads because
 * it needs punch-grain rows nothing else on the Dashboard loads, but it is one
 * awaited unit inside that single pass, not a per-card fetch.
 */
export async function getDepartmentUtilization(month: string): Promise<DepartmentUtilizationResult> {
  const workingDays = workingDaysInMonth(month);

  const [employees, closeDates, punches] = await Promise.all([
    // ── Who counts as staff for THIS month (2026-08-28) ───────────────────
    //
    // Not `active: true`. Somebody who worked in July and left in August was
    // genuinely on the payroll in July: their hours are real, they consumed real
    // capacity, and both belong in July's figures. Filtering on today's active
    // flag dropped 670 hours out of July 2026 alone — and dropped them SILENTLY,
    // so Billable + Non-Billable stopped footing to the month's actual hours.
    // A utilization report that quietly loses 9% of the month is worse than one
    // that shows a leaver.
    //
    // So the population is "active today OR booked hours in this month", and the
    // headcount that divides into it is the same set — a leaver adds to actual
    // hours AND to theoretical hours, never to just one.
    prisma.employee.findMany({
      where: {
        paylocityId: { not: null },
        OR: [{ active: true }, { paylocityId: { in: await monthEmployeeIds(month) } }],
      },
      select: { paylocityId: true, name: true, department: true, discipline: true, team: true, billingGroup: true, active: true },
    }),
    loadEffectiveCloseDates(),
    prisma.jobHoursDetail.findMany({
      where: { month },
      select: {
        employeeId: true,
        rawSection: true,
        workDate: true,
        hours: true,
        travelHours: true,
        job: { select: { jobId: true } },
      },
    }),
  ]);

  // ── Employee -> department, via the app's own standardized chain ──────────
  type Person = {
    employeeId: string;
    name: string;
    departmentKey: string;
    departmentTitle: string;
    billingGroup: string;
    inScope: boolean;
    /** False for a leaver retained because they booked hours in this month. */
    active: boolean;
  };
  const people = new Map<string, Person>();
  for (const e of employees) {
    if (!e.paylocityId) continue;
    const group = resolveEmployeeGroup(e);
    // resolveEmployeeGroup returns null for departments the Employees tab hides.
    // They keep their hours (they are real punches) under an explicit bucket rather
    // than being dropped, which would break the "Billable + Non-Billable = Actual"
    // foot at the total row.
    const cardKey = group?.key ?? "other";
    const rollup: WorkforceGroupKey = workforceGroupForCardKey(cardKey);
    people.set(e.paylocityId, {
      employeeId: e.paylocityId,
      name: e.name,
      departmentKey: cardKey,
      departmentTitle: group?.title ?? "Other",
      billingGroup: workforceGroupTitle(rollup),
      inScope: UTILIZATION_TEAM_CODES.includes(cardKey),
      active: e.active,
    });
  }

  // ── Fold punches onto people ──────────────────────────────────────────────
  const byEmployee = new Map<string, UtilizationMeasures>();
  // (employee, day) -> hours, for the overtime rule. Built alongside so the punch
  // list is walked once.
  const dailyHours = new Map<string, number>();
  let travelKnown = false;

  for (const row of punches) {
    const person = people.get(row.employeeId);
    // Unreachable on today's data — the population query above explicitly includes
    // everybody who booked hours this month, so every punch has a person. Kept as a
    // guard rather than a `!`: if an employee row is ever deleted out from under its
    // punches, dropping that punch is safer than crashing the whole Dashboard, and
    // the foot-check in the test suite will catch it.
    if (!person) continue;

    const travelHours = row.travelHours === null ? null : Number(row.travelHours);
    if (travelHours !== null) travelKnown = true;

    const p: PunchRow = {
      employeeId: row.employeeId,
      jobNumber: row.job.jobId,
      rawSection: row.rawSection,
      workDate: row.workDate,
      hours: Number(row.hours),
      travelHours,
      effectiveCloseDate: closeDates.get(row.job.jobId) ?? null,
    };

    let m = byEmployee.get(row.employeeId);
    if (!m) {
      m = emptyMeasures();
      byEmployee.set(row.employeeId, m);
    }
    accumulate(m, p);

    const dayKey = `${row.employeeId}::${p.workDate.toISOString().slice(0, 10)}`;
    dailyHours.set(dayKey, (dailyHours.get(dayKey) ?? 0) + p.hours);
  }

  // Overtime: per employee per day, the hours above 8. Applied after the fold so a
  // day split across several jobs is judged on the day's TOTAL, which is what the
  // report's SUMMARIZE(Employee Name, Date) does.
  for (const [dayKey, hours] of dailyHours) {
    if (hours <= OVERTIME_DAILY_THRESHOLD) continue;
    const employeeId = dayKey.slice(0, dayKey.indexOf("::"));
    const m = byEmployee.get(employeeId);
    if (m) m.overtimeHours += hours - OVERTIME_DAILY_THRESHOLD;
  }

  // ── Build the employee rows ───────────────────────────────────────────────
  const employeeRows: EmployeeUtilizationRow[] = [];
  for (const person of people.values()) {
    const m = byEmployee.get(person.employeeId) ?? emptyMeasures();
    // One person is one headcount, so their own theoretical hours are a full month.
    finalize(m, { employees: 1, workingDays, inScope: person.inScope });
    employeeRows.push({
      ...m,
      employeeId: person.employeeId,
      name: person.name,
      departmentKey: person.departmentKey,
      departmentTitle: person.departmentTitle,
      billingGroup: person.billingGroup,
      inUtilizationScope: person.inScope,
      active: person.active,
    });
  }

  // ── Roll up to departments ────────────────────────────────────────────────
  // Rebuilt from the PUNCHES, not by summing the finalized employee rows — summing
  // rounded percentages is how a department total ends up disagreeing with its own
  // expanded rows. Only headcount and hours add; every ratio is recomputed.
  const deptAcc = new Map<string, { row: DepartmentUtilizationRow; headcount: number }>();
  for (const er of employeeRows) {
    let entry = deptAcc.get(er.departmentKey);
    if (!entry) {
      entry = {
        row: {
          ...emptyMeasures(),
          key: er.departmentKey,
          title: er.departmentTitle,
          billingGroup: er.billingGroup,
          inUtilizationScope: er.inUtilizationScope,
          employeeRows: [],
        },
        headcount: 0,
      };
      deptAcc.set(er.departmentKey, entry);
    }
    entry.headcount += 1;
    entry.row.employeeRows.push(er);
  }

  // The foot of the card, so it sums exactly the rows the card renders — the ETC
  // Engineering + Shop departments — rather than the report's five billable ones.
  // Accumulated from the PUNCHES like every department row, not by adding
  // the finalized rows up, for the same reason stated above: summing rounded
  // ratios is how a total disagrees with its own rows.
  const totalAcc = emptyMeasures();
  let totalHeadcount = 0;

  for (const row of punches) {
    const person = people.get(row.employeeId);
    if (!person) continue;
    const travelHours = row.travelHours === null ? null : Number(row.travelHours);
    const p: PunchRow = {
      employeeId: row.employeeId,
      jobNumber: row.job.jobId,
      rawSection: row.rawSection,
      workDate: row.workDate,
      hours: Number(row.hours),
      travelHours,
      effectiveCloseDate: closeDates.get(row.job.jobId) ?? null,
    };
    const entry = deptAcc.get(person.departmentKey);
    if (entry) accumulate(entry.row, p);
    // isEtcCapacityCardKey, not `person.inScope`: inScope is the report's five
    // billable departments, which is a different question from "is this a row the
    // card shows" (they differ by Manufacturing Operations and General
    // Engineering).
    if (isEtcCapacityCardKey(person.departmentKey)) accumulate(totalAcc, p);
  }

  // Overtime rolls up as a sum of the employee figures — it is already a per-person
  // per-day quantity, so adding people's overtime is the correct aggregation (unlike
  // the ratios above, which have to be recomputed).
  for (const er of employeeRows) {
    const entry = deptAcc.get(er.departmentKey);
    if (entry) entry.row.overtimeHours += er.overtimeHours;
    if (isEtcCapacityCardKey(er.departmentKey)) {
      totalAcc.overtimeHours += er.overtimeHours;
      // Headcount for the foot's Employees count and its theoretical hours, so
      // Available % at the foot is over the same people the rows above cover.
      totalHeadcount += 1;
    }
  }

  const departments = [...deptAcc.values()]
    // Everything the ETC grid has no column for leaves the card here — one
    // filter, on the shared ETC mapping, applied before anything is finalized.
    // The nested employeeRows go with their department, so an expanded row can
    // never show a back-office employee under an ETC department.
    .filter(({ row }) => isEtcCapacityCardKey(row.key))
    .map(({ row, headcount }) => {
      finalize(row, { employees: headcount, workingDays, inScope: row.inUtilizationScope });
      row.employeeRows.sort((a, b) => a.name.localeCompare(b.name));
      return row;
    });

  // The ETC tab's own column order — Mechanical Engineering → Controls
  // Engineering → General Engineering → Mechanical Build → Electrical Build.
  //
  // Was "in-scope first, then billing group, then title A→Z", which put Controls
  // Engineering above Mechanical Engineering and split the Engineering block. The
  // rank is derived from ETC_SECTIONS, so reordering the ETC grid's columns moves
  // these rows with them and there is nothing here to update. The title tiebreak
  // survives only for a key the ETC order does not know, which all rank
  // equal-last — and the filter above means none reach the sort today.
  departments.sort((a, b) => etcCapacityOrderRank(a.key) - etcCapacityOrderRank(b.key) || a.title.localeCompare(b.title));

  finalize(totalAcc, { employees: totalHeadcount, workingDays, inScope: true });

  return {
    month,
    workingDays,
    travelKnown,
    departments,
    employees: employeeRows,
    total: totalAcc,
  };
}
