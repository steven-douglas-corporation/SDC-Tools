import "server-only";
import mysql from "mysql2/promise";

// Read-only connection to the SDC Scheduler's MySQL (sdc_scheduler), used to
// mirror its team roster/grouping into ETC (see sync-scheduler-team.ts). The
// Scheduler owns team_members; ETC only ever READS it here.
//
// Fail-closed, exactly like scheduler-api-auth.ts: if SCHEDULER_DATABASE_URL is
// not set, the connector throws a clear error rather than guessing a host. That
// keeps the feature dormant until the connection string is deliberately set on
// the ETC host (both apps live on the same server, so this is a local reach).
//
// SCHEDULER_DATABASE_URL format:
//   mysql://user:pass@host:3306/sdc_scheduler
// A dedicated read-only MySQL user is strongly recommended.

const globalForSchedulerDb = globalThis as unknown as {
  schedulerPool: mysql.Pool | undefined;
};

export function isSchedulerDbConfigured(): boolean {
  return Boolean(process.env.SCHEDULER_DATABASE_URL);
}

function getPool(): mysql.Pool {
  const url = process.env.SCHEDULER_DATABASE_URL;
  if (!url) {
    throw new Error(
      "Scheduler sync is not configured: set SCHEDULER_DATABASE_URL (read-only MySQL) on the ETC host.",
    );
  }
  // Reuse one pool across HMR reloads / requests (same trick as prisma.ts).
  if (!globalForSchedulerDb.schedulerPool) {
    globalForSchedulerDb.schedulerPool = mysql.createPool({
      uri: url,
      connectionLimit: 3,
      // This app must never write to the Scheduler DB.
      // (Enforced by convention + a dedicated read-only user; we only SELECT.)
      namedPlaceholders: true,
    });
  }
  return globalForSchedulerDb.schedulerPool;
}

export type SchedulerTeamMember = {
  name: string;
  discipline: string;
  active: boolean;
  isLead: boolean;
  sortOrder: number | null;
  specialty: string | null;
};

// Real team members (placeholders like "ME Placeholder" are the Scheduler's own
// assignment stand-ins, not people, so they're always excluded). By default
// only active members; pass includeInactive for status reconciliation.
export async function fetchSchedulerTeam(includeInactive = false): Promise<SchedulerTeamMember[]> {
  const pool = getPool();
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT name, discipline, active, is_lead, sort_order, specialty
       FROM team_members
      WHERE name NOT LIKE '%Placeholder%'
        ${includeInactive ? "" : "AND active = 1"}
      ORDER BY discipline, sort_order, name`,
  );
  return rows.map((r) => ({
    name: String(r.name),
    discipline: String(r.discipline),
    active: Boolean(r.active),
    isLead: Boolean(r.is_lead),
    sortOrder: r.sort_order == null ? null : Number(r.sort_order),
    specialty: r.specialty == null ? null : String(r.specialty),
  }));
}

export type SchedulerPlaceholder = { discipline: string; name: string };

// Placeholders — Scheduler's own staffing stand-ins for an unfilled seat
// ("ME Placeholder", "Build Placeholder", …). Not a separate table or flag on
// the Scheduler side: a placeholder IS a team_members row, identified purely
// by its name matching "%Placeholder%" (same convention Scheduler's own
// public/app.js uses client-side via isPlaceholder(m.name), and the inverse
// of fetchSchedulerTeam's exclusion filter above). No employee_id — a
// placeholder isn't a real person, so there's nothing in Reports to join it
// to.
//
// Fail-soft like fetchSchedulerProjectJobNumbers: an unreachable Scheduler DB
// degrades to "no placeholders shown", not a broken page.
export async function fetchSchedulerPlaceholders(): Promise<SchedulerPlaceholder[]> {
  if (!isSchedulerDbConfigured()) return [];
  try {
    const pool = getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT discipline, name
         FROM team_members
        WHERE name LIKE '%Placeholder%'
        ORDER BY discipline, sort_order, name`,
    );
    return rows.map((r) => ({ discipline: String(r.discipline), name: String(r.name) }));
  } catch {
    return [];
  }
}

// Set of ETC job numbers that already have a project in the Scheduler
// (projects.job_number is stamped with the ETC jobId when a schedule is
// created from an ETC job — see SDC_Scheduler routes/projects.js). Used by the
// grids to show the "open in Scheduler" icon ONLY for jobs that actually have a
// schedule, so it's never a dead link.
//
// Fail-SOFT (unlike fetchSchedulerTeam): if the read-only Scheduler DB isn't
// configured, or the query fails, this returns an empty set instead of throwing
// — the icon simply doesn't render and the rest of the page is unaffected.
export async function fetchSchedulerProjectJobNumbers(): Promise<Set<string>> {
  if (!isSchedulerDbConfigured()) return new Set();
  try {
    const pool = getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT DISTINCT job_number
         FROM projects
        WHERE job_number IS NOT NULL AND job_number <> ''`,
    );
    return new Set(rows.map((r) => String(r.job_number).trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

// ── FAT events (2026-08-27) ─────────────────────────────────────────────────
//
// The Scheduler is the authoritative source for FAT dates, and it holds them as
// ORDINARY TASKS — there is no fat_date column on projects and no dedicated
// milestone table. What identifies a FAT is the task NAME: "FAT", "Perform FAT",
// "1138 - Shade-O-Matic FAT", "FAT - Bifacial 3", "Pre FAT"… (85 rows are the
// bare word alone; the rest are free text a scheduler typed). Verified against
// the live database on 2026-08-27 — 42 distinct spellings, every one of them
// containing the word.
//
// So the match is a WORD-boundary regexp, not a LIKE '%FAT%': the latter also
// catches any future task with "fatigue" or "fatal" in its name, and this feeds a
// count managers read as a commitment. `is_action = 0` drops the Scheduler's
// action items, which are to-dos hanging off a schedule rather than scheduled
// work.
//
// Pre-FATs are returned rather than filtered out, tagged `kind: "pre"`, because
// they are real scheduled events the execution team plans around — but they are
// NOT the customer-facing FAT, so every count that means "how many FATs" must
// exclude them. Classifying here rather than at each call site keeps that one
// decision in one place.
//
// Fail-SOFT, like fetchSchedulerProjectJobNumbers: an unconfigured or unreachable
// Scheduler yields null — distinct from an empty array, so the dashboard can say
// "Scheduler unavailable" instead of the far worse "0 FATs".
export type SchedulerFatEvent = {
  taskId: number;
  name: string;
  /** Scheduler project (schedule) name — shown so two schedules for one job are visible rather than silently merged. */
  project: string;
  /** ETC job number stamped on the Scheduler project. */
  jobNumber: string;
  /** "YYYY-MM-DD" — the Scheduler stores dates as strings. */
  date: string;
  /** Whoever the FAT task itself is assigned to, if anyone. */
  assignee: string | null;
  /**
   * The machine this FAT belongs to ("M1", "M2", …), from the Scheduler's own
   * `tasks.machine` column — the real relationship, not a guess parsed out of the
   * task name. NULL is meaningful and common: on a single-machine project, and on
   * a FAT that covers the whole project, the Scheduler leaves it unset. Callers
   * render that as a project-level FAT rather than as missing data.
   */
  machine: string | null;
  /** A "Pre FAT"/"Pre-FAT"/"Internal Pre-FAT" is a readiness run, not the FAT. */
  kind: "fat" | "pre";
  progress: number;
};

// "Pre FAT", "Pre-FAT", "PreFAT", "Internal Pre-FAT for all NEWT wire types" —
// all four spellings are live in the database today.
function isPreFat(name: string): boolean {
  return /pre[\s-]*fat/i.test(name);
}

export async function fetchSchedulerFatEvents(): Promise<SchedulerFatEvent[] | null> {
  if (!isSchedulerDbConfigured()) return null;
  try {
    const pool = getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT t.id, t.name, t.project, p.job_number, t.start_date, t.assignee, t.progress, t.machine
         FROM tasks t
         JOIN projects p ON p.name = t.project
        WHERE p.job_number IS NOT NULL AND p.job_number <> ''
          AND p.is_template = 0
          AND t.is_action = 0
          AND t.start_date IS NOT NULL AND t.start_date <> ''
          AND t.name REGEXP '(^|[^A-Za-z])FAT([^A-Za-z]|$)'
        ORDER BY t.start_date`,
    );
    return rows.map((r) => {
      const name = String(r.name);
      return {
        taskId: Number(r.id),
        name,
        project: String(r.project),
        jobNumber: String(r.job_number).trim(),
        // Scheduler date columns are VARCHAR(32); everything live is already
        // "YYYY-MM-DD", and slicing keeps a stray time component out.
        date: String(r.start_date).slice(0, 10),
        assignee: r.assignee ? String(r.assignee).trim() || null : null,
        machine: r.machine ? String(r.machine).trim() || null : null,
        kind: isPreFat(name) ? "pre" : "fat",
        progress: r.progress == null ? 0 : Number(r.progress),
      };
    });
  } catch {
    return null;
  }
}

// ── One FAT per (job, date, kind) ───────────────────────────────────────────
//
// Even when two Scheduler schedules or two differently-named tasks describe the
// same real event. Live data has both: job 1138 carries "FAT" and
// "1138 - Shade-O-Matic FAT" on 2026-08-19, and jobs 1101/1153 each have more
// than one schedule. Collapsing them is what stops "FATs this month"
// double-counting one event; the surviving row keeps its schedule name, so a
// genuinely duplicated schedule is still visible rather than hidden.
//
// Lives HERE, beside the reader whose rows it de-duplicates, rather than inside
// one consumer: the Dashboard's FAT KPIs and its Execution Calendar both have to
// count a month the same way, and they only do that for as long as they run the
// same function. (They briefly did not — the calendar showed 8 FATs in August
// against the KPI's 7, which is exactly this 1138 pair.)
export function dedupeFats(events: SchedulerFatEvent[]): SchedulerFatEvent[] {
  const seen = new Map<string, SchedulerFatEvent>();
  for (const e of events) {
    const key = `${e.jobNumber}|${e.date}|${e.kind}`;
    const prior = seen.get(key);
    // Prefer the row that names a person — it is the one worth showing.
    if (!prior || (!prior.assignee && e.assignee)) seen.set(key, e);
  }
  return [...seen.values()];
}

// ── Who ME/CE is, per job (2026-08-27) ──────────────────────────────────────
//
// A FAT task almost never carries a department itself (checked live: of the FAT
// rows above, `sub_department` is null on all but a handful). The discipline
// breakdown therefore comes from the SCHEDULE, not from the FAT row: which named
// mechanical and controls engineers are assigned anywhere on that job's schedule.
//
// Deliberately NOT "does the project have any mech/controls task" — every one of
// the 14 projects with an upcoming FAT has both, so that test answers "yes" for
// everything and tells a manager nothing. Named assignees do vary, and they are
// also the answer to "who owns this FAT", which is the same lookup.
//
// Placeholders ("ME Placeholder", "CE Placeholder") are excluded by the same
// name convention fetchSchedulerTeam/fetchSchedulerPlaceholders already use —
// an unfilled seat is not a person, and counting it as ME involvement would
// report staffing that does not exist.
export type SchedulerJobDisciplineOwners = {
  /** ETC job number → distinct named engineers on that job's mech tasks. */
  me: Map<string, string[]>;
  controls: Map<string, string[]>;
};

export async function fetchSchedulerJobDisciplineOwners(): Promise<SchedulerJobDisciplineOwners> {
  const empty: SchedulerJobDisciplineOwners = { me: new Map(), controls: new Map() };
  if (!isSchedulerDbConfigured()) return empty;
  try {
    const pool = getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT DISTINCT p.job_number, t.sub_department, t.assignee
         FROM tasks t
         JOIN projects p ON p.name = t.project
        WHERE p.job_number IS NOT NULL AND p.job_number <> ''
          AND p.is_template = 0
          AND t.sub_department IN ('mech', 'controls')
          AND t.assignee IS NOT NULL AND t.assignee <> ''
          AND t.assignee NOT LIKE '%Placeholder%'
        ORDER BY p.job_number, t.assignee`,
    );
    const out: SchedulerJobDisciplineOwners = { me: new Map(), controls: new Map() };
    for (const r of rows) {
      const job = String(r.job_number).trim();
      const bucket = String(r.sub_department) === "mech" ? out.me : out.controls;
      const list = bucket.get(job) ?? [];
      const name = String(r.assignee).trim();
      if (name && !list.includes(name)) list.push(name);
      bucket.set(job, list);
    }
    return out;
  } catch {
    return empty;
  }
}
