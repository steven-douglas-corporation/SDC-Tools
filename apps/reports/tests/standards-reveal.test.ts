import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  hideStandardSheet,
  readStandardsState,
  resetStandardsForTest,
  revealStandardSheet,
  serverStandardsState,
  subscribeStandards,
} from "../src/lib/standards-reveal";

// ── Standard Sheet visibility is a role check now (2026-08-18) ──────────────
//
// The password box and double-click gesture this file used to pin (§48) are
// gone: standard-sheet-gate.ts's isStandardSheetUnlocked()/
// assertStandardSheetUnlocked() read the signed-in user's ROLE
// (lib/permissions.ts) instead of a shared team password, so there is
// nothing left for a client-side "reveal" gesture to unlock. What's left,
// and still worth pinning, is the separate hide/show DISPLAY toggle (§76)
// for a tab that is already authorized, and the card action's own gating.

const SRC = join(import.meta.dirname, "..", "src");

function code(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");
}

const CARD_ACTION = code("lib", "standard-fees-card.ts");
const GATE_UI = code("components", "StandardsGate.tsx");
const CARD_UI = code("components", "StandardFeesCard.tsx");
const COLUMNS_UI = code("components", "EtcStandardColumns.tsx");
const ETC_PAGE = code("app", "(app)", "etc", "page.tsx");

beforeEach(() => resetStandardsForTest());

// ── Standard Sheet and Standard Fees hide/show together (§76) ───────────────

test("hidden defaults to false, so a fresh render never opens already-collapsed", () => {
  assert.equal(serverStandardsState().hidden, false);
  assert.equal(readStandardsState().hidden, false);
});

test("showing after a hide is instant, no request of any kind", () => {
  hideStandardSheet();
  revealStandardSheet();
  assert.deepEqual(readStandardsState(), { hidden: false });
});

test("hide and show are each idempotent — no duplicate notifications", () => {
  let notifications = 0;
  subscribeStandards(() => notifications++);
  hideStandardSheet();
  hideStandardSheet();
  hideStandardSheet();
  assert.equal(notifications, 1, "repeated hides must not wake subscribers again");
  revealStandardSheet();
  revealStandardSheet();
  assert.equal(notifications, 2, "one more notification for the one real change back");
});

test("every Standard Sheet consumer checks the same hidden flag", () => {
  assert.match(COLUMNS_UI, /if \(!std \|\| hidden\) return null;/, "EtcStandardCells must hide with the row's own data");
  assert.match(COLUMNS_UI, /if \(hidden\) return null;/, "StandardGrandCells must hide too");
  assert.match(COLUMNS_UI, /export function StandardHeaderVisible/, "the header blocks need the same gate");
  assert.match(CARD_UI, /&& !hidden/, "the card's own show formula must veto on hidden");
});

test("the header blocks in the grid are wrapped, not left to hide alone", () => {
  const occurrences = ETC_PAGE.match(/<StandardHeaderVisible>/g) ?? [];
  assert.equal(occurrences.length, 2, "both header blocks (the banner and the leaf labels) must be wrapped");
});

test("hiding never clears the card's already-fetched figures", () => {
  assert.doesNotMatch(CARD_UI, /hidden[\s\S]{0,80}setData\(null\)/, "hiding must not discard cached figures");
  assert.doesNotMatch(CARD_UI, /setData\(null\)[\s\S]{0,80}hidden/, "…in either order");
});

test("the toggle button handles its own click and never lets the form submit", () => {
  const toggle = GATE_UI.slice(GATE_UI.indexOf("export function StandardsVisibilityToggle"));
  assert.match(toggle, /e\.preventDefault\(\)/, "the client handler must suppress the form submission");
  assert.match(toggle, /hideStandardSheet\(\)/);
  assert.match(toggle, /revealStandardSheet\(\)/);
  assert.doesNotMatch(toggle, /revalidatePath|router\.(push|refresh)/, "the toggle itself must never trigger a re-render");
});

test("the toolbar still carries the no-JS fallback through", () => {
  assert.match(ETC_PAGE, /<StandardsVisibilityToggle lockAction=\{lockStandardSheet\}/);
});

test("the button and the panel can never stay stuck loading", () => {
  assert.match(CARD_UI, /\.finally\(/, "the card's load must clear its indicator on every path");
  assert.match(CARD_UI, /Try again/, "…and offer a way forward after a failure");
});

// ── The card loads only itself, and only when allowed ───────────────────────

test("the card's data action is gated before it reads anything", () => {
  // A server action is directly callable by anyone who captures its id, so the role
  // check is the actual boundary — not the page deciding whether to render.
  const first = CARD_ACTION.slice(CARD_ACTION.indexOf("export async function getStandardFeesCard"));
  const guardAt = first.indexOf("assertStandardSheetUnlocked");
  const readAt = Math.min(
    ...["prisma.", "loadEffectivePools", "newProjectsEnteringMonth", "checkMonthlyReport"]
      .map((s) => first.indexOf(s))
      .filter((i) => i >= 0),
  );
  assert.ok(guardAt > 0, "the action must assert the gate");
  assert.ok(guardAt < readAt, "…before it reads a single figure");
});

test("the confidential figures are not sent to an unauthorized visitor", () => {
  assert.match(ETC_PAGE, /initialData=\{\s*showStandards\s*\?/, "initialData must be gated on the server check");
  assert.match(ETC_PAGE, /:\s*null\s*\}/, "…and be null otherwise");
});

test("the card asks for its own inputs and nothing else", () => {
  for (const forbidden of ["getEtcMonthJobWhere", "buildKpiBlocks", "getPartsCost", "groupHoursRows"]) {
    assert.ok(!CARD_ACTION.includes(forbidden), `the card action must not pull in ${forbidden}`);
  }
});

test("one definition of the four pools", () => {
  const meta = code("lib", "pool-panel-meta.ts");
  assert.match(meta, /ENGINEERING_PM/);
  assert.match(ETC_PAGE, /from "@\/lib\/pool-panel-meta"/, "the page must import it");
  assert.doesNotMatch(ETC_PAGE, /const POOL_PANEL_META = \[/, "…not declare a second copy");
  assert.match(CARD_ACTION, /from "@\/lib\/pool-panel-meta"/);
});
