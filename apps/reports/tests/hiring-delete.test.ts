import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Deleting a hiring position (2026-10-27). Managers use positions created in SDC
// Reports as requests and want to withdraw one that is no longer needed. A Paylocity
// position must never be deletable here: the app doesn't own it, and the next
// warehouse load would bring it back. These pin that rule in the source, since the
// action needs a session and a database to call directly.

const src = (rel: string) => readFileSync(join(__dirname, "..", "src", rel), "utf8");
const actions = src("lib/hiring-actions.ts");
const deleteAction = actions.slice(actions.indexOf("export async function deleteHiringPosition"), actions.indexOf("// ── Openings:"));

test("delete is gated by the Manage Hiring Positions permission", () => {
  assert.match(deleteAction, /assertActionPermission\("employees:hiring:assign"\)/);
});

test("delete accepts only a created position's id and refuses anything else before touching the database", () => {
  const guard = deleteAction.indexOf("/^manual-(\\d+)$/.exec(sourceId)");
  const refusal = deleteAction.indexOf("if (!match) return { ok: false");
  const write = deleteAction.indexOf("deleteCreatedHiringPosition(id)");
  assert.ok(guard > 0 && refusal > guard && write > refusal, "the manual-id check and its refusal must come before the delete");
});

test("delete is written to the audit log with what the position said", () => {
  assert.match(deleteAction, /action: "hiring\.positionDeleted"/);
  for (const field of ["title", "jobStatus", "workforceGroup", "department", "quantity", "filledCount"]) {
    assert.match(deleteAction, new RegExp(`\\b${field}:`), `audit metadata keeps ${field}`);
  }
});

test("the store only deletes from the created-positions table", () => {
  const store = src("lib/hiring-positions-store.ts");
  const fn = store.slice(store.indexOf("export async function deleteCreatedHiringPosition"));
  assert.match(fn.slice(0, 300), /DELETE FROM HiringPositionCreated WHERE id = \$\{id\}/);
});

test("only the created-position edit form offers Delete", () => {
  const drawer = src("components/HiringPositionDetailDrawer.tsx");
  const form = drawer.slice(drawer.indexOf("function ManualEditForm"), drawer.indexOf("export function HiringPositionDetailDrawer"));
  const rest = drawer.slice(drawer.indexOf("export function HiringPositionDetailDrawer"));
  assert.match(form, /deleteHiringPosition\(position\.sourceId\)/);
  assert.doesNotMatch(rest, /deleteHiringPosition\(/, "the read-only / Paylocity branch must not call delete");
  assert.match(rest, /position\.source === "manual" && canAssign \? \(\s*<ManualEditForm/);
});
