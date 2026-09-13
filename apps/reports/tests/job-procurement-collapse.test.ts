import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Procurement parts drill-down: loose parts collapse too (§74) ────────────
//
// AssemblyRow already collapsed-by-default correctly (§53: `key={bom.jobId}` remounts
// AssembliesTab, and its own `collapsed` set starts as every assembly key). What did NOT
// collapse was a section's LOOSE parts — job-bom.ts's `section.parts`, the flattened-away
// top node's own direct children, which have no sub-assembly of their own to be gated by.
// Those rendered via an unconditional `{section.parts.length > 0 && <PartsDetailTable
// .../>}`, with no header, no caret, and no membership in `collapsed` — so a section with
// dozens of loose parts showed every one of them the moment the page loaded, regardless of
// Expand All/Collapse All or the "collapsed by default" the rest of the tree already had.
//
// No React test renderer exists in this repo (see the other tests/*.test.ts files: they
// assert on source structure, not mounted output), so this does the same — it is a
// regression guard against the unconditional-render pattern coming back, not a substitute
// for opening the report in a browser.

const SRC = join(import.meta.dirname, "..", "src");
const RAW = readFileSync(join(SRC, "components", "JobProcurement.tsx"), "utf8");

// Comments stripped, same treatment tests/drill-design.test.ts and
// tests/drill-filters.test.ts give their source files: this component's own comments
// describe the bug in the past tense, and a raw-text assertion would match the sentence
// explaining what must not be true rather than the code itself.
const CODE = RAW.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/[^\n]*$/gm, "")
  .replace(/\/\/[^\n"'`]*$/gm, "");

test("a section's loose parts no longer render unconditionally", () => {
  // The exact defect: PartsDetailTable invoked straight off `section.parts.length > 0`,
  // with no `isOpen`/`collapsed` check anywhere near it.
  assert.doesNotMatch(
    CODE,
    /section\.parts\.length > 0 && <PartsDetailTable/,
    "section.parts must be gated by a collapsible row, not rendered directly",
  );
});

test("the loose-parts row is keyed and joins the same collapsed set as every assembly", () => {
  assert.match(CODE, /function loosePartsKey\(section: BomNode\): string/, "a stable key per section's loose-parts group");
  // It has to land in `allKeys` — the set both `collapsed`'s initial state and Collapse
  // All are built from — or "collapsed by default" and "Collapse All" would both silently
  // skip it, exactly as they did before this key existed.
  assert.match(
    CODE,
    /if \(sec\.parts\.length > 0\) keys\.add\(loosePartsKey\(sec\)\)/,
    "the loose-parts key must be added alongside every assembly key",
  );
});

// LoosePartsRow's full body, sliced by the next top-level function declaration rather
// than a brace-counting regex — the destructured-props object and its type annotation
// each close with their own `}`, which defeats a lazy `[\s\S]*?\n\}` well before the
// function's actual end (it stops at the FIRST bare `}` line, which is the parameter
// list's own closing brace).
const LOOSE_PARTS_ROW = CODE.slice(
  CODE.indexOf("function LoosePartsRow("),
  CODE.indexOf("function PartsDetailTable("),
);

test("LoosePartsRow exists and takes collapsed/toggle as props, not separate state", () => {
  assert.ok(LOOSE_PARTS_ROW.startsWith("function LoosePartsRow("), "LoosePartsRow must exist");
  // The property that makes Expand All/Collapse All and "closing one must not open
  // others" hold for this row too: it has to share AssemblyRow's exact state, not a
  // parallel useState that Expand All doesn't know to touch.
  assert.match(LOOSE_PARTS_ROW, /collapsed: Set<string>/);
  assert.match(LOOSE_PARTS_ROW, /toggle: \(key: string\) => void/);
  assert.doesNotMatch(LOOSE_PARTS_ROW, /useState<Set<string>>/, "no second collapsed-set");
});

test("LoosePartsRow gates its table behind the SAME isOpen/collapsed mechanism AssemblyRow uses", () => {
  assert.match(LOOSE_PARTS_ROW, /const isOpen = !collapsed\.has\(keyId\)/, "openness reads off the shared `collapsed` set");
  assert.match(LOOSE_PARTS_ROW, /\{isOpen && <PartsDetailTable/, "the part rows must not mount until expanded");
});

test("the render site passes the loose-parts row through the shared collapsed/toggle, not a new mechanism", () => {
  assert.match(
    CODE,
    /<LoosePartsRow\s+keyId=\{loosePartsKey\(section\)\}\s+parts=\{section\.parts\}\s+depth=\{0\}\s+collapsed=\{collapsed\}\s+toggle=\{toggle\}/,
    "LoosePartsRow must be wired to the same collapsed/toggle AssemblyRow uses",
  );
});

test("Expand All and Collapse All are unchanged, and now cover the loose-parts keys too", () => {
  // Unchanged mechanism: both buttons still just set `collapsed` from `allKeys`, which
  // now includes the loose-parts keys (previous test) — no separate reset path was added
  // for the new row, which is what keeps one click still meaning "every row in the tree".
  assert.match(CODE, /onClick=\{\(\) => setCollapsed\(new Set\(\)\)\}[\s\S]{0,80}Expand All/);
  assert.match(CODE, /onClick=\{\(\) => setCollapsed\(new Set\(allKeys\)\)\}[\s\S]{0,80}Collapse All/);
});

// The toggle function, sliced to just before the next declaration (`const ghostBtn`)
// rather than a brace-counting regex — `toggle`'s body ends in `});`, not `};`, so a
// pattern anchored on `};` runs past it into everything that follows.
const TOGGLE_FN = CODE.slice(CODE.indexOf("const toggle = (key: string) =>"), CODE.indexOf("const ghostBtn ="));

test("expanding one assembly (or the loose-parts row) must not affect any other key", () => {
  // `toggle` mutates exactly one key in the Set and leaves the rest untouched — the
  // property behind "expanding one assembly must not open others". A single shared
  // implementation, used by both AssemblyRow and LoosePartsRow, is what guarantees this
  // rather than each row re-deriving it.
  assert.ok(TOGGLE_FN.length > 0 && TOGGLE_FN.length < 400, "the slice must land on just the toggle function");
  assert.match(TOGGLE_FN, /next\.delete\(key\)/);
  assert.match(TOGGLE_FN, /next\.add\(key\)/);
  assert.doesNotMatch(TOGGLE_FN, /new Set\(\)|\.clear\(\)/, "toggle must only touch the one key, never reset the whole set");
});

test("the loose-parts row still reports readiness and cost, computed from its own parts", () => {
  // Same four figures AssemblyRow shows (priced/total, received/total, cost, readiness
  // %), so collapsing the presentation into one row does not drop any of the totals the
  // requirement says to preserve.
  assert.match(LOOSE_PARTS_ROW, /parts\.filter\(\(p\) => p\.unitPrice > 0\)\.length/);
  assert.match(LOOSE_PARTS_ROW, /parts\.filter\(\(p\) => partStatus\(p, now\)\.key === "received"\)/);
  assert.match(LOOSE_PARTS_ROW, /parts\.reduce\(\(s, p\) => s \+ p\.unitPrice \* p\.qty, 0\)/);
  assert.match(LOOSE_PARTS_ROW, /<ReadinessBar pct=\{pct\} \/>/);
});
