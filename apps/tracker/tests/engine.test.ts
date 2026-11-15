import { test } from "node:test";
import assert from "node:assert/strict";
import {
  schedule,
  simulate,
  summarize,
  verify,
  toDay,
  fromDay,
  isoWeekday,
  type Inputs,
  type Resource,
  type Result,
  type Scheduled,
  type Task,
} from "../src/forecast/engine.ts";

const AS_OF = "2026-11-11"; // a Wednesday

function sched(out: Map<string, Result>, id: string): Scheduled {
  const r = out.get(id);
  assert.ok(r && r.scheduled, `${id} should be scheduled, got ${JSON.stringify(r)}`);
  return r;
}

function reason(out: Map<string, Result>, id: string): string {
  const r = out.get(id);
  assert.ok(r && !r.scheduled, `${id} should be unscheduled, got ${JSON.stringify(r)}`);
  return r.reason;
}

const person = (id: string, extra: Partial<Resource> = {}): Resource => ({ id, hoursPerDay: 6, ...extra });

// The worked example in section 5 of the 2026-11-11 spec, as produced by forecast_prototype.py.
// 8 hours a day at a 0.75 focus factor is 6 project hours a day.
function specExample(): Inputs {
  return {
    asOf: AS_OF,
    holidays: ["2026-11-26", "2026-11-27"],
    resources: [person("Ana"), person("Ben", { timeOff: [{ start: "2026-11-16", end: "2026-11-17" }] })],
    tasks: [
      { id: "ALPHA-1", project: "ALPHA", projectRank: 1, remainingHours: 30, assignee: "Ana", priority: 1, number: 1 },
      { id: "ALPHA-2", project: "ALPHA", projectRank: 1, remainingHours: 24, assignee: "Ben", priority: 2, number: 2 },
      {
        id: "ALPHA-3",
        project: "ALPHA",
        projectRank: 1,
        remainingHours: 18,
        assignee: "Ana",
        priority: 3,
        number: 3,
        preds: [{ id: "ALPHA-1" }, { id: "ALPHA-2" }],
      },
      { id: "BRAIN-1", project: "BRAIN", projectRank: 2, remainingHours: 36, assignee: "Ana", number: 1 },
      {
        id: "BRAIN-2",
        project: "BRAIN",
        projectRank: 2,
        remainingHours: 30,
        assignee: "Ben",
        number: 2,
        preds: [{ id: "BRAIN-1" }],
      },
      { id: "BRAIN-3", project: "BRAIN", projectRank: 2, remainingHours: 20, assignee: null, number: 3 },
    ],
  };
}

test("date helpers", () => {
  assert.equal(fromDay(toDay("2026-11-11")), "2026-11-11");
  assert.equal(isoWeekday(toDay("2026-11-11")), 3); // Wednesday
  assert.equal(isoWeekday(toDay("2026-11-15")), 7); // Sunday
  assert.equal(isoWeekday(toDay("1969-12-29")), 1); // a Monday before 1970
});

test("matches the Python prototype on the spec's worked example", () => {
  const inputs = specExample();
  const out = schedule(inputs);
  const got = (id: string) => {
    const r = sched(out.results, id);
    return [r.start, r.finish, r.driver, r.driverTask];
  };
  assert.deepEqual(got("ALPHA-1"), ["2026-11-11", "2026-11-17", "start", null]);
  assert.deepEqual(got("ALPHA-2"), ["2026-11-11", "2026-11-18", "start", null]);
  assert.deepEqual(got("ALPHA-3"), ["2026-11-19", "2026-11-23", "predecessor", "ALPHA-2"]);
  assert.deepEqual(got("BRAIN-1"), ["2026-11-18", "2026-12-02", "resource", null]);
  assert.deepEqual(got("BRAIN-2"), ["2026-12-03", "2026-12-09", "predecessor", "BRAIN-1"]);
  assert.equal(reason(out.results, "BRAIN-3"), "no assignee");

  assert.deepEqual(summarize(inputs.tasks, out.results), [
    { project: "ALPHA", finish: "2026-11-23", unscheduledTasks: 0, unscheduledHours: 0, unestimatedTasks: 0 },
    { project: "BRAIN", finish: "2026-12-09", unscheduledTasks: 1, unscheduledHours: 20, unestimatedTasks: 0 },
  ]);
  assert.deepEqual(verify(inputs, out), []);
});

test("priority inheritance: a blocker is scheduled at the priority of what waits on it", () => {
  // In the prototype TOP-1 finished on Dec 10, behind 120 hours of rank-2 work.
  const inputs: Inputs = {
    asOf: AS_OF,
    resources: [person("Ana")],
    tasks: [
      {
        id: "TOP-1",
        project: "TOP",
        projectRank: 1,
        remainingHours: 6,
        assignee: "Ana",
        number: 1,
        preds: [{ id: "LOW-1" }],
      },
      { id: "MID-1", project: "MID", projectRank: 2, remainingHours: 120, assignee: "Ana", number: 1 },
      { id: "LOW-1", project: "LOW", projectRank: 3, remainingHours: 6, assignee: "Ana", number: 1 },
    ],
  };
  const out = schedule(inputs);
  const low = sched(out.results, "LOW-1");
  assert.deepEqual([low.start, low.finish, low.priorityFrom], ["2026-11-11", "2026-11-11", "TOP-1"]);
  assert.equal(sched(out.results, "TOP-1").finish, "2026-11-12");
  assert.equal(sched(out.results, "MID-1").start, "2026-11-13");
  assert.deepEqual(verify(inputs, out), []);
});

test("priority inheritance passes down a chain, and stored priority is untouched", () => {
  const tasks: Task[] = [
    { id: "A", project: "TOP", projectRank: 1, remainingHours: 6, assignee: "Ana", preds: [{ id: "B" }] },
    { id: "B", project: "LOW", projectRank: 5, remainingHours: 6, assignee: "Ana", priority: 4, preds: [{ id: "C" }] },
    { id: "C", project: "LOW", projectRank: 5, remainingHours: 6, assignee: "Ana", priority: 5 },
    { id: "M", project: "MID", projectRank: 2, remainingHours: 60, assignee: "Ana" },
  ];
  const out = schedule({ asOf: AS_OF, resources: [person("Ana")], tasks });
  assert.equal(sched(out.results, "C").priorityFrom, "A");
  assert.equal(sched(out.results, "B").priorityFrom, "A");
  assert.equal(sched(out.results, "A").priorityFrom, null);
  assert.equal(sched(out.results, "A").finish, "2026-11-13");
  assert.equal(tasks[2]!.priority, 5);
});

test("no estimate is unscheduled; a milestone needs neither estimate nor assignee", () => {
  const inputs: Inputs = {
    asOf: AS_OF,
    resources: [person("Ana")],
    tasks: [
      { id: "T-1", project: "P", projectRank: 1, remainingHours: null, assignee: "Ana", number: 1 },
      { id: "T-2", project: "P", projectRank: 1, remainingHours: 12, assignee: "Ana", number: 2 },
      {
        id: "T-3",
        project: "P",
        projectRank: 1,
        remainingHours: null,
        isMilestone: true,
        number: 3,
        preds: [{ id: "T-2" }],
      },
    ],
  };
  const out = schedule(inputs);
  assert.equal(reason(out.results, "T-1"), "no estimate");
  const m = sched(out.results, "T-3");
  assert.deepEqual([m.start, m.finish, m.assignedTo, m.driverTask], ["2026-11-13", "2026-11-13", null, "T-2"]);
  const [s] = summarize(inputs.tasks, out.results);
  assert.deepEqual([s!.unscheduledTasks, s!.unestimatedTasks], [1, 1]);
});

test("blocked: unscheduled without a date, scheduled from the date with one", () => {
  const base = { project: "P", projectRank: 1, assignee: "Ana" } as const;
  const out = schedule({
    asOf: AS_OF,
    resources: [person("Ana")],
    tasks: [
      { ...base, id: "B-1", remainingHours: 6, number: 1, blocked: true },
      { ...base, id: "B-2", remainingHours: 6, number: 2, preds: [{ id: "B-1" }] },
      { ...base, id: "B-3", remainingHours: 6, number: 3, blocked: true, expectedUnblock: "2026-11-18" },
      { ...base, id: "B-4", remainingHours: 6, number: 4 },
    ],
  });
  assert.equal(reason(out.results, "B-1"), "blocked");
  assert.equal(reason(out.results, "B-2"), "blocked by unscheduled predecessor B-1");
  const b3 = sched(out.results, "B-3");
  assert.deepEqual([b3.start, b3.driver], ["2026-11-18", "blocked_until"]);
  assert.equal(sched(out.results, "B-4").start, "2026-11-11", "blocked work does not hold capacity");
});

test("capacity: a 6-hour task takes 3 days for someone with 2 project hours a day", () => {
  const out = schedule({
    asOf: AS_OF,
    resources: [person("Cal", { hoursPerDay: 2 })],
    tasks: [{ id: "T-1", project: "P", projectRank: 1, remainingHours: 6, assignee: "Cal" }],
  });
  assert.equal(sched(out.results, "T-1").finish, "2026-11-13");
});

test("capacity: date-ranged periods and partial days off", () => {
  const out = schedule({
    asOf: AS_OF,
    resources: [
      person("Ana", {
        periods: [{ start: "2026-11-11", end: "2026-11-12", hoursPerDay: 1 }], // a busy stretch elsewhere
        timeOff: [{ start: "2026-11-13", end: "2026-11-13", dayPortion: 0.5 }], // half a day off
      }),
    ],
    tasks: [{ id: "T-1", project: "P", projectRank: 1, remainingHours: 11, assignee: "Ana" }],
  });
  // 1 + 1 + 3, then a full 6 on Monday Nov 16.
  assert.equal(sched(out.results, "T-1").finish, "2026-11-16");
});

test("role pool: goes to the member who would finish first", () => {
  const inputs: Inputs = {
    asOf: AS_OF,
    resources: [person("Ana"), person("Ben"), person("Cal")],
    pools: { controls: ["Ana", "Ben"], empty: [] },
    tasks: [
      { id: "X-1", project: "X", projectRank: 1, remainingHours: 30, assignee: "Ana", number: 1 },
      { id: "X-2", project: "X", projectRank: 1, remainingHours: 12, pool: "controls", number: 2 },
      { id: "X-3", project: "X", projectRank: 1, remainingHours: 12, pool: "controls", number: 3 },
      { id: "X-4", project: "X", projectRank: 1, remainingHours: 6, pool: "empty", number: 4 },
    ],
  };
  const out = schedule(inputs);
  const x2 = sched(out.results, "X-2");
  assert.deepEqual([x2.assignedTo, x2.finish], ["Ben", "2026-11-12"]);
  const x3 = sched(out.results, "X-3");
  assert.deepEqual([x3.assignedTo, x3.start, x3.finish], ["Ben", "2026-11-13", "2026-11-16"]);
  assert.equal(reason(out.results, "X-4"), "role pool has no members with capacity");
  assert.deepEqual(verify(inputs, out), []);
});

test("allocations: a share with no work is released; one with work is held", () => {
  const ana = person("Ana", {
    allocations: [
      { project: "A", percent: 50 },
      { project: "B", percent: 50 },
    ],
  });
  const a1: Task = { id: "A-1", project: "A", projectRank: 1, remainingHours: 30, assignee: "Ana" };

  // In the prototype this took 10 working days although B had nothing to do.
  const alone = schedule({ asOf: AS_OF, resources: [ana], tasks: [a1] });
  assert.equal(sched(alone.results, "A-1").finish, "2026-11-17");

  const inputs: Inputs = {
    asOf: AS_OF,
    resources: [ana],
    tasks: [a1, { id: "B-1", project: "B", projectRank: 2, remainingHours: 6, assignee: "Ana" }],
  };
  const both = schedule(inputs);
  assert.equal(sched(both.results, "A-1").finish, "2026-11-24");
  assert.equal(sched(both.results, "B-1").finish, "2026-11-12", "the lower-ranked project still gets its half");
  assert.deepEqual(verify(inputs, both), []);

  const other = schedule({
    asOf: AS_OF,
    resources: [ana],
    tasks: [{ id: "C-1", project: "C", projectRank: 1, remainingHours: 6, assignee: "Ana" }],
  });
  assert.equal(reason(other.results, "C-1"), "no allocation to this project");
});

test("allocations apply only inside their dates", () => {
  const ana = person("Ana", {
    allocations: [
      { project: "A", percent: 50, start: "2026-11-16" },
      { project: "B", percent: 50, start: "2026-11-16" },
    ],
  });
  const out = schedule({
    asOf: AS_OF,
    resources: [ana],
    tasks: [
      { id: "A-1", project: "A", projectRank: 1, remainingHours: 24, assignee: "Ana" },
      { id: "B-1", project: "B", projectRank: 2, remainingHours: 6, assignee: "Ana" },
    ],
  });
  // Wed to Fri at a full 6, then 3 a day from Monday: 18 + 3 + 3.
  assert.equal(sched(out.results, "A-1").finish, "2026-11-17");
});

test("dependency cycles are reported, and so is work that follows them", () => {
  const base = { project: "P", projectRank: 1, remainingHours: 6, assignee: "Ana" } as const;
  const out = schedule({
    asOf: AS_OF,
    resources: [person("Ana")],
    tasks: [
      { ...base, id: "C-1", preds: [{ id: "C-2" }] },
      { ...base, id: "C-2", preds: [{ id: "C-1" }] },
      { ...base, id: "C-3", preds: [{ id: "C-2" }] },
      { ...base, id: "C-4" },
    ],
  });
  assert.equal(reason(out.results, "C-1"), "dependency cycle");
  assert.equal(reason(out.results, "C-2"), "dependency cycle");
  assert.equal(reason(out.results, "C-3"), "blocked by unscheduled predecessor C-2");
  assert.equal(sched(out.results, "C-4").finish, "2026-11-11");
});

test("lag is in calendar days; a missing predecessor counts as finished", () => {
  const out = schedule({
    asOf: AS_OF,
    resources: [person("Ana")],
    tasks: [
      { id: "L-1", project: "P", projectRank: 1, remainingHours: 6, assignee: "Ana", number: 1 },
      {
        id: "L-2",
        project: "P",
        projectRank: 1,
        remainingHours: 6,
        assignee: "Ana",
        number: 2,
        preds: [{ id: "L-1", lagDays: 2 }, { id: "GONE-9" }],
      },
    ],
  });
  // L-1 finishes Wed Nov 11; +1 +2 calendar days is Sat Nov 14, so work starts Mon Nov 16.
  assert.equal(sched(out.results, "L-2").start, "2026-11-16");
});

// ---------- simulation ----------

function longPlan(n: number): Inputs {
  return {
    asOf: AS_OF,
    resources: [person("Ana")],
    tasks: Array.from({ length: n }, (_, i) => ({
      id: `P-${i + 1}`,
      project: "P",
      projectRank: 1,
      remainingHours: 12,
      assignee: "Ana",
      number: i + 1,
    })),
  };
}

test("simulation is reproducible for a seed and ordered P50 <= P80", () => {
  const a = simulate(specExample(), { runs: 300, seed: 11 });
  const b = simulate(specExample(), { runs: 300, seed: 11 });
  assert.deepEqual([...a.projects], [...b.projects]);
  for (const [, p] of a.projects) assert.ok(p.p50! <= p.p80!);
  assert.deepEqual(a.tasks.get("BRAIN-3"), { p50: null, p80: null }, "unscheduled work has no percentiles");
});

test("simulation: P50 is later than the single schedule, which is why at-risk uses P80", () => {
  const inputs = longPlan(20);
  const single = summarize(inputs.tasks, schedule(inputs).results)[0]!.finish!;
  const sim = simulate(inputs, { runs: 400 }).projects.get("P")!;
  assert.ok(sim.p50! > single, `${sim.p50} should be after ${single}`);
});

test("simulation: shared estimate error keeps the range from collapsing on a long plan", () => {
  const inputs = longPlan(60);
  const spread = (correlation: number) => {
    const p = simulate(inputs, { runs: 400, correlation }).projects.get("P")!;
    return toDay(p.p80!) - toDay(p.p50!);
  };
  const independent = spread(0);
  const shared = spread(0.5);
  assert.ok(shared >= independent * 2, `shared ${shared} days vs independent ${independent} days`);
});

// ---------- a larger random plan through the self-checks ----------

test("a random 300-task plan passes every self-check", () => {
  let seed = 3;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const people = Array.from({ length: 12 }, (_, i) =>
    person(
      `u${i}`,
      i % 4 === 0
        ? {
            allocations: [
              { project: "PR0", percent: 60 },
              { project: "PR1", percent: 40 },
            ],
          }
        : {},
    ),
  );
  const tasks: Task[] = [];
  for (let i = 1; i <= 300; i++) {
    const k = Math.floor(rnd() * 12);
    const allocated = k % 4 === 0;
    const project = allocated ? `PR${i % 2}` : `PR${i % 6}`;
    const usePool = !allocated && rnd() < 0.2;
    tasks.push({
      id: `T-${i}`,
      project,
      projectRank: Number(project.slice(2)) + 1,
      remainingHours: rnd() < 0.05 ? null : [3, 6, 18, 30][Math.floor(rnd() * 4)]!,
      assignee: usePool ? null : `u${k}`,
      pool: usePool ? "any" : null,
      priority: 1 + Math.floor(rnd() * 5),
      number: i,
      preds:
        i > 1 && rnd() < 0.3 ? [{ id: `T-${1 + Math.floor(rnd() * (i - 1))}`, lagDays: Math.floor(rnd() * 3) }] : [],
      blocked: rnd() < 0.03,
    });
  }
  const inputs: Inputs = {
    asOf: AS_OF,
    holidays: ["2026-11-26", "2026-11-27", "2026-12-25"],
    resources: people,
    pools: { any: ["u1", "u2", "u3"] },
    tasks,
  };
  const out = schedule(inputs);
  assert.deepEqual(verify(inputs, out), []);
  const scheduled = [...out.results.values()].filter((r) => r.scheduled).length;
  assert.ok(scheduled > 200 && scheduled < 300, `${scheduled} scheduled`);
});
