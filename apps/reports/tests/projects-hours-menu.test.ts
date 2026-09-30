import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProjectsHoursColumns, hoursHref, hoursCellProps, hoursRowProps } from "../src/lib/job-cell-menu";
import { SECTIONS, mapPunchToColumns } from "../src/lib/sections";

// Right-click an hours cell on Projects -> the Hours tab filtered to that job and the
// raw Paylocity codes behind the cell (2026-09-30).

const eng = SECTIONS.filter((s) => s.group !== "Shop").map((s) => s.code);
const shop = SECTIONS.filter((s) => s.group === "Shop").map((s) => s.code);
const map = buildProjectsHoursColumns(SECTIONS, eng, shop);

test("a column's filter holds every raw code that folds onto it, and nothing that doesn't", () => {
  for (const s of SECTIONS) {
    const codes = map[s.code].codes;
    assert.ok(codes.includes(s.code), `${s.code} filters by itself`);
    for (const raw of codes) {
      assert.ok(
        mapPunchToColumns(raw, 1).some((c) => c.section === s.code),
        `${raw} is in ${s.code}'s filter, so it must fold onto ${s.code}`,
      );
    }
  }
  // 10-414 is Manufacturing's raw code; the column is 10-413.
  assert.ok(map["10-413"].codes.includes("10-414"));
});

test("the 10-311 split is called out, since the Hours tab shows those punches whole", () => {
  assert.ok(map["10-312"].codes.includes("10-311") && map["10-312"].note);
  assert.ok(map["10-313"].codes.includes("10-311") && map["10-313"].note);
  assert.equal(map["10-211"].note, undefined);
  // A total holding both halves of the split needs no note.
  const both = eng.includes("10-312") && eng.includes("10-313");
  assert.equal(Boolean(map.eng.note), !both);
});

test("ENG and SHOP totals filter by every visible code in their billing group", () => {
  for (const c of eng) assert.ok(map.eng.codes.includes(c));
  for (const c of shop) assert.ok(map.shop.codes.includes(c));
  assert.ok(!shop.some((c) => map.eng.codes.includes(c) && !eng.includes(c)));
});

test("Service and Unmapped carry their own per-row codes on the cell", () => {
  assert.deepEqual(map.service.codes, []);
  assert.deepEqual(hoursCellProps("service", ["80-311", "90-211"]), { "data-hours-col": "service", "data-hours-codes": "80-311,90-211" });
  assert.deepEqual(hoursCellProps("10-211"), { "data-hours-col": "10-211" }, "a section cell carries only its key");
  assert.deepEqual(hoursRowProps("1131", "Line A"), { "data-hours-job": "1131", "data-hours-job-name": "Line A" });
});

test("the Hours URL: job plus sorted, de-duplicated codes", () => {
  assert.equal(hoursHref({ jobId: "1131", codes: ["10-414", "10-413", "10-413"] }), "/hours?jobs=1131&sections=10-413%2C10-414");
  assert.equal(hoursHref({ jobId: "1131" }), "/hours?jobs=1131");
  assert.equal(hoursHref({}), "/hours");
});
