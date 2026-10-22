import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPeopleIndex,
  resolveTempPerson,
  resolveTempPunches,
  unmatchedEmployeeId,
  isUnmatchedEmployeeId,
  TEMP_PUNCH_TRAVEL,
  type AppPerson,
} from "../src/lib/temp-punch-people";
import type { WarehousePunch } from "../src/lib/paylocity-workbook";

// ── A temp punch's NAME becomes the id the app already holds for that person ──
//
// Paylocity's Temp Punches report carries names and no Employee Id. The rules below are
// the whole of how a name is turned into an id: the report's own id when it has one and the
// app knows it, then the app's Employee rows by name (the same matcher the typed-in
// timecards use), then the ids on still-active typed-in timecards, and otherwise nobody —
// whose hours still count, under a visible placeholder, and are listed on Data Management.

const person = (name: string, paylocityId: string | null, active = true): AppPerson => ({ name, paylocityId, active });

const PEOPLE: AppPerson[] = [
  person("Casey Lane", "TEMP1"),
  person("Drew Harper", "100700"),
  person("Robin Vale", "100600"),
  person("Pat Smith", "100010"),
  person("Pat Smith", "100011", false), // a leaver with the same name
  person("Alex Twin", "100020"),
  person("Alex Twin", "100021"), // two ACTIVE people with one name
];
const index = buildPeopleIndex(PEOPLE);

test("a name matches the app's person whatever its case or spacing", () => {
  const a = resolveTempPerson({ name: "Casey Lane", employeeId: null }, index);
  const b = resolveTempPerson({ name: "  CASEY lane ", employeeId: null }, index);
  assert.deepEqual(a, { kind: "matched", employeeId: "TEMP1", via: "name", reportId: null });
  assert.deepEqual(b, a);
});

test("a placeholder id is the id the app holds, so it is what the hours are filed under", () => {
  assert.deepEqual(resolveTempPerson({ name: "Casey Lane", employeeId: null }, index), {
    kind: "matched",
    employeeId: "TEMP1",
    via: "name",
    reportId: null,
  });
});

test("the single ACTIVE namesake wins over a leaver, and two active namesakes are never chosen between", () => {
  assert.deepEqual(resolveTempPerson({ name: "Pat Smith", employeeId: null }, index), {
    kind: "matched",
    employeeId: "100010",
    via: "name",
    reportId: null,
  });
  assert.deepEqual(resolveTempPerson({ name: "Alex Twin", employeeId: null }, index), {
    kind: "ambiguous",
    candidates: ["100020", "100021"],
  });
});

test("the report's own Employee Id wins when the app knows it, even over a different name match", () => {
  // Paylocity gives Casey a real id; the app has it on someone else's row too.
  const idx = buildPeopleIndex([...PEOPLE, person("Casey Lane", "100999")]);
  assert.deepEqual(resolveTempPerson({ name: "Casey Lane", employeeId: "100999" }, idx), {
    kind: "matched",
    employeeId: "100999",
    via: "id",
    reportId: "100999",
  });
});

test("a report id the app does not know falls back to the name, and remembers what the report said", () => {
  assert.deepEqual(resolveTempPerson({ name: "Casey Lane", employeeId: "100999" }, index), {
    kind: "matched",
    employeeId: "TEMP1",
    via: "name",
    reportId: "100999",
  });
});

test("a person with no Employee row keeps the id on their typed-in timecards, so the two sources suppress each other", () => {
  const idx = buildPeopleIndex(PEOPLE, [{ name: "Morgan Pike", paylocityId: "TEMP4" }]);
  assert.deepEqual(resolveTempPerson({ name: "Morgan Pike", employeeId: null }, idx), {
    kind: "matched",
    employeeId: "TEMP4",
    via: "typed-in",
    reportId: null,
  });
});

test("two different ids typed in for one name are not guessed between", () => {
  const idx = buildPeopleIndex(PEOPLE, [
    { name: "Morgan Pike", paylocityId: "TEMP4" },
    { name: "Morgan Pike", paylocityId: "TEMP9" },
  ]);
  assert.equal(resolveTempPerson({ name: "Morgan Pike", employeeId: null }, idx).kind, "unmatched");
});

test("the Employee row beats the typed-in timecards: they are only a bridge", () => {
  const idx = buildPeopleIndex(PEOPLE, [{ name: "Casey Lane", paylocityId: "TEMP-OLD" }]);
  assert.equal((resolveTempPerson({ name: "Casey Lane", employeeId: null }, idx) as { employeeId: string }).employeeId, "TEMP1");
});

test("someone nobody has heard of is unmatched, not invented", () => {
  assert.deepEqual(resolveTempPerson({ name: "Quinn Ashby", employeeId: null }, index), { kind: "unmatched", reportId: null });
  assert.deepEqual(resolveTempPerson({ name: null, employeeId: null }, index), { kind: "unmatched", reportId: null });
});

// ── Applying it to punches ──────────────────────────────────────────────────

const punch = (p: Partial<WarehousePunch> & { sheetRow: number; employeeName: string }): WarehousePunch => ({
  employeeId: null,
  workDate: "2026-10-05",
  job: "1158",
  jobName: "Panduit",
  section: "10",
  fn: "211",
  hours: 4,
  travel: null,
  ...p,
});

test("matched punches carry the app's id and the home site; the names never reach the worksheet", () => {
  const r = resolveTempPunches([punch({ sheetRow: 6, employeeName: "Casey Lane" })], PEOPLE);
  assert.equal(r.punches.length, 1);
  assert.equal(r.punches[0].employeeId, "TEMP1");
  assert.equal(r.punches[0].travel, TEMP_PUNCH_TRAVEL);
  assert.equal(TEMP_PUNCH_TRAVEL, "Concord");
});

test("an unmatched person's hours still count: filed under a visible placeholder, not dropped", () => {
  const r = resolveTempPunches([punch({ sheetRow: 7, employeeName: "Quinn Ashby" })], PEOPLE);
  assert.equal(r.punches.length, 1);
  assert.equal(r.punches[0].employeeId, unmatchedEmployeeId("Quinn Ashby"));
  assert.equal(r.punches[0].employeeId, "NAME:Quinn Ashby");
  assert.ok(isUnmatchedEmployeeId(r.punches[0].employeeId!));
  assert.ok(!isUnmatchedEmployeeId("TEMP1"));
});

test("an unmatched person with an id in the report is filed under that id", () => {
  const r = resolveTempPunches([punch({ sheetRow: 7, employeeName: "Quinn Ashby", employeeId: "100777" })], PEOPLE);
  assert.equal(r.punches[0].employeeId, "100777");
});

test("an ambiguous name's punches are held back, not filed under either person", () => {
  const r = resolveTempPunches([punch({ sheetRow: 8, employeeName: "Alex Twin" }), punch({ sheetRow: 9, employeeName: "Casey Lane" })], PEOPLE);
  assert.deepEqual(r.punches.map((p) => p.sheetRow), [9]);
  assert.equal(r.ambiguous.length, 1);
  assert.deepEqual(r.ambiguous[0].candidates, ["100020", "100021"]);
});

test("the summary lists each person once, with their punches, hours and date range", () => {
  const r = resolveTempPunches(
    [
      punch({ sheetRow: 6, employeeName: "Quinn Ashby", workDate: "2026-10-06", hours: 4 }),
      punch({ sheetRow: 7, employeeName: "Quinn Ashby", workDate: "2026-10-09", hours: 4.25 }),
      punch({ sheetRow: 8, employeeName: "Casey Lane", workDate: "2026-10-07", hours: 8 }),
    ],
    PEOPLE,
  );
  assert.deepEqual(
    r.people.map((p) => ({ name: p.name, punches: p.punches, hours: p.hours, firstDate: p.firstDate, lastDate: p.lastDate })),
    [
      { name: "Casey Lane", punches: 1, hours: 8, firstDate: "2026-10-07", lastDate: "2026-10-07" },
      { name: "Quinn Ashby", punches: 2, hours: 8.25, firstDate: "2026-10-06", lastDate: "2026-10-09" },
    ],
  );
});
