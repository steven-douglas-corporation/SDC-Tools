import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveContractorEmployeeId, contractorCandidatesByName } from "../src/lib/manual-contractor-hours";

// ── A timecard name must resolve to ONE person, or to nobody (2026-09-14) ───
//
// mergeManualContractorHours used to build `name -> paylocityId` over the whole roster
// with a plain Map, so two rows sharing a name (a rehire, a namesake, a leaver kept for
// history) sent every segment to whichever row was read last — and the dedup against
// the official feed compared on that id too. The rule is now a pure function.

const active = (id: string) => ({ paylocityId: id, active: true });
const leaver = (id: string) => ({ paylocityId: id, active: false });

test("no roster match keeps the id seeded with the punch — the designed case for a contractor with no Paylocity id yet", () => {
  assert.deepEqual(resolveContractorEmployeeId([], "TEMP1"), { kind: "resolved", employeeId: "TEMP1" });
});

test("exactly one match uses that row's id, active or not", () => {
  // A leaver's row is still THE row for that name when it is the only one — the dedup
  // hook the module header describes (fill in the real id, dedup switches on).
  assert.deepEqual(resolveContractorEmployeeId([active("100900")], "TEMP1"), { kind: "resolved", employeeId: "100900" });
  assert.deepEqual(resolveContractorEmployeeId([leaver("100900")], "TEMP1"), { kind: "resolved", employeeId: "100900" });
});

test("several matches prefer the single ACTIVE row — a timecard is current work, a leaver's row is history", () => {
  assert.deepEqual(resolveContractorEmployeeId([leaver("100100"), active("100900")], "TEMP1"), { kind: "resolved", employeeId: "100900" });
  assert.deepEqual(resolveContractorEmployeeId([active("100900"), leaver("100100")], "TEMP1"), { kind: "resolved", employeeId: "100900" });
});

test("two active namesakes are NOT guessed between", () => {
  const r = resolveContractorEmployeeId([active("100100"), active("100900")], "TEMP1");
  assert.equal(r.kind, "ambiguous");
  assert.deepEqual(r.kind === "ambiguous" ? r.candidates.sort() : [], ["100100", "100900"]);
});

test("two leavers with the same name are ambiguous too — neither is more current than the other", () => {
  const r = resolveContractorEmployeeId([leaver("100100"), leaver("100900")], "TEMP1");
  assert.equal(r.kind, "ambiguous");
});

test("the seeded id never wins over a roster match, and never breaks a tie", () => {
  // If it did, an ambiguous name would silently fall back to the temp id and the
  // segment would count under a person the roster says has a real id.
  const r = resolveContractorEmployeeId([active("100100"), active("100900")], "100100");
  assert.equal(r.kind, "ambiguous");
});

test("candidates are grouped by the trimmed, case-folded name, and rows with no id are ignored", () => {
  const by = contractorCandidatesByName([
    { name: "Shedole, Lahu", paylocityId: "100900", active: true },
    { name: "  shedole, lahu ", paylocityId: "100100", active: false },
    { name: "Shedole, Lahu", paylocityId: null, active: true }, // no Paylocity id -> cannot be a candidate
    { name: "Vijayan, Vipin", paylocityId: "100200", active: true },
  ]);
  assert.deepEqual(by.get("shedole, lahu")?.map((c) => c.paylocityId).sort(), ["100100", "100900"]);
  assert.deepEqual(by.get("vijayan, vipin")?.map((c) => c.paylocityId), ["100200"]);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test("an ambiguous segment is recorded as a rejected EMPLOYEE_NOT_MAPPED punch and skipped, not emitted", () => {
  const src = readFileSync(join(process.cwd(), "src", "lib", "manual-contractor-hours.ts"), "utf8");
  assert.match(src, /resolveContractorEmployeeId\(candidatesByName\.get\(/);
  assert.match(src, /reason: "EMPLOYEE_NOT_MAPPED"/);
  assert.match(src, /countsTowardKpi: false/, "not a job-number fault, so outside the KPI's definition");
  // The last-writer-wins Map is gone.
  assert.doesNotMatch(src, /new Map\(employees\.map\(\(e\) => \[e\.name/);
  // The roster read now carries `active`, which the rule depends on.
  assert.match(src, /SELECT name, paylocityId, active FROM Employee/);
});
