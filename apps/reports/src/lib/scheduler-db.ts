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

// ── PM and Debug Lead, per schedule (2026-08-28) ────────────────────────────
//
// The Scheduler stores both in ONE settings row — `settings.project_leads`, a
// JSON object keyed by the SCHEDULE NAME (`projects.name`, not the job number)
// holding `{ pm?, debug? }`. That is the same store its own Projects page reads
// and writes through its PM / Debug lead pickers, so this is the existing
// assignment rather than a second field invented here.
//
// Keyed by schedule name and not by job number on purpose: a job can carry more
// than one schedule (1101 has three live today) and they do not always name the
// same debug lead. Resolving by job would have to pick one arbitrarily.
export type SchedulerProjectLeads = Map<string, { pm: string | null; debug: string | null }>;

export async function fetchSchedulerProjectLeads(): Promise<SchedulerProjectLeads> {
  const out: SchedulerProjectLeads = new Map();
  if (!isSchedulerDbConfigured()) return out;
  try {
    const pool = getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT value FROM settings WHERE \`key\` = 'project_leads' LIMIT 1`,
    );
    const raw = rows[0]?.value;
    if (!raw) return out;
    const parsed: unknown = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== "object") return out;
    for (const [project, leads] of Object.entries(parsed as Record<string, unknown>)) {
      if (!leads || typeof leads !== "object") continue;
      const l = leads as { pm?: unknown; debug?: unknown };
      const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
      out.set(project, { pm: clean(l.pm), debug: clean(l.debug) });
    }
    return out;
  } catch {
    // Same failure posture as every other reader here: an unreachable or
    // malformed Scheduler yields "unknown", never a thrown Dashboard.
    return out;
  }
}

// ── Key Dates: milestone anchors on the execution timeline ──────────────────
//
// The Scheduler marks a milestone with `tasks.anchor_key` — the same column its
// own "Key Dates" view reads. This reads it rather than matching task NAMES the
// way fetchSchedulerFatEvents has to (that one predates the column and matches
// /FAT/ textually), so a milestone here and a milestone there cannot disagree.
//
// Same exclusions as every other query in this file: templates and action rows
// are not schedule work, and a project with no job number cannot be joined to
// anything in this app.
export type SchedulerAnchorTask = {
  id: number;
  jobNumber: string;
  project: string;
  machine: string | null;
  anchorKey: string;
  name: string;
  startDate: string;
  completedOn: string | null;
  assignee: string | null;
};

export async function fetchSchedulerAnchorTasks(
  anchorKeys: string[],
  startDate: string,
  endExclusive: string,
): Promise<SchedulerAnchorTask[] | null> {
  if (!isSchedulerDbConfigured() || anchorKeys.length === 0) return null;
  try {
    const pool = getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT t.id, t.name, t.project, p.job_number, t.machine, t.anchor_key,
              t.start_date, t.completed_on, t.assignee
         FROM tasks t
         JOIN projects p ON p.name = t.project
        WHERE t.anchor_key IN (?)
          AND t.start_date >= ? AND t.start_date < ?
          AND p.is_template = 0
          AND t.is_action = 0
        ORDER BY t.start_date`,
      [anchorKeys, startDate, endExclusive],
    );
    return rows
      // A schedule with no job number in EITHER the column or its name is not a
      // real project — "SDC_StandardProject_Template" is the one that reaches
      // here, carrying is_template = 0 despite the name. Dropping on the job
      // number rather than on is_template is what keeps 1165/1163 (real jobs
      // whose job_number column is simply unset) while still excluding it.
      .filter((r) => jobNumberFor(r.job_number, r.project) !== "")
      .map((r) => ({
      id: Number(r.id),
      jobNumber: jobNumberFor(r.job_number, r.project),
      project: String(r.project),
      machine: r.machine ? String(r.machine) : null,
      anchorKey: String(r.anchor_key),
      name: String(r.name),
      startDate: isoDay(r.start_date),
      completedOn: r.completed_on ? isoDay(r.completed_on) : null,
      assignee: r.assignee ? String(r.assignee).trim() || null : null,
    }));
  } catch (err) {
    console.error("[scheduler-db] anchor task read failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// Build Start is DERIVED, exactly as the Scheduler derives it: the first day any
// person of discipline `build` is assigned to that machine. There is no anchor
// row to read because it is not a milestone anybody sets.
//
// `assignee` is a comma-separated list of names, which is why this joins through
// FIND_IN_SET on a normalised copy rather than an equality test.
export type SchedulerBuildStart = { jobNumber: string; project: string; machine: string | null; startDate: string };

export async function fetchSchedulerBuildStarts(
  startDate: string,
  endExclusive: string,
): Promise<SchedulerBuildStart[] | null> {
  if (!isSchedulerDbConfigured()) return null;
  try {
    const pool = getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT p.job_number, t.project, t.machine, MIN(t.start_date) AS start_date
         FROM tasks t
         JOIN projects p ON p.name = t.project
         JOIN team_members tm
           ON FIND_IN_SET(TRIM(tm.name), REPLACE(REPLACE(t.assignee, ', ', ','), ' ,', ',')) > 0
        WHERE tm.discipline = 'build'
          AND t.start_date >= ? AND t.start_date < ?
          AND p.is_template = 0
          AND t.is_action = 0
        GROUP BY p.job_number, t.project, t.machine`,
      [startDate, endExclusive],
    );
    return rows
      // Same rule as the anchor read above — see the note there.
      .filter((r) => jobNumberFor(r.job_number, r.project) !== "")
      .map((r) => ({
        jobNumber: jobNumberFor(r.job_number, r.project),
        project: String(r.project),
        machine: r.machine ? String(r.machine) : null,
        startDate: isoDay(r.start_date),
      }));
  } catch (err) {
    console.error("[scheduler-db] build-start read failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * The job number for a schedule, from the column when it is set and from the
 * project NAME when it is not.
 *
 * Requiring projects.job_number silently dropped two real rows from the first
 * version of this query — 1165_Johnson Matthey and 1163_Haemonetics both carry a
 * Mech 1 release and a NULL job_number — which is why the Dashboard timeline was
 * short against the Scheduler's own Key Dates view. Every Scheduler schedule is
 * named "<job>_<customer>_<description>", so the number is present either way;
 * the column is just not always filled in.
 *
 * Returns "" when neither source has one, which the caller renders rather than
 * discarding: a milestone with no job number is still a milestone.
 */
function jobNumberFor(column: unknown, projectName: unknown): string {
  const fromColumn = column == null ? "" : String(column).trim();
  if (fromColumn) return fromColumn;
  const m = String(projectName ?? "").match(/^\s*(\d{3,6})/);
  return m ? m[1] : "";
}

/** MySQL hands dates back as Date or string depending on the driver path; normalise both. */
function isoDay(value: unknown): string {
  if (value instanceof Date) {
    // Local getters, not toISOString: these are DATE columns with no time zone,
    // and UTC conversion would move a date across midnight.
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value).slice(0, 10);
}
