import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── "Parts Cost Actual" says what it is on hover (2026-10-19) ────────────────
//
// The Projects tab shows "quoted / actual" in one Parts Cost column, and "actual" was read as the
// job's parts cost. It is the parts invoiced and posted so far — it leaves out open POs that are
// ordered but not yet invoiced (1160: $199,505 here, $260,090 committed, $268,751 projected on the
// Parts Cost card). A native tooltip on the column header and on the actual figure says so.

const SRC = readFileSync(join(import.meta.dirname, "..", "src", "app", "(app)", "quoted", "page.tsx"), "utf8").replace(/\r\n/g, "\n");
const code = SRC.replace(/^\s*\/\/.*$/gm, "");

function constant(name: string): string {
  const m = new RegExp(`const ${name} =\\s*\\n?\\s*(["\`])([\\s\\S]*?)\\1;`).exec(code);
  assert.ok(m, `${name} must exist`);
  return m[2];
}

test("both tooltips exist and say what the figure is and is not", () => {
  for (const name of ["PARTS_ACTUAL_TIP", "PARTS_COST_HEADER_TIP"]) {
    const tip = constant(name);
    assert.match(tip, /invoiced and posted/i, `${name}: what it is`);
    assert.match(tip, /transferred between jobs/i, `${name}: transfers are in it`);
    assert.match(tip, /open POs/i, `${name}: what it leaves out`);
    assert.match(tip, /not (yet invoiced|invoiced)/i, `${name}: why they are left out`);
    assert.match(tip, /Parts Cost card on Job Details/, `${name}: where to see the full cost`);
    assert.match(tip, /not the full or final cost/i, `${name}: the warning`);
  }
});

test("the column header carries the header tooltip", () => {
  assert.match(code, /<th rowSpan=\{3\} title=\{PARTS_COST_HEADER_TIP\} className=\{`\$\{PARTS_COST_COL_CLASS\}/);
});

test("the actual figure — and only the actual half — carries the cell tooltip", () => {
  assert.match(code, /<span className="actual-suffix inline-flex items-center gap-0\.5 text-sdc-green-text" title=\{PARTS_ACTUAL_TIP\}>/);
  assert.equal((code.match(/title=\{PARTS_ACTUAL_TIP\}/g) ?? []).length, 1, "once, on the actual half");
  const quoted = code.slice(code.indexOf('<span className="parts-cost-quoted'), code.indexOf('<span className="actual-suffix'));
  assert.doesNotMatch(quoted, /title=/, "the quoted half has no tooltip of its own");
});

test("the figure itself is untouched: same field, same label, same rounding, still editable", () => {
  assert.match(code, /name=\{`jobField__\$\{job\.id\}__costActualHistorical`\}/);
  assert.match(code, /defaultValue=\{job\.costActualHistorical != null \? Number\(job\.costActualHistorical\)\.toString\(\) : ""\}/);
  assert.match(code, /ariaLabel=\{`Parts Cost Actual, \$\{job\.jobName\}`\}/);
  assert.match(code, /className=\{MONEY_INPUT_PAIRED\}\s*\n\s*maxFractionDigits=\{0\}/);
});

test("the tooltip wording matches what the Parts Cost card actually shows", () => {
  const card = readFileSync(join(import.meta.dirname, "..", "src", "components", "PartsCostSummary.tsx"), "utf8");
  assert.match(card, /GL-posted parts spend, all POs, lifetime/, "the card's Invoiced row is the same measure the tooltip names");
  assert.match(card, /label: "Left to invoice"/, "and the open POs the tooltip says are left out are the card's Left to invoice row");
});
