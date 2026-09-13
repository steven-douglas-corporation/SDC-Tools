import { test } from "node:test";
import assert from "node:assert/strict";
import { SECTIONS, ETC_SECTIONS, ETC_TRACKED_CODES, HOURS_IMPORT_CODES, ENGINEERING_OTHER_CODES, mapPunchToColumns } from "../src/lib/sections";

// ── Centralized Paylocity mapping wiring (2026-08-20) ───────────────────────
//
// sections.ts's SECTIONS table is meant to draw its `name`/`group` wording from
// paylocity-canonical.ts rather than typing it a second time. These tests pin
// that the WIRING held — the phase-aware structure (which codes are tracked,
// which merge) is covered by the existing sections behavior these did not
// touch; paylocity-canonical.test.ts pins the vocabulary itself.

test("phase-10 section names/groups use the exact canonical wording, not an abbreviation", () => {
  const byCode = new Map(SECTIONS.map((s) => [s.code, s]));
  // Function 111 reads "Project Management (PM)" since 2026-09-02 (was
  // "Management"). Both the group and the section name come from the one
  // canonical table, so both moved together.
  assert.equal(byCode.get("10-111")!.group, "Project Management (PM)");
  assert.equal(byCode.get("10-111")!.name, "Project Management (PM)");
  assert.equal(byCode.get("10-211")!.group, "Mechanical Engineering");
  assert.equal(byCode.get("10-211")!.name, "General");
  assert.equal(byCode.get("10-312")!.group, "Controls Engineering");
  assert.equal(byCode.get("10-312")!.name, "System Design & Drawings");
  assert.equal(byCode.get("10-313")!.group, "Controls Engineering");
  assert.equal(byCode.get("10-313")!.name, "Software");
  assert.equal(byCode.get("10-515")!.name, "HMI Programming");
  assert.equal(byCode.get("10-516")!.name, "Robot Programming");
  assert.equal(byCode.get("10-517")!.name, "Vision Programming");
  assert.equal(byCode.get("10-518")!.name, "Device Programming");
  assert.equal(byCode.get("10-411")!.name, "Mechanical Build");
  assert.equal(byCode.get("10-412")!.name, "Electrical Build");
  assert.equal(byCode.get("10-413")!.name, "Manufacturing");
});

test("the phase 40/50/70 merged columns keep their own short label, deliberately NOT derived from the canonical table", () => {
  // A first attempt at deriving these from joinCanonicalDepartments broke two ways
  // at once (found by adversarial review, 2026-08-20): the 211-family join produced
  // a 44-character string with no override table to catch it on the Quoted page's
  // narrow leaf-column header, and the 411-family join collapsed to just "Shop" —
  // both codes share that department — losing which two trades were merged. The
  // canonical table has no opinion about a multi-Function-ID merge at all, so these
  // stay their own short, hand-typed labels, unchanged from before this rename.
  const byCode = new Map(SECTIONS.map((s) => [s.code, s]));
  for (const code of ["40-211", "50-211", "70-211"]) {
    assert.equal(byCode.get(code)!.name, "ME & CE", code);
  }
  for (const code of ["40-411", "50-411", "70-411"]) {
    assert.equal(byCode.get(code)!.name, "MB & EB", code);
  }
});

test("no two SECTIONS rows disagree about the same Function ID's wording", () => {
  // A regression this exact class of bug (10-412's task calling itself "Panel
  // Build" while its own department field called it "Electrical Build") would
  // reproduce as two different SECTIONS entries sharing a function id but not a
  // name. Structurally impossible now since every phase-10 name comes from one
  // canonical lookup, but pinned directly in case a future edit re-inlines one.
  const byFunctionId = new Map<string, Set<string>>();
  for (const s of SECTIONS) {
    const fn = s.code.split("-")[1];
    const names = byFunctionId.get(fn) ?? new Set<string>();
    names.add(s.name);
    byFunctionId.set(fn, names);
  }
  // 211 and 411 legitimately have two names: their own (phase 10) and their
  // merged-family name (phase 40/50/70) — every OTHER function id must be
  // named identically everywhere it appears.
  for (const [fn, names] of byFunctionId) {
    if (fn === "211" || fn === "411") continue;
    assert.equal(names.size, 1, `Function ${fn} has ${names.size} different names across SECTIONS: ${[...names].join(", ")}`);
  }
});

test("Engineering Other codes (112, 118, 119, 120) are importable but off the ETC/Quoted grid, same treatment as PM/Warranty/Service", () => {
  assert.deepEqual([...ENGINEERING_OTHER_CODES].sort(), ["10-112", "10-118", "10-119", "10-120"]);
  for (const code of ENGINEERING_OTHER_CODES) {
    assert.ok(HOURS_IMPORT_CODES.has(code), `${code} must be importable`);
    assert.ok(!ETC_TRACKED_CODES.has(code), `${code} must not be an ETC/Quoted grid column`);
    assert.ok(!ETC_SECTIONS.some((s) => s.code === code), `${code} must not appear in ETC_SECTIONS`);
  }
});

test("a punch on an Engineering Other code resolves to itself, not to []", () => {
  for (const code of ["10-112", "10-118", "10-119", "10-120"]) {
    assert.deepEqual(mapPunchToColumns(code, 8), [{ section: code, hours: 8 }]);
  }
});

// ── Never drops a row for being unmapped (2026-08-21 fix) ───────────────────
//
// mapPunchToColumns used to return [] for any code outside HOURS_IMPORT_CODES —
// exactly the "standardization decides existence" bug the Hours page's ingestion
// fix closes. A genuinely unknown Function ID (or MachineSec) now resolves to
// itself, unchanged, so its hours still reach JobHoursDetail; whether it is a
// STANDARD code is a question for HOURS_IMPORT_CODES.has(), not for this
// function, whose only job is deciding where a punch's hours belong.
test("a genuinely unknown Function ID resolves to itself, not to []", () => {
  assert.deepEqual(mapPunchToColumns("10-999", 8), [{ section: "10-999", hours: 8 }]);
  assert.deepEqual(mapPunchToColumns("10-990", 8), [{ section: "10-990", hours: 8 }]);
  assert.ok(!HOURS_IMPORT_CODES.has("10-999"), "still correctly NOT a standard code");
});

test("a real punch on a phase/function combination the app has never modeled resolves to itself too — e.g. Warranty's 70-517", () => {
  assert.ok(!HOURS_IMPORT_CODES.has("70-517"), "genuinely unmodeled — not in HOURS_IMPORT_CODES");
  assert.deepEqual(mapPunchToColumns("70-517", 4.5), [{ section: "70-517", hours: 4.5 }]);
});

test("adding Engineering Other did not touch the ETC grid's own tracked/billing sets", () => {
  // The team-confirmed 9-code Engineering / 4-code Shop formulas (sections.ts's
  // own comment) must be exactly what they were before this change.
  assert.equal(ETC_TRACKED_CODES.size, 13);
  assert.equal(ETC_SECTIONS.filter((s) => s.billingGroup === "Engineering").length, 9);
  assert.equal(ETC_SECTIONS.filter((s) => s.billingGroup === "Shop").length, 4);
});
