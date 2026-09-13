import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTmHoursSection, type TmHoursDrillKey } from "../src/lib/tm-hours-classify";
import { ETC_SECTIONS, SECTIONS, POOL_QUOTED_SECTION, billingGroupForSection } from "../src/lib/sections";

// classifyTmHoursSection is the ONE function getTmHoursTotals (the KPI
// aggregate) and getTmHoursDrillRows (the drill-through) both run every
// section code through — so a card's KPI total and its own drill-through
// can only ever disagree if this function disagrees with ITSELF between two
// calls, which it can't (it's pure and depends on nothing but its argument).
// These tests pin down the actual code->card mapping, since that's the part
// that's cheap to get subtly wrong (a code moved to the wrong bucket, or a
// bucket overlapping another) without a live database to catch it.

const ALL_KEYS: TmHoursDrillKey[] = ["engineeringHours", "shopHours", "pmHours", "manufacturingHours", "otherHours"];

test("PM Hours is exactly function 111 (10-111) — the same single code poolCategoryForPunch treats as canonical", () => {
  assert.equal(classifyTmHoursSection("10-111"), "pmHours");
  assert.equal(POOL_QUOTED_SECTION.ENGINEERING_PM, "10-111");
});

test("Manufacturing Hours is exactly 10-413 (phase 10 only) — not Spare Parts' own 90-414", () => {
  assert.equal(classifyTmHoursSection("10-413"), "manufacturingHours");
  assert.equal(POOL_QUOTED_SECTION.SHOP_MANUFACTURING, "10-413");
  // 90-414 is a real, separately-imported Spare Parts code (sections.ts's
  // SERVICE_AND_SPARE_PARTS_CODES) — it must NOT fold into Manufacturing
  // Hours, which is exactly the ~40h/month overcount sections.ts's own
  // SECTION_ALIASES comment documents for counting 414 outside phase 10.
  // 90-414 is a real, separately-imported Spare Parts code — it must NOT fold
  // into Manufacturing Hours. It lands in `otherHours` (2026-09-01): still
  // excluded from Manufacturing, but no longer discarded without trace.
  assert.equal(classifyTmHoursSection("90-414"), "otherHours");
});

test("every Engineering/Shop billing-group code from ETC_SECTIONS classifies to the matching card, and to no other", () => {
  for (const s of ETC_SECTIONS) {
    const expected = s.billingGroup === "Engineering" ? "engineeringHours" : "shopHours";
    assert.equal(classifyTmHoursSection(s.code), expected, `${s.code} (${s.name}) should classify as ${expected}`);
  }
});

test("PM and Manufacturing codes are excluded from ETC_SECTIONS — Engineering/Shop can never double-count them", () => {
  const etcCodes = new Set(ETC_SECTIONS.map((s) => s.code));
  assert.ok(!etcCodes.has(POOL_QUOTED_SECTION.ENGINEERING_PM), "PM's code must not also be an Engineering/Shop billing-group code");
  assert.ok(!etcCodes.has(POOL_QUOTED_SECTION.SHOP_MANUFACTURING), "Manufacturing's code must not also be an Engineering/Shop billing-group code");
});

test("a code the app doesn't import at all lands in Other — never in one of the four, never dropped", () => {
  // Was `null`, and tm-hours.ts skipped every row that answered null. On
  // 2026-05-31..2026-07-31 that silently hid 562.47h of real punched time
  // (Service 80-*, Spare Parts 90-*, an unmapped 10-400, and malformed codes
  // like "5-111"). "Not Engineering or Shop" is not the same as "did not
  // happen"; Power BI's own model has an `Other Hours` measure for precisely
  // this. See the audit note in tm-hours-classify.ts.
  assert.equal(classifyTmHoursSection("99-999"), "otherHours");
  assert.equal(classifyTmHoursSection("10-400"), "otherHours");
  assert.equal(classifyTmHoursSection("80-411"), "otherHours");
  assert.equal(classifyTmHoursSection("5-111"), "otherHours");
});

test("the WARRANTY phase counts as Engineering / Shop — the omission this audit found", () => {
  // 70-211 (ME & CE) and 70-411 (MB & EB) are Warranty-phase Engineering and
  // Shop work with real SECTIONS rows. They were absent from both cards because
  // the sets were derived from ETC_SECTIONS, which excludes them — an exclusion
  // that is about the "Managers Fill Out" spreadsheet having no Warranty column,
  // not about what billing group the work belongs to.
  //
  // Cost, measured on 2026-05-31..2026-07-31 all jobs: Engineering read 7,004
  // instead of 7,426 and Shop read 5,870 instead of 6,306.
  //
  // Power BI's own measure is `[Billing Group] = "Engineering"` with no phase
  // exclusion at all, which is the authority for counting them.
  assert.equal(classifyTmHoursSection("70-211"), "engineeringHours");
  assert.equal(classifyTmHoursSection("70-411"), "shopHours");
  assert.equal(billingGroupForSection("70-211"), "Engineering");
  assert.equal(billingGroupForSection("70-411"), "Shop");
});

test("billingGroupForSection covers every SECTIONS code, and only Management is neither", () => {
  for (const s of SECTIONS) {
    const g = billingGroupForSection(s.code);
    if (s.code === POOL_QUOTED_SECTION.ENGINEERING_PM) {
      assert.equal(g, null, "PM (Management) belongs to neither billing group");
    } else {
      assert.ok(g === "Engineering" || g === "Shop", `${s.code} (${s.name}, group "${s.group}") resolved to ${g}`);
    }
  }
});

test("classifyTmHoursSection is TOTAL — every SECTIONS code answers exactly one card", () => {
  // The property the five cards' partition rests on: the page adds them up and
  // compares to raw punched hours, so a code answering nothing would reopen the
  // silent-drop bug.
  const counts = new Map<TmHoursDrillKey, number>();
  for (const s of SECTIONS) {
    const key = classifyTmHoursSection(s.code);
    assert.ok(ALL_KEYS.includes(key), `${s.code} classified as "${key}"`);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Every bucket except Other is fed by at least one real section code.
  for (const k of ["engineeringHours", "shopHours", "pmHours", "manufacturingHours"] as TmHoursDrillKey[]) {
    assert.ok((counts.get(k) ?? 0) > 0, `${k} has no section codes feeding it`);
  }
});

test("every one of the four named buckets is non-empty and no code is claimed by two buckets", () => {
  // Drawn from SECTIONS, not ETC_SECTIONS: the whole point of the 2026-09-01 fix
  // is that the T&M cards are no longer scoped to the codes the ETC sheet has a
  // column for, so testing against ETC_SECTIONS would no longer test the mapping
  // the page actually uses.
  const seen = new Map<string, TmHoursDrillKey>();
  for (const code of SECTIONS.map((s) => s.code)) {
    const key = classifyTmHoursSection(code);
    const prior = seen.get(code);
    assert.ok(!prior || prior === key, `${code} classified as both "${prior}" and "${key}"`);
    seen.set(code, key);
  }
  // Every real section code belongs to one of the four NAMED cards — none of
  // them should be falling through to Other.
  const named: TmHoursDrillKey[] = ["engineeringHours", "shopHours", "pmHours", "manufacturingHours"];
  for (const key of named) {
    assert.ok([...seen.values()].includes(key), `no section code classified as "${key}" — that card would always show 0`);
  }
  const fellThrough = [...seen].filter(([, k]) => k === "otherHours").map(([c]) => c);
  assert.deepEqual(fellThrough, [], `these have a SECTIONS row but no card: ${fellThrough.join(", ")}`);
});
