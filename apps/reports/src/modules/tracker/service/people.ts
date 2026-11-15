import { TrackerError, assertIsoDate, one, type Actor, type Database } from "./database";
import { requireGlobalRole, requireProjectRole, hasGlobalRole, type ProjectRole } from "./access";

// People as the forecast sees them: who is on a project, how many hours of project work each
// person has in a day, when they are away, and which days nobody works.
//
// Capacity has three levels (global default, team, person) in the schema. This file manages the
// global default and a person's own standing figure; team overrides and date-ranged overrides
// exist in the table and are honoured by the forecast, but nothing here writes them yet.

export interface Member {
  personId: number;
  name: string;
  email: string;
  role: ProjectRole;
}

/** Everyone with a role on a project. Any member may see the list. */
export async function listMembers(db: Database, actor: Actor, projectId: number): Promise<Member[]> {
  return db.transaction(async (tx) => {
    await requireProjectRole(tx, projectId, actor, "viewer");
    const { rows } = await tx.query<{ person_id: number; name: string; email: string; role: ProjectRole }>(
      `SELECT m.person_id, p.display_name AS name, p.email, m.role
         FROM tracker.project_member m JOIN tracker.person p ON p.id = m.person_id
        WHERE m.project_id = $1
        ORDER BY (m.role = 'manager') DESC, (m.role = 'contributor') DESC, p.display_name`,
      [projectId],
    );
    return rows.map((r) => ({ personId: Number(r.person_id), name: r.name, email: r.email, role: r.role }));
  });
}

export interface TimeOffEntry {
  id: number;
  personId: number;
  start: string;
  end: string;
  /** Part of each day that is off, 0 to 1. 1 is the whole day. */
  dayPortion: number;
  note: string | null;
}

export interface PersonCapacity {
  id: number;
  name: string;
  email: string;
  /** This person's own standing figure, or null when they use the default. */
  ownHoursPerDay: number | null;
  /** What the forecast uses today: their own figure, else their team's, else the global default. */
  hoursPerDay: number;
  timeOff: TimeOffEntry[];
}

export interface CapacityOverview {
  /** The global default: hours of project work in a normal day. */
  globalHoursPerDay: number;
  people: PersonCapacity[];
  holidays: { date: string; name: string }[];
  /** Whether the viewer may change other people's figures, the default and the holidays. */
  canManage: boolean;
  viewerPersonId: number;
}

/** What the capacity screen shows. Readable by anyone who can open the tracker: it explains the forecast. */
export async function getCapacityOverview(db: Database, actor: Actor): Promise<CapacityOverview> {
  return db.transaction(async (tx) => {
    const global = await tx.query<{ hours: number }>(
      `SELECT project_hours_per_day::float8 AS hours FROM tracker.capacity_setting
        WHERE scope = 'global' AND effective_from IS NULL AND effective_to IS NULL AND project_hours_per_day IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
    );
    const people = await tx.query<{
      id: number;
      name: string;
      email: string;
      own: number | null;
      effective: number | null;
    }>(
      `SELECT p.id, p.display_name AS name, p.email,
              (SELECT c.project_hours_per_day::float8 FROM tracker.capacity_setting c
                WHERE c.scope = 'person' AND c.person_id = p.id
                  AND c.effective_from IS NULL AND c.effective_to IS NULL AND c.project_hours_per_day IS NOT NULL
                ORDER BY c.id DESC LIMIT 1) AS own,
              (SELECT x.project_hours_per_day::float8 FROM tracker.person_capacity_on(p.id, CURRENT_DATE) x) AS effective
         FROM tracker.person p
        WHERE p.active
        ORDER BY p.display_name`,
    );
    const off = await tx.query<{
      id: number;
      person_id: number;
      start_date: string;
      end_date: string;
      day_portion: number;
      note: string | null;
    }>(
      `SELECT id, person_id, start_date::text, end_date::text, day_portion::float8, note
         FROM tracker.time_off WHERE end_date >= CURRENT_DATE ORDER BY start_date, id`,
    );
    const holidays = await tx.query<{ date: string; name: string }>(
      `SELECT holiday_date::text AS date, name FROM tracker.company_holiday WHERE holiday_date >= CURRENT_DATE ORDER BY holiday_date`,
    );
    const globalHours = Number(global.rows[0]?.hours ?? 0);
    return {
      globalHoursPerDay: globalHours,
      people: people.rows.map((p) => ({
        id: Number(p.id),
        name: p.name,
        email: p.email,
        ownHoursPerDay: p.own == null ? null : Number(p.own),
        hoursPerDay: Number(p.effective ?? globalHours),
        timeOff: off.rows
          .filter((o) => Number(o.person_id) === Number(p.id))
          .map((o) => ({
            id: Number(o.id),
            personId: Number(o.person_id),
            start: o.start_date,
            end: o.end_date,
            dayPortion: Number(o.day_portion),
            note: o.note,
          })),
      })),
      holidays: holidays.rows,
      canManage: await hasGlobalRole(tx, actor, "admin"),
      viewerPersonId: actor.personId,
    };
  });
}

function assertDayHours(hours: number): void {
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
    throw new TrackerError("invalid", "Hours a day must be between 0 and 24.");
  }
}

/** Sets the company-wide default: hours of project work in a normal day. Admin only. */
export async function setGlobalHours(db: Database, actor: Actor, hoursPerDay: number): Promise<void> {
  assertDayHours(hoursPerDay);
  if (hoursPerDay <= 0)
    throw new TrackerError("invalid", "The default must be more than zero, or nothing can be forecast.");
  await db.transaction(async (tx) => {
    await requireGlobalRole(tx, actor, "admin");
    const updated = await tx.query(
      `UPDATE tracker.capacity_setting SET project_hours_per_day = $1
        WHERE scope = 'global' AND effective_from IS NULL AND effective_to IS NULL RETURNING id`,
      [hoursPerDay],
    );
    if (!updated.rows.length) {
      await tx.query(
        `INSERT INTO tracker.capacity_setting (scope, project_hours_per_day, working_weekdays, note)
         VALUES ('global', $1, '{1,2,3,4,5}', 'Global default')`,
        [hoursPerDay],
      );
    }
  });
}

/**
 * Sets one person's standing hours of project work a day, or removes it (null) so they go back
 * to the default. For someone who spends most of their time on work outside the tracker, this
 * is the number that says so. Admin only.
 */
export async function setPersonHours(
  db: Database,
  actor: Actor,
  personId: number,
  hoursPerDay: number | null,
): Promise<void> {
  if (hoursPerDay !== null) assertDayHours(hoursPerDay);
  await db.transaction(async (tx) => {
    await requireGlobalRole(tx, actor, "admin");
    await one(tx, `SELECT id FROM tracker.person WHERE id = $1`, [personId], "Person");
    await tx.query(
      `DELETE FROM tracker.capacity_setting
        WHERE scope = 'person' AND person_id = $1 AND effective_from IS NULL AND effective_to IS NULL`,
      [personId],
    );
    if (hoursPerDay !== null) {
      await tx.query(
        `INSERT INTO tracker.capacity_setting (scope, person_id, project_hours_per_day) VALUES ('person', $1, $2)`,
        [personId, hoursPerDay],
      );
    }
  });
}

/**
 * Records time away. A person may add their own; an admin may add anyone's.
 *
 * TODO (backlog M-15): time off is typed in by hand for now. Approved time off already lives in
 * Paylocity, so the plan is a daily import, matched on person.paylocity_employee_id, with typed
 * entries kept only for what Paylocity does not hold. The import copies rows into
 * tracker.time_off; the forecast keeps reading only the tracker's own tables.
 */
export async function addTimeOff(
  db: Database,
  actor: Actor,
  input: { personId: number; start: string; end: string; dayPortion?: number; note?: string | null },
): Promise<number> {
  assertIsoDate(input.start, "Start date");
  assertIsoDate(input.end, "End date");
  if (!input.start || !input.end) throw new TrackerError("invalid", "Time off needs a start and an end date.");
  if (input.end < input.start) throw new TrackerError("invalid", "The end date is before the start date.");
  const portion = input.dayPortion ?? 1;
  if (!Number.isFinite(portion) || portion <= 0 || portion > 1) {
    throw new TrackerError("invalid", "The part of the day off must be more than 0 and at most 1.");
  }
  return db.transaction(async (tx) => {
    if (input.personId !== actor.personId) await requireGlobalRole(tx, actor, "admin");
    await one(tx, `SELECT id FROM tracker.person WHERE id = $1`, [input.personId], "Person");
    const row = await one<{ id: number }>(
      tx,
      `INSERT INTO tracker.time_off (person_id, start_date, end_date, day_portion, note)
       VALUES ($1, $2::date, $3::date, $4, $5) RETURNING id`,
      [input.personId, input.start, input.end, portion, input.note?.trim() || null],
      "Time off",
    );
    return Number(row.id);
  });
}

export async function removeTimeOff(db: Database, actor: Actor, timeOffId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await one<{ person_id: number }>(
      tx,
      `SELECT person_id FROM tracker.time_off WHERE id = $1`,
      [timeOffId],
      "Time off",
    );
    if (Number(row.person_id) !== actor.personId) await requireGlobalRole(tx, actor, "admin");
    await tx.query(`DELETE FROM tracker.time_off WHERE id = $1`, [timeOffId]);
  });
}

/** A day nobody works. Admin only. */
export async function addHoliday(db: Database, actor: Actor, input: { date: string; name: string }): Promise<void> {
  assertIsoDate(input.date, "Holiday date");
  if (!input.date) throw new TrackerError("invalid", "A holiday needs a date.");
  if (!input.name.trim()) throw new TrackerError("invalid", "A holiday needs a name.");
  await db.transaction(async (tx) => {
    await requireGlobalRole(tx, actor, "admin");
    await tx.query(
      `INSERT INTO tracker.company_holiday (holiday_date, name) VALUES ($1::date, $2)
       ON CONFLICT (holiday_date) DO UPDATE SET name = EXCLUDED.name`,
      [input.date, input.name.trim()],
    );
  });
}

export async function removeHoliday(db: Database, actor: Actor, date: string): Promise<void> {
  assertIsoDate(date, "Holiday date");
  await db.transaction(async (tx) => {
    await requireGlobalRole(tx, actor, "admin");
    await tx.query(`DELETE FROM tracker.company_holiday WHERE holiday_date = $1::date`, [date]);
  });
}
