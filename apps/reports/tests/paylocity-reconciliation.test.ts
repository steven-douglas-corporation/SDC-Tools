import { test } from "node:test";
import assert from "node:assert/strict";
import { HOURS_IMPORT_CODES, ETC_TRACKED_CODES, ENGINEERING_OTHER_CODES, SECTION_ALIASES, mapPunchToColumns } from "../src/lib/sections";
import { resolveCanonicalFunction, isTotalControlFunctionId, TOTAL_CONTROL_FUNCTION_IDS } from "../src/lib/paylocity-canonical";

// ── "Raw Paylocity hours = mapped valid hours + undefined/data-quality hours,
// with no lost or duplicated hours" (acceptance criteria) ──────────────────
//
// Proven here as a property over the actual resolver functions, not asserted
// against one sample file — every code the app is CONFIGURED to import is
// exercised, plus the boundary cases (the 10-311 split, a genuinely unknown
// code, a total/control code, a raw punch with no usable Function ID at all).

test("every importable code maps to itself with its full hours, no split, no loss — except the documented 10-311 exception", () => {
  for (const code of HOURS_IMPORT_CODES) {
    if (code === "10-311") continue; // its own test below
    const hours = 7.25;
    const mapped = mapPunchToColumns(code, hours);
    assert.equal(mapped.length, 1, `${code} should resolve to exactly one column`);
    assert.equal(mapped[0].section, code);
    assert.equal(mapped[0].hours, hours, `${code} must not gain or lose hours`);
  }
});

test("10-311's 30/70 split still sums to exactly the input hours — the one documented exception to 1:1 mapping", () => {
  const hours = 10;
  const mapped = mapPunchToColumns("10-311", hours);
  assert.equal(mapped.length, 2);
  const total = mapped.reduce((s, m) => s + m.hours, 0);
  assert.ok(Math.abs(total - hours) < 1e-9, `split must sum to ${hours}, got ${total}`);
});

// ── Never drops a row for being unmapped (2026-08-21 fix) ───────────────────
//
// mapPunchToColumns used to return [] for any code outside HOURS_IMPORT_CODES —
// the exact "standardization decides existence" bug the Hours page's ingestion
// fix closes. It now resolves such a code to ITSELF, with the full input hours,
// exactly like an importable code — whether a resulting section counts as a
// STANDARD one is HOURS_IMPORT_CODES.has(section), a question for the caller
// (JobHoursDetail keeps the row regardless either way), never a reason for this
// function to make the hours disappear.
test("a code the app is not configured to import still resolves to itself, with its full hours — never forced into [] ", () => {
  for (const code of ["10-999", "20-211", "25-100"]) {
    assert.deepEqual(mapPunchToColumns(code, 5), [{ section: code, hours: 5 }], code);
    assert.ok(!HOURS_IMPORT_CODES.has(code), `${code} is genuinely not a standard code`);
  }
});

// Total/control codes (990-998) are excluded further UP the pipeline —
// paylocity-workbook.ts checks isTotalControlFunctionId(fn) BEFORE ever calling
// mapPunchToColumns, precisely so a control row can never be misfiled as a
// job-number problem or a generic unmapped punch. mapPunchToColumns itself has no
// opinion about them at all, so passed one directly (as a lower-level unit test
// might), it treats it exactly like any other code it doesn't recognize: keep it,
// don't lose the hours. That is correct FOR THIS FUNCTION — the exclusion is the
// caller's responsibility, not this one's.
test("mapPunchToColumns has no special knowledge of total/control codes — that exclusion lives in the caller, not here", () => {
  for (const fn of TOTAL_CONTROL_FUNCTION_IDS) {
    assert.deepEqual(mapPunchToColumns(`10-${fn}`, 5), [{ section: `10-${fn}`, hours: 5 }]);
  }
});

test("reconciliation: a synthetic file covering every importable code, plus codes the standard mapping has never seen, loses zero hours", () => {
  // One synthetic row per importable code (an arbitrary but fixed hours value per
  // row, keyed by index so no two rows accidentally share a value), plus rows for
  // codes genuinely outside HOURS_IMPORT_CODES — the exact class that used to
  // vanish. "Mapped" vs "unmapped" is now a property of the RESULT
  // (HOURS_IMPORT_CODES.has(section)), not of whether mapPunchToColumns kept the row
  // at all — it always does.
  const importableRows = [...HOURS_IMPORT_CODES].map((code, i) => ({ code, hours: 1 + i * 0.1 }));
  const unmappedRows = [
    { code: "10-999", hours: 3.3 }, // genuinely unrecognized Function ID
    // A genuinely unrecognized Section. NOT "25-211": that used to qualify, but
    // SECTION_ALIASES was materialized on 2026-08-21 (the Power BI resolver's mapping
    // moved into the table) and 25-211 is now a real alias onto 10-211. Picked from
    // outside the phase range the taxonomy uses at all, and asserted below rather
    // than assumed, so widening the table again cannot quietly invalidate this case.
    { code: "99-211", hours: 1.7 },
    ...[...TOTAL_CONTROL_FUNCTION_IDS].map((fn, i) => ({ code: `10-${fn}`, hours: 2 + i * 0.05 })), // control codes, treated the same by THIS function
  ];

  const rawTotal = [...importableRows, ...unmappedRows].reduce((s, r) => s + r.hours, 0);

  let mappedTotal = 0;
  let unmappedTotal = 0;
  for (const r of importableRows) {
    const mapped = mapPunchToColumns(r.code, r.hours);
    assert.ok(mapped.length > 0, `${r.code} should have mapped somewhere`);
    for (const m of mapped) {
      if (HOURS_IMPORT_CODES.has(m.section)) mappedTotal += m.hours;
      else unmappedTotal += m.hours; // still counted — just not a standard code
    }
  }
  for (const r of unmappedRows) {
    const mapped = mapPunchToColumns(r.code, r.hours);
    assert.equal(mapped.length, 1, `${r.code} must still resolve to exactly one row`);
    assert.equal(mapped[0].section, r.code, `${r.code} keeps its own raw identity`);
    assert.ok(!HOURS_IMPORT_CODES.has(mapped[0].section), `${r.code} is genuinely not a standard code`);
    assert.equal(SECTION_ALIASES[r.code], undefined, `${r.code} must not be an alias, or it is not an unmapped case at all`);
    unmappedTotal += mapped[0].hours;
  }

  assert.ok(Math.abs(mappedTotal + unmappedTotal - rawTotal) < 1e-9, "mapped + unmapped must equal raw, exactly — no lost hours");
});

test("Engineering Other codes (112/118/119/120) are importable and resolve to a canonical function, unlike total/control codes", () => {
  for (const code of ENGINEERING_OTHER_CODES) {
    const fn = code.split("-")[1];
    assert.equal(resolveCanonicalFunction(fn).kind, "function", `${code}'s function id (${fn}) should be a real canonical function`);
    assert.ok(!ETC_TRACKED_CODES.has(code), `${code} must stay off the ETC/Quoted grid`);
  }
  for (const fn of TOTAL_CONTROL_FUNCTION_IDS) {
    assert.equal(resolveCanonicalFunction(fn).kind, "total");
    assert.ok(isTotalControlFunctionId(fn));
  }
});

test("no Function ID is simultaneously an Engineering Other code and a total/control code", () => {
  for (const code of ENGINEERING_OTHER_CODES) {
    const fn = code.split("-")[1];
    assert.ok(!isTotalControlFunctionId(fn), `${fn} cannot be both`);
  }
});
