import "server-only";
import { prisma } from "@/lib/prisma";
import {
  fetchSchedulerFatEvents,
  fetchSchedulerJobDisciplineOwners,
  fetchSchedulerProjectLeads,
  dedupeFats,
  type SchedulerFatEvent,
} from "@/lib/scheduler-db";
import { getCustomerVisits } from "@/lib/customer-visits";

// ── One event model for the Execution Calendar (2026-08-28) ─────────────────
//
// FATs, Pre-FATs and Customer Visits are three different upstreams that the
// Dashboard now draws in a single month grid. They are normalised into ONE
// CalendarEvent here, so the calendar and the "Upcoming" list are two renderings
// of the same array rather than two pipelines that can disagree — and so a
// fourth event type later is a new builder plus a colour, not a new view.
//
// ── What is authoritative for each field ────────────────────────────────────
//
//   FAT / Pre-FAT     Scheduler `tasks`, via fetchSchedulerFatEvents — the SAME
//                     reader the Dashboard's FAT KPIs already use, so the
//                     calendar and those cards cannot disagree about the month's
//                     FAT count. Pre-FAT vs FAT is that reader's own `kind`.
//   Machine           Scheduler `tasks.machine` — the real relationship. NOT
//                     parsed out of the task name: "FAT - Pair 3" carries
//                     machine "M3" as a column, and a name like "Squeegee1 FAT"
//                     carries "M2" that no text rule would have found. NULL is
//                     meaningful — the FAT covers the whole project.
//   ME / CE           fetchSchedulerJobDisciplineOwners, unchanged — named
//                     engineers on the job's schedule, placeholders already
//                     excluded there. Job-level rather than machine-level
//                     because machine is set on only ~40% of mech/controls
//                     tasks, so a machine-scoped list would be silently short.
//   Debug Lead        Scheduler `settings.project_leads`, the store its own
//                     Projects page reads and writes. Not a new field.
//   Customer / name   THIS app's Job table, matched on job number — the same
//                     place every other Dashboard section names a job from.
//   Customer Visits   customer-visits.ts, which reports `configured: false`
//                     while no source exists. No visit is ever invented, and no
//                     task name is scraped as one.

export type CalendarEventType = "fat" | "pre" | "visit";

export type CalendarEvent = {
  /** Stable and unique across types — `fat:<taskId>` / `visit:<date>:<customer>`. */
  eventId: string;
  eventType: CalendarEventType;
  /** "YYYY-MM-DD". */
  date: string;
  /** ETC job number, when the event has one. Visits may not. */
  jobNumber: string | null;
  /** This app's job name for that number, null when the number matches no job here. */
  jobName: string | null;
  customer: string | null;
  /** The Scheduler schedule the FAT lives on — two schedules for one job stay distinguishable. */
  projectName: string | null;
  /** "M1" … from tasks.machine, or null for a project-level FAT. */
  machine: string | null;
  /** The Scheduler task's own name, e.g. "FAT - Pair 3". */
  title: string;
  meOwners: string[];
  ceOwners: string[];
  debugLead: string | null;
  pm: string | null;
  /** Visit-only. */
  visitOwner: string | null;
  visitNote: string | null;
};

export type ExecutionCalendar = {
  month: string;
  events: CalendarEvent[];
  /** False when the Scheduler is unreachable — the UI says so rather than showing an empty month as fact. */
  schedulerAvailable: boolean;
  /** False while no Customer Visit source exists. Drives the compact empty state. */
  visitsConfigured: boolean;
};

function inMonth(date: string, month: string): boolean {
  return date.startsWith(`${month}-`);
}

/**
 * Every event in `month`, from all three sources, in one array.
 *
 * Runs inside getDashboardOverview's single pass. It re-reads the Scheduler FAT
 * feed rather than being handed the overview's copy because the overview keeps
 * only the rows its KPIs need; both calls go through the same reader, so there
 * is still one definition of "a FAT".
 */
export async function getExecutionCalendar(month: string): Promise<ExecutionCalendar> {
  const [fatEvents, owners, leads, visits] = await Promise.all([
    fetchSchedulerFatEvents(),
    fetchSchedulerJobDisciplineOwners(),
    fetchSchedulerProjectLeads(),
    getCustomerVisits(month),
  ]);

  // dedupeFats FIRST, exactly as the FAT KPIs do — one FAT per (job, date, kind)
  // however many schedules or task names describe it. Without it the calendar
  // showed 8 FATs in August 2026 against the KPI's 7 (job 1138 carries both
  // "FAT" and "1138 - Shade-O-Matic FAT" on the 19th), which is both a wrong
  // number and a visibly duplicated row in the grid.
  const monthFats: SchedulerFatEvent[] = dedupeFats(fatEvents ?? []).filter((e) => inMonth(e.date, month));

  // Name and customer come from THIS app's job book, one read for the job
  // numbers actually on screen this month.
  const jobNumbers = [...new Set(monthFats.map((e) => e.jobNumber).filter((n): n is string => n.length > 0))];
  const jobs =
    jobNumbers.length === 0
      ? []
      : await prisma.job.findMany({
          where: { jobId: { in: jobNumbers } },
          select: { jobId: true, jobName: true, customer: true },
        });
  const jobByNumber = new Map(jobs.map((j) => [j.jobId, j]));

  const fatRows: CalendarEvent[] = monthFats.map((e) => {
    const job = jobByNumber.get(e.jobNumber);
    const lead = leads.get(e.project);
    return {
      // taskId is the Scheduler's primary key, so this is unique by construction —
      // two schedules describing the same real FAT are two tasks and stay two
      // events, exactly as the FAT KPIs already count them.
      eventId: `fat:${e.taskId}`,
      eventType: e.kind === "pre" ? "pre" : "fat",
      date: e.date,
      jobNumber: e.jobNumber || null,
      jobName: job?.jobName ?? null,
      customer: job?.customer?.trim() || null,
      projectName: e.project,
      machine: e.machine,
      title: e.name,
      meOwners: owners.me.get(e.jobNumber) ?? [],
      ceOwners: owners.controls.get(e.jobNumber) ?? [],
      debugLead: lead?.debug ?? null,
      pm: lead?.pm ?? null,
      visitOwner: null,
      visitNote: null,
    };
  });

  const visitRows: CalendarEvent[] = (visits.configured ? visits.visits : [])
    .filter((v) => inMonth(v.date, month))
    .map((v) => ({
      eventId: `visit:${v.date}:${v.customer}`,
      eventType: "visit" as const,
      date: v.date,
      jobNumber: v.jobNumber,
      jobName: v.jobName,
      customer: v.customer,
      projectName: null,
      machine: null,
      title: v.customer,
      meOwners: [],
      ceOwners: [],
      debugLead: null,
      pm: null,
      visitOwner: v.owner,
      visitNote: v.note,
    }));

  const events = [...fatRows, ...visitRows].sort(
    (a, b) => a.date.localeCompare(b.date) || a.eventType.localeCompare(b.eventType) || a.eventId.localeCompare(b.eventId),
  );

  return {
    month,
    events,
    schedulerAvailable: fatEvents !== null,
    visitsConfigured: visits.configured,
  };
}
