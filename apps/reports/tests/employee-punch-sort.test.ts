import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PUNCH_SORT_COLUMNS, BUCKET_RANK, sectionSortKey, type PunchSortKey } from "../src/lib/employee-punch-sort";
import { sortRows, cycleSortState, type SortState } from "../src/lib/table-sort";
import { BUCKET_LABEL, type EmployeeMonthPunch } from "../src/lib/employee-punch-drill";

// ── Sorting the employee punch drill (2026-08-31) ──────────────────────────
//
// Every column is data-type aware, and the ways that goes wrong are all
// "it looks sorted": a date column sorted on its formatted label puts April
// before August, an hours column sorted as text puts 10 before 9, and a job
// column sorted as text puts 1129 before 979. Each of those is checked with
// values that actually expose it, not with a pre-sorted fixture.

const punch = (p: Partial<EmployeeMonthPunch>): EmployeeMonthPunch => ({
  date: "2026-08-01",
  jobId: "1129",
  jobName: "Cartoner Machine",
  section: "10-211",
  sectionName: "General",
  hours: 8,
  bucket: "billableActive",
  billable: true,
  ...p,
});

const sortBy = (rows: EmployeeMonthPunch[], key: PunchSortKey, direction: "asc" | "desc") =>
  sortRows(rows, { key, direction } as SortState<PunchSortKey>, PUNCH_SORT_COLUMNS);

test("every displayed column has a sort definition", () => {
  // The six columns the panel renders. A column with a header but no entry here
  // would throw at the click, or silently no-op.
  const expected: PunchSortKey[] = ["date", "jobId", "project", "section", "bucket", "hours"];
  assert.deepEqual(Object.keys(PUNCH_SORT_COLUMNS).sort(), [...expected].sort());
});

// ── Date ───────────────────────────────────────────────────────────────────

test("date sorts chronologically, across a month boundary", () => {
  // The rendered label is "Fri, Aug 28" — sorting THAT text puts April first and
  // orders by weekday name. These rows are built so a text sort on the label
  // would give a different answer from the right one.
  const rows = [
    punch({ date: "2026-08-05" }),
    punch({ date: "2026-04-30" }),
    punch({ date: "2026-08-28" }),
    punch({ date: "2026-12-01" }),
  ];
  assert.deepEqual(sortBy(rows, "date", "asc").map((r) => r.date), [
    "2026-04-30",
    "2026-08-05",
    "2026-08-28",
    "2026-12-01",
  ]);
  assert.deepEqual(sortBy(rows, "date", "desc").map((r) => r.date), [
    "2026-12-01",
    "2026-08-28",
    "2026-08-05",
    "2026-04-30",
  ]);
});

test("date sorts on the ISO value, not on the day of the month", () => {
  // "2026-08-09" vs "2026-08-10": a naive numeric-day sort or a formatted-label
  // sort both get this wrong in at least one direction.
  const rows = [punch({ date: "2026-08-10" }), punch({ date: "2026-08-09" })];
  assert.deepEqual(sortBy(rows, "date", "asc").map((r) => r.date), ["2026-08-09", "2026-08-10"]);
});

// ── Job ────────────────────────────────────────────────────────────────────

test("job sorts numerically — 979 before 1129, which a string sort reverses", () => {
  const rows = [punch({ jobId: "1129" }), punch({ jobId: "979" }), punch({ jobId: "6000" }), punch({ jobId: "4000" })];
  assert.deepEqual(sortBy(rows, "jobId", "asc").map((r) => r.jobId), ["979", "1129", "4000", "6000"]);
});

test("a non-numeric job id sorts safely instead of breaking the order", () => {
  // Falls back to a string compare for the pair that cannot both parse. The only
  // real requirement is that it is total and stable — no NaN, nothing dropped.
  const rows = [punch({ jobId: "1129" }), punch({ jobId: "SPARE" }), punch({ jobId: "979" })];
  const asc = sortBy(rows, "jobId", "asc").map((r) => r.jobId);
  assert.equal(asc.length, 3, "no row lost");
  assert.ok(asc.includes("SPARE"));
  assert.ok(asc.indexOf("979") < asc.indexOf("1129"), "the numeric pair still compares numerically");
});

// ── Project ────────────────────────────────────────────────────────────────

test("project sorts case-insensitively", () => {
  const rows = [
    punch({ jobName: "zebra line" }),
    punch({ jobName: "Apple Sorter" }),
    punch({ jobName: "banana Packer" }),
  ];
  assert.deepEqual(sortBy(rows, "project", "asc").map((r) => r.jobName), [
    "Apple Sorter",
    "banana Packer",
    "zebra line",
  ]);
});

test("project sorting does not depend on the original casing being uniform", () => {
  const rows = [punch({ jobName: "BELLCO FEEDERS" }), punch({ jobName: "Bellco Feeders" }), punch({ jobName: "abc" })];
  const asc = sortBy(rows, "project", "asc").map((r) => r.jobName);
  assert.equal(asc[0], "abc", "lower-cased 'abc' must precede both Bellco spellings");
});

// ── Section ────────────────────────────────────────────────────────────────

test("section sorts naturally by code, including 1-digit sections", () => {
  const rows = [
    punch({ section: "40-311" }),
    punch({ section: "10-211" }),
    punch({ section: "1-311" }),
    punch({ section: "10-313" }),
    punch({ section: "9-211" }),
  ];
  assert.deepEqual(sortBy(rows, "section", "asc").map((r) => r.section), [
    "1-311",
    "9-211",
    "10-211",
    "10-313",
    "40-311",
  ]);
});

test("section padding fixes the cases a raw compare actually gets wrong", () => {
  // Measured, not assumed. A raw compare gets "1-311" vs "10-211" RIGHT by luck
  // (digits tie, then "-" sorts below "0"); these two are where it fails, and
  // they are why the padding exists.
  for (const [lower, higher] of [
    ["9-211", "10-211"],
    ["10-99", "10-100"],
  ] as const) {
    assert.ok(lower.localeCompare(higher) > 0, `${lower} vs ${higher}: raw compare should be wrong here`);
    assert.ok(
      sectionSortKey(lower).localeCompare(sectionSortKey(higher)) < 0,
      `${lower} must sort before ${higher} once padded`,
    );
  }
});

test("sectionSortKey zero-pads every digit run", () => {
  assert.equal(sectionSortKey("1-311"), "000001-000311");
  assert.equal(sectionSortKey("10-211"), "000010-000211");
  assert.ok(sectionSortKey("1-311") < sectionSortKey("10-211"));
  assert.ok(sectionSortKey("10-313") < sectionSortKey("40-311"));
});

test("sectionSortKey leaves a non-numeric code intact rather than dropping it", () => {
  assert.equal(sectionSortKey("N/A"), "N/A");
  assert.equal(sectionSortKey(""), "");
});

// ── Counts as ──────────────────────────────────────────────────────────────

test("counts-as sorts in the business order, not alphabetically", () => {
  const rows = [
    punch({ bucket: "nonBillable" }),
    punch({ bucket: "bellco" }),
    punch({ bucket: "billableActive" }),
    punch({ bucket: "warranty" }),
  ];
  assert.deepEqual(sortBy(rows, "bucket", "asc").map((r) => r.bucket), [
    "billableActive",
    "warranty",
    "bellco",
    "nonBillable",
  ]);
  // Alphabetically by LABEL this would be Bellco, Billable, Non-Billable,
  // Warranty — which is the ordering this column deliberately does not use.
  const alphabetical = rows.map((r) => BUCKET_LABEL[r.bucket]).sort((a, b) => a.localeCompare(b));
  assert.equal(alphabetical[0], "Bellco");
  assert.notEqual(sortBy(rows, "bucket", "asc").map((r) => BUCKET_LABEL[r.bucket])[0], "Bellco");
});

test("the bucket rank is derived from BUCKET_LABEL, so a new bucket is ranked automatically", () => {
  assert.deepEqual([...BUCKET_RANK.keys()], Object.keys(BUCKET_LABEL));
  for (const bucket of Object.keys(BUCKET_LABEL)) {
    assert.equal(typeof BUCKET_RANK.get(bucket), "number", `${bucket} has no rank`);
  }
  // Billable first, Non-Billable last — the property the column is for.
  assert.equal(BUCKET_RANK.get("billableActive"), 0);
  assert.equal(BUCKET_RANK.get("nonBillable"), BUCKET_RANK.size - 1);
});

// ── Hours ──────────────────────────────────────────────────────────────────

test("hours sorts numerically — a string sort puts 10 before 9", () => {
  const rows = [punch({ hours: 9 }), punch({ hours: 10 }), punch({ hours: 0.5 }), punch({ hours: 2.25 })];
  assert.deepEqual(sortBy(rows, "hours", "asc").map((r) => r.hours), [0.5, 2.25, 9, 10]);
  assert.deepEqual(sortBy(rows, "hours", "desc").map((r) => r.hours), [10, 9, 2.25, 0.5]);
});

// ── The cycle, the default, and not mutating the source ────────────────────

test("the click cycle is ascending, descending, then back to the default", () => {
  let sort: SortState<PunchSortKey> = null;
  sort = cycleSortState(sort, "hours");
  assert.deepEqual(sort, { key: "hours", direction: "asc" });
  sort = cycleSortState(sort, "hours");
  assert.deepEqual(sort, { key: "hours", direction: "desc" });
  sort = cycleSortState(sort, "hours");
  assert.equal(sort, null, "the third click returns to the default order");
});

test("a null sort returns the rows in their original server order, untouched", () => {
  // The default is the query's `workDate desc` — restored by returning the very
  // same array, so there is no second definition of "default" to drift.
  const rows = [punch({ date: "2026-08-28" }), punch({ date: "2026-08-01" })];
  const out = sortRows(rows, null, PUNCH_SORT_COLUMNS);
  assert.equal(out, rows, "must be the same array reference, not a re-sorted copy");
});

test("sorting never mutates the loaded punch rows", () => {
  // The bucket chips and the footer total read result.rows directly; reordering
  // it in place would not change any total, but it would make the panel's own
  // arithmetic depend on which header was last clicked.
  const rows = [punch({ hours: 1 }), punch({ hours: 9 }), punch({ hours: 5 })];
  const snapshot = rows.map((r) => r.hours);
  const sorted = sortBy(rows, "hours", "asc");
  assert.deepEqual(rows.map((r) => r.hours), snapshot, "the input array must be unchanged");
  assert.notEqual(sorted, rows, "the sorted result must be a copy");
});

test("sorting changes only the order — no row is added, dropped or altered", () => {
  const rows = [
    punch({ date: "2026-08-01", hours: 3 }),
    punch({ date: "2026-08-28", hours: 8 }),
    punch({ date: "2026-08-14", hours: 1.5 }),
  ];
  for (const key of Object.keys(PUNCH_SORT_COLUMNS) as PunchSortKey[]) {
    for (const direction of ["asc", "desc"] as const) {
      const out = sortBy(rows, key, direction);
      assert.equal(out.length, rows.length, `${key}/${direction} changed the row count`);
      assert.equal(
        out.reduce((s, r) => s + r.hours, 0),
        rows.reduce((s, r) => s + r.hours, 0),
        `${key}/${direction} changed the hours total`,
      );
      assert.deepEqual(new Set(out), new Set(rows), `${key}/${direction} altered a row`);
    }
  }
});

// ── Wiring ─────────────────────────────────────────────────────────────────

const PANEL = readFileSync(
  join(import.meta.dirname, "..", "src", "components", "dashboard", "EmployeePunchDrill.tsx"),
  "utf8",
);

test("all six headers are rendered as sortable cells", () => {
  for (const key of ["date", "jobId", "project", "section", "bucket", "hours"]) {
    assert.match(PANEL, new RegExp(`sortKey="${key}"`), `${key} has no sortable header`);
  }
  assert.equal((PANEL.match(/<SortableTh/g) ?? []).length, 6, "expected exactly six sortable headers");
  // No plain <th> left behind — a mix would give some columns a click target and
  // others not, which reads as broken rather than as a deliberate exception.
  assert.doesNotMatch(PANEL, /<th\s/, "every header must go through SortableTh");
});

test("the panel sorts a copy and renders it, rather than reading result.rows", () => {
  assert.match(PANEL, /sortRows\(result\?\.rows \?\? \[\], sort, PUNCH_SORT_COLUMNS\)/);
  assert.match(PANEL, /\{rows\.map\(/, "the body must render the sorted copy");
  assert.doesNotMatch(PANEL, /\{result\.rows\.map\(/, "rendering result.rows directly would ignore the sort");
});

test("the sort resets when the panel switches to another employee", () => {
  // Requirement: opening a different person starts back at newest-first. Done by
  // adjusting state during render on a changed prop, so it cannot be forgotten by
  // whoever renders the panel next.
  assert.match(PANEL, /sortedFor !== target\.employeeId/);
  assert.match(PANEL, /setSort\(null\)/);
});

test("the headers stay sticky", () => {
  assert.match(PANEL, /const TH = "sticky top-0/, "the shared header class must keep position: sticky");
});
