import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The Hiring Positions list (2026-10-27): every row ends in one "Edit" link, Paylocity
// rows included. The group/department dropdowns used to sit inline on Paylocity rows;
// they belong to the position panel's "Move to" now. Pinned in the source, since the
// list is a client component with no render harness here.

const src = (rel: string) => readFileSync(join(__dirname, "..", "src", rel), "utf8");

test("the list no longer renders the move-to dropdowns inline", () => {
  assert.doesNotMatch(src("components/HiringPositionsList.tsx"), /HiringMoveToControl/);
});

test("every row's Edit link opens the panel, whatever the source", () => {
  const list = src("components/HiringPositionsList.tsx");
  assert.doesNotMatch(list, /p\.source === "workbook" \?/, "the row actions must not branch on source");
  assert.match(list, /onClick=\{\(\) => onSelect\(p\)\}[\s\S]{0,200}Edit\s*<\/button>/);
});

test("the panel still offers Move to for a Paylocity position", () => {
  const drawer = src("components/HiringPositionDetailDrawer.tsx");
  assert.match(drawer, /position\.source === "workbook" \? \(\s*<HiringMoveToControl/);
});
