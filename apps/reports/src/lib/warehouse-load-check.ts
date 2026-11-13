// ── Is the warehouse load current? (2026-11-13) ──────────────────────────────
//
// The rules behind the "warehouse_load" source. Pure on purpose, like
// source-health.ts: the caller reads "Integration"."JobHealth" and the hours
// freshness row, this decides what they mean, and
// tests/warehouse-load-check.test.ts asserts it.
//
// Written after the Paylocity load stopped for three business days (11/10-11/12)
// and the app said nothing. The task's stored password had gone stale, so Task
// Scheduler never started it. A run that never starts records no failure
// anywhere, and the hours sync, which only ever saw the same rows again, reported
// itself healthy every hour. Two questions catch that, and this answers both:
//
//   1. Did the load run? Every expected job must have succeeded since its latest
//      business-day deadline. The warehouse computes that ("IsOverdue") because
//      it owns the run log and the holiday calendar.
//   2. Did the data move? Even when the load "succeeded", the hours must reach
//      the business day before that deadline. This catches Paylocity delivering
//      an old or empty file to a load that ran fine.

/** One row of "Integration"."JobHealth". */
export type WarehouseJobHealth = {
  jobName: string;
  description: string;
  /** "06:30:00", Eastern. */
  dueBy: string;
  dueSince: Date | null;
  /** YYYY-MM-DD: the business day before dueSince. */
  expectedDataThrough: string | null;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
  lastSucceededAt: Date | null;
  isOverdue: boolean;
  todayIsBusinessDay: boolean;
};

export type WarehouseLoadCheck = {
  ok: boolean;
  /** Sentences, each a complete reason. Empty when ok. */
  problems: string[];
  /** What the step reports when everything is current. */
  summary: string;
  /** Newest success across the expected jobs, which becomes the source's refreshedThrough. */
  lastSucceededAt: Date | null;
  /** Whether today is a business day, so the Teams alert is not sent on weekends or holidays. */
  todayIsBusinessDay: boolean;
};

/** The job whose data is the hours. Its name is the tag paylocity_ingest.py writes. */
export const HOURS_JOB = "paylocity_ingest";

const TZ = "America/New_York";

export function formatEastern(d: Date): string {
  return d.toLocaleString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatDay(ymd: string): string {
  // Noon UTC so the weekday cannot slip a day in any zone.
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}

function formatDueBy(dueBy: string): string {
  const [h, m] = dueBy.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function evaluateWarehouseLoad(input: {
  jobs: WarehouseJobHealth[];
  /** YYYY-MM-DD: the latest work date the app holds hours for (hours_actual.refreshedThrough). */
  hoursThrough: string | null;
}): WarehouseLoadCheck {
  const { jobs, hoursThrough } = input;
  const problems: string[] = [];

  for (const j of jobs) {
    if (!j.isOverdue) continue;
    const since = j.lastSucceededAt ? `has not succeeded since ${formatEastern(j.lastSucceededAt)}` : "has never succeeded";
    let sentence = `The ${j.description} (${j.jobName}) ${since}; it is due by ${formatDueBy(j.dueBy)} every business day.`;
    // The newest run's own error says WHY when there is one. When there is none, the
    // job did not start at all, which points at Task Scheduler rather than the script.
    if (j.lastRunStatus === "failed" && j.lastRunAt && (!j.lastSucceededAt || j.lastRunAt > j.lastSucceededAt)) {
      sentence += ` Its last run (${formatEastern(j.lastRunAt)}) failed: ${(j.lastRunError ?? "no error recorded").slice(0, 200)}`;
    } else {
      sentence += " No run has started since, so check that its scheduled task is running.";
    }
    problems.push(sentence);
  }

  const hoursJob = jobs.find((j) => j.jobName === HOURS_JOB);
  const expected = hoursJob?.expectedDataThrough ?? null;
  // Only said when the load itself looks fine: if it is overdue, that sentence
  // already explains why the hours are behind, and saying it twice reads as two
  // separate faults.
  if (hoursJob && !hoursJob.isOverdue && expected && hoursThrough && hoursThrough < expected) {
    problems.push(
      `Hours only run through ${formatDay(hoursThrough)} but should run through ${formatDay(expected)}. ` +
        "The load ran, so Paylocity's file may not contain the latest punches.",
    );
  }

  const lastSucceededAt = jobs.reduce<Date | null>(
    (acc, j) => (j.lastSucceededAt && (!acc || j.lastSucceededAt > acc) ? j.lastSucceededAt : acc),
    null,
  );

  const summary =
    `${jobs.length} warehouse job${jobs.length === 1 ? "" : "s"} current` +
    (lastSucceededAt ? `; last load ${formatEastern(lastSucceededAt)}` : "") +
    (hoursThrough ? `; hours through ${formatDay(hoursThrough)}` : "");

  return {
    ok: problems.length === 0,
    problems,
    summary,
    lastSucceededAt,
    todayIsBusinessDay: jobs.some((j) => j.todayIsBusinessDay),
  };
}
