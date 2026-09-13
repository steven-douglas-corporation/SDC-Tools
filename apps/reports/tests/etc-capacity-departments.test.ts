import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ETC_CAPACITY_DEPARTMENTS,
  ETC_CAPACITY_CARD_KEYS,
  isEtcCapacityCardKey,
  etcCapacityOrderRank,
  etcCapacityBillingGroup,
} from "../src/lib/etc-capacity-departments";
import { ETC_SECTIONS } from "../src/lib/sections";
import { departmentFor } from "../src/lib/hours-operational-grouping";
import { EMPLOYEE_TEAMS } from "../src/lib/employee-teams";
import { DEPARTMENT_CARD_ORDER, departmentCardOrderRank } from "../src/lib/employee-workforce-groups";
import { NO_DEPARTMENT } from "../src/lib/employee-card-theme";

// ── The Dashboard's Engineering & Shop Utilization card (2026-08-31) ────────
//
// Which departments the card shows, and in what order. Both are DERIVED from
// the ETC grid's own columns (sections.ts's ETC_SECTIONS), so these tests are
// mostly about pinning that derivation against the two ways it has already gone
// wrong:
//
//   1. Filtering by ORGANISATION. A first pass used the app's Engineering/Shop/PM
//      grouping and excluded Shop, because Shop rolls up under an Operations
//      organisation — which dropped Mechanical Build and Electrical Build, two of
//      the five core ETC departments. Whether a department sits under Operations
//      says nothing about whether it books ETC hours.
//   2. Reaching for ETC_DEPARTMENTS (the month SIGN-OFF checklist) as the order.
//      That list is PM-first and has no General Engineering, so it describes who
//      ticks a box, not which columns the grid has.
//
// The card's real source is the ETC grid's phase-10 columns, which is also the
// only one of the candidates that produces the requested structure.

test("the card shows exactly the ETC grid's five department columns", () => {
  assert.deepEqual([...ETC_CAPACITY_CARD_KEYS], ["mech", "controls", "geneng", "build", "wire"]);
});

test("the requested departments are present, in the requested order", () => {
  // The request's own numbered list, spelled out — this is the assertion a
  // reader opens this file for.
  assert.deepEqual(
    ETC_CAPACITY_DEPARTMENTS.map((d) => `${d.billingGroup}: ${d.name}`),
    [
      "Engineering: Mechanical Engineering",
      "Engineering: Controls Engineering",
      "Engineering: General Engineering",
      "Shop: Mechanical Build",
      "Shop: Electrical Build",
    ],
  );
});

test("Shop is IN — the previous change wrongly removed it", () => {
  assert.ok(isEtcCapacityCardKey("build"), "Mechanical Build must be on the card");
  assert.ok(isEtcCapacityCardKey("wire"), "Electrical Build must be on the card");
  assert.equal(etcCapacityBillingGroup("build"), "Shop");
  assert.equal(etcCapacityBillingGroup("wire"), "Shop");
});

test("Engineering is IN", () => {
  assert.ok(isEtcCapacityCardKey("mech"));
  assert.ok(isEtcCapacityCardKey("controls"));
  assert.equal(etcCapacityBillingGroup("mech"), "Engineering");
  assert.equal(etcCapacityBillingGroup("controls"), "Engineering");
});

test("Wire is counted, as part of Electrical Build rather than a sixth row", () => {
  // There is no separate Wire department to add: the `wire` team owns BOTH
  // department strings, so wiring people are already inside Electrical Build and
  // a sixth row would double-count them.
  const wire = EMPLOYEE_TEAMS.find((t) => t.schedulerCode === "wire")!;
  assert.equal(wire.name, "Electrical Build");
  assert.deepEqual(wire.departments, ["Electrical Build", "Machine Wiring"]);
  assert.equal(ETC_CAPACITY_CARD_KEYS.filter((k) => k === "wire").length, 1);
});

test("the administrative departments are OUT", () => {
  for (const [cardKey, name] of [
    ["exec", "Executive Leadership"],
    ["finance", "Finance"],
    ["growth", "Growth / Business Development"],
    ["sales", "Sales"],
    ["operations", "Operations"],
    [NO_DEPARTMENT, "No department"],
    ["other", "Other"],
    ["Robotics Integration", "an unclassified new department string"],
  ] as const) {
    assert.ok(!isEtcCapacityCardKey(cardKey), `${name} (${cardKey}) must NOT be on the card`);
  }
});

test("PM, Manufacturing Operations and Service are out because the ETC GRID has no column for them", () => {
  // Not our judgement call — sections.ts's ETC_EXCLUDED_CODES drops 10-111 (PM)
  // and 10-413 (Manufacturing), "confirmed by decoding the real 'Managers Fill
  // Out' sheet", and there is no section-10 Service column at all. Asserted
  // against the section list so this stays true for the stated reason: if the
  // sheet gains a PM column, this test fails and the card gains a PM row.
  const codes = new Set(ETC_SECTIONS.map((s) => s.code));
  assert.ok(!codes.has("10-111"), "the ETC grid has no PM column");
  assert.ok(!codes.has("10-413"), "the ETC grid has no Manufacturing column");
  for (const key of ["pm", "mfgops", "service"]) {
    assert.ok(!isEtcCapacityCardKey(key), `${key} must not be on the card while the ETC grid has no column for it`);
  }
});

// ── Order ──────────────────────────────────────────────────────────────────

test("the order is the ETC grid's column order, not alphabetical", () => {
  const names = ETC_CAPACITY_DEPARTMENTS.map((d) => d.name);
  assert.notDeepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), "alphabetical would put Controls first");
  // The specific inversions that matter.
  assert.ok(names.indexOf("Mechanical Engineering") < names.indexOf("Controls Engineering"));
  assert.ok(names.indexOf("Controls Engineering") < names.indexOf("Mechanical Build"));
  assert.ok(names.indexOf("Mechanical Build") < names.indexOf("Electrical Build"));
});

test("the whole Engineering block precedes the whole Shop block, as the ETC tab shows it", () => {
  const groups = ETC_CAPACITY_DEPARTMENTS.map((d) => d.billingGroup);
  assert.equal(groups.lastIndexOf("Engineering") < groups.indexOf("Shop"), true, groups.join(","));
});

test("the order is derived from ETC_SECTIONS, so reordering the ETC grid moves the card", () => {
  // Recompute independently from the section list and require the same answer.
  const seen: string[] = [];
  for (const s of ETC_SECTIONS) {
    if (s.phase !== "Complete Design & Build") continue;
    const d = departmentFor(s.code);
    if (!seen.includes(d)) seen.push(d);
  }
  assert.deepEqual(ETC_CAPACITY_DEPARTMENTS.map((d) => d.name), seen);
});

test("multi-column departments collapse to one row, at their first column's position", () => {
  // Controls Engineering has two ETC columns (10-312, 10-313) and General
  // Engineering four (10-515..518). One row each, or the card would show
  // Controls Engineering twice.
  const controls = ETC_CAPACITY_DEPARTMENTS.find((d) => d.cardKey === "controls")!;
  assert.deepEqual(controls.sectionCodes, ["10-312", "10-313"]);
  const geneng = ETC_CAPACITY_DEPARTMENTS.find((d) => d.cardKey === "geneng")!;
  assert.deepEqual(geneng.sectionCodes, ["10-515", "10-516", "10-517", "10-518"]);
  assert.equal(new Set(ETC_CAPACITY_CARD_KEYS).size, ETC_CAPACITY_CARD_KEYS.length);
});

test("an unlisted department ranks last rather than into the middle", () => {
  assert.equal(etcCapacityOrderRank("Robotics Integration"), Number.MAX_SAFE_INTEGER);
  assert.ok(etcCapacityOrderRank("wire") < etcCapacityOrderRank("finance"));
  const ranks = ETC_CAPACITY_CARD_KEYS.map(etcCapacityOrderRank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test("the ETC order and the roster's canonical order agree where they overlap", () => {
  // Two different questions with two different sources — "which departments book
  // ETC hours" and "how is the company organised" — so this is a real check, not
  // a tautology: if they ever disagreed, one of the two lists would be wrong and
  // the Dashboard would contradict either the ETC tab or the Employees tab.
  const rosterOrder = DEPARTMENT_CARD_ORDER.filter((k) => isEtcCapacityCardKey(k));
  assert.deepEqual(rosterOrder, [...ETC_CAPACITY_CARD_KEYS]);
  const ranks = ETC_CAPACITY_CARD_KEYS.map(departmentCardOrderRank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "roster ranks must ascend in ETC order too");
});

// ── Wiring ─────────────────────────────────────────────────────────────────

const SRC = join(import.meta.dirname, "..", "src");
const read = (...p: string[]) => readFileSync(join(SRC, ...p), "utf8");

/**
 * The file with its comment lines removed — these modules document the
 * departments they exclude BY NAME in their headers, so a "must not hardcode a
 * department name" check over the raw text fails on the prose explaining the
 * rule.
 */
const codeOf = (src: string): string =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

test("the utilization module filters and orders through the ETC mapping", () => {
  const src = read("lib", "department-utilization.ts");
  assert.match(src, /isEtcCapacityCardKey\(/, "must filter through the ETC mapping");
  assert.match(src, /etcCapacityOrderRank\(/, "must order through the ETC mapping");
});

test("the utilization module does NOT filter by team or workforce group", () => {
  // The rule the request states outright: not a generic team === "Execution"
  // filter. This is the check that would have caught the Shop removal.
  const code = codeOf(read("lib", "department-utilization.ts"));
  assert.doesNotMatch(code, /isExecutionEngineering|isExecutionGroup|EXECUTION_GROUP_KEYS|groupInScope/, "must not filter by organisational group");
  assert.doesNotMatch(code, /"(Electrical Build|Mechanical Build|Executive Leadership|Finance)"/, "must not hardcode department names");
});

test("the ETC mapping is derived, not a hand-written department list", () => {
  const code = codeOf(read("lib", "etc-capacity-departments.ts"));
  assert.match(code, /ETC_SECTIONS/, "the set must come from the ETC grid's own columns");
  assert.match(code, /departmentFor\(/, "and its department names from the shared section mapping");
  // The only department names allowed in the code are the ones EMPLOYEE_TEAMS is
  // matched on, which is a lookup, not a list.
  assert.doesNotMatch(code, /\[\s*"Mechanical Engineering"/, "no literal ordered department array");
});

test("the card is renamed and no longer claims to be execution-only", () => {
  const src = read("components", "dashboard", "UtilizationPanel.tsx");
  assert.match(src, /title="Engineering & Shop Utilization"/);
  assert.doesNotMatch(src, /Execution Team Department Utilization/);
  // Both the populated card and its no-hours empty state.
  assert.equal((src.match(/title="Engineering & Shop Utilization"/g) ?? []).length, 2);
});

test("the card still defaults to the server's order rather than re-sorting", () => {
  const src = read("components", "dashboard", "UtilizationPanel.tsx");
  assert.match(src, /useState<SortState<DeptSortKey>>\(null\)/);
  assert.doesNotMatch(src, /useState<SortState<DeptSortKey>>\(\{\s*key:\s*"utilizationPct"/);
});

test("the peer Employee Utilization panel is untouched by the filter", () => {
  const src = read("components", "dashboard", "UtilizationPanel.tsx");
  assert.match(src, /for \(const e of result\.employees\)/, "its options come from the rows it filters");
  assert.doesNotMatch(src, /result\.departments\.filter\(\(d\) => d\.employeeRows\.length > 0\)/);
});
