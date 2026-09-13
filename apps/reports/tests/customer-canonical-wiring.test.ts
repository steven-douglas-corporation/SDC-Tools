import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── The chart, the drill and the resolver must stay wired together ──────────
//
// customer-canonical.test.ts proves the RULES are right. These tests guard the
// three ways canonical grouping comes undone in the wiring around it, none of
// which shows up in a diff as anything but a renamed variable:
//
//   1. The chart going back to grouping (or keying, or drilling) on a customer
//      NAME. Two canonical customers can display the same dominant spelling, and
//      the whole 2026-08-28 collation bug was one side identifying a bar
//      differently from the other. The id is the contract.
//   2. A second grouping expression appearing somewhere — an inline
//      `.toUpperCase()`, a local alias table, a `customer ===` comparison in a
//      component. That is how the app ends up with two answers to "who is the
//      customer", which is what the old no-fuzzy-merging comment was rightly
//      afraid of.
//   3. The stored spelling being dropped from the drill-through. Grouping fixes
//      the chart; hiding the raw value is what would turn a data-quality problem
//      into a permanent one.

const SRC = join(import.meta.dirname, "..", "src");
const read = (...p: string[]) => readFileSync(join(SRC, ...p), "utf8");

const OVERVIEW = read("lib", "dashboard-overview.ts");
const DRILL = read("lib", "dashboard-job-drill.ts");
const BARS = read("components", "dashboard", "CustomerBars.tsx");
const SECTION = read("components", "dashboard", "ActiveJobsSection.tsx");
const PANEL = read("components", "dashboard", "JobDrillPanel.tsx");
const DATA_QUALITY = read("lib", "data-quality.ts");

test("the chart and the drill both group through canonicalCustomerKey", () => {
  for (const [name, src] of [
    ["dashboard-overview.ts", OVERVIEW],
    ["dashboard-job-drill.ts", DRILL],
  ] as const) {
    assert.match(src, /canonicalCustomerKey\(/, `${name} must resolve customers through the shared function`);
    assert.match(
      src,
      /from "@\/lib\/customer-canonical"/,
      `${name} must import it from the shared module, not redefine it`,
    );
  }
});

test("the drill narrows on the canonical id, never on a customer name", () => {
  assert.match(
    DRILL,
    /canonicalCustomerKey\(j\)\.canonicalCustomerId === filter\.value/,
    "the customer drill must compare canonical ids",
  );
  assert.doesNotMatch(
    DRILL,
    /customerBucket\(j\.customer\) === filter\.value/,
    "narrowing by stored name is the bug this replaced — a bar of 24 would open a table of 12",
  );
});

test("the chart rows are keyed and opened by canonical id", () => {
  assert.match(BARS, /key=\{c\.canonicalCustomerId\}/, "React key must be the id, not the label");
  assert.match(BARS, /isOpen\(c\.canonicalCustomerId\)/);
  assert.match(BARS, /onOpen\(c\.canonicalCustomerId\)/);
  assert.doesNotMatch(BARS, /onOpen\(c\.name\)/, "opening a drill by label cannot identify a bar unambiguously");
});

test("the section looks the clicked bar up by id, for both its count and its heading", () => {
  // expectedCount is what makes a bar/table mismatch visible in the UI. Looking
  // it up by name would silently return 0 for any relabelled customer, and the
  // panel would then claim the chart said 0.
  const byId = SECTION.match(/c\.canonicalCustomerId === drill\.filter!\.value/g) ?? [];
  assert.equal(byId.length, 2, "both expectedCount and label must resolve the row by canonical id");
  assert.doesNotMatch(SECTION, /c\.name === drill\.filter!\.value/);
});

test("no component re-implements customer grouping", () => {
  // The rule lives in one module. A component that starts normalizing customer
  // text itself is a second definition of the customer, which is exactly what
  // the Dashboard used to (correctly) refuse to have. Only the customer-facing
  // expressions are checked \u2014 a class name like "text-sdc-navy" is not a
  // customer name, and asserting on bare brand words would fail on every file.
  for (const [name, src] of [
    ["CustomerBars.tsx", BARS],
    ["ActiveJobsSection.tsx", SECTION],
    ["JobDrillPanel.tsx", PANEL],
  ] as const) {
    assert.doesNotMatch(
      src,
      /(customer|rawCustomer|\.name)[^\n]*\.to(Upper|Lower)Case\(\)/i,
      `${name} must not normalize customer text itself`,
    );
    assert.doesNotMatch(
      src,
      /"(FIRST SOLAR[^"]*|First Solar[^"]*|Steven Douglas[^"]*|SDC)"/,
      `${name} must not hardcode a customer name \u2014 the registry owns those`,
    );
  }
});

test("the canonical layer is shared, not dashboard-specific", () => {
  const MODULE = read("lib", "customer-canonical.ts");
  // No prisma, no server-only, no React, and no import from a dashboard module:
  // those are what would pin it to one page. It has to be callable from the
  // Projects page, an export, or the next chart. (Its PROSE names the dashboard
  // freely \u2014 that is history, not a dependency, so only imports are checked.)
  const imports = MODULE.split("\n").filter((l) => /^\s*import\s/.test(l)).join("\n");
  assert.doesNotMatch(imports, /@\/lib\/prisma/);
  assert.doesNotMatch(MODULE, /"server-only"/);
  assert.doesNotMatch(imports, /from "react"/);
  assert.doesNotMatch(imports, /dashboard/i, "the shared customer layer must not import a dashboard module");
  // And the dependency has to point the other way round, or it is not shared.
  assert.match(OVERVIEW, /from "@\/lib\/customer-canonical"/);
});

test("the drill-through carries the STORED customer value on every row", () => {
  assert.match(DRILL, /rawCustomer: customerBucket\(j\.customer\)/, "each row must report its stored spelling");
  assert.match(PANEL, /r\.rawCustomer/, "the panel must render it, or a merge cannot be checked");
  assert.match(PANEL, /"Stored As"/, "and it needs a column header saying what it is");
});

test("aliasing is reported on the Data Quality tab, not just quietly fixed", () => {
  assert.match(DATA_QUALITY, /customerAliasFindings/);
  assert.match(DATA_QUALITY, /customerNaming/);
  const PANEL_DQ = read("components", "DataQualityPanel.tsx");
  assert.match(PANEL_DQ, /dq\.customerNaming/, "the finding must actually be rendered");
  assert.match(PANEL_DQ, /reviewedWithoutSourceEvidence/, "merges without source evidence must be called out");
});

test("the chart tells the reader when a row combined several stored names", () => {
  assert.match(BARS, /rawNames\.length > 1/, "a combined row must be identifiable on the chart");
  assert.match(BARS, /Combined from/, "and it must name the spellings it combined");
});
