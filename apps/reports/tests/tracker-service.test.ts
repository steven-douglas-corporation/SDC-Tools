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
  await pg.exec(migration("0003_work_kinds.sql"));
  await pg.exec(migration("0004_count_work_cards.sql"));
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
  assert.deepEqual(now.holidays.map((h) => h.date).includes("2026-11-18"), true);

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
  assert.deepEqual([after.ownHoursPerDay, after.hoursPerDay, after.timeOff.length], [null, 6, 0]);

  await P.setGlobalHours(db, admin, 5);
  assert.equal((await P.getCapacityOverview(db, cal)).globalHoursPerDay, 5);
  await P.setGlobalHours(db, admin, 6);
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
  await refuses(() => make("x", { parentTaskId: plain.id }), "invalid", /card with no kind/);
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
      "Kind changed from Task to nothing",
      "No longer under TAX-2",
    ],
  );
  assert.deepEqual([l.kind, l.parentTaskId, l.ancestors.length], [null, null, 0]);

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
      ["TAX-6", null],
    ],
  );

  assert.deepEqual(s.rollup, { cards: 2, done: 0, remainingHours: 18, forecastFinish: null, notForecast: 2 });
  assert.equal(t.rollup, null, "nothing sits under a task");

  // The board: a parent adds up the cards that carry work, however deep; a leaf has no roll-up.
  await changeStatus(db, ana, bug.id, await statusId(projectId, "Done"));
  const board = await getBoard(db, ana, "TAX");
  assert.deepEqual(
    board.kinds.map((k) => k.label),
    ["Epic", "Feature", "Story", "Task", "Bug", "Issue"],
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
      ["AUTO-6", null, "Backlog"],
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
