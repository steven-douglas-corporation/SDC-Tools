import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTransferCode } from "../src/lib/manual-contractor-punch-parse";
import { SECTIONS, SERVICE_AND_SPARE_PARTS_CODES } from "../src/lib/sections";

// ── Paylocity transfer codes on the manual contractor timecards ─────────────
//
// TEMPORARY (2026-09-01): Paylocity is not carrying temp/contractor punches for
// July-August 2026, so the timecards are transcribed and merged into the hours
// feed. The single thing most worth getting right is this parse — the JOB is the
// SECOND part of the code, not the first and not the whole value. Reading it any
// other way attributes every contractor hour to a job that does not exist.

test("a transfer code is FUNCTION/JOB/PHASE, and the job is the middle part", () => {
  const p = parseTransferCode("211/1158/10");
  assert.ok(p);
  assert.equal(p.functionId, "211");
  assert.equal(p.jobNumber, "1158", "1158 is the JOB — 211 is the function, 10 is the phase");
  assert.equal(p.machineSec, "10");
  assert.equal(p.section, "10-211");
  assert.equal(p.location, "");
});

test("the optional 4th part is a location, and does not disturb the parse", () => {
  const withLoc = parseTransferCode("211/1158/10/Concord");
  const without = parseTransferCode("211/1158/10");
  assert.ok(withLoc && without);
  assert.equal(withLoc.location, "Concord");
  // Same work, same job, same section — the location must not change any of them.
  assert.equal(withLoc.jobNumber, without.jobNumber);
  assert.equal(withLoc.section, without.section);
});

test("every transfer code in the supplied timecards resolves to a section the app models", () => {
  // Drawn from the three cards. Each must land on either a real SECTIONS row or
  // one of the Service/Spare-Parts codes — if a code resolved to something the app
  // has never heard of, those hours would classify as Undefined instead of
  // reaching a department.
  const known = new Set<string>([...SECTIONS.map((s) => s.code), ...SERVICE_AND_SPARE_PARTS_CODES]);
  const codes = [
    "211/1158/10/Concord", "211/1158/10", "211/1145/40", "211/1118/40",
    "211/7000/80", "211/1104/40", "211/1135/40", "211/1160/10",
    "211/1163/10", "211/1168/10", "211/1159/10", "211/1154/10", "211/1145/10",
    "312/1160/10", "312/1131/10", "312/1158/10", "312/1146/10", "312/1147/10",
  ];
  for (const c of codes) {
    const p = parseTransferCode(c);
    assert.ok(p, `"${c}" did not parse`);
    assert.ok(known.has(p.section), `"${c}" -> section ${p.section}, which the app does not model`);
  }
});

test("phases 40 and 80 are respected — a contractor's phase is not assumed to be 10", () => {
  assert.equal(parseTransferCode("211/1145/40")!.section, "40-211", "Machine Testing, not Complete Design & Build");
  assert.equal(parseTransferCode("211/7000/80")!.section, "80-211", "Service phase");
});

test("a malformed code is REFUSED, never guessed into a job", () => {
  // Fewer than three parts, or a blank in a required position: the caller reports
  // these instead of producing a punch against job "" or section "-211".
  for (const bad of ["", "211", "211/1158", "//", "211//10", "/1158/10", "211/1158/"]) {
    assert.equal(parseTransferCode(bad), null, `"${bad}" should not parse`);
  }
});

test("leading zeros and stray spacing normalize the way workbook punches do", () => {
  const p = parseTransferCode(" 211 / 01158 / 010 / Concord ");
  assert.ok(p);
  assert.equal(p.jobNumber, "1158");
  assert.equal(p.section, "10-211");
});
