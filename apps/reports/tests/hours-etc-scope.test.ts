import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEtcScopeReport,
  etcScopeCaveats,
  exclusionReasonFor,
  monthBounds,
  parseEtcMonth,
  rawCodeInEtcScope,
  scopeFilters,
} from "../src/lib/hours-etc-scope-rules";
import { ETC_TRACKED_CODES, HOURS_IMPORT_CODES, mapPunchToColumns } from "../src/lib/sections";

// ── "Match Monthly ETC" on the Hours tab ────────────────────────────────────
//
// The Hours tab restricted to exactly what Monthly ETC counts as Hours Worked, with
// everything it leaves out itemised. The two properties that matter: the code rule is
// the sync's own (mapPunchToColumns + ETC_TRACKED_CODES), and every hour is accounted
// for exactly once.

test("every tracked column is in scope, and so is every raw code that folds onto one", () => {
  for (const code of ETC_TRACKED_CODES) assert.ok(rawCodeInEtcScope(code), code);
  assert.ok(rawCodeInEtcScope("12-211"), "12-211 folds onto 10-211");
  assert.ok(rawCodeInEtcScope("10-311"), "10-311 splits onto 10-312 and 10-313, both tracked");
});

test("no raw code is only partly in scope — so a section IN (...) filter is exact", () => {
  for (const code of HOURS_IMPORT_CODES) {
    const cols = mapPunchToColumns(code, 1);
    const tracked = cols.filter((c) => ETC_TRACKED_CODES.has(c.section)).length;
    assert.ok(tracked === 0 || tracked === cols.length, `${code} splits across tracked and untracked columns`);
  }
});

test("codes with no Monthly ETC column get the reason a reader would use", () => {
  assert.equal(exclusionReasonFor("10-413"), "Manufacturing");
  assert.equal(exclusionReasonFor("10-414"), "Manufacturing", "414 folds onto 413");
  assert.equal(exclusionReasonFor("10-111"), "Project Management");
  assert.equal(exclusionReasonFor("70-211"), "Warranty");
  assert.equal(exclusionReasonFor("70-411"), "Warranty");
  assert.equal(exclusionReasonFor("80-414"), "Service");
  assert.equal(exclusionReasonFor("90-411"), "Spare Parts");
  assert.equal(exclusionReasonFor("10-118"), "Engineering “Other”");
  assert.equal(exclusionReasonFor("10-400"), "Unmapped / other codes");
  for (const code of ["10-413", "10-111", "70-211", "80-414", "90-411", "10-118", "10-400"]) assert.ok(!rawCodeInEtcScope(code), code);
});

test("every hour lands in exactly one place: the view, a code reason, or an off-grid job", () => {
  const report = buildEtcScopeReport({
    punches: [
      { jobId: "1145", jobName: "A", section: "10-211", hours: 100 },
      { jobId: "1145", jobName: "A", section: "10-411", hours: 50 },
      { jobId: "1145", jobName: "A", section: "10-311", hours: 10 },
      { jobId: "1145", jobName: "A", section: "10-413", hours: 20 },
      { jobId: "4000", jobName: "Overhead", section: "10-211", hours: 30 },
      // An untracked code on an off-grid job is reported under the CODE, as the sync drops it first.
      { jobId: "4000", jobName: "Overhead", section: "10-400", hours: 7 },
    ],
    gridJobIds: new Set(["1145"]),
    etcEntries: [],
  });
  assert.equal(report.allHours, 217);
  assert.equal(report.view.engineering, 110, "10-211 + both halves of 10-311");
  assert.equal(report.view.shop, 50);
  assert.equal(report.view.total, 160);
  assert.deepEqual(report.excludedByCode.map((r) => [r.reason, r.hours]), [["Manufacturing", 20], ["Unmapped / other codes", 7]]);
  assert.deepEqual(report.excludedByJob.map((j) => [j.jobId, j.hours]), [["4000", 30]]);
  const accounted = report.view.total + report.excludedByCode.reduce((s, r) => s + r.hours, 0) + report.excludedByJob.reduce((s, j) => s + j.hours, 0);
  assert.equal(accounted, report.allHours);
  assert.deepEqual(report.inScopeCodes, ["10-211", "10-311", "10-411"]);
});

test("Monthly ETC's side is summed by billing group from the stored rows", () => {
  const report = buildEtcScopeReport({
    punches: [],
    gridJobIds: new Set(),
    etcEntries: [
      { section: "10-211", hoursWorked: 12.5 },
      { section: "40-211", hoursWorked: 2 },
      { section: "10-412", hoursWorked: 8 },
    ],
  });
  assert.deepEqual(report.etc, { engineering: 14.5, shop: 8, total: 22.5 });
});

test("the month parses strictly and bounds cover the whole month", () => {
  assert.equal(parseEtcMonth("2026-09"), "2026-09");
  assert.equal(parseEtcMonth("2026-13"), undefined);
  assert.equal(parseEtcMonth("Sept"), undefined);
  assert.deepEqual(monthBounds("2026-09"), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(monthBounds("2028-02"), { from: "2028-02-01", to: "2028-02-29" });
});

test("scoping intersects with what the user already picked, and never widens it", () => {
  const s = scopeFilters({ jobIds: ["1145", "4000"], from: "2026-09-10" }, "2026-09", ["1145", "1158"], ["10-211"]);
  assert.deepEqual(s.jobIds, ["1145"]);
  assert.deepEqual(s.sections, ["10-211"]);
  assert.equal(s.from, "2026-09-10");
  assert.equal(s.to, "2026-09-30");
  assert.deepEqual(s.months, ["2026-09"]);
});

test("an empty intersection matches nothing rather than falling back to everything", () => {
  const s = scopeFilters({ jobIds: ["4000"] }, "2026-09", ["1145"], ["10-211"]);
  assert.equal(s.jobIds?.length, 1);
  assert.ok(!["4000", "1145"].includes(s.jobIds![0]));
});

test("caveats name the filters Monthly ETC cannot honour", () => {
  assert.deepEqual(etcScopeCaveats({}, "2026-09"), []);
  assert.equal(etcScopeCaveats({ from: "2026-09-15" }, "2026-09").length, 1);
  assert.equal(etcScopeCaveats({ employeeIds: ["1"] }, "2026-09").length, 1);
  assert.equal(etcScopeCaveats({ sections: ["10-211"] }, "2026-09").length, 1);
});
