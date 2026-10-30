import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The Hiring Positions list (2026-10-30): each row is one button that opens the
// position's panel, Paylocity rows included. Rows used to end in an "Edit" link
// and a Hide/Show control; hiding positions was removed. The group/department
// dropdowns belong to the position panel's "Move to". Pinned in the source, since
// the list is a client component with no render harness here.

const src = (rel: string) => readFileSync(join(__dirname, "..", "src", rel), "utf8");

test("the list no longer renders the move-to dropdowns inline", () => {
  assert.doesNotMatch(src("components/HiringPositionsList.tsx"), /HiringMoveToControl/);
});

test("each row is one button that opens the panel, whatever the source", () => {
  const list = src("components/HiringPositionsList.tsx");
  assert.doesNotMatch(list, /p\.source === "workbook" \?/, "rows must not branch on source");
  const rowButton = list.slice(list.indexOf("function RowButton("), list.indexOf("function GroupCard("));
  assert.match(rowButton, /<button\s+type="button"\s+onClick=\{\(\) => onSelect\(p\)\}/);
  assert.match(rowButton, /w-full/);
  // Both the Requested card and the posting cards render their rows through it.
  assert.equal(list.match(/<RowButton p=\{(r|p)\} onSelect=\{onSelect\}/g)?.length, 2);
  // The title is text inside the row, not a second (nested) button.
  const title = list.slice(list.indexOf("function RowTitle("), list.indexOf("function RowButton("));
  assert.doesNotMatch(title, /<button/);
  assert.doesNotMatch(title, /truncate/, "titles wrap, never get cut off");
});

test("no Edit link, hide control or Show hidden toggle is left", () => {
  const list = src("components/HiringPositionsList.tsx");
  assert.doesNotMatch(list, />\s*Edit\s*<\/button>/);
  assert.doesNotMatch(list, /HiringVisibilityControl/);
  assert.doesNotMatch(list, /Show hidden/);
  assert.doesNotMatch(list, /isVisible/);
});

test("the panel still offers Move to for a Paylocity position", () => {
  const drawer = src("components/HiringPositionDetailDrawer.tsx");
  // Requests take the first branch (2026-10-29); everything else is a posting.
  const postingBranch = drawer.slice(drawer.indexOf("{isRequest ? ("));
  assert.match(postingBranch, /\) : \(\s*<div className="flex flex-col">[\s\S]{0,400}<HiringMoveToControl/);
});

test("the Org chart's open positions wrap long titles rather than cutting them off (2026-10-30)", () => {
  const dropdown = src("components/OpenPositionsDropdown.tsx");
  assert.doesNotMatch(dropdown, /\btruncate\b/);
  assert.match(dropdown, /min-w-0 flex-1 break-words/);
});
