import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Projects Edit Mode: Standard Fees column visibility is a role check now
// (2026-08-18), not tied to the Edit Mode toggle at all ──────────────────────
//
// Before this date, the four restricted columns (PM/Manufacturing/Warranty)
// followed a shared password AND the Edit Mode toggle together, which is what
// produced the bug this file used to pin: unlocking didn't always refresh the
// Sections picker's available columns, because the refresh was conditional on
// what was already selected.
//
// That whole class of bug is gone by construction now: `sectionAllowed` in
// quoted/page.tsx reads the signed-in user's Standard Fees permissions
// directly (lib/sections.ts's POOL_PERMISSION), computed once per render, with
// no cookie and no dependency on the Edit Mode switch. Flipping Edit Mode
// on/off changes nothing about which columns are rendered, so there is no
// router.refresh() left anywhere in ProjectsEditMode.tsx to get wrong.

const SRC = join(import.meta.dirname, "..", "src");

function code(path: string): string {
  const raw = readFileSync(path, "utf8");
  return raw
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");
}

const EDIT_MODE = code(join(SRC, "components", "ProjectsEditMode.tsx"));
const SECTIONS_MENU = code(join(SRC, "components", "ProjectsSectionsMenu.tsx"));
const QUOTED_PAGE = code(join(SRC, "app", "(app)", "quoted", "page.tsx"));

test("Edit Mode never triggers a server refresh — nothing rendered depends on it any more", () => {
  assert.doesNotMatch(EDIT_MODE, /router\.refresh\(\)/, "toggling Edit Mode must not re-render the route");
  assert.doesNotMatch(EDIT_MODE, /from ["']next\/navigation["']/, "no reason left to import useRouter here");
});

test("restricted-column visibility reads role permissions, not Edit Mode state", () => {
  assert.match(
    QUOTED_PAGE,
    /const sectionAllowed = \(code: string\) => \{/,
    "sectionAllowed must be a real function body, not a one-line `editingNow ||` shortcut",
  );
  assert.match(QUOTED_PAGE, /restrictedSectionPermission\(code\)/, "must resolve a code's specific Standard Fees permission");
  assert.match(QUOTED_PAGE, /hasPermission\(role, permission\)/, "must check the resolved permission against the signed-in role");
  assert.doesNotMatch(QUOTED_PAGE, /\beditingNow\b/, "column visibility must not reference the retired Edit Mode-derived flag");
});

test("ProjectsSectionsMenu no longer reads anything from ProjectsEditMode", () => {
  assert.doesNotMatch(
    SECTIONS_MENU,
    /useProjectsEditMode/,
    "the menu's available columns come from `phases`, computed once from role — it has no reason to read the edit-mode toggle",
  );
});

test("setPhase only ever touches its own phase's codes — Select All under one section must never reach into another's", () => {
  const setPhaseFn = SECTIONS_MENU.slice(SECTIONS_MENU.indexOf("function setPhase"), SECTIONS_MENU.indexOf("return (", SECTIONS_MENU.indexOf("function setPhase")));
  assert.match(setPhaseFn, /const phaseCodes = spec\.sections\.map/, "must derive the codes to add/remove from THIS call's own phase spec");
  assert.match(setPhaseFn, /cols\.filter\(\(c\) => !phaseCodes\.includes\(c\)\)/, "must only strip this phase's own codes out of the rest, never another phase's");
});
