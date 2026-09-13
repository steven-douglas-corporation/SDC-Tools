import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── The Active Work chart row (2026-08-31) ─────────────────────────────────
//
// Two cards that size INDEPENDENTLY and align at the top:
//
//   * Project Type hugs its six rows. No height, no min-height, no filler.
//   * Customer carries its own ceiling and scrolls inside it, so the dashboard
//     does not grow with the customer count.
//
// Both halves have been wrong once, in opposite directions, which is why they
// are pinned:
//
//   * `flex-1 min-h-0` alone capped nothing — the customer card went 565px at 21
//     customers to 1058px at 41 and the list never scrolled, because min-h-0
//     only lets a flex item shrink, it does not stop the container growing.
//   * Fixing that with a shared fixed height on BOTH sections then forced the
//     six-row type card to 510px, leaving a third of a card of blank space under
//     Head Start.

const SRC = join(import.meta.dirname, "..", "src");
const read = (...p: string[]) => readFileSync(join(SRC, ...p), "utf8");

/**
 * Comments stripped from every source read here.
 *
 * These files DOCUMENT the classes they no longer use — "not the default
 * items-stretch", "no longer h-full" — so a `doesNotMatch` over the raw text
 * fails on the very prose explaining the rule. Twice now. Read the code.
 *
 * The `[^:]` guard on the line-comment pattern is so a `https://` inside a
 * string is not mistaken for one, matching stripNoise in client-boundary.test.ts.
 */
const codeOf = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const SECTION = codeOf(read("components", "dashboard", "ActiveJobsSection.tsx"));
const BARS = codeOf(read("components", "dashboard", "CustomerBars.tsx"));
const CSS = codeOf(read("app", "globals.css"));

test("the two cards are NOT forced to a shared height", () => {
  assert.doesNotMatch(SECTION, /CHART_SECTION/, "the shared-height constant must be gone");
  assert.doesNotMatch(SECTION, /chart-card-row/, "so must the shared-height class");
  assert.doesNotMatch(CSS, /\.chart-card-row/, "and its rule");
});

test("the sections align at the top instead of stretching to match", () => {
  assert.match(SECTION, /grid items-start gap-6 xl:grid-cols-/, "items-start, not the default items-stretch");
  assert.doesNotMatch(SECTION, /items-stretch/, "stretch is what made the short card as tall as the tall one");
});

test("the Project Type card has no height, no min-height and no filler", () => {
  // Everything that could reserve space under Head Start.
  assert.match(SECTION, /<Frame>/, "the card takes no sizing className at all");
  assert.doesNotMatch(SECTION, /flex-1 bg-white/, "the white filler must be gone");
  assert.doesNotMatch(SECTION, /aria-hidden \/>/, "no leftover spacer element");
  assert.doesNotMatch(SECTION, /min-h-\[/, "no min-height anywhere in the section");
  // Both <section>s carry layout classes only — no height of any kind. Checked
  // on the section elements rather than over the whole file, because `h-full` is
  // used legitimately inside a chart for the bar fill within its track.
  const sections = SECTION.match(/<section className="[^"]*"/g) ?? [];
  assert.equal(sections.length, 2);
  for (const tag of sections) {
    assert.equal(tag, '<section className="flex min-w-0 flex-col"', "a section must not size itself");
  }
});

test("the Project Type shell still keeps its rows at their natural height", () => {
  // Flex, not grid: a grid distributes spare height across auto rows, so if this
  // card is ever given a height again the rows would stretch silently rather
  // than the card simply being too tall.
  const frame = SECTION.slice(SECTION.indexOf("function Frame"), SECTION.indexOf("function SectionHead"));
  assert.match(frame, /flex flex-col gap-px/);
  assert.doesNotMatch(frame, /\bgrid\b/);
  // And nothing in the shell reserves height.
  assert.doesNotMatch(frame, /h-full|min-h-|flex-1/);
});

test("the customer card owns its own ceiling", () => {
  assert.match(CSS, /\.customer-chart-cap\s*\{[^}]*max-height: clamp\(/, "a max-height, defined once in CSS");
  assert.doesNotMatch(CSS, /\.customer-chart-cap\s*\{[^}]*[^-]height: clamp\(/, "a fixed height would reintroduce blank space");
  // The card's own root: carries the cap, can shrink under it, and takes no
  // height from a parent. (`h-full` elsewhere in this file is a bar fill inside
  // its track, which is a different thing entirely.)
  const cardRoot = (BARS.match(/<div className="customer-chart-cap[^"]*"/) ?? [""])[0];
  assert.match(cardRoot, /customer-chart-cap flex min-h-0 flex-col/, "the card applies the cap and can shrink under it");
  assert.doesNotMatch(cardRoot, /\bh-full\b/, "the card must not take its height from a parent any more");
});

test("the ceiling does not depend on how many customers there are", () => {
  const rule = CSS.slice(CSS.indexOf(".customer-chart-cap"), CSS.indexOf(".customer-chart-cap") + 200);
  assert.doesNotMatch(rule, /fit-content|max-content|min-content/);
  assert.match(rule, /clamp\(22rem, calc\(100vh - 26rem\), 34rem\)/, "viewport-relative, never data-relative");
});

test("the customer list still scrolls internally, with a fixed legend and footer", () => {
  assert.match(BARS, /min-h-0 flex-1 divide-y[^"]*overflow-y-auto/, "the row list is the one scrolling region");
  assert.match(BARS, /flex shrink-0 flex-wrap items-center/, "the legend must not shrink away");
  assert.match(BARS, /<p className="shrink-0 border-t/, "the footer must not shrink away");
});

test("Top 10 / Top 15 / All are still gone, and every customer is rendered", () => {
  assert.doesNotMatch(BARS, /TOP_CHOICES|Top \{n\}|scope/);
  assert.doesNotMatch(BARS, /customers\.slice\(/);
  assert.match(BARS, /\{customers\.map\(\(c\) => \(/);
});

test("the preserved behaviour is still wired", () => {
  assert.match(BARS, /key=\{c\.canonicalCustomerId\}/);
  assert.match(BARS, /onOpen\(c\.canonicalCustomerId\)/);
  assert.match(BARS, /jobTypeColor\(/, "stacked segments keep the shared brand colours");
  assert.match(BARS, /rawNames\.length > 1/, "the combined-names signal is kept");
  assert.match(SECTION, /kind: "customer", value: id/, "the customer drill-through is unchanged");
  // Head Start keeps its own styling and its link out.
  assert.match(SECTION, /href="\/jobs\?status=HeadStart"/);
  assert.match(SECTION, /bg-sdc-yellow-bg\/40/);
});
