import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOURS_GROUP_BY_ROW_FIELD,
  HOURS_GROUP_BY_VALUES,
  groupMismatches,
  narrowFiltersForGroupValue,
  punchIdentity,
  rawFunctionName,
  rawSectionName,
  rollupByRawTier,
  splitRawPair,
} from "../src/lib/hours-filters";
import { classifyPunch } from "../src/lib/paylocity-standard-rules";

// ── The raw Section+Function pair is the unique reporting key — never merged ─
//
// Requested 2026-08-21, after a screenshot showed a Function group labelled "413 —
// Manufacturing" holding raw-414 rows. That fix (grouping keys reading rawSection/
// rawFunction instead of the standardized column) removed the SYMPTOM but not the
// cause: storage itself was still folding 10-414 into 10-413, splitting 10-311 into
// two rows, and merging 12/13/14-211 onto 10-211. `rawSection`/`rawFunction` sat
// alongside a `section` column that had already rewritten the punch.
//
// `JobHoursDetail.section` now IS the raw pair, unconditionally — no alias, no fold,
// no split, ever. These tests pin that at the punchIdentity() layer every page reads
// through, using this message's own worked examples.

test("every one of the spec's worked raw pairs stays independently distinct", () => {
  const pairs = ["10-413", "10-414", "10-211", "12-211", "13-211", "14-211", "10-518", "10-315", "10-312", "10-313", "10-311"];
  const seen = new Set<string>();
  for (const pair of pairs) {
    const [sec, fn] = splitRawPair(pair);
    const id = punchIdentity(sec, fn);
    assert.equal(id.rawSectionFunctionKey, pair, `rawSectionFunctionKey must equal the pair itself, got ${id.rawSectionFunctionKey}`);
    assert.equal(id.rawSection, sec);
    assert.equal(id.rawFunction, fn);
    seen.add(id.rawSectionFunctionKey);
  }
  assert.equal(seen.size, pairs.length, "no two of the eleven worked examples collapsed into one key");
});

test("413 vs 414: same standard category, distinct raw identity — never turn 414 into 413", () => {
  const a = punchIdentity("10", "413");
  const b = punchIdentity("10", "414");
  assert.equal(a.rawFunction, "413");
  assert.equal(b.rawFunction, "414", "414 must never read back as 413");
  assert.notEqual(a.rawSectionFunctionKey, b.rawSectionFunctionKey);
  assert.equal(a.standardTaskDescription, "Manufacturing");
  assert.equal(b.standardTaskDescription, "Manufacturing");
  assert.equal(a.mappingStatus, "Mapped");
  assert.equal(b.mappingStatus, "Mapped");
});

test("same Function, different Section: 10-211/12-211/13-211/14-211 stay four distinct pairs", () => {
  const pairs = ["10", "12", "13", "14"].map((sec) => punchIdentity(sec, "211"));
  const keys = new Set(pairs.map((p) => p.rawSectionFunctionKey));
  assert.equal(keys.size, 4, "four different Sections paired with Function 211 must never combine into one '211' bucket");
  assert.equal(pairs[0].mappingStatus, "Mapped");
  for (const p of pairs.slice(1)) {
    assert.equal(p.mappingStatus, "Undefined", p.rawSectionFunctionKey);
    assert.equal(p.rawSection, p.rawSectionFunctionKey.split("-")[0], "raw Section must stay as given, never rewritten to 10");
  }
});

test("an entirely new, never-seen combination is preserved and shown as Undefined, not merged into a neighbor", () => {
  const id = punchIdentity("25", "600");
  assert.equal(id.rawSection, "25");
  assert.equal(id.rawFunction, "600");
  assert.equal(id.rawSectionFunctionKey, "25-600");
  assert.equal(id.mappingStatus, "Undefined");
  assert.equal(id.standardDepartment, "Undefined");
  assert.equal(id.standardTaskDescription, "Undefined");
  assert.notEqual(id.rawSection, "10");
  assert.notEqual(id.rawFunction, "211");
});

test("an unknown Section (e.g. 35) keeps its own raw identity — never converted to a known Section", () => {
  const id = punchIdentity("35", "211");
  assert.equal(id.rawSection, "35", "must not become 40 or any other known Section");
  assert.equal(id.rawFunction, "211");
  assert.equal(id.mappingStatus, "Undefined");
});

test("rawSectionFunctionKey is generated from the raw values, never regenerated from a standardized field", () => {
  const id = punchIdentity("40", "311");
  assert.equal(id.mappingStatus, "Mapped");
  assert.equal(id.rawSectionFunctionKey, "40-311");
});

test("rawFunctionName is the Function's OWN name, independent of whether the pairing is approved", () => {
  const undefinedPair = punchIdentity("10", "311");
  const approvedPair = punchIdentity("40", "311");
  assert.equal(undefinedPair.rawFunctionName, "General", "311's own name is a fact, not a verdict");
  assert.equal(approvedPair.rawFunctionName, "General");
  assert.equal(undefinedPair.standardTaskDescription, "Undefined", "Section 10 + 311 is not approved");
  assert.notEqual(approvedPair.standardTaskDescription, "Undefined", "Section 40 + 311 IS approved");
  assert.equal(approvedPair.standardDepartment, "Engineering");
});

test("standardization adds fields; it never carries a rewritten raw Section or Function", () => {
  const id = punchIdentity("10", "414");
  const standardKeys = Object.keys(id).filter((k) => k.startsWith("standard"));
  assert.deepEqual(standardKeys.sort(), ["standardDepartment", "standardSectionName", "standardTaskDescription"]);
  assert.notEqual(id.standardSectionName, "13");
});

test("blank or malformed Section/Function yields Undefined and keeps the punch readable", () => {
  for (const [sec, fn] of [
    ["", "211"],
    ["10", ""],
    ["Not Defined", "Not Defined"],
  ]) {
    const id = punchIdentity(sec, fn);
    assert.equal(id.mappingStatus, "Undefined", `${sec}/${fn}`);
    assert.equal(id.standardDepartment, "Undefined", `${sec}/${fn}`);
    assert.equal(id.standardTaskDescription, "Undefined", `${sec}/${fn}`);
    assert.ok(id.rawSectionName.length > 0);
    assert.ok(id.rawFunctionName.length > 0);
  }
});

test("names are the name ALONE, with no code prefixed — the columns are separate now", () => {
  assert.ok(!rawSectionName("10").includes("10"), `got "${rawSectionName("10")}"`);
  assert.ok(!rawFunctionName("211").includes("211"), `got "${rawFunctionName("211")}"`);
});

test("splitRawPair splits on the first hyphen only", () => {
  assert.deepEqual(splitRawPair("10-211"), ["10", "211"]);
  assert.deepEqual(splitRawPair("10"), ["10", ""]);
  assert.deepEqual(splitRawPair(""), ["", ""]);
});

// ── Grouping is presentation: it must never change the total ────────────────

test("every raw grouping tier preserves the total exactly", () => {
  const rows = [
    { rawSection: "10", rawFunction: "211", hours: 107.79, punchCount: 3 },
    { rawSection: "10", rawFunction: "311", hours: 186.33, punchCount: 9 },
    { rawSection: "40", rawFunction: "311", hours: 28.42, punchCount: 2 },
    { rawSection: "14", rawFunction: "211", hours: 103.59, punchCount: 4 },
    { rawSection: "10", rawFunction: "412", hours: 207.78, punchCount: 11 },
    { rawSection: "", rawFunction: "", hours: 6.42, punchCount: 1 },
  ];
  const total = rows.reduce((s, r) => s + r.hours, 0);
  for (const tier of ["sectionNumber", "functionId", "mappingStatus", "standardDepartment"] as const) {
    const g = rollupByRawTier(rows, tier);
    const sum = g.reduce((s, r) => s + r.hours, 0);
    assert.ok(Math.abs(sum - total) < 1e-9, `${tier}: ${sum} != ${total}`);
    const punches = g.reduce((s, r) => s + r.punchCount, 0);
    assert.equal(punches, rows.reduce((s, r) => s + r.punchCount, 0), `${tier} punch count`);
  }
});

test("Section and Function group INDEPENDENTLY — neither tier merges them into one key", () => {
  const rows = [
    { rawSection: "10", rawFunction: "211", hours: 10, punchCount: 1 },
    { rawSection: "10", rawFunction: "312", hours: 20, punchCount: 1 },
    { rawSection: "40", rawFunction: "211", hours: 30, punchCount: 1 },
  ];

  const bySection = rollupByRawTier(rows, "sectionNumber");
  assert.equal(bySection.length, 2, "two distinct sections");
  assert.equal(bySection.find((r) => r.key === "10")?.hours, 30, "section 10 collects both its functions");
  assert.equal(bySection.find((r) => r.key === "40")?.hours, 30);

  const byFunction = rollupByRawTier(rows, "functionId");
  assert.equal(byFunction.length, 2, "two distinct functions");
  assert.equal(byFunction.find((r) => r.key === "211")?.hours, 40, "function 211 spans sections 10 and 40");
  assert.equal(byFunction.find((r) => r.key === "312")?.hours, 20);

  assert.equal(bySection.length + byFunction.length, 4);
});

test("mappingStatus groups into exactly Mapped and Undefined, Undefined ordered last", () => {
  const rows = [
    { rawSection: "10", rawFunction: "311", hours: 500, punchCount: 1 },
    { rawSection: "10", rawFunction: "211", hours: 10, punchCount: 1 },
  ];
  const g = rollupByRawTier(rows, "mappingStatus");
  assert.deepEqual(
    g.map((r) => r.key),
    ["Mapped", "Undefined"],
    "Undefined sorts last even when it holds more hours — it is the exception list",
  );
});

// ── Grouping architecture: one dedicated field per dimension ────────────────

test("HOURS_GROUP_BY_ROW_FIELD points Section/Function at the RAW columns", () => {
  const row = {
    rawSection: "14",
    rawFunction: "414",
    standardDepartment: "Shop",
    mappingStatus: "Mapped",
    jobId: "1119",
    employeeId: "100077",
    date: "2026-08-10",
  };
  assert.equal(HOURS_GROUP_BY_ROW_FIELD.sectionNumber!(row), "14");
  assert.equal(HOURS_GROUP_BY_ROW_FIELD.functionId!(row), "414");
  assert.equal(HOURS_GROUP_BY_ROW_FIELD.standardDepartment!(row), "Shop");
  assert.equal(HOURS_GROUP_BY_ROW_FIELD.mappingStatus!(row), "Mapped");
});

test("every dimension either has a dedicated row field or is explicitly derived", () => {
  for (const dim of HOURS_GROUP_BY_VALUES) {
    assert.ok(dim in HOURS_GROUP_BY_ROW_FIELD, `${dim} must declare its grouping field (or null)`);
  }
});

test("groupMismatches: a group of Section=10/Function=414 cannot contain a 10-413 or 40-414 or 10-211 child", () => {
  const rows = [
    { rawSection: "10", rawFunction: "414", standardDepartment: "Shop", mappingStatus: "Mapped", jobId: "1119", employeeId: "1", date: "2026-08-10" },
    { rawSection: "10", rawFunction: "413", standardDepartment: "Shop", mappingStatus: "Mapped", jobId: "1119", employeeId: "1", date: "2026-08-11" },
    { rawSection: "40", rawFunction: "414", standardDepartment: "Undefined", mappingStatus: "Undefined", jobId: "1119", employeeId: "1", date: "2026-08-12" },
    { rawSection: "10", rawFunction: "211", standardDepartment: "Engineering", mappingStatus: "Mapped", jobId: "1119", employeeId: "1", date: "2026-08-13" },
  ];
  assert.equal(groupMismatches(rows, "sectionNumber", "10").length, 1, "only the 40-414 row has a different raw Section");
  assert.equal(groupMismatches(rows, "functionId", "414").length, 2, "the 10-413 and 10-211 rows have a different raw Function");
  const bySection = new Set(rows.filter((r) => r.rawSection === "10"));
  const byFunction = new Set(rows.filter((r) => r.rawFunction === "414"));
  const bothMatch = rows.filter((r) => bySection.has(r) && byFunction.has(r));
  assert.equal(bothMatch.length, 1);
  assert.equal(bothMatch[0].rawSection, "10");
  assert.equal(bothMatch[0].rawFunction, "414");
});

test("narrowing a raw dimension keys on the raw column, so a fold can never leak rows in", () => {
  const bySection = narrowFiltersForGroupValue({}, "sectionNumber", "14");
  assert.equal(bySection.rawSectionNumber, "14");
  assert.equal(bySection.sectionNumber, undefined);

  const byFunction = narrowFiltersForGroupValue({}, "functionId", "414");
  assert.equal(byFunction.rawFunctionId, "414");
  assert.equal(byFunction.functionId, undefined);
});

test("a Function group's label always begins with its own key — never another Function ID", () => {
  const rows = [
    { rawSection: "10", rawFunction: "413", hours: 8.61, punchCount: 1 },
    { rawSection: "10", rawFunction: "414", hours: 173.89, punchCount: 1 },
  ];
  const g = rollupByRawTier(rows, "functionId");
  assert.equal(g.length, 2, "413 and 414 are separate Function groups even though both are Manufacturing");
  for (const row of g) {
    assert.ok(row.label.startsWith(row.key), `label "${row.label}" must begin with its key "${row.key}"`);
  }
  assert.ok(g.every((r) => r.label.includes("Manufacturing")));
});

test("Task Description MAY combine raw Function IDs — the allowed counterpart", () => {
  assert.equal(classifyPunch("10", "413").taskDescription, "Manufacturing");
  assert.equal(classifyPunch("10", "414").taskDescription, "Manufacturing");
  assert.notEqual(classifyPunch("10", "413").rawFunction, classifyPunch("10", "414").rawFunction);
});

// ── Drill-down narrowing must widen through the fold, not just the aggregate ─

test("narrowing into a standardized group (e.g. Task=Manufacturing) widens to every raw code that folds into it", () => {
  // The same undercount bug as the aggregate rollup, one layer up: clicking to
  // expand "Manufacturing" must not silently show only 10-413's rows while 10-414's
  // (which also classifies as Manufacturing, via the fold) go missing.
  const narrowed = narrowFiltersForGroupValue({}, "taskDescription", "Manufacturing");
  assert.ok(narrowed.sections?.includes("10-413"), "the standardized target itself");
  assert.ok(narrowed.sections?.includes("10-414"), "the raw code that folds onto 10-413");
});
