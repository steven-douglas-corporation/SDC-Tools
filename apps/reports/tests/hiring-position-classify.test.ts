import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyHiringPosition } from "../src/lib/hiring-position-classify";
import type { HiringPositionSourceRow } from "../src/lib/hiring-workbook-parse";

function row(overrides: Partial<HiringPositionSourceRow>): HiringPositionSourceRow {
  return {
    sourceId: "1",
    title: "Test",
    status: "Published",
    subStatus: null,
    functionCode: null,
    functionDescription: null,
    sectionCode: null,
    sectionDescription: null,
    hiringDepartment: null,
    workLocDescription: null,
    createdDate: null,
    createdBy: null,
    modifiedBy: null,
    archived: false,
    archiveDate: null,
    remote: false,
    internal: false,
    ...overrides,
  };
}

// The three real rows from the live workbook (2026-08-19), pinned down so a
// future change to the heuristic can't silently misclassify the actual data
// this was built against.

test("real row: 'Lead Debug Engineer', Function Code 111 -> PM", () => {
  const c = classifyHiringPosition(row({ title: "Lead Debug Engineer (Not for Everyone!)", functionCode: "111" }));
  assert.deepEqual(c, { workforceGroup: "pm", department: "pm" });
});

test("real row: 'Electrical Controls Engineer', no function code -> Controls Engineering via keyword", () => {
  const c = classifyHiringPosition(row({ title: "Electrical Controls Engineer" }));
  assert.deepEqual(c, { workforceGroup: "engineering", department: "controls" });
});

test("real row: 'Service Technician - Solar Test and Inspection Machines' -> Service Engineering via keyword", () => {
  const c = classifyHiringPosition(row({ title: "Service Technician - Solar Test and Inspection Machines" }));
  assert.deepEqual(c, { workforceGroup: "engineering", department: "service" });
});

test("function code wins over a title that would otherwise match a keyword", () => {
  // Titled like a builder, but the workbook itself tags it 413 (Manufacturing) —
  // the structured signal wins over the looser text guess.
  const c = classifyHiringPosition(row({ title: "Machine Builder", functionCode: "413" }));
  assert.deepEqual(c, { workforceGroup: "shop", department: "mfgops" });
});

test("an unrecognized function code falls through to the keyword guess instead of giving up", () => {
  const c = classifyHiringPosition(row({ title: "Electrician", functionCode: "999" }));
  assert.deepEqual(c, { workforceGroup: "shop", department: "wire" });
});

test("a title with no discipline signal at all classifies to Unassigned, not a guess", () => {
  const c = classifyHiringPosition(row({ title: "Front Desk Coordinator" }));
  assert.deepEqual(c, { workforceGroup: null, department: null });
});

test("every function-code mapping resolves to a real, known department", () => {
  // 211/311/414 added 2026-08-20 — completed to match sections.ts's own
  // numbering per the centralized Paylocity mapping audit; they used to fall
  // through to the keyword heuristic like an unrecognized code would.
  for (const code of ["111", "211", "311", "312", "313", "411", "412", "413", "414"]) {
    const c = classifyHiringPosition(row({ functionCode: code }));
    assert.notEqual(c.department, null, `function code ${code} should classify to a department`);
  }
});

test("Function 211 (Mechanical Engineering) and 311 (Controls Engineering) no longer fall through to a keyword guess", () => {
  assert.deepEqual(classifyHiringPosition(row({ title: "Anything", functionCode: "211" })), { workforceGroup: "engineering", department: "mech" });
  assert.deepEqual(classifyHiringPosition(row({ title: "Anything", functionCode: "311" })), { workforceGroup: "engineering", department: "controls" });
});

test("Function 414 (Manufacturing's other raw code) classifies the same as 413", () => {
  assert.deepEqual(classifyHiringPosition(row({ functionCode: "414" })), classifyHiringPosition(row({ functionCode: "413" })));
});
