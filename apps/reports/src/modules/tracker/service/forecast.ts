import { TrackerError, type Database, type Tx } from "./database";
import { childrenByParent, expandDependencies } from "./dependencies";
import {
  schedule,
  simulate,
  summarize,
  type Allocation,
  type CapacityPeriod,
  type Inputs,
  type SimulationOutput,
  type Resource,
  type Task,
  type TimeOff,
} from "../forecast/engine";

// Reads everything the forecast engine needs from the tracker's tables, runs it, and writes the
// result back. The engine itself (../forecast/engine.ts) knows nothing about the database.
//
// runForecast is the only code that writes the forecast tables. In production it runs under the
// tracker_engine login, which can write nothing else.
//
// Known limits, on purpose for a first version:
//  - Only cards that carry effort themselves are scheduled. A dependency on or from a card with
//    cards under it is applied to the work cards beneath it (see ./dependencies.ts).
//  - Capacity: the most specific undated setting is a person's normal day; dated settings at any
//    level override it for their dates, person over team over global.

const FAR_FUTURE = "9999-12-31";

/** Why a task was held back before the engine saw it, by task id. */
export type HeldBack = Map<string, string>;

export interface LoadedInputs {
  inputs: Inputs;
  heldBack: HeldBack;
}

interface TaskRow {
  id: number;
  project_id: number;
  project_state: string;
  portfolio_rank: number | null;
  number: number;
  type: string;
  category: string;
  assignee_person_id: number | null;
  role_pool_id: number | null;
  priority: number;
  remaining: number | null;
  not_before_date: string | null;
  expected_unblock_date: string | null;
  in_sprint: boolean | null;
  bucket_hours: number | null;
  low_hours: number | null;
  high_hours: number | null;
  estimate_low_factor: number;
  estimate_high_factor: number;
}

interface CapacityRow {
  scope: "global" | "team" | "person";
  team_id: number | null;
  person_id: number | null;
  hours: number | null;
  working_weekdays: number[] | null;
  effective_from: string | null;
  effective_to: string | null;
}

const LEVEL = { global: 0, team: 1, person: 2 } as const;

export async function loadForecastInputs(tx: Tx, asOf: string): Promise<LoadedInputs> {
  const heldBack: HeldBack = new Map();

  const taskRows = await tx.query<TaskRow>(
    `SELECT t.id, t.project_id, p.state AS project_state, p.portfolio_rank, t.number, t.type, t.category,
            t.assignee_person_id, t.role_pool_id, t.priority,
            coalesce(t.remaining_effort_hours, t.effort_estimate_hours)::float8 AS remaining,
            t.not_before_date::text, t.expected_unblock_date::text,
            (sp.state = 'active') AS in_sprint,
            b.hours::float8 AS bucket_hours, b.low_hours::float8, b.high_hours::float8,
            p.estimate_low_factor::float8, p.estimate_high_factor::float8
       FROM tracker.open_leaf_task t
       JOIN tracker.project p ON p.id = t.project_id
  LEFT JOIN tracker.sprint sp ON sp.id = t.sprint_id
  LEFT JOIN tracker.effort_bucket b ON b.id = t.effort_bucket_id
      WHERE p.state IN ('planned', 'active', 'on_hold')
      ORDER BY t.id`,
  );
  const depRows = await tx.query<{ predecessor_task_id: number; successor_task_id: number; lag_days: number }>(
    `SELECT predecessor_task_id, successor_task_id, lag_days FROM tracker.task_dependency`,
  );
  // A link to or from a card with cards under it stands for the work cards beneath it.
  const placed = await tx.query<{ id: number; parent_task_id: number }>(
    `SELECT id, parent_task_id FROM tracker.task WHERE archived_at IS NULL AND parent_task_id IS NOT NULL`,
  );
  const children = childrenByParent(placed.rows.map((r) => ({ id: Number(r.id), parentId: Number(r.parent_task_id) })));
  const predsOf = new Map<string, { id: string; lagDays: number }[]>();
  const links = expandDependencies(
    depRows.rows.map((d) => ({
      predecessorId: Number(d.predecessor_task_id),
      successorId: Number(d.successor_task_id),
      lagDays: Number(d.lag_days),
    })),
    children,
  );
  for (const d of links) {
    const key = String(d.successorId);
    const list = predsOf.get(key) ?? [];
    list.push({ id: String(d.predecessorId), lagDays: d.lagDays });
    predsOf.set(key, list);
  }

  const tasks: Task[] = taskRows.rows.map((r) => {
    const id = String(r.id);
    // Work the engine must not schedule still goes in, marked blocked, so that anything waiting
    // on it is reported as waiting instead of being scheduled as if it were finished.
    let hold: string | null = null;
    if (r.project_state === "on_hold") hold = "project on hold";
    else if (r.portfolio_rank == null) hold = "project has no stack rank";
    if (hold) heldBack.set(id, hold);

    const isMilestone = r.type === "milestone";
    const factors =
      r.bucket_hours && r.low_hours && r.high_hours
        ? { lowFactor: r.low_hours / r.bucket_hours, highFactor: r.high_hours / r.bucket_hours }
        : { lowFactor: r.estimate_low_factor, highFactor: r.estimate_high_factor };
    return {
      id,
      project: String(r.project_id),
      projectRank: r.portfolio_rank == null ? Number.MAX_SAFE_INTEGER : Number(r.portfolio_rank),
      remainingHours: isMilestone ? null : r.remaining,
      isMilestone,
      assignee: r.assignee_person_id == null ? null : String(r.assignee_person_id),
      pool: r.role_pool_id == null ? null : String(r.role_pool_id),
      priority: Number(r.priority),
      number: Number(r.number),
      inSprint: r.in_sprint === true,
      notBefore: r.not_before_date,
      blocked: hold !== null || r.category === "blocked",
      expectedUnblock: hold !== null ? null : r.expected_unblock_date,
      preds: predsOf.get(id) ?? [],
      ...factors,
    };
  });

  // ---- people and their capacity ----
  const people = await tx.query<{ id: number; team_id: number | null }>(
    `SELECT id, team_id FROM tracker.person WHERE active ORDER BY id`,
  );
  const capacity = await tx.query<CapacityRow>(
    `SELECT scope, team_id, person_id, project_hours_per_day::float8 AS hours, working_weekdays,
            effective_from::text, effective_to::text
       FROM tracker.capacity_setting
      WHERE effective_to IS NULL OR effective_to >= $1::date
      ORDER BY id`,
    [asOf],
  );
  // Without the global default every person has zero hours a day, and the forecast would
  // report all work as "no capacity within horizon" — true, but it hides the real cause.
  // Found by running against a real server whose capacity table had been emptied.
  const hasGlobalDefault = capacity.rows.some(
    (c) => c.scope === "global" && c.hours != null && c.effective_from == null && c.effective_to == null,
  );
  if (!hasGlobalDefault) {
    throw new TrackerError(
      "invalid",
      "The global capacity default is missing. Add an undated row to tracker.capacity_setting with scope 'global' and the project hours per day.",
    );
  }
  const timeOff = await tx.query<{ person_id: number; start_date: string; end_date: string; day_portion: number }>(
    `SELECT person_id, start_date::text, end_date::text, day_portion::float8 FROM tracker.time_off WHERE end_date >= $1::date`,
    [asOf],
  );
  const allocations = await tx.query<{
    person_id: number;
    project_id: number;
    percent: number;
    start_date: string | null;
    end_date: string | null;
  }>(
    `SELECT person_id, project_id, percent::float8, start_date::text, end_date::text
       FROM tracker.resource_allocation WHERE end_date IS NULL OR end_date >= $1::date`,
    [asOf],
  );

  const resources: Resource[] = people.rows.map((p) => {
    const mine = capacity.rows
      .filter(
        (c) =>
          c.scope === "global" ||
          (c.scope === "person" && Number(c.person_id) === Number(p.id)) ||
          (c.scope === "team" && p.team_id != null && Number(c.team_id) === Number(p.team_id)),
      )
      .sort((a, b) => LEVEL[a.scope] - LEVEL[b.scope]);
    const undated = mine.filter((c) => c.effective_from == null && c.effective_to == null);
    // Most specific undated value wins: the list is sorted global, team, person, so take the last.
    const base = undated.filter((c) => c.hours != null).at(-1)?.hours ?? 0;
    const weekdays = mine.filter((c) => c.working_weekdays != null).at(-1)?.working_weekdays ?? [1, 2, 3, 4, 5];
    // Dated settings become periods. The engine lets a later period win, so the same ordering
    // gives person over team over global.
    const periods: CapacityPeriod[] = mine
      .filter((c) => c.hours != null && (c.effective_from != null || c.effective_to != null))
      .map((c) => ({
        start: c.effective_from ?? asOf,
        end: c.effective_to ?? FAR_FUTURE,
        hoursPerDay: c.hours as number,
      }));
    const off: TimeOff[] = timeOff.rows
      .filter((o) => Number(o.person_id) === Number(p.id))
      .map((o) => ({ start: o.start_date, end: o.end_date, dayPortion: Number(o.day_portion) }));
    const alloc: Allocation[] = allocations.rows
      .filter((a) => Number(a.person_id) === Number(p.id))
      .map((a) => ({
        project: String(a.project_id),
        percent: Number(a.percent),
        ...(a.start_date ? { start: a.start_date } : {}),
        ...(a.end_date ? { end: a.end_date } : {}),
      }));
    return {
      id: String(p.id),
      hoursPerDay: base,
      weekdays: weekdays.map(Number),
      timeOff: off,
      periods,
      allocations: alloc,
    };
  });

  const poolRows = await tx.query<{ role_pool_id: number; person_id: number }>(
    `SELECT role_pool_id, person_id FROM tracker.role_pool_member ORDER BY role_pool_id, person_id`,
  );
  const pools: Record<string, string[]> = {};
  for (const r of poolRows.rows) (pools[String(r.role_pool_id)] ??= []).push(String(r.person_id));

  const holidays = await tx.query<{ day: string }>(
    `SELECT holiday_date::text AS day FROM tracker.company_holiday WHERE holiday_date >= $1::date`,
    [asOf],
  );

  return { inputs: { asOf, tasks, resources, pools, holidays: holidays.rows.map((h) => h.day) }, heldBack };
}

export interface ForecastRunOptions {
  /** The day the forecast is made for, YYYY-MM-DD. */
  asOf: string;
  triggeredBy: "change" | "nightly" | "manual";
  /**
   * How many simulated schedules to run for the P50 and P80 dates. 0 skips the simulation and
   * leaves the existing P50 and P80 in place. A simulation is slow: never ask for one from
   * inside the web process.
   */
  simulations?: number;
}

export interface ForecastRunResult {
  runId: number;
  tasksScheduled: number;
  tasksUnscheduled: number;
}

const idOrNull = (value: string | null | undefined): number | null => (value == null ? null : Number(value));

/** A simulation worked out ahead of the write, and the plan it was worked out for. */
interface SimulatedAhead {
  plan: string;
  sim: SimulationOutput;
}

/**
 * Reads the plan and simulates it with no lock held. A simulation takes tens of seconds on a
 * large plan; inside the write below it would hold the forecast lock all that time, and every
 * save in the app waits for that lock to redo the forecast.
 */
async function simulateAhead(db: Database, asOf: string, runs: number): Promise<SimulatedAhead> {
  const { inputs } = await db.transaction((tx) => loadForecastInputs(tx, asOf));
  return { plan: JSON.stringify(inputs), sim: simulate(inputs, { runs }) };
}

/** How many times a simulation is redone because the plan changed under it, before it is done inside the lock. */
const SIMULATE_AHEAD_ATTEMPTS = 2;

/**
 * Runs the forecast and replaces the stored result, all in one transaction: readers see either
 * the previous forecast or the new one, never a mix.
 *
 * A simulation is worked out first, outside that transaction, and used only if the plan is
 * still the one it was made for. If somebody changed the plan meanwhile it is redone; if the
 * plan keeps changing, the last try simulates inside the lock, which is slow but always right.
 */
export async function runForecast(db: Database, options: ForecastRunOptions): Promise<ForecastRunResult> {
  const simulations = options.simulations ?? 0;
  if (simulations > 0) {
    for (let attempt = 0; attempt < SIMULATE_AHEAD_ATTEMPTS; attempt++) {
      const ahead = await simulateAhead(db, options.asOf, simulations);
      const written = await writeForecast(db, options, simulations, ahead);
      if (written) return written;
    }
  }
  return (await writeForecast(db, options, simulations, null)) as ForecastRunResult;
}

/** Returns null, having written nothing, when `ahead` was made for a plan that has since changed. */
async function writeForecast(
  db: Database,
  options: ForecastRunOptions,
  simulations: number,
  ahead: SimulatedAhead | null,
): Promise<ForecastRunResult | null> {
  return db.transaction(async (tx) => {
    // One run at a time. Readers take the rows of the newest run, so a run that started first
    // and finished last would leave every row stamped with an older run and the screens empty.
    // The lock is taken before anything is read, so each run sees what the one before it wrote.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('tracker.forecast'))`);
    const { inputs, heldBack } = await loadForecastInputs(tx, options.asOf);
    if (ahead && JSON.stringify(inputs) !== ahead.plan) return null;

    const run = await tx.query<{ id: number }>(
      `INSERT INTO tracker.schedule_run (triggered_by, as_of_date, simulations) VALUES ($1, $2::date, $3) RETURNING id`,
      [options.triggeredBy, options.asOf, simulations],
    );
    const runId = Number((run.rows[0] as { id: number }).id);

    const { results } = schedule(inputs);

    const taskRows = inputs.tasks.map((t) => {
      const r = results.get(t.id);
      if (r && r.scheduled) {
        return {
          task_id: Number(t.id),
          scheduled_start: r.start,
          scheduled_finish: r.finish,
          assigned_person_id: idOrNull(r.assignedTo),
          driver: r.driver,
          driver_task_id: idOrNull(r.driverTask),
          priority_from_task_id: idOrNull(r.priorityFrom),
          unscheduled_reason: null,
        };
      }
      return {
        task_id: Number(t.id),
        scheduled_start: null,
        scheduled_finish: null,
        assigned_person_id: null,
        driver: null,
        driver_task_id: null,
        priority_from_task_id: null,
        unscheduled_reason: heldBack.get(t.id) ?? (r && !r.scheduled ? r.reason : "not scheduled"),
      };
    });

    // Rows for tasks that are no longer open go; the rest are rewritten. P50 and P80 are left
    // alone here so a quick run does not wipe the last simulation's answer.
    await tx.query(
      `DELETE FROM tracker.task_forecast f
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS x(task_id bigint) WHERE x.task_id = f.task_id)`,
      [JSON.stringify(taskRows)],
    );
    await tx.query(
      `INSERT INTO tracker.task_forecast
         (task_id, run_id, scheduled_start, scheduled_finish, assigned_person_id, driver, driver_task_id,
          priority_from_task_id, unscheduled_reason, computed_at)
       SELECT x.task_id, $1, x.scheduled_start, x.scheduled_finish, x.assigned_person_id, x.driver, x.driver_task_id,
              x.priority_from_task_id, x.unscheduled_reason, now()
         FROM jsonb_to_recordset($2::jsonb) AS x(
              task_id bigint, scheduled_start date, scheduled_finish date, assigned_person_id bigint, driver text,
              driver_task_id bigint, priority_from_task_id bigint, unscheduled_reason text)
       ON CONFLICT (task_id) DO UPDATE SET
              run_id = EXCLUDED.run_id, scheduled_start = EXCLUDED.scheduled_start,
              scheduled_finish = EXCLUDED.scheduled_finish, assigned_person_id = EXCLUDED.assigned_person_id,
              driver = EXCLUDED.driver, driver_task_id = EXCLUDED.driver_task_id,
              priority_from_task_id = EXCLUDED.priority_from_task_id,
              unscheduled_reason = EXCLUDED.unscheduled_reason, computed_at = EXCLUDED.computed_at`,
      [runId, JSON.stringify(taskRows)],
    );

    const projectRows = summarize(inputs.tasks, results).map((s) => ({
      project_id: Number(s.project),
      finish_date: s.finish,
      unscheduled_tasks: s.unscheduledTasks,
      unscheduled_hours: s.unscheduledHours,
    }));
    await tx.query(
      `DELETE FROM tracker.project_forecast f
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS x(project_id bigint) WHERE x.project_id = f.project_id)`,
      [JSON.stringify(projectRows)],
    );
    await tx.query(
      `INSERT INTO tracker.project_forecast (project_id, run_id, finish_date, unscheduled_tasks, unscheduled_hours, computed_at)
       SELECT x.project_id, $1, x.finish_date, x.unscheduled_tasks, x.unscheduled_hours, now()
         FROM jsonb_to_recordset($2::jsonb) AS x(project_id bigint, finish_date date, unscheduled_tasks integer, unscheduled_hours numeric)
       ON CONFLICT (project_id) DO UPDATE SET
              run_id = EXCLUDED.run_id, finish_date = EXCLUDED.finish_date,
              unscheduled_tasks = EXCLUDED.unscheduled_tasks, unscheduled_hours = EXCLUDED.unscheduled_hours,
              computed_at = EXCLUDED.computed_at`,
      [runId, JSON.stringify(projectRows)],
    );

    if (simulations > 0) {
      const sim = ahead ? ahead.sim : simulate(inputs, { runs: simulations });
      const taskPct = [...sim.tasks].map(([id, p]) => ({ task_id: Number(id), p50: p.p50, p80: p.p80 }));
      const projectPct = [...sim.projects].map(([id, p]) => ({ project_id: Number(id), p50: p.p50, p80: p.p80 }));
      await tx.query(
        `UPDATE tracker.task_forecast f
            SET p50_finish = x.p50, p80_finish = x.p80, simulation_run_id = $1
           FROM jsonb_to_recordset($2::jsonb) AS x(task_id bigint, p50 date, p80 date)
          WHERE f.task_id = x.task_id`,
        [runId, JSON.stringify(taskPct)],
      );
      await tx.query(
        `UPDATE tracker.project_forecast f
            SET p50_finish = x.p50, p80_finish = x.p80, simulation_run_id = $1
           FROM jsonb_to_recordset($2::jsonb) AS x(project_id bigint, p50 date, p80 date)
          WHERE f.project_id = x.project_id`,
        [runId, JSON.stringify(projectPct)],
      );
    } else {
      // A quick run keeps the last simulation's P50 and P80 only while they can still be true.
      // They are dropped when the simulation was made for a different day, or when the new
      // single schedule already finishes after the old P80: a "pessimistic" date earlier than
      // the plain forecast is worse than no date. The roll-up then judges risk on the single
      // schedule until the next simulation. (Seen on the first real board: forecast Nov 30
      // beside a P80 of Nov 25 left over from an earlier run.)
      await tx.query(
        `UPDATE tracker.task_forecast f
            SET p50_finish = NULL, p80_finish = NULL, simulation_run_id = NULL
          WHERE f.simulation_run_id IS NOT NULL
            AND (f.scheduled_finish IS NULL
                 OR f.p80_finish IS NULL
                 OR f.p80_finish < f.scheduled_finish
                 OR (SELECT r.as_of_date FROM tracker.schedule_run r WHERE r.id = f.simulation_run_id) <> $1::date)`,
        [options.asOf],
      );
      await tx.query(
        `UPDATE tracker.project_forecast f
            SET p50_finish = NULL, p80_finish = NULL, simulation_run_id = NULL
          WHERE f.simulation_run_id IS NOT NULL
            AND (f.finish_date IS NULL
                 OR f.p80_finish IS NULL
                 OR f.p80_finish < f.finish_date
                 OR (SELECT r.as_of_date FROM tracker.schedule_run r WHERE r.id = f.simulation_run_id) <> $1::date)`,
        [options.asOf],
      );
    }

    // Nightly runs are kept so the drift of each project's forecast can be charted.
    if (options.triggeredBy === "nightly") {
      await tx.query(
        `INSERT INTO tracker.project_forecast_history (project_id, run_id, finish_date, p50_finish, p80_finish)
         SELECT project_id, run_id, finish_date, p50_finish, p80_finish FROM tracker.project_forecast WHERE run_id = $1`,
        [runId],
      );
    }

    const tasksScheduled = taskRows.filter((t) => t.scheduled_finish !== null).length;
    const tasksUnscheduled = taskRows.length - tasksScheduled;
    await tx.query(
      `UPDATE tracker.schedule_run
          SET status = 'succeeded', finished_at = now(), tasks_scheduled = $2, tasks_unscheduled = $3
        WHERE id = $1`,
      [runId, tasksScheduled, tasksUnscheduled],
    );
    return { runId, tasksScheduled, tasksUnscheduled };
  });
}
