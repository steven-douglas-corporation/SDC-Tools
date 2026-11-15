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
  createProject,
  ensurePerson,
  setPortfolioRanks,
  setProjectMember,
  updateProject,
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

const migration = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../db/tracker/migrations/${name}`, import.meta.url)), "utf8");

let pg: PGlite;
let db: Database;
let ana: Actor, ben: Actor, cal: Actor, boss: Actor;

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
  await pg.exec("RESET search_path");
  db = { transaction: (fn) => pg.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })) as never };

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

test("forecast run: a missing global capacity default is an error, not a silent zero", async () => {
  // Last on purpose: it removes the row every other forecast test relies on.
  await pg.exec(`DELETE FROM tracker.capacity_setting WHERE scope = 'global'`);
  await refuses(
    () => runForecast(db, { asOf: "2026-11-11", triggeredBy: "manual" }),
    "invalid",
    /global capacity default/,
  );
  const runs = await rows(`SELECT 1 FROM tracker.schedule_run WHERE status = 'running'`);
  assert.equal(runs.length, 0, "the refused run leaves nothing behind");
});
