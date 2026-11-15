// Loads the migrations into a real Postgres (PGlite, Postgres compiled to WebAssembly) and
// exercises the rules the schema is supposed to enforce. No database server is needed.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const migration = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../db/tracker/migrations/${name}`, import.meta.url)), "utf8");

let db: PGlite;
let ana: number, ben: number, alpha: number, brain: number;
const status: Record<string, Record<string, number>> = {};

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params);
  assert.equal(r.rows.length, 1, `expected one row from: ${sql}`);
  return r.rows[0] as T;
}

async function rejects(sql: string, pattern: RegExp, params: unknown[] = []) {
  await assert.rejects(() => db.query(sql, params), pattern, sql);
}

async function newTask(projectId: number, number: number, extra: Record<string, unknown> = {}) {
  const key = projectId === alpha ? "alpha" : "brain";
  const row: Record<string, unknown> = {
    project_id: projectId,
    number,
    title: `task ${number}`,
    reporter_person_id: ana,
    status_id: status[key]!["To Do"],
    ...extra,
  };
  const cols = Object.keys(row);
  const r = await one<{ id: number }>(
    `INSERT INTO task (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    Object.values(row),
  );
  return Number(r.id);
}

before(async () => {
  db = new PGlite();
  await db.exec(migration("0001_schema.sql"));
  await db.exec(migration("0002_roles.sql"));
  await db.exec("SET search_path = tracker, public");

  ana = Number(
    (
      await one<{ id: number }>(
        `INSERT INTO person (email, display_name) VALUES ('ana@example.test', 'Ana') RETURNING id`,
      )
    ).id,
  );
  ben = Number(
    (
      await one<{ id: number }>(
        `INSERT INTO person (email, display_name) VALUES ('ben@example.test', 'Ben') RETURNING id`,
      )
    ).id,
  );

  for (const [key, rank] of [
    ["ALPHA", 1],
    ["BRAIN", 2],
  ] as const) {
    const p = await one<{ id: number }>(
      `INSERT INTO project (key, name, owner_person_id, created_by, state, portfolio_rank, target_date)
       VALUES ($1, $1, $2, $2, 'active', $3, '2026-12-11') RETURNING id`,
      [key, ana, rank],
    );
    const id = Number(p.id);
    await db.query("SELECT seed_default_statuses($1)", [id]);
    const rows = await db.query<{ id: number; name: string }>(
      "SELECT id, name FROM workflow_status WHERE project_id = $1",
      [id],
    );
    status[key.toLowerCase()] = Object.fromEntries(rows.rows.map((r) => [r.name, Number(r.id)]));
    if (key === "ALPHA") alpha = id;
    else brain = id;
  }
});

test("seed data: five estimate buckets and a global 6-hour day", async () => {
  const b = await db.query<{ label: string; hours: string }>(
    "SELECT label, hours FROM effort_bucket ORDER BY sort_order",
  );
  assert.deepEqual(
    b.rows.map((r) => [r.label, Number(r.hours)]),
    [
      ["Half a day or less", 3],
      ["1 Day", 6],
      ["3 Days", 18],
      ["1 Week", 30],
      ["2 Weeks", 60],
    ],
  );
  const c = await one<{ project_hours_per_day: string }>("SELECT * FROM person_capacity_on($1, $2)", [
    ana,
    "2026-11-16",
  ]);
  assert.equal(Number(c.project_hours_per_day), 6);
});

test("blocked is its own status category", async () => {
  const r = await one<{ category: string }>(
    `SELECT category FROM workflow_status WHERE project_id = $1 AND name = 'Blocked'`,
    [alpha],
  );
  assert.equal(r.category, "blocked");
});

test("stack rank: duplicates rejected, swaps allowed, active needs a rank", async () => {
  await rejects(`UPDATE project SET portfolio_rank = 1 WHERE id = $1`, /project_rank_unique/, [brain]);

  // The draft schema's partial unique index made this single-statement swap fail.
  await db.query(`UPDATE project SET portfolio_rank = CASE id WHEN $1 THEN 2 ELSE 1 END WHERE id IN ($1, $2)`, [
    alpha,
    brain,
  ]);
  await db.query(`UPDATE project SET portfolio_rank = CASE id WHEN $1 THEN 1 ELSE 2 END WHERE id IN ($1, $2)`, [
    alpha,
    brain,
  ]);

  await rejects(`UPDATE project SET portfolio_rank = NULL WHERE id = $1`, /project_active_needs_rank/, [brain]);

  // A completed project gives its rank back.
  const done = await one<{ id: number }>(
    `INSERT INTO project (key, name, owner_person_id, created_by, state, portfolio_rank)
     VALUES ('OLD', 'Old', $1, $1, 'completed', 1) RETURNING id`,
    [ana],
  );
  assert.ok(done.id);
});

test("a task cannot use another project's status, sprint or parent", async () => {
  await rejects(
    `INSERT INTO task (project_id, number, title, reporter_person_id, status_id) VALUES ($1, 900, 'x', $2, $3)`,
    /foreign key/,
    [alpha, ana, status.brain!["To Do"]],
  );

  const parentInBrain = await newTask(brain, 901);
  await rejects(
    `INSERT INTO task (project_id, number, title, reporter_person_id, status_id, parent_task_id)
     VALUES ($1, 902, 'x', $2, $3, $4)`,
    /foreign key/,
    [alpha, ana, status.alpha!["To Do"], parentInBrain],
  );
});

test("subtasks go one level deep", async () => {
  const parent = await newTask(alpha, 910);
  const child = await newTask(alpha, 911, { parent_task_id: parent });
  await rejects(
    `INSERT INTO task (project_id, number, title, reporter_person_id, status_id, parent_task_id)
     VALUES ($1, 912, 'x', $2, $3, $4)`,
    /itself a subtask/,
    [alpha, ana, status.alpha!["To Do"], child],
  );
  const other = await newTask(alpha, 913);
  await rejects(`UPDATE task SET parent_task_id = $1 WHERE id = $2`, /has subtasks/, [other, parent]);
});

test("milestones carry no effort; a not-before date needs a reason", async () => {
  await rejects(
    `INSERT INTO task (project_id, number, title, reporter_person_id, status_id, type, effort_estimate_hours)
     VALUES ($1, 920, 'm', $2, $3, 'milestone', 6)`,
    /check/,
    [alpha, ana, status.alpha!["To Do"]],
  );
  await rejects(
    `INSERT INTO task (project_id, number, title, reporter_person_id, status_id, not_before_date)
     VALUES ($1, 921, 'x', $2, $3, '2026-12-01')`,
    /check/,
    [alpha, ana, status.alpha!["To Do"]],
  );
});

test("remaining effort is stamped on change and can be confirmed without a change", async () => {
  const id = await newTask(alpha, 930, { remaining_effort_hours: 12 });
  const t0 = await one<{ at: Date }>("SELECT remaining_effort_updated_at AS at FROM task WHERE id = $1", [id]);
  assert.ok(t0.at, "stamped on insert");

  await db.query(`UPDATE task SET remaining_effort_updated_at = '2026-01-01' WHERE id = $1`, [id]);
  await db.query(`UPDATE task SET title = 'renamed' WHERE id = $1`, [id]);
  const t1 = await one<{ at: Date }>("SELECT remaining_effort_updated_at AS at FROM task WHERE id = $1", [id]);
  assert.equal(new Date(t1.at).getUTCFullYear(), 2026, "unrelated edit leaves the stamp");
  assert.equal(new Date(t1.at).getUTCMonth(), 0);

  await db.query(`UPDATE task SET remaining_effort_hours = 9 WHERE id = $1`, [id]);
  const t2 = await one<{ fresh: boolean }>(
    `SELECT remaining_effort_updated_at > now() - interval '1 minute' AS fresh FROM task WHERE id = $1`,
    [id],
  );
  assert.equal(t2.fresh, true, "a change to the value restamps it");
});

test("capacity: person override beats team override beats global, within its dates", async () => {
  const team = await one<{ id: number }>(`INSERT INTO team (name) VALUES ('Robotics') RETURNING id`);
  await db.query("UPDATE person SET team_id = $1 WHERE id IN ($2, $3)", [team.id, ana, ben]);
  await db.query(`INSERT INTO capacity_setting (scope, team_id, project_hours_per_day) VALUES ('team', $1, 4)`, [
    team.id,
  ]);
  await db.query(
    `INSERT INTO capacity_setting (scope, person_id, project_hours_per_day, effective_from, effective_to)
     VALUES ('person', $1, 2, '2026-12-01', '2026-12-31')`,
    [ben],
  );

  const hours = async (person: number, day: string) =>
    Number(
      (await one<{ project_hours_per_day: string }>("SELECT * FROM person_capacity_on($1, $2)", [person, day]))
        .project_hours_per_day,
    );

  assert.equal(await hours(ana, "2026-12-10"), 4, "team override");
  assert.equal(await hours(ben, "2026-12-10"), 2, "person override inside its dates");
  assert.equal(await hours(ben, "2027-01-10"), 4, "falls back to team outside its dates");

  // Weekdays were not overridden, so they still come from the global row.
  const wd = await one<{ working_weekdays: number[] }>("SELECT * FROM person_capacity_on($1, $2)", [ben, "2026-12-10"]);
  assert.deepEqual(wd.working_weekdays, [1, 2, 3, 4, 5]);
});

test("roll-up counts unscheduled, unestimated and stale work and ignores old runs", async () => {
  const p = await one<{ id: number }>(
    `INSERT INTO project (key, name, owner_person_id, created_by, state, portfolio_rank, target_date)
     VALUES ('ROLL', 'Roll', $1, $1, 'active', 9, '2026-12-11') RETURNING id`,
    [ana],
  );
  const pid = Number(p.id);
  await db.query("SELECT seed_default_statuses($1)", [pid]);
  const st = await one<{ id: number }>(`SELECT id FROM workflow_status WHERE project_id = $1 AND name = 'To Do'`, [
    pid,
  ]);
  const add = async (number: number, cols: string, vals: string) =>
    Number(
      (
        await one<{ id: number }>(
          `INSERT INTO task (project_id, number, title, reporter_person_id, status_id${cols})
       VALUES ($1, $2, 't', $3, $4${vals}) RETURNING id`,
          [pid, number, ana, st.id],
        )
      ).id,
    );

  const scheduled = await add(1, ", effort_estimate_hours, remaining_effort_hours", ", 18, 12");
  const unassigned = await add(2, ", effort_estimate_hours", ", 30"); // no remaining: falls back to the estimate
  await add(3, "", ""); // no estimate at all
  const parent = await add(4, ", effort_estimate_hours", ", 60");
  await db.query(
    `INSERT INTO task (project_id, number, title, reporter_person_id, status_id, parent_task_id, effort_estimate_hours, remaining_effort_hours)
     VALUES ($1, 5, 'child', $2, $3, $4, 6, 6)`,
    [pid, ana, st.id, parent],
  );

  const oldRun = await one<{ id: number }>(
    `INSERT INTO schedule_run (triggered_by, as_of_date, status, finished_at) VALUES ('manual', '2026-11-10', 'succeeded', now()) RETURNING id`,
  );
  await db.query(`INSERT INTO task_forecast (task_id, run_id, scheduled_finish) VALUES ($1, $2, '2026-11-20')`, [
    unassigned,
    oldRun.id,
  ]);
  const run = await one<{ id: number }>(
    `INSERT INTO schedule_run (triggered_by, as_of_date, status, finished_at) VALUES ('manual', '2026-11-11', 'succeeded', now()) RETURNING id`,
  );
  await db.query(
    `INSERT INTO task_forecast (task_id, run_id, scheduled_start, scheduled_finish) VALUES ($1, $2, '2026-11-11', '2026-11-13')`,
    [scheduled, run.id],
  );
  await db.query(
    `INSERT INTO project_forecast (project_id, run_id, finish_date, p50_finish, p80_finish)
     VALUES ($1, $2, '2026-12-09', '2026-12-10', '2026-12-15')`,
    [pid, run.id],
  );

  const r = await one<Record<string, unknown>>("SELECT * FROM project_rollup WHERE project_id = $1", [pid]);
  assert.equal(Number(r.task_count), 5);
  assert.equal(Number(r.total_hours), 18 + 30 + 6, "the parent's 60 hours are not counted on top of its subtask");
  assert.equal(Number(r.remaining_hours), 12 + 30 + 6);
  assert.equal(Number(r.unscheduled_tasks), 3, "unassigned (old-run row ignored), unestimated, and the subtask");
  assert.equal(Number(r.unscheduled_hours), 30 + 6);
  assert.equal(Number(r.unestimated_tasks), 1);
  assert.equal(Number(r.stale_tasks), 2, "the two tasks whose remaining effort was never entered");
  assert.equal(r.at_risk, true, "P80 of Dec 15 is past the Dec 11 target even though the single schedule is not");
  assert.equal(r.at_risk_basis, "p80");
});

test("one write path: each database role can write only its own tables", async () => {
  const id = await newTask(alpha, 940, { remaining_effort_hours: 6 });
  try {
    await db.exec("SET ROLE tracker_engine");
    await rejects(`UPDATE tracker.task SET title = 'engine was here' WHERE id = $1`, /permission denied/, [id]);
    const run = await one<{ id: number }>(
      `INSERT INTO tracker.schedule_run (triggered_by, as_of_date) VALUES ('manual', '2026-11-11') RETURNING id`,
    );
    await db.query(`INSERT INTO tracker.task_forecast (task_id, run_id) VALUES ($1, $2)`, [id, run.id]);

    await db.exec("RESET ROLE; SET ROLE tracker_service");
    await db.query(`UPDATE tracker.task SET title = 'service edit' WHERE id = $1`, [id]);
    await rejects(
      `UPDATE tracker.task_forecast SET scheduled_finish = '2026-01-01' WHERE task_id = $1`,
      /permission denied/,
      [id],
    );

    await db.exec("RESET ROLE; SET ROLE tracker_readonly");
    await db.query("SELECT count(*) FROM tracker.project_rollup");
    await rejects(`UPDATE tracker.task SET title = 'chat edit' WHERE id = $1`, /permission denied/, [id]);
  } finally {
    await db.exec("RESET ROLE");
  }
});
