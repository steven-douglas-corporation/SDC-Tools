import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVED_PAIRS,
  RECONCILIATION_BUCKETS,
  STANDARD_DEPARTMENTS,
  bucketHours,
  classifyPunch,
  classifyPunchCode,
  emptyBucketTotals,
  isApprovedPair,
  normalizeSectionId,
  totalOf,
} from "../src/lib/paylocity-standard-rules";
import { TOTAL_CONTROL_FUNCTION_IDS } from "../src/lib/paylocity-canonical";

// ── The core rule: the PAIR is the key, never the Function alone ────────────
//
// These four cases are the spec's own worked examples, and they are the whole
// reason this module exists. If validation ever regresses to Function-only,
// exactly these break.

test("Section+Function is validated as a pair — a Function valid in one Section is Undefined in another", () => {
  // The spec's examples, verbatim.
  assert.equal(classifyPunch("40", "311").department, "Engineering", "Section 40 + 311 is approved");
  assert.equal(classifyPunch("10", "311").department, "Undefined", "Section 10 + 311 is NOT approved");
  assert.equal(classifyPunch("10", "413").department, "Shop", "Section 10 + 413 is approved");
  assert.equal(classifyPunch("40", "413").department, "Undefined", "Section 40 + 413 is NOT approved");
});

test("the 10-311 case the spec calls out keeps its raw identity and its hours while going Undefined", () => {
  const c = classifyPunch("10", "311");
  assert.equal(c.rawSection, "10");
  assert.equal(c.rawFunction, "311");
  assert.equal(c.rawKey, "10-311");
  assert.equal(c.department, "Undefined");
  assert.equal(c.functionGroup, "Undefined");
  assert.equal(c.taskDescription, "Undefined");
  assert.equal(c.mappingStatus, "Undefined");
  assert.equal(c.undefinedReason, "PAIR_NOT_APPROVED");
});

test("every approved pair classifies as Mapped into a standard department, and every one names a real task", () => {
  for (const pair of APPROVED_PAIRS) {
    const [section, fn] = pair.split(":");
    const c = classifyPunch(section, fn);
    assert.equal(c.mappingStatus, "Mapped", pair);
    assert.ok(
      (STANDARD_DEPARTMENTS as readonly string[]).includes(c.department),
      `${pair} must land in a standard department, got ${c.department}`,
    );
    assert.notEqual(c.taskDescription, "Undefined", `${pair} should carry a real task description`);
    assert.notEqual(c.functionGroup, "Undefined", `${pair} should carry a real function group`);
    assert.equal(c.undefinedReason, undefined, `${pair} is Mapped, so it must carry no undefined reason`);
  }
});

test("the rule book covers exactly the approved combinations and nothing more", () => {
  // Pinned so that widening the rule book is always a deliberate, reviewed edit
  // rather than a side effect of some other change.
  assert.equal(APPROVED_PAIRS.size, 1 + 8 + 4 * 2 + 4 + 4 * 2);
  assert.ok(APPROVED_PAIRS.has("10:111"), "PM");
  // Section 10 Engineering deliberately EXCLUDES 311 while including 312/313.
  assert.ok(!APPROVED_PAIRS.has("10:311"));
  assert.ok(APPROVED_PAIRS.has("10:312") && APPROVED_PAIRS.has("10:313"));
  // 413/414 are Shop in Section 10 only.
  for (const s of ["40", "50", "70", "80"]) {
    assert.ok(!APPROVED_PAIRS.has(`${s}:413`), `${s}-413 must not be approved`);
    assert.ok(!APPROVED_PAIRS.has(`${s}:414`), `${s}-414 must not be approved`);
  }
  // 111 is PM in Section 10 only — it is not a general-purpose code.
  for (const s of ["40", "50", "70", "80"]) assert.ok(!APPROVED_PAIRS.has(`${s}:111`));
});

// ── Undefined is classified, never discarded ────────────────────────────────

test("unapproved, blank and control rows are all Undefined, each with a distinguishable reason", () => {
  assert.equal(classifyPunch("90", "211").undefinedReason, "PAIR_NOT_APPROVED");
  assert.equal(classifyPunch("10", "417").undefinedReason, "PAIR_NOT_APPROVED");
  assert.equal(classifyPunch("Not Defined", "311").undefinedReason, "MISSING_SECTION");
  assert.equal(classifyPunch("", "311").undefinedReason, "MISSING_SECTION");
  assert.equal(classifyPunch("10", "").undefinedReason, "MISSING_FUNCTION");
  assert.equal(classifyPunch("10", "Not Defined").undefinedReason, "MISSING_FUNCTION");
  for (const fn of TOTAL_CONTROL_FUNCTION_IDS) {
    assert.equal(classifyPunch("10", fn).undefinedReason, "TOTAL_CONTROL_ROW", `${fn} is a control row`);
  }
});

test("a control row is reported as a control row even when its Section is also unusable", () => {
  // Order matters: the drill-through needs "booked to a summary code" to be
  // distinguishable from "blank section", because the two have different fixes.
  assert.equal(classifyPunch("Not Defined", "998").undefinedReason, "TOTAL_CONTROL_ROW");
});

test("no classification is ever null/undefined — every input yields one of the four buckets", () => {
  const inputs: (string | number | null | undefined)[] = [null, undefined, "", " ", "abc", 0, 10, "010", -1, 99999];
  for (const s of inputs) {
    for (const f of inputs) {
      const c = classifyPunch(s, f);
      assert.ok(RECONCILIATION_BUCKETS.includes(c.department), `${String(s)}/${String(f)} -> ${c.department}`);
      // Undefined and Mapped must agree with each other, always.
      assert.equal(c.mappingStatus === "Undefined", c.department === "Undefined");
    }
  }
});

// ── Normalization: the two feeds disagree cosmetically, never semantically ──

test("padded, labelled, numeric and bare Section values all resolve to the same rule", () => {
  for (const s of ["10", "010", 10, " 10 ", "010 - Complete Design & Build"]) {
    assert.equal(normalizeSectionId(s), "10", JSON.stringify(s));
    assert.equal(classifyPunch(s, "211").department, "Engineering", JSON.stringify(s));
  }
  assert.equal(normalizeSectionId("Not Defined"), "");
  assert.equal(normalizeSectionId(null), "");
});

test("padded and numeric Function values resolve alike", () => {
  for (const f of ["211", "0211", 211, " 211 "]) {
    assert.equal(classifyPunch("10", f).department, "Engineering", JSON.stringify(f));
  }
});

test("classifyPunchCode splits a combined code on the first hyphen only", () => {
  assert.equal(classifyPunchCode("10-211").department, "Engineering");
  assert.equal(classifyPunchCode("10-311").department, "Undefined");
  assert.equal(classifyPunchCode("40-411").department, "Shop");
  // A combined code is always the bare `${MachineSec}-${Function}` form (that is
  // what JobHoursDetail.section stores), so a first-hyphen split is exact. A
  // LABELLED section glued to a function is not a real code and correctly fails
  // to a bucket rather than being creatively parsed — pass those through
  // classifyPunch's two arguments instead.
  assert.equal(classifyPunchCode("010-211").department, "Engineering");
  assert.equal(classifyPunchCode("010 - Complete Design & Build-211").department, "Undefined");
  // Garbage in still yields a bucket, never a throw.
  assert.equal(classifyPunchCode("").department, "Undefined");
  assert.equal(classifyPunchCode(null).department, "Undefined");
  assert.equal(classifyPunchCode("nonsense").department, "Undefined");
});

test("isApprovedPair agrees with classifyPunch, always", () => {
  for (const s of ["10", "40", "50", "70", "80", "90", "12", "", "Not Defined"]) {
    for (const f of ["111", "211", "311", "312", "313", "411", "412", "413", "414", "417", "998", ""]) {
      assert.equal(isApprovedPair(s, f), classifyPunch(s, f).mappingStatus === "Mapped", `${s}-${f}`);
    }
  }
});

// ── The reconciliation identity — the acceptance criterion ──────────────────

test("PM + Engineering + Shop + Undefined equals the raw total, exactly, hours preserved to the cent", () => {
  // Deliberately mixes approved pairs, pairs that are valid-elsewhere-only, an
  // entirely unmodelled section, a control row and unusable cells — i.e. every
  // path through the classifier — with awkward decimal hours so that any
  // rounding or dropping shows up as a mismatch.
  const rows = [
    { sec: "10", fn: "111", h: 12.34 }, // PM
    { sec: "10", fn: "211", h: 107.79 }, // Engineering
    { sec: "10", fn: "312", h: 79.35 },
    { sec: "10", fn: "313", h: 107.42 },
    { sec: "10", fn: "517", h: 27.25 },
    { sec: "10", fn: "518", h: 30.84 },
    { sec: "40", fn: "311", h: 28.42 },
    { sec: "10", fn: "411", h: 89.34 }, // Shop
    { sec: "10", fn: "412", h: 195.78 },
    { sec: "10", fn: "414", h: 173.9 },
    { sec: "40", fn: "411", h: 21.92 },
    { sec: "10", fn: "311", h: 180.0 }, // Undefined — valid in 40/50/70/80, not in 10
    { sec: "80", fn: "311", h: 8.75 }, // Engineering (approved in 80)
    { sec: "12", fn: "211", h: 70.38 }, // Undefined — section not in the rule book
    { sec: "40", fn: "413", h: 1.62 }, // Undefined — 413 is Section 10 only
    { sec: "10", fn: "417", h: 2272.1 }, // Undefined — function not in the rule book
    { sec: "10", fn: "998", h: 3.5 }, // Undefined — control row
    { sec: "Not Defined", fn: "Not Defined", h: 8.02 }, // Undefined — unusable cells
  ];

  const rawTotal = rows.reduce((s, r) => s + r.h, 0);
  const totals = bucketHours(
    rows,
    (r) => r.sec,
    (r) => r.fn,
    (r) => r.h,
  );

  assert.ok(
    Math.abs(totalOf(totals) - rawTotal) < 1e-9,
    `standardization must neither create nor destroy hours: raw ${rawTotal}, bucketed ${totalOf(totals)}`,
  );

  // And the hours actually landed where the rule book says, not merely summed to
  // the right grand total — a test that only checked the total would pass even if
  // every row were dumped into Undefined.
  assert.ok(Math.abs(totals.PM - 12.34) < 1e-9, "PM");
  assert.ok(Math.abs(totals.Engineering - (107.79 + 79.35 + 107.42 + 27.25 + 30.84 + 28.42 + 8.75)) < 1e-9, "Engineering");
  assert.ok(Math.abs(totals.Shop - (89.34 + 195.78 + 173.9 + 21.92)) < 1e-9, "Shop");
  assert.ok(Math.abs(totals.Undefined - (180.0 + 70.38 + 1.62 + 2272.1 + 3.5 + 8.02)) < 1e-9, "Undefined");
});

test("Undefined hours never leak into a standard bucket — reclassifying cannot inflate Engineering/Shop/PM", () => {
  // Every pair the rule book does NOT approve, swept across a wide grid of real
  // Paylocity section and function values, must contribute to Undefined and to
  // nothing else.
  const sections = ["1", "5", "10", "11", "12", "13", "14", "15", "16", "17", "18", "25", "40", "50", "70", "80", "90"];
  const functions = ["100", "111", "112", "118", "119", "120", "211", "311", "312", "313", "315", "400", "411", "412", "413", "414", "417", "515", "516", "517", "518", "990", "998"];

  let approved = 0;
  let undefinedCount = 0;
  for (const s of sections) {
    for (const f of functions) {
      const c = classifyPunch(s, f);
      if (c.mappingStatus === "Mapped") {
        approved += 1;
        assert.ok(APPROVED_PAIRS.has(`${s}:${f}`), `${s}-${f} classified Mapped but is not in APPROVED_PAIRS`);
      } else {
        undefinedCount += 1;
        assert.equal(c.department, "Undefined", `${s}-${f}`);
        assert.ok(!APPROVED_PAIRS.has(`${s}:${f}`), `${s}-${f} classified Undefined but IS in APPROVED_PAIRS`);
      }
    }
  }
  assert.ok(approved > 0 && undefinedCount > 0, "the sweep should exercise both outcomes");
  // Every approved pair in the rule book uses a section/function this sweep covers,
  // so the sweep must have found all of them — a guard against the grid silently
  // drifting away from the rule book.
  assert.equal(approved, APPROVED_PAIRS.size, "the sweep should have hit every approved pair");
});

test("an empty input set reconciles trivially rather than throwing", () => {
  const totals = bucketHours(
    [],
    () => "10",
    () => "211",
    () => 0,
  );
  assert.deepEqual(totals, emptyBucketTotals());
  assert.equal(totalOf(totals), 0);
});
