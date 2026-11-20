// The tracker's service layer against a real Postgres engine (PGlite, in-process). These are
// the rules the schema leaves to the service: numbering, logging, completion dates, blocked
// reasons, dependency loops, who may do what, and the forecast run.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { TrackerError, type Actor, type Database } from "../src/modules/tracker/service/database";
import {
  createProject as createProjectAsIs,
  ensurePerson,
  setPortfolioRanks,
  setProjectMember,
  updateProject,
  type NewProject,
} from "../src/modules/tracker/service/projects";
import {
  addDependency,
  archiveTask,
  changeStatus,
  confirmRemainingEffort,
  createTask,
  removeDependency,
  updateTask,
} from "../src/modules/tracker/service/tasks";
import { runForecast } from "../src/modules/tracker/service/forecast";
import {
  departmentScope,
  listDepartments,
  syncDepartments,
  type OrgUnit,
} from "../src/modules/tracker/service/departments";

const ORG: OrgUnit[] = [
  { code: "company", name: "Company-wide", parentCode: null },
  { code: "pm", name: "Project Management", parentCode: null },
  { code: "group:engineering", name: "Engineering", parentCode: null },
  { code: "mech", name: "Mechanical Engineering", parentCode: "group:engineering" },
  { code: "controls", name: "Controls Engineering", parentCode: "group:engineering" },
  { code: "group:support", name: "Support", parentCode: null },
  { code: "finance", name: "Finance", parentCode: "group:support" },
  { code: "hr", name: "Human Resources", parentCode: "group:support" },
];

const migration = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../db/tracker/migrations/${name}`, import.meta.url)), "utf8");

let pg: PGlite;
let db: Database;
let ana: Actor, ben: Actor, cal: Actor, boss: Actor;

// Every project needs a justification, a yearly value and a department. Tests that are about
// something else get one of each from here; the tests of those rules call the service as it is.
let someValue: number;
let someDepartment: number;
const createProject = (
  d: Database,
  actor: Actor,
  input: Omit<NewProject, "justification" | "valueBucketId" | "forDepartmentId" | "doneByDepartmentId"> &
    Partial<NewProject>,
) =>
  createProjectAsIs(d, actor, {
    justification: "Saves the team time.",
    valueBucketId: someValue,
    forDepartmentId: someDepartment,
    doneByDepartmentId: someDepartment,
    ...input,
  });

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}

async function refuses(fn: () => Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(fn, (e: unknown) => {
    assert.ok(e instanceof TrackerError, `expected a TrackerError, got ${e}`);
    assert.equal(e.code, code);
    if (message) assert.match(e.message, message);
    return true;
  });
}

async function statusId(projectId: number, name: string): Promise<number> {
  const [r] = await rows<{ id: number }>(`SELECT id FROM tracker.workflow_status WHERE project_id = $1 AND name = $2`, [
    projectId,
    name,
  ]);
  return Number(r!.id);
}

before(async () => {
  pg = new PGlite();
  await pg.exec(migration("0001_schema.sql"));
  await pg.exec(migration("0002_roles.sql"));
  await pg.exec(migration("0003_work_kinds.sql"));
  await pg.exec(migration("0004_count_work_cards.sql"));
  await pg.exec(migration("0005_kind_required.sql"));
  await pg.exec(migration("0006_requested_by.sql"));
  await pg.exec(migration("0007_checklist.sql"));
  await pg.exec(migration("0008_migration_record_readable.sql"));
  await pg.exec(migration("0009_project_priority_dropped.sql"));
  await pg.exec(migration("0010_project_justification.sql"));
  await pg.exec(migration("0011_project_for_department.sql"));
  await pg.exec(migration("0012_project_done_by_department.sql"));
  await pg.exec(migration("0013_task_actual_start.sql"));
  await pg.exec(migration("0014_project_start_date.sql"));
  await pg.exec("RESET search_path");
  db = { transaction: (fn) => pg.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })) as never };
  // The company's departments as the roster would hand them over: see the departments test.
  await syncDepartments(db, ORG);
  someDepartment = (await listDepartments(db)).find((d) => d.code === "company")!.id;
  someValue = Number(
    (await rows<{ id: number }>(`SELECT id FROM tracker.value_bucket ORDER BY sort_order LIMIT 1`))[0]!.id,
  );

  ana = { personId: await ensurePerson(db, { email: "Ana@Example.test", displayName: "Ana" }) };
  ben = { personId: await ensurePerson(db, { email: "ben@example.test", displayName: "Ben" }) };
  cal = { personId: await ensurePerson(db, { email: "cal@example.test", displayName: "Cal" }) };
  boss = { personId: await ensurePerson(db, { email: "boss@example.test", displayName: "Boss" }) };
  await pg.query(`INSERT INTO tracker.person_global_role (person_id, role) VALUES ($1, 'portfolio_owner')`, [
    boss.personId,
  ]);
});

test("a person is created once and matched by email after that", async () => {
  const again = await ensurePerson(db, { email: "ana@example.test", displayName: "Ana Lopez" });
  assert.equal(again, ana.personId);
  const [p] = await rows<{ email: string; display_name: string }>(
    `SELECT email, display_name FROM tracker.person WHERE id = $1`,
    [ana.personId],
  );
  assert.deepEqual([p!.email, p!.display_name], ["ana@example.test", "Ana Lopez"]);
});

test("a new project gets the default columns and its creator as manager", async () => {
  const p = await createProject(db, ana, { key: "bin", name: "Bin picking" });
  assert.equal(p.key, "BIN");
  const cols = await rows<{ name: string }>(
    `SELECT name FROM tracker.workflow_status WHERE project_id = $1 ORDER BY sort_order`,
    [p.id],
  );
  assert.deepEqual(
    cols.map((c) => c.name),
    ["Backlog", "To Do", "In Progress", "In Review", "Blocked", "Done", "Cancelled"],
  );
  const [m] = await rows<{ role: string }>(
    `SELECT role FROM tracker.project_member WHERE project_id = $1 AND person_id = $2`,
    [p.id, ana.personId],
  );
  assert.equal(m!.role, "manager");

  await refuses(() => createProject(db, ben, { key: "BIN", name: "Again" }), "conflict");
  await refuses(() => createProject(db, ben, { key: "1bad", name: "x" }), "invalid");
});

test("tasks are numbered per project, sized from a bucket, and logged from the first status", async () => {
  const p = await createProject(db, ana, { key: "NUM", name: "Numbering" });
  const [bucket] = await rows<{ id: number }>(`SELECT id FROM tracker.effort_bucket WHERE label = '1 Day'`);

  const t1 = await createTask(db, ana, {
    projectId: p.id,
    title: "First",
    effortBucketId: Number(bucket!.id),
    estimatedCompletionDate: "2026-12-01",
  });
  const t2 = await createTask(db, ana, { projectId: p.id, title: "Second" });
  assert.deepEqual([t1.key, t2.key], ["NUM-1", "NUM-2"]);

  const [row] = await rows<{ hours: string; baseline: string; status: string }>(
    `SELECT t.effort_estimate_hours::text AS hours, t.baseline_completion_date::text AS baseline, s.name AS status
       FROM tracker.task t JOIN tracker.workflow_status s ON s.id = t.status_id WHERE t.id = $1`,
    [t1.id],
  );
  assert.deepEqual([Number(row!.hours), row!.baseline, row!.status], [6, "2026-12-01", "Backlog"]);

  const log = await rows<{ from_status_id: number | null }>(
    `SELECT from_status_id FROM tracker.status_log WHERE task_id = $1`,
    [t1.id],
  );
  assert.deepEqual(
    log.map((l) => l.from_status_id),
    [null],
  );

  await refuses(
    () => createTask(db, ana, { projectId: p.id, title: "M", type: "milestone", effortEstimateHours: 6 }),
    "invalid",
  );
  await refuses(
    () => createTask(db, ana, { projectId: p.id, title: "N", notBeforeDate: "2026-12-01" }),
    "invalid",
    /reason/,
  );
});

test("edits to tracked fields are logged, and the baseline date is never replaced", async () => {
  const p = await createProject(db, ana, { key: "EDIT", name: "Edits" });
  const t = await createTask(db, ana, {
    projectId: p.id,
    title: "T",
    remainingEffortHours: 12,
    estimatedCompletionDate: "2026-12-01",
  });

  await updateTask(
    db,
    ana,
    t.id,
    { estimatedCompletionDate: "2026-12-10", remainingEffortHours: 8, title: "Renamed" },
    "scope grew",
  );
  await updateTask(db, ana, t.id, { remainingEffortHours: 8 }); // no change: nothing logged

  const log = await rows<{ field: string; old_value: string; new_value: string; reason: string }>(
    `SELECT field, old_value, new_value, reason FROM tracker.task_change_log WHERE task_id = $1 ORDER BY id`,
    [t.id],
  );
  assert.deepEqual(
    log.map((l) => [l.field, Number(l.old_value) || l.old_value, Number(l.new_value) || l.new_value, l.reason]),
    [
      ["remaining_effort_hours", 12, 8, "scope grew"],
      ["estimated_completion_date", "2026-12-01", "2026-12-10", "scope grew"],
    ],
  );
  const [row] = await rows<{ est: string; baseline: string; title: string }>(
    `SELECT estimated_completion_date::text AS est, baseline_completion_date::text AS baseline, title FROM tracker.task WHERE id = $1`,
    [t.id],
  );
  assert.deepEqual([row!.est, row!.baseline, row!.title], ["2026-12-10", "2026-12-01", "Renamed"]);

  await pg.query(`UPDATE tracker.task SET remaining_effort_updated_at = '2026-01-01' WHERE id = $1`, [t.id]);
  await confirmRemainingEffort(db, ana, t.id);
  const [fresh] = await rows<{ ok: boolean }>(
    `SELECT remaining_effort_updated_at > now() - interval '1 minute' AS ok FROM tracker.task WHERE id = $1`,
    [t.id],
  );
  assert.equal(fresh!.ok, true);
});

test("status changes: logged, completion date set and cleared, blocked needs a reason", async () => {
  const p = await createProject(db, ana, { key: "STAT", name: "Statuses" });
  const other = await createProject(db, ana, { key: "OTHER", name: "Other" });
  const t = await createTask(db, ana, { projectId: p.id, title: "T" });

  await refuses(() => changeStatus(db, ana, t.id, 0), "invalid");
  await refuses(
    async () => changeStatus(db, ana, t.id, await statusId(other.id, "Done")),
    "invalid",
    /different project/,
  );
  await refuses(async () => changeStatus(db, ana, t.id, await statusId(p.id, "Blocked")), "invalid", /blocking/);

  await changeStatus(db, ana, t.id, await statusId(p.id, "Blocked"), {
    blockedReason: "waiting on parts",
    expectedUnblockDate: "2026-12-05",
  });
  let [row] = await rows<{ blocked_reason: string | null; unblock: string | null; done: string | null }>(
    `SELECT blocked_reason, expected_unblock_date::text AS unblock, actual_completion_date::text AS done FROM tracker.task WHERE id = $1`,
    [t.id],
  );
  assert.deepEqual([row!.blocked_reason, row!.unblock, row!.done], ["waiting on parts", "2026-12-05", null]);

  await changeStatus(db, ana, t.id, await statusId(p.id, "Done"), { note: "shipped" });
  [row] = await rows(
    `SELECT blocked_reason, expected_unblock_date::text AS unblock, actual_completion_date::text AS done FROM tracker.task WHERE id = $1`,
    [t.id],
  );
  assert.equal(row!.blocked_reason, null, "leaving blocked clears the reason");
  assert.ok(row!.done, "entering done sets the completion date");

  await changeStatus(db, ana, t.id, await statusId(p.id, "In Progress"));
  [row] = await rows(
    `SELECT blocked_reason, expected_unblock_date::text AS unblock, actual_completion_date::text AS done FROM tracker.task WHERE id = $1`,
    [t.id],
  );
  assert.equal(row!.done, null, "reopening clears it");

  const log = await rows<{ name: string; note: string | null }>(
    `SELECT s.name, l.note FROM tracker.status_log l JOIN tracker.workflow_status s ON s.id = l.to_status_id WHERE l.task_id = $1 ORDER BY l.id`,
    [t.id],
  );
  assert.deepEqual(
    log.map((l) => [l.name, l.note]),
    [
      ["Backlog", null],
      ["Blocked", "waiting on parts"],
      ["Done", "shipped"],
      ["In Progress", null],
    ],
  );
});

test("dependencies: loops are refused, changes are logged on the waiting task", async () => {
  const p = await createProject(db, ana, { key: "DEP", name: "Dependencies" });
  const a = await createTask(db, ana, { projectId: p.id, title: "A" });
  const b = await createTask(db, ana, { projectId: p.id, title: "B" });
  const c = await createTask(db, ana, { projectId: p.id, title: "C" });

  await addDependency(db, ana, a.id, b.id);
  await addDependency(db, ana, b.id, c.id, 2);
  await refuses(() => addDependency(db, ana, c.id, a.id), "invalid", /loop/);
  await refuses(() => addDependency(db, ana, a.id, a.id), "invalid");
  await refuses(() => addDependency(db, ana, a.id, b.id), "conflict");

  await removeDependency(db, ana, a.id, b.id);
  const log = await rows<{ old_value: string | null; new_value: string | null }>(
    `SELECT old_value, new_value FROM tracker.task_change_log WHERE task_id = $1 AND field = 'dependency' ORDER BY id`,
    [b.id],
  );
  assert.deepEqual(
    log.map((l) => [l.old_value, l.new_value]),
    [
      [null, "waits on DEP-1"],
      ["waits on DEP-1", null],
    ],
  );
  const [lag] = await rows<{ new_value: string }>(
    `SELECT new_value FROM tracker.task_change_log WHERE task_id = $1 AND field = 'dependency'`,
    [c.id],
  );
  assert.equal(lag!.new_value, "waits on DEP-2 (+2 days)");
});

test("who may do what: members only, managers for archiving, the portfolio owner for ranks", async () => {
  const p = await createProject(db, ana, { key: "ACL", name: "Access" });
  const t = await createTask(db, ana, { projectId: p.id, title: "T" });

  await refuses(() => createTask(db, ben, { projectId: p.id, title: "x" }), "forbidden");
  await setProjectMember(db, ana, p.id, ben.personId, "viewer");
  await refuses(() => updateTask(db, ben, t.id, { priority: 1 }), "forbidden");
  await setProjectMember(db, ana, p.id, ben.personId, "contributor");
  await updateTask(db, ben, t.id, { priority: 1 });
  await refuses(() => archiveTask(db, ben, t.id), "forbidden");
  await refuses(() => setProjectMember(db, ben, p.id, cal.personId, "viewer"), "forbidden");

  await refuses(() => setPortfolioRanks(db, ana, [{ projectId: p.id, rank: 50 }]), "forbidden");
  await refuses(() => updateProject(db, ana, p.id, { state: "active" }), "invalid", /stack rank/);
  await setPortfolioRanks(db, boss, [{ projectId: p.id, rank: 50 }]);
  await updateProject(db, ana, p.id, { state: "active", targetDate: "2026-12-31" }, "kickoff");

  const log = await rows<{ field: string; new_value: string }>(
    `SELECT field, new_value FROM tracker.project_change_log WHERE project_id = $1 ORDER BY id`,
    [p.id],
  );
  assert.deepEqual(
    log.map((l) => [l.field, l.new_value]),
    [
      ["portfolio_rank", "50"],
      ["target_date", "2026-12-31"],
      ["state", "active"],
    ],
  );

  await archiveTask(db, ana, t.id);
  await refuses(() => updateTask(db, ana, t.id, { priority: 2 }), "invalid", /archived/);
});

test("a project can be renamed by a manager: the key stays, an empty name is refused, nothing is logged", async () => {
  const p = await createProject(db, ana, { key: "RENAME", name: "Old name" });
  await setProjectMember(db, ana, p.id, ben.personId, "contributor");
  await refuses(() => updateProject(db, ben, p.id, { name: "Mine now" }), "forbidden");
  await refuses(() => updateProject(db, ana, p.id, { name: "   " }), "invalid", /needs a name/);
  await updateProject(db, ana, p.id, { name: "  New name  " });

  const [row] = await rows<{ key: string; name: string }>(`SELECT key, name FROM tracker.project WHERE id = $1`, [
    p.id,
  ]);
  assert.deepEqual(row, { key: "RENAME", name: "New name" });
  const log = await rows(`SELECT 1 FROM tracker.project_change_log WHERE project_id = $1`, [p.id]);
  assert.equal(log.length, 0);
});

test("stack ranks can be swapped in one step; a clash changes nothing", async () => {
  const a = await createProject(db, ana, { key: "RANKA", name: "A" });
  const b = await createProject(db, ana, { key: "RANKB", name: "B" });
  await setPortfolioRanks(db, boss, [
    { projectId: a.id, rank: 61 },
    { projectId: b.id, rank: 62 },
  ]);
  await setPortfolioRanks(db, boss, [
    { projectId: a.id, rank: 62 },
    { projectId: b.id, rank: 61 },
  ]);
  await refuses(() => setPortfolioRanks(db, boss, [{ projectId: a.id, rank: 61 }]), "conflict");
  const got = await rows<{ key: string; portfolio_rank: number }>(
    `SELECT key, portfolio_rank FROM tracker.project WHERE id = ANY(ARRAY[$1::bigint, $2::bigint]) ORDER BY key`,
    [a.id, b.id],
  );
  assert.deepEqual(
    got.map((r) => [r.key, Number(r.portfolio_rank)]),
    [
      ["RANKA", 62],
      ["RANKB", 61],
    ],
  );
});

test("forecast run: the spec's worked example, built through the service and read back from the tables", async () => {
  // Start from a clean set of projects so nothing above competes for Ana and Ben.
  await pg.exec(`UPDATE tracker.project SET state = 'completed'`);
  await pg.query(
    `INSERT INTO tracker.company_holiday (holiday_date, name) VALUES ('2026-11-26', 'Thanksgiving'), ('2026-11-27', 'Day after')`,
  );
  await pg.query(
    `INSERT INTO tracker.time_off (person_id, start_date, end_date) VALUES ($1, '2026-11-16', '2026-11-17')`,
    [ben.personId],
  );

  const alpha = await createProject(db, ana, { key: "ALPHA", name: "Alpha", targetDate: "2026-12-11" });
  const brain = await createProject(db, ana, { key: "BRAIN", name: "Brain", targetDate: "2026-12-31" });
  const idle = await createProject(db, ana, { key: "IDLE", name: "Not ranked yet" });
  await setPortfolioRanks(db, boss, [
    { projectId: alpha.id, rank: 1 },
    { projectId: brain.id, rank: 2 },
  ]);
  await updateProject(db, ana, alpha.id, { state: "active" });
  await updateProject(db, ana, brain.id, { state: "active" });

  const a1 = await createTask(db, ana, {
    projectId: alpha.id,
    title: "A1",
    remainingEffortHours: 30,
    assigneePersonId: ana.personId,
    priority: 1,
  });
  const a2 = await createTask(db, ana, {
    projectId: alpha.id,
    title: "A2",
    remainingEffortHours: 24,
    assigneePersonId: ben.personId,
    priority: 2,
  });
  const a3 = await createTask(db, ana, {
    projectId: alpha.id,
    title: "A3",
    remainingEffortHours: 18,
    assigneePersonId: ana.personId,
    priority: 3,
  });
  await addDependency(db, ana, a1.id, a3.id);
  await addDependency(db, ana, a2.id, a3.id);
  const b1 = await createTask(db, ana, {
    projectId: brain.id,
    title: "B1",
    remainingEffortHours: 36,
    assigneePersonId: ana.personId,
  });
  const b2 = await createTask(db, ana, {
    projectId: brain.id,
    title: "B2",
    remainingEffortHours: 30,
    assigneePersonId: ben.personId,
  });
  await addDependency(db, ana, b1.id, b2.id);
  const b3 = await createTask(db, ana, { projectId: brain.id, title: "B3", remainingEffortHours: 20 });
  const parked = await createTask(db, ana, {
    projectId: idle.id,
    title: "Parked",
    remainingEffortHours: 6,
    assigneePersonId: cal.personId,
  });

  const run = await runForecast(db, { asOf: "2026-11-11", triggeredBy: "nightly", simulations: 40 });
  assert.deepEqual([run.tasksScheduled, run.tasksUnscheduled], [5, 2]);

  const f = await rows<{
    task_id: number;
    s: string | null;
    e: string | null;
    driver: string | null;
    reason: string | null;
    who: number | null;
  }>(
    `SELECT task_id, scheduled_start::text AS s, scheduled_finish::text AS e, driver, unscheduled_reason AS reason, assigned_person_id AS who
       FROM tracker.task_forecast`,
  );
  const of = (id: number) => {
    const r = f.find((x) => Number(x.task_id) === id)!;
    return [r.s, r.e, r.driver, r.reason];
  };
  assert.deepEqual(of(a1.id), ["2026-11-11", "2026-11-17", "start", null]);
  assert.deepEqual(of(a2.id), ["2026-11-11", "2026-11-18", "start", null]);
  assert.deepEqual(of(a3.id), ["2026-11-19", "2026-11-23", "predecessor", null]);
  assert.deepEqual(of(b1.id), ["2026-11-18", "2026-12-02", "resource", null]);
  assert.deepEqual(of(b2.id), ["2026-12-03", "2026-12-09", "predecessor", null]);
  assert.deepEqual(of(b3.id), [null, null, null, "no assignee"]);
  assert.deepEqual(of(parked.id), [null, null, null, "project has no stack rank"]);

  const roll = await rows<Record<string, unknown>>(
    `SELECT key, forecast_completion_date::text AS finish, p50_finish::text AS p50, p80_finish::text AS p80,
            unscheduled_tasks, unscheduled_hours::float8 AS unscheduled_hours, at_risk, at_risk_basis
       FROM tracker.project_rollup WHERE key IN ('ALPHA', 'BRAIN') ORDER BY key`,
  );
  assert.deepEqual([roll[0]!.finish, Number(roll[0]!.unscheduled_tasks)], ["2026-11-23", 0]);
  assert.deepEqual(
    [roll[1]!.finish, Number(roll[1]!.unscheduled_tasks), roll[1]!.unscheduled_hours],
    ["2026-12-09", 1, 20],
  );
  for (const r of roll) {
    assert.ok(r.p50 && r.p80 && String(r.p50) <= String(r.p80), "the simulation filled P50 and P80");
    assert.equal(r.at_risk_basis, "p80");
    assert.equal(r.at_risk, false);
  }
  const history = await rows(`SELECT 1 FROM tracker.project_forecast_history WHERE run_id = $1`, [run.runId]);
  assert.equal(history.length, 3, "a nightly run is kept for the drift chart");

  // A quick run after a change: dates move, the last simulation's P50 and P80 stay.
  await changeStatus(db, ana, a1.id, await statusId(alpha.id, "Done"));
  const quick = await runForecast(db, { asOf: "2026-11-11", triggeredBy: "change" });
  const after = await rows<{
    task_id: number;
    s: string | null;
    p80: string | null;
    run_id: number;
    sim: number | null;
  }>(
    `SELECT task_id, scheduled_start::text AS s, p80_finish::text AS p80, run_id, simulation_run_id AS sim FROM tracker.task_forecast`,
  );
  assert.equal(
    after.some((r) => Number(r.task_id) === a1.id),
    false,
    "a finished task has no forecast row",
  );
  const b1After = after.find((r) => Number(r.task_id) === b1.id)!;
  assert.equal(b1After.s, "2026-11-11", "Ana is free at once now that A1 is done");
  assert.deepEqual([Number(b1After.run_id), Number(b1After.sim)], [quick.runId, run.runId]);
  assert.ok(b1After.p80, "P80 from the earlier simulation is still there");
});

test("forecast run: a quick run on a later day drops the old simulation's P80 instead of showing it stale", async () => {
  const before = await rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM tracker.task_forecast WHERE p80_finish IS NOT NULL`,
  );
  assert.ok(before[0]!.n > 0, "the earlier simulation left P80 dates to drop");

  await runForecast(db, { asOf: "2026-11-12", triggeredBy: "change" });
  const tasks = await rows(
    `SELECT 1 FROM tracker.task_forecast WHERE p80_finish IS NOT NULL OR simulation_run_id IS NOT NULL`,
  );
  assert.equal(tasks.length, 0);
  const roll = await rows<{ p80: string | null; basis: string | null; at_risk: boolean | null }>(
    `SELECT p80_finish::text AS p80, at_risk_basis AS basis, at_risk FROM tracker.project_rollup WHERE key IN ('ALPHA', 'BRAIN')`,
  );
  for (const r of roll) {
    assert.equal(r.p80, null);
    assert.equal(r.basis, "single schedule", "risk falls back to the plain forecast until the next simulation");
    assert.equal(r.at_risk, false);
  }
});

test("screens: a person sees only their projects, an admin sees all, and a board carries each task's forecast", async () => {
  const { listProjects, getBoard } = await import("../src/modules/tracker/service/queries");
  const { ensurePeople } = await import("../src/modules/tracker/service/projects");

  const mine = await listProjects(db, cal);
  assert.deepEqual(
    mine.map((p) => p.key),
    [],
    "Cal is a member of nothing",
  );
  const all = await listProjects(db, { ...cal, admin: true });
  assert.ok(all.length >= 3);
  assert.deepEqual(
    all.filter((p) => p.state === "active").map((p) => p.key),
    ["ALPHA", "BRAIN"],
    "open projects first, in rank order",
  );
  assert.ok(
    all.every((p) => p.myRole === "manager"),
    "an admin is a manager everywhere",
  );

  await refuses(() => getBoard(db, cal, "ALPHA"), "not_found");
  await refuses(() => getBoard(db, ana, "NOPE"), "not_found");

  const board = await getBoard(db, ana, "alpha");
  assert.equal(board.project.key, "ALPHA");
  assert.equal(board.project.myRole, "manager");
  assert.deepEqual(
    board.statuses.map((s) => s.category),
    ["todo", "todo", "in_progress", "in_progress", "blocked", "done", "cancelled"],
  );
  assert.equal(board.forecastAsOf, "2026-11-12");
  const a3 = board.tasks.find((t) => t.title === "A3")!;
  assert.equal(a3.key, "ALPHA-3");
  assert.equal(a3.driver, "predecessor");
  assert.equal(a3.driverTaskKey, "ALPHA-2", "the reason names the task by its key, not its id");
  assert.equal(a3.assigneeName, "Ana Lopez");
  assert.equal(typeof a3.remainingHours, "number");
  const a1 = board.tasks.find((t) => t.title === "A1")!;
  assert.ok(a1.actualCompletionDate, "a finished task keeps its completion date");
  assert.equal(a1.forecastFinish, null, "and has no forecast");
  assert.deepEqual(board.buckets.map((b) => [b.label, b.hours]).slice(0, 2), [
    ["Half a day or less", 3],
    ["1 Day", 6],
  ]);

  // The app's users are copied in so they can be assigned work; names are corrected, nobody is removed.
  const count = async () => Number((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM tracker.person`))[0]!.n);
  const start = await count();
  await ensurePeople(db, [
    { email: "New.Person@example.test", displayName: "New Person" },
    { email: "ben@example.test", displayName: "Ben Renamed" },
  ]);
  assert.equal(await count(), start + 1);
  const [ben2] = await rows<{ display_name: string }>(`SELECT display_name FROM tracker.person WHERE id = $1`, [
    ben.personId,
  ]);
  assert.equal(ben2!.display_name, "Ben Renamed");
});

test("the app's all-access flag stands in for the tracker's admin role", async () => {
  const p = await createProject(db, ana, { key: "ADMIN", name: "Admin flag" });
  await refuses(() => setPortfolioRanks(db, cal, [{ projectId: p.id, rank: 77 }]), "forbidden");
  await setPortfolioRanks(db, { ...cal, admin: true }, [{ projectId: p.id, rank: 77 }]);
  const t = await createTask(
    db,
    { ...cal, admin: true },
    { projectId: p.id, title: "by an admin who is not a member" },
  );
  assert.equal(t.key, "ADMIN-1");
});

test("members: a manager adds people, any member can see the list, outsiders cannot", async () => {
  const { listMembers } = await import("../src/modules/tracker/service/people");
  const p = await createProject(db, ana, { key: "PPL", name: "People" });
  await setProjectMember(db, ana, p.id, cal.personId, "viewer");
  await setProjectMember(db, ana, p.id, ben.personId, "contributor");

  const members = await listMembers(db, cal, p.id);
  assert.deepEqual(
    members.map((m) => [m.personId, m.role]),
    [
      [ana.personId, "manager"],
      [ben.personId, "contributor"],
      [cal.personId, "viewer"],
    ],
  );
  await refuses(() => listMembers(db, boss, p.id), "forbidden");

  await setProjectMember(db, ana, p.id, cal.personId, null);
  assert.equal((await listMembers(db, ana, p.id)).length, 2);
  await setProjectMember(db, ana, p.id, cal.personId, "viewer");

  await refuses(
    () => createProject(db, ana, { key: "people", name: "would shadow the capacity page" }),
    "invalid",
    /reserved/,
  );
});

test("task page: fields, links both ways, comments, and history in words, newest first", async () => {
  const { getTaskDetail } = await import("../src/modules/tracker/service/task-detail");
  const { addComment } = await import("../src/modules/tracker/service/tasks");
  const [p] = await rows<{ id: number }>(`SELECT id FROM tracker.project WHERE key = 'PPL'`);
  const projectId = Number(p!.id);

  const x = await createTask(db, ana, { projectId, title: "X", remainingEffortHours: 6 });
  const y = await createTask(db, ana, {
    projectId,
    title: "Y",
    description: "Do the thing",
    estimatedCompletionDate: "2026-12-01",
  });
  const z = await createTask(db, ana, { projectId, title: "Z" });
  await addDependency(db, ana, x.id, y.id, 1);
  await addDependency(db, ana, y.id, z.id);
  await updateTask(db, ana, y.id, { assigneePersonId: ben.personId, remainingEffortHours: 12 }, "handing over");
  await changeStatus(db, ana, y.id, await statusId(projectId, "In Progress"), { note: "started" });
  await addComment(db, ben, y.id, "  On it.  ");
  await refuses(() => addComment(db, cal, y.id, "viewers cannot comment"), "forbidden");
  await refuses(() => addComment(db, ben, y.id, "   "), "invalid");

  const d = await getTaskDetail(db, cal, "ppl", y.number);
  assert.deepEqual(
    [d.key, d.title, d.description, d.statusName, d.statusCategory, d.myRole],
    ["PPL-2", "Y", "Do the thing", "In Progress", "in_progress", "viewer"],
  );
  assert.deepEqual([d.assigneePersonId, d.remainingHours, d.baselineCompletionDate], [ben.personId, 12, "2026-12-01"]);
  assert.ok(d.remainingUpdatedAt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(d.remainingUpdatedAt));
  assert.deepEqual(
    d.waitsOn.map((l) => [l.key, l.lagDays, l.closed]),
    [["PPL-1", 1, false]],
  );
  assert.deepEqual(
    d.blocks.map((l) => l.key),
    ["PPL-3"],
  );
  assert.deepEqual(
    d.candidates.map((c) => c.key),
    ["PPL-3"],
    "not itself, and not what it already waits on",
  );
  assert.deepEqual(
    d.comments.map((c) => c.body),
    ["On it."],
  );
  assert.ok(d.comments[0]!.author.startsWith("Ben"));

  const words = d.history.map((h) => h.what);
  assert.equal(words[0], "Moved from Backlog to In Progress");
  assert.equal(d.history[0]!.why, "started");
  assert.equal(words.at(-1), "Created in Backlog");
  assert.ok(words.includes("Now waits on PPL-1 (+1 days)"));
  assert.ok(words.includes("Hours left changed from nothing to 12 h"));
  assert.ok(
    words.some((w) => /^Assignee changed from nothing to Ben/.test(w)),
    "an assignee is shown by name, not id",
  );
  assert.ok(d.history.filter((h) => h.why === "handing over").length === 2);

  await refuses(() => getTaskDetail(db, boss, "PPL", y.number), "not_found");
  await refuses(() => getTaskDetail(db, ana, "PPL", 999), "not_found");
});

test("capacity: the default, a person's own figure, time off and holidays all move the forecast", async () => {
  const P = await import("../src/modules/tracker/service/people");
  const admin = { ...ana, admin: true };
  const [p] = await rows<{ id: number }>(`SELECT id FROM tracker.project WHERE key = 'PPL'`);
  const projectId = Number(p!.id);

  const before = await P.getCapacityOverview(db, ana);
  assert.equal(before.globalHoursPerDay, 6);
  assert.equal(before.canManage, false);
  assert.equal(before.people.find((x) => x.id === cal.personId)!.hoursPerDay, 6);
  assert.equal((await P.getCapacityOverview(db, admin)).canManage, true);

  await refuses(() => P.setGlobalHours(db, ana, 5), "forbidden");
  await refuses(() => P.setPersonHours(db, ana, cal.personId, 2), "forbidden");
  await refuses(() => P.setGlobalHours(db, admin, 0), "invalid");
  await refuses(() => P.setPersonHours(db, admin, cal.personId, 30), "invalid");

  // Cal mostly works on things outside the tracker: 2 project hours a day.
  await P.setPersonHours(db, admin, cal.personId, 2);
  // Anyone may record their own time off; only an admin may record someone else's.
  const off = await P.addTimeOff(db, cal, {
    personId: cal.personId,
    start: "2026-11-17",
    end: "2026-11-17",
    note: "dentist",
  });
  await refuses(
    () => P.addTimeOff(db, ben, { personId: cal.personId, start: "2026-11-20", end: "2026-11-20" }),
    "forbidden",
  );
  await refuses(
    () => P.addTimeOff(db, cal, { personId: cal.personId, start: "2026-11-20", end: "2026-11-19" }),
    "invalid",
  );
  await refuses(() => P.addHoliday(db, ana, { date: "2026-11-18", name: "x" }), "forbidden");
  await P.addHoliday(db, admin, { date: "2026-11-18", name: "Shutdown day" });

  const now = await P.getCapacityOverview(db, cal);
  const mine = now.people.find((x) => x.id === cal.personId)!;
  assert.deepEqual([mine.ownHoursPerDay, mine.hoursPerDay], [2, 2]);
  // The screen lists only holidays still to come, so that is checked with a date counted from
  // today. The fixed week below is forecast as of its own Monday and never goes stale.
  const stored = await rows(`SELECT 1 FROM tracker.company_holiday WHERE holiday_date = '2026-11-18'`);
  assert.equal(stored.length, 1);
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await P.addHoliday(db, admin, { date: soon, name: "Still to come" });
  assert.ok((await P.getCapacityOverview(db, cal)).holidays.some((h) => h.date === soon));
  await P.removeHoliday(db, admin, soon);

  // A 6-hour task for Cal from Monday Nov 16: 2 h Mon, off Tue, holiday Wed, 2 h Thu, 2 h Fri.
  await setPortfolioRanks(db, admin, [{ projectId, rank: 90 }]);
  await updateProject(db, ana, projectId, { state: "active" });
  const t = await createTask(db, ana, {
    projectId,
    title: "Cal's task",
    remainingEffortHours: 6,
    assigneePersonId: cal.personId,
  });
  await runForecast(db, { asOf: "2026-11-16", triggeredBy: "manual" });
  const finish = async () =>
    (
      await rows<{ e: string | null }>(
        `SELECT scheduled_finish::text AS e FROM tracker.task_forecast WHERE task_id = $1`,
        [t.id],
      )
    )[0]!.e;
  assert.equal(await finish(), "2026-11-20");

  // Take all three away and it is one ordinary day's work again.
  await refuses(() => P.removeTimeOff(db, ben, off), "forbidden");
  await P.removeTimeOff(db, cal, off);
  await P.removeHoliday(db, admin, "2026-11-18");
  await P.setPersonHours(db, admin, cal.personId, null);
  await runForecast(db, { asOf: "2026-11-16", triggeredBy: "manual" });
  assert.equal(await finish(), "2026-11-16");
  const after = (await P.getCapacityOverview(db, cal)).people.find((x) => x.id === cal.personId)!;
  assert.deepEqual([after.ownHoursPerDay, after.hoursPerDay], [null, 6]);
  // Counted in the table: the screen lists only time off still to come, and this week is fixed.
  const left = await rows(`SELECT 1 FROM tracker.time_off WHERE person_id = $1`, [cal.personId]);
  assert.equal(left.length, 0);

  await P.setGlobalHours(db, admin, 5);
  assert.equal((await P.getCapacityOverview(db, cal)).globalHoursPerDay, 5);
  await P.setGlobalHours(db, admin, 6);
});

test("forecast run: a missing global capacity default is an error, not a silent zero", async () => {
  // It removes the row every other forecast test relies on, and puts it back at the end.
  const kept = await rows<{ hours: string; days: string; note: string | null }>(
    `SELECT project_hours_per_day::text AS hours, working_weekdays::text AS days, note
       FROM tracker.capacity_setting WHERE scope = 'global'`,
  );
  await pg.exec(`DELETE FROM tracker.capacity_setting WHERE scope = 'global'`);
  await refuses(
    () => runForecast(db, { asOf: "2026-11-11", triggeredBy: "manual" }),
    "invalid",
    /global capacity default/,
  );
  const runs = await rows(`SELECT 1 FROM tracker.schedule_run WHERE status = 'running'`);
  assert.equal(runs.length, 0, "the refused run leaves nothing behind");
  for (const k of kept) {
    await pg.query(
      `INSERT INTO tracker.capacity_setting (scope, project_hours_per_day, working_weekdays, note)
       VALUES ('global', $1::numeric, $2::int[], $3)`,
      [k.hours, k.days, k.note],
    );
  }
  await runForecast(db, { asOf: "2026-11-11", triggeredBy: "manual" });
});

test("kinds: a card sits only under a higher kind, changes are logged, and a parent shows what is under it", async () => {
  const { getTaskDetail } = await import("../src/modules/tracker/service/task-detail");
  const { getBoard } = await import("../src/modules/tracker/service/queries");
  const p = await createProject(db, ana, { key: "TAX", name: "Taxonomy" });
  const projectId = p.id;
  const make = (title: string, extra: Partial<Parameters<typeof createTask>[2]> = {}) =>
    createTask(db, ana, { projectId, title, ...extra });

  const epic = await make("Epic", { kind: "epic" });
  const feature = await make("Feature", { kind: "feature", parentTaskId: epic.id });
  const story = await make("Story", { kind: "story", parentTaskId: feature.id });
  const task = await make("Task", { kind: "task", parentTaskId: story.id, effortEstimateHours: 6 });
  const bug = await make("Bug", { kind: "bug", parentTaskId: epic.id, effortEstimateHours: 3 }); // levels can be skipped
  const plain = await make("Plain", { parentTaskId: story.id, effortEstimateHours: 18, remainingEffortHours: 12 });
  const loose = await make("Loose story", { kind: "story" });

  // What is refused, in words a person can act on.
  await refuses(
    () => make("x", { kind: "story", parentTaskId: task.id }),
    "invalid",
    /TAX-4 is a Task, and a Story can sit only/,
  );
  await refuses(() => make("x", { parentTaskId: plain.id }), "invalid", /TAX-6 is a Task, and a Task can sit only/);
  await refuses(() => make("x", { kind: "nonsense" }), "invalid", /does not exist/);
  await refuses(() => updateTask(db, ana, loose.id, { parentTaskId: story.id }), "invalid", /higher kind/);
  await refuses(() => updateTask(db, ana, loose.id, { parentTaskId: loose.id }), "invalid", /under itself/);
  await refuses(() => updateTask(db, ana, epic.id, { parentTaskId: feature.id }), "invalid", /higher kind/);
  await refuses(
    () => updateTask(db, ana, feature.id, { kind: "story" }),
    "invalid",
    /TAX-3 sits under this card and is a Story/,
  );
  const [elsewhere] = await rows<{ id: number }>(
    `SELECT t.id FROM tracker.task t JOIN tracker.project p ON p.id = t.project_id WHERE p.key = 'PPL' LIMIT 1`,
  );
  await refuses(
    () => updateTask(db, ana, loose.id, { parentTaskId: Number(elsewhere!.id) }),
    "invalid",
    /same project/,
  );

  // Kind and parent can change together, and each change is in the history.
  await updateTask(db, ana, loose.id, { kind: "task", parentTaskId: story.id }, "it was smaller than it looked");
  await updateTask(db, ana, loose.id, { parentTaskId: feature.id });
  await updateTask(db, ana, loose.id, { parentTaskId: null, kind: null });
  const l = await getTaskDetail(db, ana, "TAX", loose.number);
  assert.deepEqual(
    l.history
      .map((h) => h.what)
      .filter((w) => /kind|under/i.test(w))
      .reverse(),
    [
      "Kind changed from Story to Task",
      "Moved under TAX-3",
      "Moved under TAX-2 (was under TAX-3)",
      "No longer under TAX-2",
    ],
  );
  assert.deepEqual(
    [l.kind, l.parentTaskId, l.ancestors.length],
    ["task", null, 0],
    "clearing the kind puts it back to Task",
  );

  // The task page: the path above, the cards below, and what it could sit under.
  const t = await getTaskDetail(db, ana, "TAX", task.number);
  assert.deepEqual([t.kind, t.kindLabel, t.parentTaskId], ["task", "Task", story.id]);
  assert.deepEqual(
    t.ancestors.map((a) => a.key),
    ["TAX-1", "TAX-2", "TAX-3"],
    "top of the hierarchy first",
  );
  assert.deepEqual(
    t.parentCandidates.map((c) => [c.key, c.kindLabel]),
    [
      ["TAX-1", "Epic"],
      ["TAX-2", "Feature"],
      ["TAX-3", "Story"],
    ],
    "only cards that can have something under them",
  );
  const s = await getTaskDetail(db, ana, "TAX", story.number);
  assert.deepEqual(
    s.children.map((c) => [c.key, c.kindLabel]),
    [
      ["TAX-4", "Task"],
      ["TAX-6", "Task"],
    ],
  );

  assert.deepEqual(s.rollup, { cards: 2, done: 0, remainingHours: 18, forecastFinish: null, notForecast: 2 });
  assert.equal(t.rollup, null, "nothing sits under a task");

  // The board: a parent adds up the cards that carry work, however deep; a leaf has no roll-up.
  await changeStatus(db, ana, bug.id, await statusId(projectId, "Done"));
  const board = await getBoard(db, ana, "TAX");
  assert.deepEqual(
    board.kinds.map((k) => k.label),
    ["Epic", "Feature", "Story", "Task", "Bug", "Issue", "Milestone"],
  );
  const card = (key: string) => board.tasks.find((c) => c.key === key)!;
  assert.deepEqual([card("TAX-4").kindLabel, card("TAX-4").parentKey, card("TAX-4").rollup], ["Task", "TAX-3", null]);
  assert.deepEqual(card("TAX-3").rollup, {
    cards: 2,
    done: 0,
    remainingHours: 18,
    forecastFinish: null,
    notForecast: 2,
  });
  assert.deepEqual(card("TAX-1").rollup, {
    cards: 3,
    done: 1,
    remainingHours: 18,
    forecastFinish: null,
    notForecast: 2,
  });
});

test("roll-up: latest finish wins, cancelled cards are left out, done cards count but add no hours", async () => {
  const { rollUp } = await import("../src/modules/tracker/service/queries");
  const card = (
    id: number,
    parentId: number | null,
    o: Partial<{ closed: boolean; cancelled: boolean; h: number; f: string | null }> = {},
  ) => ({
    id,
    parentId,
    closed: o.closed ?? false,
    cancelled: o.cancelled ?? false,
    remainingHours: o.h ?? 0,
    forecastFinish: o.f ?? null,
  });
  const r = rollUp([
    card(1, null),
    card(2, 1),
    card(3, 2, { h: 6, f: "2026-11-20" }),
    card(4, 2, { h: 12, f: "2026-12-02" }),
    card(5, 1, { closed: true, h: 30 }),
    card(6, 1, { closed: true, cancelled: true, h: 60 }),
    card(7, 1, { h: 3 }),
    card(8, null, { h: 6 }),
  ]);
  assert.deepEqual(r.get(2), { cards: 2, done: 0, remainingHours: 18, forecastFinish: "2026-12-02", notForecast: 0 });
  assert.deepEqual(r.get(1), { cards: 4, done: 1, remainingHours: 21, forecastFinish: "2026-12-02", notForecast: 1 });
  assert.equal(r.has(8), false);
  assert.equal(r.has(3), false);
});

test("parents follow the cards under them, and are never closed over open work without an answer", async () => {
  const { getTaskDetail } = await import("../src/modules/tracker/service/task-detail");
  const { getBoard } = await import("../src/modules/tracker/service/queries");
  const p = await createProject(db, ana, { key: "AUTO", name: "Auto" });
  const projectId = p.id;
  const make = (title: string, extra: Partial<Parameters<typeof createTask>[2]> = {}) =>
    createTask(db, ana, { projectId, title, ...extra });
  const epic = await make("Epic", { kind: "epic" });
  const story = await make("Story", { kind: "story", parentTaskId: epic.id });
  const a = await make("A", { parentTaskId: story.id, effortEstimateHours: 6 });
  const b = await make("B", { parentTaskId: story.id, effortEstimateHours: 6 });
  const c = await make("C", { kind: "bug", parentTaskId: epic.id, effortEstimateHours: 3 });
  const done = await statusId(projectId, "Done");
  const inProgress = await statusId(projectId, "In Progress");
  const cancelled = await statusId(projectId, "Cancelled");
  const where = async (id: number) => {
    const [r] = await rows<{ name: string; finished: string | null }>(
      `SELECT s.name, t.actual_completion_date::text AS finished
         FROM tracker.task t JOIN tracker.workflow_status s ON s.id = t.status_id WHERE t.id = $1`,
      [id],
    );
    return r!;
  };

  // The last open card under a parent closes it; a parent with open work elsewhere stays open.
  await changeStatus(db, ana, a.id, done);
  assert.equal((await where(story.id)).name, "Backlog");
  assert.deepEqual(await changeStatus(db, ana, b.id, done), { moved: true, openUnder: [] });
  assert.equal((await where(story.id)).name, "Done");
  assert.ok((await where(story.id)).finished, "an automatic close sets the completion date too");
  assert.equal((await where(epic.id)).name, "Backlog", "C is still open under the epic");

  // Cancelling the rest finishes the epic: something under it was done, and nothing is open.
  await changeStatus(db, ana, c.id, cancelled);
  assert.equal((await where(epic.id)).name, "Done");
  const e = await getTaskDetail(db, ana, "AUTO", epic.number);
  assert.deepEqual(
    [e.history[0]!.what, e.history[0]!.why],
    ["Moved from Backlog to Done", "Everything under it is finished"],
  );

  // Reopening a card reopens everything above it.
  await changeStatus(db, ana, b.id, inProgress);
  assert.deepEqual(
    [(await where(story.id)).name, (await where(epic.id)).name, (await where(epic.id)).finished],
    ["In Progress", "In Progress", null],
  );
  await changeStatus(db, ana, b.id, done);
  assert.deepEqual([(await where(story.id)).name, (await where(epic.id)).name], ["Done", "Done"]);

  // So does a new open card under a finished parent.
  const d = await make("D", { parentTaskId: story.id });
  assert.deepEqual([(await where(story.id)).name, (await where(epic.id)).name], ["In Progress", "In Progress"]);

  // Closing a parent by hand over open work: nothing moves, and the open cards come back.
  const asked = await changeStatus(db, ana, epic.id, done);
  assert.equal(asked.moved, false);
  assert.deepEqual(
    asked.openUnder.map((o) => [o.key, o.kindLabel, o.statusName]),
    [
      ["AUTO-2", "Story", "In Progress"],
      ["AUTO-6", "Task", "Backlog"],
    ],
  );
  assert.equal((await where(epic.id)).name, "In Progress");

  // With an answer, the open cards are closed that way first, each with a note saying why.
  assert.equal((await changeStatus(db, ana, epic.id, done, { closeUnder: "cancelled" })).moved, true);
  assert.deepEqual(
    [(await where(epic.id)).name, (await where(story.id)).name, (await where(d.id)).name, (await where(a.id)).name],
    ["Done", "Cancelled", "Cancelled", "Done"],
  );
  const closedD = await getTaskDetail(db, ana, "AUTO", d.number);
  assert.equal(closedD.history[0]!.why, "Closed with AUTO-1");

  // A parent whose cards were all cancelled is not "done": nothing was finished.
  const empty = await make("Second epic", { kind: "epic" });
  const only = await make("Only", { parentTaskId: empty.id });
  await changeStatus(db, ana, only.id, cancelled);
  assert.equal((await where(empty.id)).name, "Backlog");

  // Lifting the last open card out from under a parent closes it; archiving does the same.
  const third = await make("Third", { kind: "story" });
  const x = await make("X", { parentTaskId: third.id });
  const y = await make("Y", { parentTaskId: third.id });
  await changeStatus(db, ana, x.id, done);
  await updateTask(db, ana, y.id, { parentTaskId: null });
  assert.equal((await where(third.id)).name, "Done");

  // The project's own count is over cards that carry work; kinds are counted as what they are.
  const board = await getBoard(db, ana, "AUTO");
  assert.deepEqual(
    [board.project.doneCount, board.project.taskCount],
    [3, 4],
    "A, B, X done; Y open; parents not counted",
  );
  assert.deepEqual(board.kindCounts, [
    { label: "Epic", total: 2, done: 1 },
    { label: "Story", total: 1, done: 1 },
    { label: "Task", total: 4, done: 3 },
  ]);
});

test("dependencies on a parent stand for the work cards under it", async () => {
  const D = await import("../src/modules/tracker/service/dependencies");
  // 1 (feature) holds 11 and 12; 2 (feature) holds 21 and a story 22, which holds 221; 3 is alone.
  const children = D.childrenByParent([
    { id: 11, parentId: 1 },
    { id: 12, parentId: 1 },
    { id: 21, parentId: 2 },
    { id: 22, parentId: 2 },
    { id: 221, parentId: 22 },
    { id: 3, parentId: null },
  ]);
  assert.deepEqual(D.workCardsUnder(2, children).sort(), [21, 221]);
  assert.deepEqual(D.workCardsUnder(3, children), [3]);

  const pairs = (links: { predecessorId: number; successorId: number; lagDays: number }[]) =>
    links.map((l) => `${l.successorId} waits on ${l.predecessorId}${l.lagDays ? ` +${l.lagDays}` : ""}`).sort();
  assert.deepEqual(pairs(D.expandDependencies([{ predecessorId: 1, successorId: 2, lagDays: 0 }], children)), [
    "21 waits on 11",
    "21 waits on 12",
    "221 waits on 11",
    "221 waits on 12",
  ]);
  // A parent on one side only, and the longer lag wins when two links give the same pair.
  assert.deepEqual(
    pairs(
      D.expandDependencies(
        [
          { predecessorId: 1, successorId: 3, lagDays: 0 },
          { predecessorId: 11, successorId: 3, lagDays: 2 },
        ],
        children,
      ),
    ),
    ["3 waits on 11 +2", "3 waits on 12"],
  );

  assert.equal(D.inSameLine(2, 221, children), true);
  assert.equal(D.inSameLine(221, 2, children), true);
  assert.equal(D.inSameLine(21, 221, children), false);

  // A loop hidden in the hierarchy: 2 waits on 1, then a card under 1 is asked to wait on a card under 2.
  const stored = [{ predecessorId: 1, successorId: 2, lagDays: 0 }];
  assert.equal(D.wouldLoop(stored, { predecessorId: 221, successorId: 11, lagDays: 0 }, children), true);
  assert.equal(D.wouldLoop(stored, { predecessorId: 3, successorId: 11, lagDays: 0 }, children), false);
  assert.equal(D.wouldLoop(stored, { predecessorId: 2, successorId: 1, lagDays: 0 }, children), true);

  // The same two refusals through the service, in words.
  const p = await createProject(db, ana, { key: "UNDER", name: "Dependencies and parents" });
  const make = (title: string, extra: Partial<Parameters<typeof createTask>[2]> = {}) =>
    createTask(db, ana, { projectId: p.id, title, ...extra });
  const fa = await make("Feature A", { kind: "feature" });
  const fb = await make("Feature B", { kind: "feature" });
  const a1 = await make("a1", { parentTaskId: fa.id });
  const b1 = await make("b1", { parentTaskId: fb.id });
  await refuses(() => addDependency(db, ana, fa.id, a1.id), "invalid", /sit one under the other/);
  await addDependency(db, ana, fa.id, fb.id);
  await refuses(() => addDependency(db, ana, b1.id, a1.id), "invalid", /through the cards under them/);
  await addDependency(db, ana, a1.id, b1.id); // the same direction as the features: allowed

  // A loop that is already there, with no candidate link: what a move is checked against.
  assert.equal(D.hasLoop(stored, children), false);
  assert.equal(D.hasLoop([...stored, { predecessorId: 221, successorId: 11, lagDays: 0 }], children), true);

  // Moving a card under another is checked the same way as adding a link.
  const story = await make("Story", { kind: "story" });
  const waiter = await make("waits on the story");
  await addDependency(db, ana, story.id, waiter.id);
  await refuses(
    () => updateTask(db, ana, waiter.id, { parentTaskId: story.id }),
    "invalid",
    /UNDER-6 waits on UNDER-5, and this move would put one under the other/,
  );
  // x waits on b1, and b1 waits on everything under Feature A, so x cannot go under Feature A.
  const x = await make("x");
  await addDependency(db, ana, b1.id, x.id);
  await refuses(() => updateTask(db, ana, x.id, { parentTaskId: fa.id }), "invalid", /wait on each other in a loop/);
  await updateTask(db, ana, x.id, { parentTaskId: fb.id }); // beside b1: no loop
  const free = await make("free");
  await updateTask(db, ana, free.id, { parentTaskId: fa.id }); // no links at all: always allowed
});

test("timeline: cards run by start date under their parent, and a parent spans the open cards under it", async () => {
  const { layoutTimeline } = await import("../src/modules/tracker/service/timeline");
  const card = (id: number, parentId: number | null, start: string | null, finish: string | null, closed = false) => ({
    id,
    parentId,
    number: id,
    start,
    finish,
    closed,
  });
  const rows = layoutTimeline([
    card(1, null, null, null), // an epic
    card(2, 1, null, null), // a story under it
    card(3, 2, "2026-12-01", "2026-12-04"),
    card(4, 2, "2026-11-18", "2026-11-20"),
    card(5, 1, "2026-11-10", "2026-11-12", true), // finished: no bar, and not part of the span
    card(6, null, "2026-11-16", "2026-11-17"),
    card(7, null, null, null), // not forecast: last
    card(8, 99, "2026-11-25", "2026-11-26"), // its parent is not in the list
  ]);
  assert.deepEqual(
    rows.map((r) => [r.id, r.depth, r.isParent, r.start, r.finish]),
    [
      [6, 0, false, "2026-11-16", "2026-11-17"],
      [1, 0, true, "2026-11-18", "2026-12-04"],
      [2, 1, true, "2026-11-18", "2026-12-04"],
      [4, 2, false, "2026-11-18", "2026-11-20"],
      [3, 2, false, "2026-12-01", "2026-12-04"],
      [5, 1, false, null, null],
      [8, 0, false, "2026-11-25", "2026-11-26"],
      [7, 0, false, null, null],
    ],
  );
});

test("a parent's own hours are flagged as not counted, and can be cleared", async () => {
  const { getTaskDetail } = await import("../src/modules/tracker/service/task-detail");
  const { getBoard, uncountedHours } = await import("../src/modules/tracker/service/queries");
  const { clearOwnHours } = await import("../src/modules/tracker/service/tasks");
  const p = await createProject(db, ana, { key: "OWN", name: "Own hours" });

  // A sized card becomes an Epic. Nothing sits under it yet, so its hours are still the work.
  const big = await createTask(db, ana, { projectId: p.id, title: "Big", kind: "task", effortEstimateHours: 60 });
  await updateTask(db, ana, big.id, { kind: "epic", remainingEffortHours: 48 });
  const card = async (key: string) => (await getBoard(db, ana, "OWN")).tasks.find((c) => c.key === key)!;
  assert.equal((await card("OWN-1")).uncountedHours, null);
  await refuses(() => clearOwnHours(db, ana, big.id), "invalid", /its hours are the work/);

  // A card goes under it: from now on the forecast uses that card's hours, and the screens say so.
  const part = await createTask(db, ana, {
    projectId: p.id,
    title: "Part",
    parentTaskId: big.id,
    effortEstimateHours: 6,
  });
  assert.equal((await card("OWN-1")).uncountedHours, 48, "hours left, when entered, over the estimate");
  assert.equal((await card("OWN-2")).uncountedHours, null);
  assert.equal((await getTaskDetail(db, ana, "OWN", big.number)).uncountedHours, 48);

  await refuses(() => clearOwnHours(db, cal, big.id), "forbidden");
  await clearOwnHours(db, ana, big.id);
  const after = await getTaskDetail(db, ana, "OWN", big.number);
  assert.deepEqual([after.uncountedHours, after.estimateHours, after.remainingHours], [null, null, null]);
  assert.ok(
    after.history.some((h) => h.what === "Estimate changed from 60 h to nothing" && /cards under it/.test(h.why ?? "")),
  );
  assert.equal((await getTaskDetail(db, ana, "OWN", part.number)).estimateHours, 6, "the card under it is untouched");

  // Only an open parent with hours is flagged.
  assert.equal(uncountedHours(true, "in_progress", null, 18), 18);
  assert.equal(uncountedHours(true, "done", 18, 18), null);
  assert.equal(uncountedHours(false, "todo", 18, 18), null);
  assert.equal(uncountedHours(true, "todo", 0, 18), null, "hours left of zero means nothing is left to count");
});

test("a parent knows how many open work cards under it have no estimate", async () => {
  const { unsizedUnder, getBoard } = await import("../src/modules/tracker/service/queries");
  const { getTaskDetail } = await import("../src/modules/tracker/service/task-detail");
  const n = unsizedUnder([
    { id: 1, parentId: null, open: true, sized: false }, // a parent: never counted itself
    { id: 2, parentId: 1, open: true, sized: false },
    { id: 3, parentId: 1, open: true, sized: true },
    { id: 4, parentId: 1, open: false, sized: false }, // finished: nothing left to estimate
    { id: 5, parentId: 1, open: true, sized: false }, // a parent in the middle
    { id: 6, parentId: 5, open: true, sized: false },
  ]);
  assert.deepEqual([n.get(1), n.get(5), n.has(2)], [2, 1, false]);

  const p = await createProject(db, ana, { key: "SIZE", name: "Sizes" });
  const top = await createTask(db, ana, { projectId: p.id, title: "Top", kind: "story", effortEstimateHours: 30 });
  await createTask(db, ana, { projectId: p.id, title: "Sized", parentTaskId: top.id, effortEstimateHours: 6 });
  await createTask(db, ana, { projectId: p.id, title: "Not sized", parentTaskId: top.id });
  await createTask(db, ana, { projectId: p.id, title: "A date", parentTaskId: top.id, type: "milestone" });
  const card = (await getBoard(db, ana, "SIZE")).tasks.find((c) => c.key === "SIZE-1")!;
  assert.deepEqual([card.uncountedHours, card.rollup?.remainingHours, card.unsizedUnder], [30, 6, 1]);
  const page = await getTaskDetail(db, ana, "SIZE", top.number);
  assert.deepEqual([page.uncountedHours, page.rollup?.remainingHours, page.unsizedUnder], [30, 6, 1]);
});

test("every card has a kind: Task unless chosen, and a milestone is a kind with no hours", async () => {
  const { getTaskDetail } = await import("../src/modules/tracker/service/task-detail");
  const p = await createProject(db, ana, { key: "KIND", name: "Kinds" });
  const kindOf = async (id: number) =>
    (await rows<{ kind: string; type: string }>(`SELECT kind, type::text FROM tracker.task WHERE id = $1`, [id]))[0]!;

  const plain = await createTask(db, ana, { projectId: p.id, title: "Plain" });
  assert.deepEqual(await kindOf(plain.id), { kind: "task", type: "task" });
  assert.equal((await getTaskDetail(db, ana, "KIND", plain.number)).kindLabel, "Task");

  // Asked for either way, a milestone is both the kind and the type.
  const byType = await createTask(db, ana, { projectId: p.id, title: "By type", type: "milestone" });
  const byKind = await createTask(db, ana, { projectId: p.id, title: "By kind", kind: "milestone" });
  assert.deepEqual(await kindOf(byType.id), { kind: "milestone", type: "milestone" });
  assert.deepEqual(await kindOf(byKind.id), { kind: "milestone", type: "milestone" });
  await refuses(
    () => createTask(db, ana, { projectId: p.id, title: "x", kind: "milestone", effortEstimateHours: 6 }),
    "invalid",
    /milestone carries no effort/,
  );

  // A card with hours cannot become a milestone until they are cleared; then its type follows.
  const sized = await createTask(db, ana, { projectId: p.id, title: "Sized", effortEstimateHours: 6 });
  await refuses(() => updateTask(db, ana, sized.id, { kind: "milestone" }), "invalid", /carries no hours/);
  await updateTask(db, ana, sized.id, { kind: "milestone", effortEstimateHours: null });
  assert.deepEqual(await kindOf(sized.id), { kind: "milestone", type: "milestone" });
  await refuses(
    () => updateTask(db, ana, sized.id, { remainingEffortHours: 3 }),
    "invalid",
    /milestone carries no effort/,
  );

  // And back: once it is a Task again it can carry hours, in the same change.
  await updateTask(db, ana, sized.id, { kind: "task", effortEstimateHours: 12 });
  assert.deepEqual(await kindOf(sized.id), { kind: "task", type: "task" });

  // The database refuses a card with no kind, and keeps kind and type in step by itself.
  await assert.rejects(() => pg.query(`UPDATE tracker.task SET kind = NULL WHERE id = $1`, [plain.id]), /null value/);
  await pg.query(`UPDATE tracker.task SET type = 'milestone' WHERE id = $1`, [plain.id]);
  assert.deepEqual(await kindOf(plain.id), { kind: "milestone", type: "milestone" });
});

test("who wants a card can change and is logged; who made it cannot", async () => {
  const { getTaskDetail } = await import("../src/modules/tracker/service/task-detail");
  const p = await createProject(db, ana, { key: "WHO", name: "Who" });
  await setProjectMember(db, ana, p.id, ben.personId, "contributor");

  // Made for oneself: both are the same person.
  const own = await createTask(db, ana, { projectId: p.id, title: "Own" });
  let d = await getTaskDetail(db, ana, "WHO", own.number);
  assert.ok(d.requestedByName.startsWith("Ana") && d.createdByName.startsWith("Ana"));
  assert.equal(d.requestedByPersonId, ana.personId);
  assert.match(d.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  // Made on someone's behalf: the requester is them, the creator is still whoever made it.
  const forCal = await createTask(db, ben, { projectId: p.id, title: "For Cal", requestedByPersonId: cal.personId });
  d = await getTaskDetail(db, ana, "WHO", forCal.number);
  assert.ok(d.requestedByName.startsWith("Cal") && d.createdByName.startsWith("Ben"));

  // Changed afterwards: logged by name, and the creator does not move.
  await updateTask(db, ana, own.id, { requestedByPersonId: boss.personId }, "it was Boss who asked");
  d = await getTaskDetail(db, ana, "WHO", own.number);
  assert.ok(d.requestedByName.startsWith("Boss") && d.createdByName.startsWith("Ana"));
  const entry = d.history.find((h) => h.what.startsWith("Requested by changed"))!;
  assert.match(entry.what, /^Requested by changed from Ana.* to Boss/);
  assert.equal(entry.why, "it was Boss who asked");
  await updateTask(db, ana, own.id, { requestedByPersonId: boss.personId });
  assert.equal(
    (await getTaskDetail(db, ana, "WHO", own.number)).history.filter((h) => h.what.startsWith("Requested by")).length,
    1,
    "setting the same person again is not a change",
  );

  await refuses(() => updateTask(db, ana, own.id, { requestedByPersonId: 999_999 }), "invalid", /not in the tracker/);
  await refuses(
    () => createTask(db, ana, { projectId: p.id, title: "x", requestedByPersonId: 999_999 }),
    "invalid",
    /not in the tracker/,
  );
  // The database itself refuses to rewrite who made a card.
  await assert.rejects(
    () => pg.query(`UPDATE tracker.task SET created_by_person_id = $1 WHERE id = $2`, [ben.personId, own.id]),
    /cannot be changed/,
  );
});

test("a card can wait on a card in another project the person can see, and the projects show as linked", async () => {
  const { getTaskDetail } = await import("../src/modules/tracker/service/task-detail");
  const { getPortfolioTimeline } = await import("../src/modules/tracker/service/timeline");
  const xa = await createProject(db, ana, { key: "XA", name: "Supplies" });
  const xb = await createProject(db, ana, { key: "XB", name: "Needs" });
  await setProjectMember(db, ana, xb.id, ben.personId, "contributor"); // Ben is on XB only
  const a1 = await createTask(db, ana, { projectId: xa.id, title: "Firmware released", kind: "milestone" });
  const b1 = await createTask(db, ana, { projectId: xb.id, title: "Install firmware" });

  // Ben may change XB's cards but cannot see XA, so to him XA's card does not exist.
  await refuses(() => addDependency(db, ben, a1.id, b1.id), "not_found");
  const benBefore = await getTaskDetail(db, ben, "XB", b1.number);
  assert.ok(
    benBefore.candidates.every((c) => c.projectKey !== "XA"),
    "cards in a project he cannot see are not offered",
  );

  // Ana is on both: the other project's cards are offered, after this project's own.
  const anaBefore = await getTaskDetail(db, ana, "XB", b1.number);
  assert.ok(anaBefore.candidates.some((c) => c.key === "XA-1" && c.projectKey === "XA"));
  await addDependency(db, ana, a1.id, b1.id);

  const anaAfter = await getTaskDetail(db, ana, "XB", b1.number);
  assert.deepEqual(
    anaAfter.waitsOn.map((l) => [l.key, l.title, l.canOpen]),
    [["XA-1", "Firmware released", true]],
  );
  // Ben sees that the card waits, since that moves its dates, but not what the other card says.
  const benAfter = await getTaskDetail(db, ben, "XB", b1.number);
  assert.deepEqual(
    benAfter.waitsOn.map((l) => [l.key, l.title, l.canOpen]),
    [["XA-1", "a card in a project you cannot open", false]],
  );

  // All projects on one timeline: a row each, and XB waits on XA.
  const forAna = await getPortfolioTimeline(db, ana);
  assert.ok(forAna.rows.some((r) => r.key === "XA") && forAna.rows.some((r) => r.key === "XB"));
  assert.ok(forAna.links.some((l) => l.fromId === xa.id && l.toId === xb.id));
  const row = forAna.rows.find((r) => r.key === "XB")!;
  assert.deepEqual(
    [row.depth, row.isParent, row.title, row.start, row.unscheduledReason],
    [0, false, "Needs", null, "project has no stack rank"],
  );
  const forBen = await getPortfolioTimeline(db, ben);
  assert.ok(!forBen.rows.some((r) => r.key === "XA"), "a project he is not on is not a row");
  assert.ok(!forBen.links.some((l) => l.fromId === xa.id), "nor is a link to it shown");

  // Once the waiting card is finished the projects are no longer linked.
  await changeStatus(db, ana, b1.id, await statusId(xb.id, "Done"));
  assert.ok(!(await getPortfolioTimeline(db, ana)).links.some((l) => l.fromId === xa.id && l.toId === xb.id));

  await refuses(() => createProject(db, ana, { key: "timeline", name: "x" }), "invalid", /reserved/);
});

test("stack rank: a project moves up, down or to a rank, and the others close up around it", async () => {
  const { moveProjectRank } = await import("../src/modules/tracker/service/projects");
  // Start from a known ranking of three fresh projects, whatever earlier tests left behind.
  await pg.query(`UPDATE tracker.project SET portfolio_rank = NULL WHERE state <> 'active'`);
  await pg.query(`UPDATE tracker.project SET state = 'planned', portfolio_rank = NULL`);
  const ids: number[] = [];
  for (const key of ["RK1", "RK2", "RK3"]) ids.push((await createProject(db, ana, { key, name: key })).id);
  const [one, two, three] = ids as [number, number, number];
  const order = async () =>
    (
      await rows<{ key: string }>(
        `SELECT key FROM tracker.project WHERE portfolio_rank IS NOT NULL ORDER BY portfolio_rank`,
      )
    ).map((r) => r.key);
  const ranksOf = async () =>
    (
      await rows<{ portfolio_rank: number }>(
        `SELECT portfolio_rank FROM tracker.project WHERE portfolio_rank IS NOT NULL ORDER BY portfolio_rank`,
      )
    ).map((r) => Number(r.portfolio_rank));

  // Typing a rank: the first becomes 1, a later one typed as 1 pushes it down.
  await moveProjectRank(db, boss, one, 1);
  await moveProjectRank(db, boss, two, 1);
  await moveProjectRank(db, boss, three, 99); // past the end: it goes last
  assert.deepEqual(await order(), ["RK2", "RK1", "RK3"]);
  assert.deepEqual(await ranksOf(), [1, 2, 3], "no gaps, no clashes");

  await moveProjectRank(db, boss, three, "up");
  assert.deepEqual(await order(), ["RK2", "RK3", "RK1"]);
  await moveProjectRank(db, boss, two, "down");
  assert.deepEqual(await order(), ["RK3", "RK2", "RK1"]);
  await moveProjectRank(db, boss, three, "up"); // already first: nothing happens
  await moveProjectRank(db, boss, one, "down"); // already last
  assert.deepEqual(await order(), ["RK3", "RK2", "RK1"]);

  // Taking one out closes the gap.
  await moveProjectRank(db, boss, two, null);
  assert.deepEqual(
    [await order(), await ranksOf()],
    [
      ["RK3", "RK1"],
      [1, 2],
    ],
  );
  await refuses(() => moveProjectRank(db, boss, two, "up"), "invalid", /no stack rank yet/);

  // Asking first: who holds a rank, and what taking it would move. Asking changes nothing.
  const { rankClash } = await import("../src/modules/tracker/service/projects");
  assert.deepEqual(await rankClash(db, boss, two, 1), {
    holderKey: "RK3",
    holderName: "RK3",
    moved: 2,
    direction: "down",
  });
  assert.deepEqual(await rankClash(db, boss, two, 2), {
    holderKey: "RK1",
    holderName: "RK1",
    moved: 1,
    direction: "down",
  });
  assert.equal(await rankClash(db, boss, two, 3), null, "a free rank needs no question");
  assert.equal(await rankClash(db, boss, three, 1), null, "nor does the rank it already has");
  assert.deepEqual(
    await rankClash(db, boss, three, 2),
    { holderKey: "RK1", holderName: "RK1", moved: 1, direction: "up" },
    "moving down the list pulls the ones it passes up",
  );
  await refuses(() => rankClash(db, ana, two, 1), "forbidden");
  assert.deepEqual(await order(), ["RK3", "RK1"]);

  // Each project whose rank changed has it in its change log.
  const log = await rows<{ old_value: string | null; new_value: string | null }>(
    `SELECT old_value, new_value FROM tracker.project_change_log WHERE project_id = $1 AND field = 'portfolio_rank' ORDER BY id`,
    [one],
  );
  assert.deepEqual(
    log.map((l) => [l.old_value, l.new_value]),
    [
      [null, "1"],
      ["1", "2"],
      ["2", "3"],
      ["3", "2"],
    ],
  );

  await refuses(() => moveProjectRank(db, ana, one, 1), "forbidden");
  await refuses(() => moveProjectRank(db, boss, one, 0), "invalid");
});

test("checklist: add, tick, reword, reorder and remove; shown on the card and counted on the board", async () => {
  const { getTaskDetail } = await import("../src/modules/tracker/service/task-detail");
  const { getBoard } = await import("../src/modules/tracker/service/queries");
  const { addChecklistItem, moveChecklistItem, removeChecklistItem, renameChecklistItem, setChecklistItemDone } =
    await import("../src/modules/tracker/service/checklist");
  const [p] = await rows<{ id: number }>(`SELECT id FROM tracker.project WHERE key = 'PPL'`);
  const projectId = Number(p!.id);
  const card = await createTask(db, ana, { projectId, title: "Card with a checklist", remainingEffortHours: 4 });
  const list = async () => (await getTaskDetail(db, cal, "PPL", card.number)).checklist;

  const a = await addChecklistItem(db, ben, card.id, "  Order   parts ");
  const b = await addChecklistItem(db, ben, card.id, "Book the crane");
  const c = await addChecklistItem(db, ana, card.id, "Tell the customer");
  assert.deepEqual(
    (await list()).map((i) => [i.body, i.done]),
    [
      ["Order parts", false],
      ["Book the crane", false],
      ["Tell the customer", false],
    ],
    "kept in the order added, with stray spaces tidied",
  );

  await refuses(() => addChecklistItem(db, cal, card.id, "viewers cannot add"), "forbidden");
  await refuses(() => addChecklistItem(db, ben, card.id, "   "), "invalid");
  await refuses(() => addChecklistItem(db, ben, card.id, "x".repeat(501)), "invalid", /too long/);
  await refuses(() => setChecklistItemDone(db, cal, a, true), "forbidden");
  await refuses(() => setChecklistItemDone(db, ben, 999_999, true), "not_found");

  // Ticking records who did it. Ticking again does not overwrite that.
  await setChecklistItemDone(db, ben, b, true);
  await setChecklistItemDone(db, ana, b, true);
  let items = await list();
  assert.deepEqual([items[1]!.done, items[1]!.doneBy?.startsWith("Ben")], [true, true]);
  assert.ok(items[1]!.doneAt && /^\d{4}-\d{2}-\d{2}T/.test(items[1]!.doneAt));

  await moveChecklistItem(db, ben, c, "up");
  await moveChecklistItem(db, ben, c, "up");
  await moveChecklistItem(db, ben, c, "up"); // already first: nothing happens
  await moveChecklistItem(db, ben, b, "down"); // already last
  await renameChecklistItem(db, ben, a, "Order the parts");
  items = await list();
  assert.deepEqual(
    items.map((i) => [i.body, i.done]),
    [
      ["Tell the customer", false],
      ["Order the parts", false],
      ["Book the crane", true],
    ],
  );

  const onBoard = (await getBoard(db, cal, "PPL")).tasks.find((t) => t.id === card.id)!;
  assert.deepEqual([onBoard.checklistTotal, onBoard.checklistDone], [3, 1]);
  const other = (await getBoard(db, cal, "PPL")).tasks.find((t) => t.id !== card.id)!;
  assert.deepEqual([other.checklistTotal, other.checklistDone], [0, 0], "a card with no checklist counts as none");

  await setChecklistItemDone(db, ana, b, false);
  await removeChecklistItem(db, ben, a);
  items = await list();
  assert.deepEqual(
    items.map((i) => [i.body, i.done, i.doneBy]),
    [
      ["Tell the customer", false, null],
      ["Book the crane", false, null],
    ],
  );

  // A checklist is not part of the plan: it leaves no trace in the history and no hours change.
  const d = await getTaskDetail(db, cal, "PPL", card.number);
  assert.ok(!d.history.some((h) => /checklist|crane|parts/i.test(h.what)));
  assert.equal(d.remainingHours, 4);

  // An archived card's checklist is frozen.
  await archiveTask(db, ana, card.id);
  await refuses(() => addChecklistItem(db, ben, card.id, "too late"), "invalid", /archived/);
  await refuses(() => setChecklistItemDone(db, ben, c, true), "invalid", /archived/);
});

test("checklist: a card holds 50 items at most", async () => {
  const { addChecklistItem } = await import("../src/modules/tracker/service/checklist");
  const [p] = await rows<{ id: number }>(`SELECT id FROM tracker.project WHERE key = 'PPL'`);
  const card = await createTask(db, ana, { projectId: Number(p!.id), title: "Long list" });
  for (let i = 1; i <= 50; i++) await addChecklistItem(db, ana, card.id, `Step ${i}`);
  await refuses(() => addChecklistItem(db, ana, card.id, "Step 51"), "invalid", /50 items/);
});

test("checklist: an Epic, Feature or Story takes none; items a card already has survive a change of kind", async () => {
  const { addChecklistItem, removeChecklistItem, setChecklistItemDone } =
    await import("../src/modules/tracker/service/checklist");
  const [p] = await rows<{ id: number }>(`SELECT id FROM tracker.project WHERE key = 'PPL'`);
  const projectId = Number(p!.id);
  const make = (title: string, kind: string) => createTask(db, ana, { projectId, title, kind });

  const { getTaskDetail } = await import("../src/modules/tracker/service/task-detail");
  const epic = await make("An epic", "epic");
  const feature = await make("A feature", "feature");
  const story = await make("A story", "story");
  await refuses(() => addChecklistItem(db, ana, epic.id, "x"), "invalid", /An Epic has no checklist/);
  await refuses(() => addChecklistItem(db, ana, feature.id, "x"), "invalid", /A Feature has no checklist/);
  await refuses(() => addChecklistItem(db, ana, story.id, "x"), "invalid", /A Story has no checklist/);
  for (const kind of ["task", "bug", "issue", "milestone"])
    await addChecklistItem(db, ana, (await make(`A ${kind}`, kind)).id, "allowed here");

  // A task with a checklist that turns out to be a story keeps what it had.
  const card = await make("Grew into a story", "task");
  const kept = await addChecklistItem(db, ana, card.id, "Written while it was a task");
  assert.equal((await getTaskDetail(db, ana, "PPL", card.number)).checklistAllowed, true);
  await updateTask(db, ana, card.id, { kind: "story" }, "it was bigger than it looked");
  const d = await getTaskDetail(db, ana, "PPL", card.number);
  assert.equal(d.checklistAllowed, false);
  assert.deepEqual(
    d.checklist.map((i) => i.body),
    ["Written while it was a task"],
  );
  await refuses(() => addChecklistItem(db, ana, card.id, "one more"), "invalid", /A Story has no checklist/);
  await setChecklistItemDone(db, ana, kept, true);
  await removeChecklistItem(db, ana, kept);
});

test("size: hours left follow a new size until somebody changes them, and clearing the size clears the estimate", async () => {
  const p = await createProject(db, ana, { key: "RESIZE", name: "Resizing" });
  const bucket = async (label: string) =>
    Number((await rows<{ id: number }>(`SELECT id FROM tracker.effort_bucket WHERE label = $1`, [label]))[0]!.id);
  const day = await bucket("1 Day");
  const week = await bucket("1 Week");
  const hoursOf = async (id: number) => {
    const [r] = await rows<{ b: number | null; e: string | null; l: string | null }>(
      `SELECT effort_bucket_id AS b, effort_estimate_hours::float8 AS e, remaining_effort_hours::float8 AS l
         FROM tracker.task WHERE id = $1`,
      [id],
    );
    return [r!.b == null ? null : Number(r!.b), r!.e == null ? null : Number(r!.e), r!.l == null ? null : Number(r!.l)];
  };

  // Hours left never typed: there is nothing to keep in step, the forecast reads the estimate.
  const bare = await createTask(db, ana, { projectId: p.id, title: "Bare", effortBucketId: day });
  await updateTask(db, ana, bare.id, { effortBucketId: week });
  assert.deepEqual(await hoursOf(bare.id), [week, 30, null]);

  // Hours left equal to the estimate were never worked down, so they follow the new size.
  const fresh = await createTask(db, ana, {
    projectId: p.id,
    title: "Fresh",
    effortBucketId: day,
    remainingEffortHours: 6,
  });
  await updateTask(db, ana, fresh.id, { effortBucketId: week });
  assert.deepEqual(await hoursOf(fresh.id), [week, 30, 30]);

  // Hours somebody has changed stay theirs.
  const worked = await createTask(db, ana, {
    projectId: p.id,
    title: "Worked",
    effortBucketId: day,
    remainingEffortHours: 4,
  });
  await updateTask(db, ana, worked.id, { effortBucketId: week });
  assert.deepEqual(await hoursOf(worked.id), [week, 30, 4]);
  // And typing hours left in the same save wins over following the size.
  await updateTask(db, ana, fresh.id, { effortBucketId: day, remainingEffortHours: 2 });
  assert.deepEqual(await hoursOf(fresh.id), [day, 6, 2]);

  // "No estimate yet" clears the size and the hours it stood for.
  await updateTask(db, ana, bare.id, { effortBucketId: null });
  assert.deepEqual(await hoursOf(bare.id), [null, null, null]);
  await updateTask(db, ana, worked.id, { effortBucketId: null });
  assert.deepEqual(await hoursOf(worked.id), [null, null, 4]);
});

test("schema status: the code's list of migrations is the folder's, and a database behind it is named", async () => {
  const S = await import("../src/modules/tracker/service/schema-status");
  const { readdirSync } = await import("node:fs");
  const folder = readdirSync(fileURLToPath(new URL("../db/tracker/migrations/", import.meta.url)))
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  assert.deepEqual([...S.MIGRATIONS], folder, "add each new migration file to MIGRATIONS in schema-status.ts");

  // No record at all: what a database older than 0008 looks like to the app.
  const fresh: Database = {
    transaction: (fn) => pg.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })) as never,
  };
  assert.deepEqual(await S.getSchemaStatus(fresh), { current: false, missing: null });
  assert.match(S.schemaBehindDetail({ missing: null }), /at least 0008_migration_record_readable\.sql is missing/);

  await pg.exec(
    `CREATE TABLE public.tracker_schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  for (const name of S.MIGRATIONS.slice(0, -2)) {
    await pg.query(`INSERT INTO public.tracker_schema_migration (name) VALUES ($1)`, [name]);
  }
  const behind = await S.getSchemaStatus(fresh);
  assert.deepEqual(behind, { current: false, missing: S.MIGRATIONS.slice(-2) });
  assert.ok(
    S.schemaBehindDetail(behind as { missing: string[] }).startsWith(`Missing: ${S.MIGRATIONS.slice(-2).join(", ")}.`),
  );

  for (const name of S.MIGRATIONS.slice(-2)) {
    await pg.query(`INSERT INTO public.tracker_schema_migration (name) VALUES ($1)`, [name]);
  }
  assert.deepEqual(await S.getSchemaStatus(fresh), { current: true });
  // A yes is remembered: the record is not read again for this connection.
  await pg.exec(`DROP TABLE public.tracker_schema_migration`);
  assert.deepEqual(await S.getSchemaStatus(fresh), { current: true });
});

test("forecast: a simulation is worked out before the lock is taken, and redone when the plan changes under it", async () => {
  const p = await createProject(db, ana, { key: "AHEAD", name: "Simulated ahead" });
  await setPortfolioRanks(db, boss, [{ projectId: p.id, rank: 50 }]);
  await updateProject(db, ana, p.id, { state: "active" });
  const card = await createTask(db, ana, { projectId: p.id, title: "Work", assigneePersonId: ana.personId });
  await updateTask(db, ana, card.id, { remainingEffortHours: 12 });

  // What each transaction of a run did, in order, and a chance to change the plan between them.
  const seen: string[] = [];
  let between: (() => Promise<void>) | null = null;
  const watched: Database = {
    transaction: async (fn) => {
      const result = await db.transaction((tx) =>
        fn({
          query: (sql, params) => {
            if (/pg_advisory_xact_lock/.test(sql)) seen.push("lock");
            if (/INSERT INTO tracker\.schedule_run/.test(sql)) seen.push("write");
            return tx.query(sql, params);
          },
        }),
      );
      if (!seen.at(-1)?.startsWith("w")) seen.push(seen.at(-1) === "lock" ? "gave up" : "read");
      const change = between;
      between = null;
      if (change) await change();
      return result;
    },
  };
  const safeDate = async () =>
    (
      await rows<{ d: string | null }>(`SELECT p80_finish::text AS d FROM tracker.task_forecast WHERE task_id = $1`, [
        card.id,
      ])
    )[0]!.d;

  // Nothing changes meanwhile: one read with no lock, then one locked write.
  await runForecast(watched, { asOf: "2026-11-11", triggeredBy: "manual", simulations: 30 });
  assert.deepEqual(seen, ["read", "lock", "write"]);
  const short = await safeDate();
  assert.ok(
    short,
    `the simulation stored a safe date: ${JSON.stringify(await rows(`SELECT * FROM tracker.task_forecast WHERE task_id = $1`, [card.id]))}`,
  );

  // The plan changes while the simulation runs: that answer is thrown away and worked out again.
  seen.length = 0;
  between = async () => void (await updateTask(db, ana, card.id, { remainingEffortHours: 120 }));
  await runForecast(watched, { asOf: "2026-11-11", triggeredBy: "manual", simulations: 30 });
  assert.deepEqual(seen, ["read", "lock", "gave up", "read", "lock", "write"]);
  const long = await safeDate();
  assert.ok(long && long > short, `the stored safe date is for the plan as it now is (${short} -> ${long})`);

  // A quick run reads and writes once, under the lock, as before.
  seen.length = 0;
  await runForecast(watched, { asOf: "2026-11-11", triggeredBy: "change" });
  assert.deepEqual(seen, ["lock", "write"]);
});

test("archive: a card with cards under it stays; archiving removes its links and says so on the cards that waited", async () => {
  const p = await createProject(db, ana, { key: "ARCH", name: "Archiving" });
  const story = await createTask(db, ana, { projectId: p.id, title: "Story", kind: "story" });
  const child = await createTask(db, ana, { projectId: p.id, title: "Child", parentTaskId: story.id });
  const first = await createTask(db, ana, { projectId: p.id, title: "First" });
  const waiter = await createTask(db, ana, { projectId: p.id, title: "Waits" });
  await addDependency(db, ana, first.id, waiter.id);
  await addDependency(db, ana, child.id, first.id);

  await refuses(() => archiveTask(db, ana, story.id), "invalid", /has 1 card under it\. Move or archive it first/);

  await archiveTask(db, ana, first.id);
  const links = await rows(
    `SELECT 1 FROM tracker.task_dependency WHERE predecessor_task_id = $1 OR successor_task_id = $1`,
    [first.id],
  );
  assert.equal(links.length, 0);
  const said = await rows<{ old_value: string; reason: string }>(
    `SELECT old_value, reason FROM tracker.task_change_log
      WHERE task_id = $1 AND field = 'dependency' AND new_value IS NULL`,
    [waiter.id],
  );
  assert.deepEqual(said, [{ old_value: "waits on ARCH-3", reason: "ARCH-3 was archived" }]);

  // Once the card under it is gone, the story can go too.
  await archiveTask(db, ana, child.id);
  await archiveTask(db, ana, story.id);
});

test("project settings: a new owner becomes a manager, and a finished project leaves the forecast", async () => {
  const p = await createProject(db, ana, { key: "SETUP", name: "Settings" });
  await setProjectMember(db, ana, p.id, ben.personId, "viewer");
  await updateProject(db, ana, p.id, { ownerPersonId: ben.personId, targetDate: "2027-01-15" }, "handover");
  const [row] = await rows<{ owner: number; target: string; role: string }>(
    `SELECT p.owner_person_id AS owner, p.target_date::text AS target, m.role
       FROM tracker.project p JOIN tracker.project_member m ON m.project_id = p.id AND m.person_id = p.owner_person_id
      WHERE p.id = $1`,
    [p.id],
  );
  assert.deepEqual([Number(row!.owner), row!.target, row!.role], [ben.personId, "2027-01-15", "manager"]);
  await refuses(() => updateProject(db, ana, p.id, { ownerPersonId: 999999 }), "invalid", /not in the tracker/);

  await setPortfolioRanks(db, boss, [{ projectId: p.id, rank: 61 }]);
  await updateProject(db, ben, p.id, { state: "active" });
  const card = await createTask(db, ben, { projectId: p.id, title: "Open work", assigneePersonId: ben.personId });
  await updateTask(db, ben, card.id, { remainingEffortHours: 6 });
  await runForecast(db, { asOf: "2026-11-11", triggeredBy: "manual" });
  const forecast = () => rows(`SELECT 1 FROM tracker.task_forecast WHERE task_id = $1`, [card.id]);
  assert.equal((await forecast()).length, 1);

  await updateProject(db, ben, p.id, { state: "completed" });
  await runForecast(db, { asOf: "2026-11-11", triggeredBy: "manual" });
  assert.equal((await forecast()).length, 0, "a finished project's open card is no longer forecast");
  const [done] = await rows<{ d: string | null }>(
    `SELECT actual_completion_date::text AS d FROM tracker.project WHERE id = $1`,
    [p.id],
  );
  assert.ok(done!.d, "the day it was finished is recorded");
});

test("justification: a project says why it is worth doing and what it is worth, before it exists and before it is active", async () => {
  const Q = await import("../src/modules/tracker/service/queries");
  const buckets = await Q.listValueBuckets(db);
  assert.deepEqual(
    buckets.map((b) => b.label),
    ["Under $10k a year", "$10k to $50k a year", "$50k to $250k a year", "$250k to $1M a year", "Over $1M a year"],
  );
  const [small, , mid] = buckets;

  // Neither can be left out when a project is created.
  await refuses(
    () =>
      createProjectAsIs(db, ana, {
        doneByDepartmentId: someDepartment,
        forDepartmentId: someDepartment,
        key: "WHY1",
        name: "No reason",
        justification: "   ",
        valueBucketId: mid!.id,
      }),
    "invalid",
    /needs a justification: what it saves, earns or prevents/,
  );
  await refuses(
    () =>
      createProjectAsIs(db, ana, {
        doneByDepartmentId: someDepartment,
        forDepartmentId: someDepartment,
        key: "WHY1",
        name: "No value",
        justification: "Saves two days a month.",
        valueBucketId: null as unknown as number,
      }),
    "invalid",
    /worth to the bottom line in a year/,
  );
  await refuses(
    () =>
      createProjectAsIs(db, ana, {
        doneByDepartmentId: someDepartment,
        forDepartmentId: someDepartment,
        key: "WHY1",
        name: "Bad value",
        justification: "x",
        valueBucketId: 999999,
      }),
    "invalid",
    /worth to the bottom line/,
  );
  const none = await rows(`SELECT 1 FROM tracker.project WHERE key = 'WHY1'`);
  assert.equal(none.length, 0, "a refused project is not created");

  const p = await createProjectAsIs(db, ana, {
    doneByDepartmentId: someDepartment,
    forDepartmentId: someDepartment,
    key: "WHY",
    name: "Roll-up",
    justification: "  Cuts the monthly roll-up from two days to two hours.  ",
    valueBucketId: mid!.id,
  });
  const listed = (await Q.listProjects(db, ana)).find((x) => x.id === p.id)!;
  assert.deepEqual(
    [listed.justification, listed.valueBucketId, listed.valueLabel],
    ["Cuts the monthly roll-up from two days to two hours.", mid!.id, "$50k to $250k a year"],
  );
  const board = await Q.getBoard(db, ana, "WHY");
  assert.equal(board.project.valueLabel, "$50k to $250k a year", "the project page reads the same thing");

  // Both can be changed, with the change kept in the history; the reason cannot be emptied.
  await updateProject(
    db,
    ana,
    p.id,
    { justification: "Saves two days a month.", valueBucketId: small!.id },
    "re-scoped",
  );
  await refuses(() => updateProject(db, ana, p.id, { justification: "" }), "invalid", /needs a justification/);
  const log = await rows<{ field: string; old_value: string; new_value: string; reason: string }>(
    `SELECT field::text, old_value, new_value, reason FROM tracker.project_change_log WHERE project_id = $1 ORDER BY id`,
    [p.id],
  );
  assert.deepEqual(log, [
    {
      field: "justification",
      old_value: "Cuts the monthly roll-up from two days to two hours.",
      new_value: "Saves two days a month.",
      reason: "re-scoped",
    },
    { field: "value", old_value: "$50k to $250k a year", new_value: "Under $10k a year", reason: "re-scoped" },
  ]);
  // Saying the same thing again changes nothing and logs nothing.
  await updateProject(db, ana, p.id, { justification: "Saves two days a month.", valueBucketId: small!.id });
  assert.equal((await rows(`SELECT 1 FROM tracker.project_change_log WHERE project_id = $1`, [p.id])).length, 2);

  // A project made before this was asked for has neither, and cannot be made active until it does.
  const old = await createProject(db, ana, { key: "OLDWHY", name: "From before" });
  await pg.query(`UPDATE tracker.project SET justification = NULL, value_bucket_id = NULL WHERE id = $1`, [old.id]);
  await setPortfolioRanks(db, boss, [{ projectId: old.id, rank: 71 }]);
  await refuses(
    () => updateProject(db, ana, old.id, { state: "active" }),
    "invalid",
    /needs a justification, a yearly value, the department it is for and the department doing the work/,
  );
  await refuses(
    () => updateProject(db, ana, old.id, { state: "active", justification: "Keeps the lights on." }),
    "invalid",
    /before it can be made active/,
  );
  // Given both in the same save, it goes active in one step.
  await updateProject(db, ana, old.id, {
    state: "active",
    justification: "Keeps the lights on.",
    valueBucketId: mid!.id,
  });
  const [now] = await rows<{ state: string }>(`SELECT state::text FROM tracker.project WHERE id = $1`, [old.id]);
  assert.equal(now!.state, "active");
});

test("departments: copied from the roster in two levels, and a project says which one it is for", async () => {
  const Q = await import("../src/modules/tracker/service/queries");
  const T = await import("../src/modules/tracker/service/timeline");

  // The copy is the roster's list, groups first with their teams under them, in the order given.
  const all = await listDepartments(db);
  assert.deepEqual(
    all.map((d) => [d.name, d.groupName, d.parentId == null]),
    [
      ["Company-wide", "Company-wide", true],
      ["Project Management", "Project Management", true],
      ["Engineering", "Engineering", true],
      ["Mechanical Engineering", "Engineering", false],
      ["Controls Engineering", "Engineering", false],
      ["Support", "Support", true],
      ["Finance", "Support", false],
      ["Human Resources", "Support", false],
    ],
  );
  const id = (code: string) => all.find((d) => d.code === code)!.id;
  // A group covers its teams; a team covers only itself.
  assert.deepEqual(
    [...departmentScope(all, id("group:engineering"))].sort(),
    [id("group:engineering"), id("mech"), id("controls")].sort(),
  );
  assert.deepEqual([...departmentScope(all, id("mech"))], [id("mech")]);

  // Copying the same list again writes nothing.
  const before = await rows<{ x: string }>(`SELECT string_agg(xmin::text, ',' ORDER BY id) AS x FROM tracker.team`);
  await syncDepartments(db, ORG);
  const after = await rows<{ x: string }>(`SELECT string_agg(xmin::text, ',' ORDER BY id) AS x FROM tracker.team`);
  assert.equal(after[0]!.x, before[0]!.x, "an unchanged roster touches no row");

  // A project cannot be made without one, or with one that is not in use.
  const asked = { justification: "Saves time.", valueBucketId: someValue };
  await refuses(
    () =>
      createProjectAsIs(db, ana, {
        doneByDepartmentId: someDepartment,
        key: "DEPT0",
        name: "x",
        ...asked,
        forDepartmentId: null as unknown as number,
      }),
    "invalid",
    /Choose the department the project is for/,
  );
  await refuses(
    () =>
      createProjectAsIs(db, ana, {
        doneByDepartmentId: someDepartment,
        key: "DEPT0",
        name: "x",
        ...asked,
        forDepartmentId: 999999,
      }),
    "invalid",
    /Choose the department/,
  );

  const fin = await createProjectAsIs(db, ana, {
    doneByDepartmentId: someDepartment,
    key: "DEPTF",
    name: "Close faster",
    ...asked,
    forDepartmentId: id("finance"),
  });
  const eng = await createProjectAsIs(db, ana, {
    doneByDepartmentId: someDepartment,
    key: "DEPTE",
    name: "Drawing checks",
    ...asked,
    forDepartmentId: id("mech"),
  });
  const wide = await createProjectAsIs(db, ana, {
    doneByDepartmentId: someDepartment,
    key: "DEPTW",
    name: "Warehouse",
    ...asked,
    forDepartmentId: id("company"),
  });
  const mine = (await Q.listProjects(db, ana)).filter((p) => [fin.id, eng.id, wide.id].includes(p.id));
  assert.deepEqual(mine.map((p) => [p.key, p.forDepartmentName, p.forGroupName]).sort(), [
    ["DEPTE", "Mechanical Engineering", "Engineering"],
    ["DEPTF", "Finance", "Support"],
    ["DEPTW", "Company-wide", "Company-wide"],
  ]);

  // Changing it is kept in the history, by name.
  await updateProject(db, ana, eng.id, { forDepartmentId: id("group:engineering") }, "both teams use it");
  const log = await rows<{ old_value: string; new_value: string; reason: string }>(
    `SELECT old_value, new_value, reason FROM tracker.project_change_log
      WHERE project_id = $1 AND field = 'for_department'`,
    [eng.id],
  );
  assert.deepEqual(log, [
    { old_value: "Mechanical Engineering", new_value: "Engineering", reason: "both teams use it" },
  ]);

  // A project from before this was asked for cannot be made active without one.
  const old = await createProject(db, ana, { key: "DEPTO", name: "From before" });
  await pg.query(`UPDATE tracker.project SET for_team_id = NULL WHERE id = $1`, [old.id]);
  await setPortfolioRanks(db, boss, [{ projectId: old.id, rank: 81 }]);
  await refuses(
    () => updateProject(db, ana, old.id, { state: "active" }),
    "invalid",
    /the department it is for and the department doing the work before/,
  );
  await updateProject(db, ana, old.id, { state: "active", forDepartmentId: id("hr") });

  // The timeline of all projects: filtered to a department, and gathered under one row each.
  const keysOf = (t: { rows: { key: string; title: string; depth: number; isParent: boolean }[] }) =>
    t.rows.filter((r) => ["DEPTF", "DEPTE", "DEPTW", "DEPTO"].includes(r.key) || r.isParent);
  const support = await T.getPortfolioTimeline(db, ana, { scope: departmentScope(all, id("group:support")) });
  assert.deepEqual(
    support.rows.map((r) => r.key).sort(),
    ["DEPTF", "DEPTO"],
    "a group's filter finds its teams' projects",
  );
  assert.ok(
    support.rows.every((r) => r.depth === 0 && !r.isParent),
    "ungrouped rows are flat",
  );

  const grouped = await T.getPortfolioTimeline(db, ana, {
    scope: new Set([id("finance"), id("hr"), id("group:engineering"), id("mech"), id("controls")]),
    grouped: true,
  });
  assert.deepEqual(
    keysOf(grouped).map((r) => [r.isParent ? r.title : r.key, r.depth]),
    [
      ["Engineering", 0],
      ["DEPTE", 1],
      ["Support", 0],
      // Rank order inside a department: DEPTO holds a rank, DEPTF does not yet.
      ["DEPTO", 1],
      ["DEPTF", 1],
    ],
    "departments in the company's order, each above its projects",
  );
  assert.ok(
    grouped.rows.filter((r) => r.isParent).every((r) => r.id < 0 && r.key === ""),
    "a department's row is no project",
  );

  // A team the roster drops is switched off, not deleted: the project still says who it was for.
  await syncDepartments(
    db,
    ORG.filter((u) => u.code !== "finance"),
  );
  assert.ok(!(await listDepartments(db)).some((d) => d.code === "finance"), "it is no longer offered");
  assert.equal((await Q.listProjects(db, ana)).find((p) => p.id === fin.id)!.forDepartmentName, "Finance");
  await refuses(
    () => updateProject(db, ana, eng.id, { forDepartmentId: id("finance") }),
    "invalid",
    /Choose the department/,
  );
  await syncDepartments(db, ORG);
  assert.ok(
    (await listDepartments(db)).some((d) => d.code === "finance"),
    "and comes back when the roster has it again",
  );
});

test("ranking inside a department trades the ranks it already holds, and asks before passing another department", async () => {
  const P = await import("../src/modules/tracker/service/projects");
  const F = await import("../src/modules/tracker/components/format");
  const all = await listDepartments(db);
  const id = (code: string) => all.find((d) => d.code === code)!.id;
  const make = async (key: string, dept: string) =>
    (await createProject(db, ana, { key, name: key, forDepartmentId: id(dept) })).id;

  // Engineering holds ranks 201, 202 and 205; Support holds 203 and 204, between them.
  const e1 = await make("RKE1", "mech");
  const e2 = await make("RKE2", "controls");
  const s1 = await make("RKS1", "finance");
  const s2 = await make("RKS2", "hr");
  const e3 = await make("RKE3", "group:engineering");
  await setPortfolioRanks(db, boss, [
    { projectId: e1, rank: 201 },
    { projectId: e2, rank: 202 },
    { projectId: s1, rank: 203 },
    { projectId: s2, rank: 204 },
    { projectId: e3, rank: 205 },
  ]);
  const ranks = async () =>
    Object.fromEntries(
      (
        await rows<{ key: string; r: number }>(
          `SELECT key, portfolio_rank AS r FROM tracker.project WHERE key ~ '^RK[ES][0-9]$' ORDER BY key`,
        )
      ).map((x) => [x.key, Number(x.r)]),
    );

  // Only whoever sets the company's ranks may do this.
  await refuses(() => P.moveProjectRankInDepartment(db, ana, e2, "up"), "forbidden");

  // Mechanical and Controls are both Engineering: neighbours, with nothing between. No question.
  const near = await P.moveProjectRankInDepartment(db, boss, e2, "up");
  assert.deepEqual(near, {
    done: true,
    moved: { key: "RKE2", from: 202, to: 201 },
    other: { key: "RKE1", from: 201, to: 202 },
    passes: 0,
  });
  assert.deepEqual(await ranks(), { RKE1: 202, RKE2: 201, RKE3: 205, RKS1: 203, RKS2: 204 });

  // RKE3 up one place in Engineering means passing both Support projects: nothing changes until confirmed.
  const asked = await P.moveProjectRankInDepartment(db, boss, e3, "up");
  assert.deepEqual(asked, {
    done: false,
    moved: { key: "RKE3", from: 205, to: 202 },
    other: { key: "RKE1", from: 202, to: 205 },
    passes: 2,
  });
  assert.deepEqual(await ranks(), { RKE1: 202, RKE2: 201, RKE3: 205, RKS1: 203, RKS2: 204 }, "asking changes nothing");
  assert.equal(
    F.departmentMoveEffect(asked!),
    "RKE3 moves from company rank 205 to 202, ahead of 2 projects of other departments. RKE1 moves to 205.",
  );

  const done = await P.moveProjectRankInDepartment(db, boss, e3, "up", true);
  assert.equal(done!.done, true);
  // Engineering still holds 201, 202 and 205; Support's two never moved.
  assert.deepEqual(await ranks(), { RKE1: 205, RKE2: 201, RKE3: 202, RKS1: 203, RKS2: 204 });

  // At the top or bottom of its department there is nowhere to go.
  assert.equal(await P.moveProjectRankInDepartment(db, boss, e2, "up"), null);
  assert.equal(await P.moveProjectRankInDepartment(db, boss, e1, "down"), null);
  // Going down says "behind".
  const down = await P.moveProjectRankInDepartment(db, boss, e3, "down");
  assert.match(
    F.departmentMoveEffect(down!),
    /RKE3 moves from company rank 202 to 205, behind 2 projects of other departments/,
  );

  // A project with no rank is given one in the full list first.
  const unranked = await make("RKE4", "mech");
  await refuses(() => P.moveProjectRankInDepartment(db, boss, unranked, "up"), "invalid", /no stack rank yet/);
});

test("dropping a project at another's place in its department rearranges only that department's ranks", async () => {
  const P = await import("../src/modules/tracker/service/projects");
  const F = await import("../src/modules/tracker/components/format");
  const all = await listDepartments(db);
  const id = (code: string) => all.find((d) => d.code === code)!.id;
  const make = async (key: string, dept: string) =>
    (await createProject(db, ana, { key, name: key, forDepartmentId: id(dept) })).id;

  // Project Management holds 301, 302, 305 and 306; Finance holds 303 and 304, between them.
  const a = await make("DRA", "pm");
  const b = await make("DRB", "pm");
  const x = await make("DRX", "finance");
  const y = await make("DRY", "finance");
  const c = await make("DRC", "pm");
  const d = await make("DRD", "pm");
  await setPortfolioRanks(db, boss, [
    { projectId: a, rank: 301 },
    { projectId: b, rank: 302 },
    { projectId: x, rank: 303 },
    { projectId: y, rank: 304 },
    { projectId: c, rank: 305 },
    { projectId: d, rank: 306 },
  ]);
  const ranks = async () =>
    Object.fromEntries(
      (
        await rows<{ key: string; r: number }>(
          `SELECT key, portfolio_rank AS r FROM tracker.project WHERE key ~ '^DR[A-DXY]$' ORDER BY key`,
        )
      ).map((r) => [r.key, Number(r.r)]),
    );
  const start = { DRA: 301, DRB: 302, DRC: 305, DRD: 306, DRX: 303, DRY: 304 };

  await refuses(() => P.placeProjectInDepartment(db, ana, b, a), "forbidden");
  assert.equal(await P.placeProjectInDepartment(db, boss, a, a), null, "dropped on itself: nothing to do");
  // Another department's project is not a place it can be dropped.
  await refuses(() => P.placeProjectInDepartment(db, boss, a, x), "invalid", /its own department/);

  // B onto A: neighbours with nothing between, so it just happens.
  assert.deepEqual(await P.placeProjectInDepartment(db, boss, b, a), {
    done: true,
    moved: { key: "DRB", from: 302, to: 301 },
    shifted: 1,
    passes: 0,
  });
  assert.deepEqual(await ranks(), { ...start, DRA: 302, DRB: 301 });

  // D to the top of its department passes both Finance projects: asked first, nothing changed.
  const asked = await P.placeProjectInDepartment(db, boss, d, b);
  assert.deepEqual(asked, { done: false, moved: { key: "DRD", from: 306, to: 301 }, shifted: 3, passes: 2 });
  assert.deepEqual(await ranks(), { ...start, DRA: 302, DRB: 301 }, "asking changes nothing");
  assert.equal(
    F.departmentDropEffect(asked!),
    "DRD moves from company rank 306 to 301, ahead of 2 projects of other departments. 3 other projects of its department each move one place to make room.",
  );

  // Confirmed: D takes the top place, B, A and C each slide down one of the department's places.
  assert.equal((await P.placeProjectInDepartment(db, boss, d, b, true))!.done, true);
  assert.deepEqual(await ranks(), { DRD: 301, DRB: 302, DRA: 305, DRC: 306, DRX: 303, DRY: 304 });

  // Downwards the same way: D back to the bottom, onto the project now last.
  const down = await P.placeProjectInDepartment(db, boss, d, c, true);
  assert.deepEqual(down!.moved, { key: "DRD", from: 301, to: 306 });
  assert.deepEqual(await ranks(), { DRB: 301, DRA: 302, DRC: 305, DRD: 306, DRX: 303, DRY: 304 });
  assert.match(F.departmentDropEffect(down!), /to 306, behind 2 projects of other departments/);
  assert.equal(
    F.departmentDropEffect({ moved: { key: "K", from: 2, to: 1 }, shifted: 1, passes: 0 }),
    "K moves from company rank 2 to 1. 1 other project of its department moves one place to make room.",
  );
});

test("a project says which department does the work: asked for when made, logged when changed, needed to go active", async () => {
  const Q = await import("../src/modules/tracker/service/queries");
  const all = await listDepartments(db);
  const id = (code: string) => all.find((d) => d.code === code)!.id;
  const asked = { justification: "Saves time.", valueBucketId: someValue, forDepartmentId: id("mech") };
  await refuses(
    () =>
      createProjectAsIs(db, ana, { key: "DOER0", name: "x", ...asked, doneByDepartmentId: null as unknown as number }),
    "invalid",
    /Choose the department that does the work/,
  );
  await refuses(
    () => createProjectAsIs(db, ana, { key: "DOER0", name: "x", ...asked, doneByDepartmentId: 999999 }),
    "invalid",
    /does the work/,
  );
  const p = await createProjectAsIs(db, ana, {
    key: "DOER",
    name: "Checks",
    ...asked,
    doneByDepartmentId: id("finance"),
  });
  const listed = async () => (await Q.listProjects(db, ana)).find((x) => x.id === p.id)!;
  assert.equal((await listed()).doneByDepartmentName, "Finance");
  assert.equal((await listed()).forDepartmentName, "Mechanical Engineering");

  await updateProject(db, ana, p.id, { doneByDepartmentId: id("hr") }, "moved teams");
  const log = await rows<{ field: string; old_value: string; new_value: string; reason: string }>(
    `SELECT field, old_value, new_value, reason FROM tracker.project_change_log WHERE project_id = $1`,
    [p.id],
  );
  assert.deepEqual(log, [
    { field: "done_by_department", old_value: "Finance", new_value: "Human Resources", reason: "moved teams" },
  ]);

  // A project made before this was asked for cannot go active until it has one.
  await db.transaction((tx) => tx.query(`UPDATE tracker.project SET done_by_team_id = NULL WHERE id = $1`, [p.id]));
  assert.equal((await listed()).doneByDepartmentId, null);
  await setPortfolioRanks(db, boss, [{ projectId: p.id, rank: 91 }]);
  await refuses(() => updateProject(db, ana, p.id, { state: "active" }), "invalid", /the department doing the work/);
  await updateProject(db, ana, p.id, { state: "active", doneByDepartmentId: id("hr") });
});

test("departments by who does the work: the list looks through either, and an unnamed card is forecast on that team", async () => {
  const Q = await import("../src/modules/tracker/service/queries");
  const P = await import("../src/modules/tracker/service/people");
  const { setPeopleDepartments } = await import("../src/modules/tracker/service/departments");
  const all = await listDepartments(db);
  const id = (code: string) => all.find((d) => d.code === code)!.id;
  const p = await createProjectAsIs(db, ana, {
    key: "LENS",
    name: "Lens",
    justification: "Saves time.",
    valueBucketId: someValue,
    forDepartmentId: id("mech"),
    doneByDepartmentId: id("finance"),
  });
  const mine = (await Q.listProjects(db, ana)).filter((x) => x.id === p.id);
  assert.equal(mine[0]!.forGroupName, "Engineering");
  assert.equal(mine[0]!.doneByGroupName, "Support");
  assert.equal(Q.throughLens(mine, "for")[0], mine[0], "for is the list as it is");
  const by = Q.throughLens(mine, "by")[0]!;
  assert.deepEqual(
    [by.forDepartmentId, by.forGroupName, by.doneByDepartmentId, by.forDepartmentName, by.doneByDepartmentName],
    [id("finance"), "Support", id("mech"), "Mechanical Engineering", "Finance"],
    "the fields a list filters and groups on change over; the names shown do not",
  );
  assert.equal(Q.throughLens(mine, "by", "team")[0]!.forGroupName, "Finance", "the department itself, not its group");
  assert.equal(Q.throughLens(mine, "for", "team")[0]!.forGroupName, "Mechanical Engineering");

  // Nobody is named on the card, and nobody is in Finance: it cannot be forecast.
  const card = await createTask(db, ana, { projectId: p.id, title: "Unnamed work", effortEstimateHours: 8 });
  await setPortfolioRanks(db, boss, [{ projectId: p.id, rank: 95 }]);
  const reason = async () =>
    (
      await rows<{ unscheduled_reason: string | null }>(
        `SELECT unscheduled_reason FROM tracker.task_forecast WHERE task_id = $1`,
        [card.id],
      )
    )[0]?.unscheduled_reason;
  await runForecast(db, { asOf: "2026-11-12", triggeredBy: "change" });
  assert.equal(await reason(), "no assignee");

  // Someone joins Finance with hours to give: the card is theirs to do, without being named on it.
  const dee = await ensurePerson(db, { email: "dee@example.test", displayName: "Dee" });
  await setPeopleDepartments(db, [{ email: "DEE@example.test", teamCode: "finance" }]);
  await P.setPersonHours(db, { ...boss, admin: true }, dee, 6);
  await runForecast(db, { asOf: "2026-11-12", triggeredBy: "change" });
  assert.equal(await reason(), null);
  const still = await rows<{ assignee_person_id: number | null }>(
    `SELECT assignee_person_id FROM tracker.task WHERE id = $1`,
    [card.id],
  );
  assert.equal(still[0]!.assignee_person_id, null, "the forecast does not name anyone on the card");
});

test("a card records the day its work started: stamped on the first move into work, and correctable", async () => {
  const p = await createProject(db, ana, { key: "STARTD", name: "Start dates" });
  const t = await createTask(db, ana, { projectId: p.id, title: "Work entered late" });
  const statuses = await rows<{ id: number; category: string }>(
    `SELECT id, category FROM tracker.workflow_status WHERE project_id = $1 ORDER BY id`,
    [p.id],
  );
  const status = (category: string) => Number(statuses.find((s) => s.category === category)!.id);
  const dates = async () =>
    (
      await rows<{ s: string | null; f: string | null }>(
        `SELECT actual_start_date::text AS s, actual_completion_date::text AS f FROM tracker.task WHERE id = $1`,
        [t.id],
      )
    )[0]!;
  assert.deepEqual(await dates(), { s: null, f: null });
  await refuses(
    () => updateTask(db, ana, t.id, { actualCompletionDate: "2026-09-30" }),
    "invalid",
    /Only a finished card/,
  );

  await changeStatus(db, ana, t.id, status("in_progress"));
  const started = (await dates()).s;
  assert.ok(started, "the first move into work stamps the day");
  await changeStatus(db, ana, t.id, status("done"));
  assert.equal((await dates()).s, started, "a later move does not restamp it");

  // The work really happened in September: both dates are put right.
  await updateTask(db, ana, t.id, { actualStartDate: "2026-09-02", actualCompletionDate: "2026-09-30" });
  assert.deepEqual(await dates(), { s: "2026-09-02", f: "2026-09-30" });
  await refuses(() => updateTask(db, ana, t.id, { actualStartDate: "2026-10-05" }), "invalid", /cannot start after/);

  const T = await import("../src/modules/tracker/service/timeline");
  const row = (await T.getTimeline(db, ana, "STARTD")).rows.find((r) => r.id === t.id)!;
  assert.deepEqual([row.startedOn, row.doneOn], ["2026-09-02", "2026-09-30"]);
});

test("a project can say when it started, and the timeline of all projects draws it from then", async () => {
  const T = await import("../src/modules/tracker/service/timeline");
  const p = await createProject(db, ana, { key: "PSTART", name: "Began earlier" });
  const row = async () => (await T.getPortfolioTimeline(db, ana)).rows.find((r) => r.id === p.id)!;
  assert.equal((await row()).startedOn, null, "nothing started, nothing said");

  await refuses(() => updateProject(db, ana, p.id, { startDate: "last spring" }), "invalid");
  await updateProject(db, ana, p.id, { startDate: "2026-04-06" }, "began before it was entered");
  assert.equal((await row()).startedOn, "2026-04-06");
  const log = await rows<{ field: string; new_value: string }>(
    `SELECT field, new_value FROM tracker.project_change_log WHERE project_id = $1`,
    [p.id],
  );
  assert.deepEqual(log, [{ field: "start_date", new_value: "2026-04-06" }]);

  // A card that started earlier still wins; clearing the date hands it back to the cards.
  const t = await createTask(db, ana, { projectId: p.id, title: "Older still" });
  await db.transaction((tx) =>
    tx.query(`UPDATE tracker.task SET actual_start_date = '2026-03-02' WHERE id = $1`, [t.id]),
  );
  assert.equal((await row()).startedOn, "2026-03-02");
  await updateProject(db, ana, p.id, { startDate: null });
  assert.equal((await row()).startedOn, "2026-03-02");
});
