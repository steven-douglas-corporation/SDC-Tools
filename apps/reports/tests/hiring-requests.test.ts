import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { daysSince, findPostingForRequest, teamLeadOptions, titlesMatch, waitingLabel } from "../src/lib/hiring-requests";
import type { HiringPosition } from "../src/lib/hiring-positions";

// Hire requests (2026-10-29): a position created in SDC Reports is a manager's
// request; the Paylocity posting it becomes is the opening. Requests never count
// toward hiring totals, and the app suggests which posting a request became so a
// person can close it.

function position(overrides: Partial<HiringPosition>): HiringPosition {
  return {
    sourceId: "1234",
    title: "Controls Engineer",
    status: "Published",
    subStatus: null,
    isOpen: true,
    quantity: 1,
    filledCount: 0,
    remainingQuantity: 1,
    source: "workbook",
    workforceGroup: "engineering",
    department: "controls",
    hiringManagerIds: ["48003052"],
    requestedAt: null,
    note: null,
    isManuallyAssigned: false,
    expectedStartDate: null,
    isVisible: true,
    functionDescription: null,
    sectionDescription: null,
    workLocDescription: null,
    createdDate: "10/28/2026",
    createdBy: null,
    modifiedBy: null,
    remote: false,
    internal: false,
    ...overrides,
  };
}

const request = (overrides: Partial<HiringPosition> = {}) =>
  position({ sourceId: "manual-7", source: "manual", status: "Requested", isOpen: false, createdDate: null, requestedAt: new Date(2026, 9, 27, 15, 30), ...overrides });

test("titles match loosely: case, punctuation and one containing the other", () => {
  assert.ok(titlesMatch("Controls Engineer", "controls engineer"));
  assert.ok(titlesMatch("Controls Engineer", "Controls Engineer II"));
  assert.ok(titlesMatch("Machine Builder - 2nd shift", "machine builder"));
  assert.ok(!titlesMatch("Controls Engineer", "Mechanical Engineer"));
  assert.ok(!titlesMatch("", "Controls Engineer"));
});

test("a request matches the posting with its title and hiring manager, published on or after the request day", () => {
  const posting = position({});
  assert.equal(findPostingForRequest(request(), [posting])?.sourceId, "1234");
  // Published the same day it was requested still counts.
  assert.equal(findPostingForRequest(request(), [position({ createdDate: "10/27/2026" })])?.sourceId, "1234");
});

test("an older posting for the same role does not close a new request for one more", () => {
  assert.equal(findPostingForRequest(request(), [position({ createdDate: "10/01/2026" })]), null);
});

test("a different hiring manager, or a different title, is not a match", () => {
  assert.equal(findPostingForRequest(request(), [position({ hiringManagerIds: ["48009999"] })]), null);
  assert.equal(findPostingForRequest(request(), [position({ title: "Mechanical Engineer" })]), null);
});

test("a request with no hiring manager falls back to the same team", () => {
  const r = request({ hiringManagerIds: [] });
  assert.equal(findPostingForRequest(r, [position({ hiringManagerIds: [] })])?.sourceId, "1234");
  assert.equal(findPostingForRequest(r, [position({ department: "mech" })]), null);
});

test("only a request is matched, only against postings, earliest posting first", () => {
  assert.equal(findPostingForRequest(position({}), [position({})]), null);
  assert.equal(findPostingForRequest(request(), [request({ sourceId: "manual-8" })]), null);
  const later = position({ sourceId: "2000", createdDate: "10/30/2026" });
  const earlier = position({ sourceId: "1999", createdDate: "10/28/2026" });
  assert.equal(findPostingForRequest(request(), [later, earlier])?.sourceId, "1999");
});

test("days waiting count calendar days", () => {
  const now = new Date(2026, 9, 29, 9, 0);
  assert.equal(daysSince(new Date(2026, 9, 29, 8, 0), now), 0);
  assert.equal(daysSince(new Date(2026, 9, 28, 23, 0), now), 1);
  assert.equal(waitingLabel(new Date(2026, 9, 29), now), "today");
  assert.equal(waitingLabel(new Date(2026, 9, 28), now), "1 day ago");
  assert.equal(waitingLabel(new Date(2026, 9, 19), now), "10 days ago");
  assert.equal(waitingLabel(null, now), "");
});

test("the hiring manager list is the active team leads who are in Paylocity, by name", () => {
  const leads = teamLeadOptions([
    { name: "Zed Lead", paylocityId: "48000002", team: "mech", isLead: true, active: true },
    { name: "Amy Lead", paylocityId: "48000001", team: "controls", isLead: true, active: true },
    { name: "Not Lead", paylocityId: "48000003", team: "mech", isLead: false, active: true },
    { name: "Gone Lead", paylocityId: "48000004", team: "build", isLead: true, active: false },
    { name: "Temp Lead", paylocityId: "TEMP-1", team: "wire", isLead: true, active: true },
  ]);
  assert.deepEqual(leads.map((l) => l.name), ["Amy Lead", "Zed Lead"]);
});

// ── Source shape: the rules that need a session and a database to call ──────

const src = (rel: string) => readFileSync(join(__dirname, "..", "src", rel), "utf8");

test("a request never counts toward hiring totals", () => {
  const positions = src("lib/hiring-positions.ts");
  const manual = positions.slice(positions.indexOf("function toManualPosition"), positions.indexOf("export type HiringPositionsOptions"));
  assert.match(manual, /isOpen: false,/);
  assert.match(manual, /status: REQUEST_STATUS,/);
});

test("closing a request is gated, accepts only a request, and audits why it closed", () => {
  const actions = src("lib/hiring-actions.ts");
  const close = actions.slice(actions.indexOf("export async function closeHiringRequest"), actions.indexOf("// ── Openings:"));
  assert.match(close, /assertActionPermission\("employees:hiring:assign"\)/);
  const guard = close.indexOf("/^manual-(\\d+)$/.exec(sourceId)");
  const refusal = close.indexOf("if (!match) return { ok: false");
  const write = close.indexOf("deleteCreatedHiringPosition(id)");
  assert.ok(guard > 0 && refusal > guard && write > refusal, "the request-id check and its refusal must come before the delete");
  assert.match(close, /"hiring\.requestPosted" : "hiring\.requestWithdrawn"/);
  for (const field of ["postedAsJobId", "title", "department", "hiringManagerId", "quantity", "note", "requestedAt"]) {
    assert.match(close, new RegExp(`\\b${field}:`), `audit metadata keeps ${field}`);
  }
});

test("a request has no openings to fill or resize outside its own form", () => {
  const actions = src("lib/hiring-actions.ts");
  const filled = actions.slice(actions.indexOf("export async function setHiringFilled"), actions.indexOf("export async function setHiringPositionQuantity"));
  const quantity = actions.slice(actions.indexOf("export async function setHiringPositionQuantity"));
  assert.match(filled, /if \(manual\) return \{ ok: false/);
  assert.match(quantity, /if \(manual\) return \{ ok: false/);
});

test("the store only deletes from the created-positions table", () => {
  const store = src("lib/hiring-positions-store.ts");
  const fn = store.slice(store.indexOf("export async function deleteCreatedHiringPosition"));
  assert.match(fn.slice(0, 300), /DELETE FROM HiringPositionCreated WHERE id = \$\{id\}/);
});

test("only an editor gets the request form; a Paylocity posting never reaches it", () => {
  const drawer = src("components/HiringPositionDetailDrawer.tsx");
  assert.match(drawer, /\{isRequest \? \(\s*canAssign \? \(\s*<HiringRequestForm/);
  assert.match(src("components/HiringRequestForm.tsx"), /closeHiringRequest\(request\.sourceId, postedAsJobId\)/);
});
