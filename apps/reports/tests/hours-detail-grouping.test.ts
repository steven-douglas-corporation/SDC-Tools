import { test } from "node:test";
import assert from "node:assert/strict";
import { groupHoursRows, groupValue } from "../src/components/HoursDetailPanel";
import type { JobHoursDetail } from "../src/lib/job-hours-detail";

// Group-by for the punch-detail drill panel (2026-08-03, by request: "group by
// department, employee").
//
// The invariant worth protecting is that grouped hours SUM to the ungrouped total,
// because the panel shows both at once — the groups in the table and the Total in its
// footer. If a punch ever fell out of a rollup (a null department, say) the two would
// silently disagree and the footer would look wrong.

type Row = JobHoursDetail["rows"][number];

const row = (over: Partial<Row> = {}): Row =>
  ({
    date: "2026-07-31",
    job: "1148 BISCUIT QTY 10",
    employee: "Jake Wiegand",
    department: "Mechanical Engineering",
    section: "10-211",
    sectionName: "ME Gen",
    hours: 8,
    ...over,
  }) as Row;

const REAL = [
  // Shaped after July's actual undefined-errors drill.
  row({ employee: "Jake Wiegand", department: "Mechanical Engineering", hours: 8 }),
  row({ employee: "Jake Wiegand", department: "Mechanical Engineering", hours: 9 }),
  row({ employee: "Jake Wiegand", department: "Mechanical Engineering", hours: 10 }),
  row({ employee: "Robert Brooks", department: "Electrical Build", section: "10-412", sectionName: "Elec Build", hours: 0.4 }),
  row({ employee: "Samuel Adams", department: "Mechanical Build / Manufacturing", section: "10-411", sectionName: "Mech Build", hours: 4 }),
  row({ employee: "Paul Vinci", department: "Mechanical Engineering", hours: 5 }),
];

const sum = (rows: Row[]) => rows.reduce((s, r) => s + r.hours, 0);

test("nothing selected means no grouping — the punch list stays", () => {
  assert.equal(groupHoursRows(REAL, []), null);
});

test("grouping by employee collapses one person's punches into one row", () => {
  const g = groupHoursRows(REAL, ["employee"])!;
  assert.equal(g.length, 4);
  const jake = g.find((x) => x.values[0] === "Jake Wiegand")!;
  assert.equal(jake.lines, 3);
  assert.equal(jake.hours, 27);
});

test("grouping by department rolls several people together", () => {
  const g = groupHoursRows(REAL, ["department"])!;
  const me = g.find((x) => x.values[0] === "Mechanical Engineering")!;
  assert.equal(me.lines, 4); // 3x Jake + Paul
  assert.equal(me.hours, 32);
});

test("department THEN employee gives one row per pair", () => {
  // The two-dimensional case the request actually asked for. Four distinct pairs:
  // ME holds Jake and Paul, and the other two departments one person each.
  const g = groupHoursRows(REAL, ["department", "employee"])!;
  assert.equal(g.length, 4);
  const pair = g.find((x) => x.values[0] === "Mechanical Engineering" && x.values[1] === "Paul Vinci")!;
  assert.equal(pair.lines, 1);
  assert.equal(pair.hours, 5);
});

test("click order pivots the columns without changing the numbers", () => {
  const deptFirst = groupHoursRows(REAL, ["department", "employee"])!;
  const empFirst = groupHoursRows(REAL, ["employee", "department"])!;
  assert.equal(deptFirst.length, empFirst.length);
  assert.equal(sum(REAL), deptFirst.reduce((s, g) => s + g.hours, 0));
  assert.equal(sum(REAL), empFirst.reduce((s, g) => s + g.hours, 0));
  // The same underlying pair appears in both, with its columns the other way round —
  // that IS the pivot, and the hours must be identical either way.
  const a = deptFirst.find((x) => x.values[0] === "Mechanical Engineering" && x.values[1] === "Jake Wiegand")!;
  const b = empFirst.find((x) => x.values[0] === "Jake Wiegand" && x.values[1] === "Mechanical Engineering")!;
  assert.deepEqual(a.values.slice().reverse(), b.values);
  assert.equal(a.hours, b.hours);
  assert.equal(a.lines, b.lines);
});

test("every grouping preserves the total — the footer must still add up", () => {
  const expected = sum(REAL);
  for (const keys of [
    ["employee"],
    ["department"],
    ["section"],
    ["job"],
    ["department", "employee"],
    ["employee", "department"],
    ["department", "employee", "section"],
    ["job", "section", "employee", "department"],
  ] as const) {
    const g = groupHoursRows(REAL, [...keys])!;
    const got = g.reduce((s, x) => s + x.hours, 0);
    assert.ok(Math.abs(got - expected) < 1e-9, `${keys.join("+")}: ${got} != ${expected}`);
    // Line counts must account for every punch too.
    assert.equal(g.reduce((s, x) => s + x.lines, 0), REAL.length);
  }
});

test("sorted by hours descending — biggest contributor first", () => {
  const g = groupHoursRows(REAL, ["employee"])!;
  for (let i = 1; i < g.length; i++) {
    assert.ok(g[i].hours <= g[i - 1].hours, `not sorted at ${i}`);
  }
  assert.equal(g[0].values[0], "Jake Wiegand");
});

test("a missing department still counts, under an em dash", () => {
  // Dropping it would make the groups stop summing to the Total.
  const rows = [...REAL, row({ department: "", employee: "Nobody", hours: 3 })];
  const g = groupHoursRows(rows, ["department"])!;
  const blank = g.find((x) => x.values[0] === "—")!;
  assert.equal(blank.hours, 3);
  assert.equal(g.reduce((s, x) => s + x.hours, 0), sum(rows));
});

test("labels containing the separator cannot merge two groups", () => {
  // The keys are JSON, so this pair stays distinct. A space-joined key would fuse
  // them into one row and silently double a total.
  const rows = [
    row({ department: "a b", employee: "c", hours: 1 }),
    row({ department: "a", employee: "b c", hours: 2 }),
  ];
  const g = groupHoursRows(rows, ["department", "employee"])!;
  assert.equal(g.length, 2);
  assert.equal(g.reduce((s, x) => s + x.hours, 0), 3);
});

test("section groups on code and name together", () => {
  assert.equal(groupValue(row(), "section"), "10-211 — ME Gen");
  // The two are 1:1, so this is the same grouping as on the bare code — it just
  // saves carrying a representative row to print the name.
  const g = groupHoursRows(REAL, ["section"])!;
  assert.ok(g.every((x) => x.values[0].includes(" — ")));
});

// ── Drilling into a group ───────────────────────────────────────────────────
// Each group carries the punches behind it so a row can be expanded in place. The
// count and the hours on the closed row have to describe exactly what opening it
// reveals, or the rollup and its own detail contradict each other.

test("a group carries exactly the punches it counted", () => {
  const g = groupHoursRows(REAL, ["employee"])!;
  for (const x of g) {
    assert.equal(x.rows.length, x.lines, `${x.values[0]}: ${x.rows.length} rows vs ${x.lines} lines`);
    assert.ok(Math.abs(sum(x.rows) - x.hours) < 1e-9, `${x.values[0]}: rows sum to ${sum(x.rows)}, group says ${x.hours}`);
  }
});

test("expanding every group accounts for every punch, exactly once", () => {
  // No punch may be duplicated across groups or dropped from all of them.
  const g = groupHoursRows(REAL, ["department", "employee"])!;
  const seen = g.flatMap((x) => x.rows);
  assert.equal(seen.length, REAL.length);
  for (const r of REAL) assert.ok(seen.includes(r), "a punch reached no group");
});

test("a group's punches all really belong to it", () => {
  const g = groupHoursRows(REAL, ["department", "employee"])!;
  for (const x of g) {
    for (const r of x.rows) {
      assert.equal(groupValue(r, "department"), x.values[0]);
      assert.equal(groupValue(r, "employee"), x.values[1]);
    }
  }
});

test("fractional punches survive the rollup", () => {
  // Robert Brooks' 0.4h renders as "<1" but must not be rounded away in the sum.
  const g = groupHoursRows(REAL, ["employee"])!;
  const robert = g.find((x) => x.values[0] === "Robert Brooks")!;
  assert.equal(robert.hours, 0.4);
});

// ── Grid order (2026-08-05, by request) ─────────────────────────────────────
//
// "the department order should be the same as the down in the grid monthly etc table".
// Grouped by a single dimension the grid has an order for, the rollup follows that
// order instead of hours-descending, so the drill and the table below it can be read
// line for line.

test("departments come out in the grid's order, not by size", () => {
  const rows = [
    // Deliberately built so hours-descending would produce the OPPOSITE order: Service
    // is the biggest and sorts last, Mechanical is the smallest and sorts first.
    row({ department: "Service Engineering", employee: "C", hours: 500 }),
    row({ department: "Controls Engineering", employee: "B", hours: 200 }),
    row({ department: "Mechanical Engineering", employee: "A", hours: 10 }),
  ];
  const g = groupHoursRows(rows, ["department"])!;
  assert.deepEqual(
    g.map((x) => x.values[0]),
    ["Mechanical Engineering", "Controls Engineering", "Service Engineering"],
    "must follow EMPLOYEE_TEAMS, which is the grid's left-to-right reading",
  );
});

test("an alias department lands in its team's slot, not at the end", () => {
  // "Mechanical Build / Manufacturing" and "Mechanical Build" are one team in
  // EMPLOYEE_TEAMS. Matching on the literal label would have missed the aliased form
  // and dumped it after Service.
  const rows = [
    row({ department: "Service Engineering", employee: "C", hours: 1 }),
    row({ department: "Mechanical Build / Manufacturing", employee: "B", hours: 1 }),
    row({ department: "Mechanical Engineering", employee: "A", hours: 1 }),
  ];
  const g = groupHoursRows(rows, ["department"])!;
  assert.deepEqual(g.map((x) => x.values[0]), [
    "Mechanical Engineering",
    "Mechanical Build / Manufacturing",
    "Service Engineering",
  ]);
});

test("a department the grid has no place for sorts last, by size", () => {
  const rows = [
    row({ department: "Astrology", employee: "X", hours: 999 }),
    row({ department: "Basket Weaving", employee: "Y", hours: 5 }),
    row({ department: "Mechanical Engineering", employee: "A", hours: 1 }),
  ];
  const g = groupHoursRows(rows, ["department"])!;
  assert.equal(g[0].values[0], "Mechanical Engineering", "known departments come first");
  // Unranked ones keep hours-descending among themselves — useful, unlike alphabetical.
  assert.deepEqual(g.slice(1).map((x) => x.values[0]), ["Astrology", "Basket Weaving"]);
});

test("sections come out in the grid's column order", () => {
  const rows = [
    row({ section: "50-411", sectionName: "MB & EB", hours: 900 }),
    row({ section: "10-211", sectionName: "ME Gen", hours: 5 }),
    row({ section: "10-411", sectionName: "Mech Build", hours: 400 }),
  ];
  const g = groupHoursRows(rows, ["section"])!;
  assert.deepEqual(
    g.map((x) => x.values[0]),
    ["10-211 — ME Gen", "10-411 — Mech Build", "50-411 — MB & EB"],
    "SECTIONS order, which IS the grid's columns",
  );
});

test("a multi-dimension rollup stays on hours descending", () => {
  // "Department › Employee" has no grid equivalent. Ordering the outer level by the grid
  // while the inner one stayed by size would read as neither.
  const rows = [
    row({ department: "Mechanical Engineering", employee: "A", hours: 1 }),
    row({ department: "Service Engineering", employee: "C", hours: 500 }),
  ];
  const g = groupHoursRows(rows, ["department", "employee"])!;
  assert.equal(g[0].values[1], "C", "biggest first when there is no grid order to follow");
});
