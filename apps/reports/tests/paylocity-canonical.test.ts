import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_FUNCTIONS,
  TOTAL_CONTROL_FUNCTION_IDS,
  normalizeFunctionId,
  isTotalControlFunctionId,
  resolveCanonicalFunction,
  canonicalDepartmentFor,
  canonicalSectionFor,
  canonicalDisplayName,
  joinCanonicalDepartments,
} from "../src/lib/paylocity-canonical";

// ── The supplied canonical table, pinned exactly (Centralize Paylocity Department
// / Section Mapping, 2026-08-20) ────────────────────────────────────────────────

const NAMED_TABLE: [string, string, string][] = [
  // Renamed from "Management" on 2026-09-02, by request.
  ["111", "Project Management (PM)", "Project Management (PM)"],
  ["211", "Mechanical Engineering", "General"],
  ["311", "Controls Engineering", "General"],
  ["312", "Controls Engineering", "System Design & Drawings"],
  ["313", "Controls Engineering", "Software"],
  ["515", "General Engineering", "HMI Programming"],
  ["516", "General Engineering", "Robot Programming"],
  ["517", "General Engineering", "Vision Programming"],
  ["518", "General Engineering", "Device Programming"],
  ["411", "Shop", "Mechanical Build"],
  ["412", "Shop", "Electrical Build"],
  ["413", "Shop", "Manufacturing"],
  ["414", "Shop", "Manufacturing"],
];

test("every Function ID in the supplied table resolves to its exact canonical department and section", () => {
  for (const [id, department, section] of NAMED_TABLE) {
    assert.deepEqual(canonicalDepartmentFor(id), department, `Function ${id} department`);
    assert.deepEqual(canonicalSectionFor(id), section, `Function ${id} section`);
    assert.deepEqual(resolveCanonicalFunction(id), { kind: "function", canonical: { functionId: id, department, section } });
  }
});

test("the canonical table has exactly the 13 named functions plus the 4 Engineering Other codes, no more no less", () => {
  const expectedIds = [...NAMED_TABLE.map((r) => r[0]), "112", "118", "119", "120"].sort();
  assert.deepEqual([...CANONICAL_FUNCTIONS.keys()].sort(), expectedIds);
});

test('112, 118, 119, 120 all resolve to ONE consistent "Engineering Other" representation', () => {
  const others = ["112", "118", "119", "120"];
  const results = others.map((id) => resolveCanonicalFunction(id));
  for (const r of results) {
    assert.equal(r.kind, "function");
  }
  const names = new Set(results.map((r) => (r.kind === "function" ? canonicalDisplayName(r.canonical.functionId) : null)));
  assert.equal(names.size, 1, "all four Engineering Other codes must share the exact same canonical representation");
});

test("990, 991, 992, 993, 998 are TOTALS/CONTROL rows, never a real function", () => {
  for (const id of ["990", "991", "992", "993", "998"]) {
    assert.equal(resolveCanonicalFunction(id).kind, "total", `${id} must resolve as a total/control row`);
    assert.equal(isTotalControlFunctionId(id), true);
    assert.equal(canonicalDepartmentFor(id), null, `${id} must never get a department`);
    assert.equal(canonicalSectionFor(id), null, `${id} must never get a section`);
  }
  assert.deepEqual([...TOTAL_CONTROL_FUNCTION_IDS].sort(), ["990", "991", "992", "993", "998"]);
});

test('"998-Invalid", "Not Defined", and other non-numeric Function values resolve as unresolved, never forced into a department', () => {
  for (const raw of ["998-Invalid", "Not Defined", "NOT DEFINED", "", "   ", null, undefined, "abc", "211-ME"]) {
    const r = resolveCanonicalFunction(raw);
    assert.equal(r.kind, "unresolved", `${JSON.stringify(raw)} must be unresolved`);
    assert.equal(canonicalDepartmentFor(raw), null);
    assert.equal(canonicalSectionFor(raw), null);
    assert.equal(canonicalDisplayName(raw), null);
  }
});

test("a missing or unrecognized numeric Function ID resolves as unresolved, not silently mapped to a real department", () => {
  for (const raw of ["999", "1", "0", "12345"]) {
    assert.equal(resolveCanonicalFunction(raw).kind, "unresolved", raw);
  }
});

test("normalizeFunctionId trims whitespace, accepts numbers, and strips leading zeros — never invents a match", () => {
  assert.equal(normalizeFunctionId(" 211 "), "211");
  assert.equal(normalizeFunctionId(211), "211");
  assert.equal(normalizeFunctionId("0211"), "211");
  assert.equal(normalizeFunctionId(""), "");
  assert.equal(normalizeFunctionId(null), "");
  assert.equal(normalizeFunctionId(undefined), "");
  assert.equal(normalizeFunctionId("211.5"), "", "not an integer Function ID");
  assert.equal(normalizeFunctionId("-211"), "", "never a negative Function ID");
});

// ── Aliases named explicitly in the requirement: different raw Paylocity labels
// for the SAME Function ID must resolve identically (§ "Examples of aliases that
// must resolve identically"). This module only ever sees the bare Function ID —
// it is the caller's job (paylocity-workbook.ts) to have already split "411-MC &
// EB" into machineSec="411"... no: the compound examples in the spec use the
// FUNCTION ID as the number after the dash is the machine/phase, and the label
// is the alias. What must be identical is: whatever raw Function ID a row
// carries, the SAME id always resolves to the same canonical pair, regardless of
// whatever free-text label a report happened to pair it with. ────────────────

test("aliases: whatever free-text label accompanies a Function ID, the ID alone determines the canonical result", () => {
  // "411-MC & EB" and "411-Mechanical Build" -> Shop / Mechanical Build
  assert.deepEqual([canonicalDepartmentFor("411"), canonicalSectionFor("411")], ["Shop", "Mechanical Build"]);
  // "312-ME & CE" and "312-Design and Drawings" -> Controls Engineering / System Design & Drawings
  assert.deepEqual([canonicalDepartmentFor("312"), canonicalSectionFor("312")], ["Controls Engineering", "System Design & Drawings"]);
  // "313-ME & CE" and "313-Software" -> Controls Engineering / Software
  assert.deepEqual([canonicalDepartmentFor("313"), canonicalSectionFor("313")], ["Controls Engineering", "Software"]);
  // "515-ME & CE" and "515-HMI" -> General Engineering / HMI Programming
  assert.deepEqual([canonicalDepartmentFor("515"), canonicalSectionFor("515")], ["General Engineering", "HMI Programming"]);
});

test("canonicalDisplayName renders Department / Section for a real function, null otherwise", () => {
  assert.equal(canonicalDisplayName("211"), "Mechanical Engineering / General");
  assert.equal(canonicalDisplayName("990"), null);
  assert.equal(canonicalDisplayName("999"), null);
});

test("joinCanonicalDepartments merges multiple Function IDs into one deduped, ordered department list", () => {
  // The 211-family merge sections.ts folds into one phase-40/50/70 column.
  assert.equal(joinCanonicalDepartments(["211", "311", "312", "313"]), "Mechanical Engineering & Controls Engineering");
  // The 411-family merge: both canonical to "Shop" already, so no ampersand.
  assert.equal(joinCanonicalDepartments(["411", "412"]), "Shop");
  // Unresolvable ids contribute nothing rather than a literal "null" in the string.
  assert.equal(joinCanonicalDepartments(["211", "990", "999"]), "Mechanical Engineering");
  assert.equal(joinCanonicalDepartments([]), "");
});
