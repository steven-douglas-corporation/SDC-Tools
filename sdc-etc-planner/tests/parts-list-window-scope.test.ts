import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Parts List invoiced-window fix: scope guards (2026-08-09) ────────────────
//
// No React test renderer exists in this repo (see tests/job-procurement-
// collapse.test.ts's own note) — this asserts on source structure, the same
// treatment that file and tests/drill-design.test.ts give their own files.
// The one thing worth a real regression guard here: the blast-radius scan
// behind this fix concluded RiskCards/PartsCardView/PoPanel never need to know
// about the windowed-invoiced state at all (they read dates/status/PO data,
// never invoicedAmount-derived fields) — pinning that so a future edit doesn't
// casually widen the window state's reach into places that were deliberately
// left alone.

const SRC = join(import.meta.dirname, "..", "src");
const strip = (raw: string) =>
  raw
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");

const RAW = readFileSync(join(SRC, "components", "JobProcurement.tsx"), "utf8");
const CODE = strip(RAW);

// The FlatPart type + flatten-and-join logic (2026-08-17) live in po-detail.ts
// now, shared with the Build Readiness PO drawer — moved out of
// JobProcurement.tsx, not rewritten, so the same source-shape guards apply
// against their new home.
const PO_DETAIL_CODE = strip(readFileSync(join(SRC, "lib", "po-detail.ts"), "utf8"));
// PoPanel itself moved the same way, into the shared drawer component.
const PO_PANEL_CODE = strip(readFileSync(join(SRC, "components", "procurement", "PoDetailPanel.tsx"), "utf8"));

function functionBody(code: string, name: string, fileLabel: string): string {
  const start = code.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in ${fileLabel}`);
  const nextFn = code.indexOf("\nfunction ", start + 1);
  return nextFn === -1 ? code.slice(start) : code.slice(start, nextFn);
}

test("pctInvoiced and leftToSpend are nullable — a windowed figure isn't mixed with a lifetime one", () => {
  assert.match(PO_DETAIL_CODE, /pctInvoiced: number \| null/, "pctInvoiced must be nullable");
  assert.match(PO_DETAIL_CODE, /leftToSpend: number \| null/, "leftToSpend must be nullable");
});

test("invoicedAmount is drawn from the window attribution, not just the lifetime PartsCostLine, when a window is active", () => {
  const fnBody = functionBody(PO_DETAIL_CODE, "flattenBomParts", "po-detail.ts");
  assert.match(fnBody, /activeAttribution\?\.byPartNumber\.get\(normPn\(p\.pn\)\)/, "a windowed row must look up its own part number in the attribution map");
});

test("row inclusion for Invoiced+range switches off the resolved window's invoicedAmount, not the stale single-date field", () => {
  const fnBody = functionBody(CODE, "PartsListTab", "JobProcurement.tsx");
  assert.match(fnBody, /windowStatus\.active/, "the date-inclusion branch must consult whether a window is actually active");
  assert.match(fnBody, /p\.invoicedAmount === 0/, "a windowed row is excluded by zero invoiced amount, not by its collapsed lifetime invoicedDate");
});

// ── Every date mode is a plain single field (2026-08-14, generalised 2026-09-10) ──
//
// This used to transcribe the four-mode ternary chain verbatim. Adding a fifth
// mode ("delivered") broke it — and broke it for a change that is precisely what
// the guard exists to permit: one more mode resolving to one more plain date
// field. A guard that goes red for the thing it was written to allow is the
// failure mode procurement-uncovered-consistency.test.ts's own header describes.
//
// So it asserts the INVARIANT rather than the transcript: every mode in
// `PartsDateFilter` appears in the chain, each resolves to its own distinct
// `p.<x>Date`, and nothing in the chain reaches for windowed-invoiced state.
// Stronger than the literal regex was — that version could not have caught a
// mode added to the type and forgotten in the chain — and a sixth mode needs no
// edit here.
test("every date-range mode resolves to its own plain date field — none picks up windowed-invoiced logic", () => {
  const fnBody = functionBody(CODE, "PartsListTab", "JobProcurement.tsx");

  // The chain, up to the semicolon that ends it. Newlines normalised: this repo's
  // files are CRLF, and a `\n`-anchored pattern silently matches nothing on them.
  const chain = fnBody.replace(/\r\n/g, "\n").match(/const d =\s*([\s\S]*?);/);
  assert.ok(chain, "the date-inclusion branch must still be one `const d = ...` chain");
  const body = chain[1];

  const declared = CODE.match(/type PartsDateFilter = ([^;]+);/);
  assert.ok(declared, "PartsDateFilter must be the one named list of modes");
  const modes = [...declared[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.ok(modes.length >= 4, "sanity: the mode list parsed");

  // Each arm is a bare field read — no call, no arithmetic, no window state. One
  // mode is the chain's fallback and so has no `dateType ===` test of its own;
  // that is why this counts fields against modes rather than requiring a test per
  // mode. A mode added to the type and forgotten in the chain fails the count.
  const tested = [...body.matchAll(/dateType === "(\w+)" \? (p\.\w+)/g)];
  const fallback = body.match(/:\s*(p\.\w+)\s*$/);
  assert.ok(fallback, "the chain must end in a plain fallback field");

  const missing = modes.filter((m) => !tested.some((t) => t[1] === m));
  assert.equal(
    missing.length,
    1,
    `exactly one mode may be the unnamed fallback; ${missing.length === 0 ? "none is" : `these are unhandled: ${missing.join(", ")}`}`,
  );
  // The fallback mode must still be identifiable to a reader — RAW, not CODE,
  // because `strip` removes the trailing comment that names it.
  assert.match(
    RAW,
    new RegExp(`${fallback[1].replace(".", "\\.")};\\s*// "${missing[0]}"`),
    `the fallback arm must say which mode it serves ("${missing[0]}")`,
  );

  const all = [...tested.map((t) => t[2]), fallback[1]];
  assert.equal(all.length, modes.length, `expected one plain field per mode, got ${all.length} for ${modes.length} modes`);
  assert.equal(new Set(all).size, all.length, `two modes resolve to the same field: ${all.join(", ")}`);
  for (const f of all) {
    assert.match(f, /^p\.\w+Date$/, `${f} is not a plain date field on the row`);
  }

  // The whole point: the lifetime/windowed split is decided ABOVE this chain by
  // `windowStatus.active`, and must never leak into it.
  for (const forbidden of ["windowStatus", "activeAttribution", "invoicedAmount", "attributeInvoicedWindow"]) {
    assert.doesNotMatch(body, new RegExp(forbidden), `${forbidden} must not appear inside the plain-date chain`);
  }
});

test("the footer reconciliation row is gated on an active window and a non-zero unattached amount", () => {
  const fnBody = functionBody(CODE, "PartsTableView", "JobProcurement.tsx");
  assert.match(
    fnBody,
    /windowStatus\.active && windowStatus\.unattachedAmount !== 0/,
    "the reconciliation row must not render for an unresolved window or a zero amount",
  );
  // The third condition — "and the Invoiced $ column is visible" — was dropped
  // 2026-09-02 along with the layout it existed for. The figure used to be rendered
  // into the Invoiced column's own cell, so with that column hidden there was
  // nothing to align it under. It now spans the table as its own strip and states
  // its amount inline, so it reads correctly whatever columns are on screen — and
  // hiding a column should not silently suppress a reconciliation figure whose
  // whole job is to stop money going unreported.
  assert.ok(
    !/cols\.some\(\(c\) => c\.key === "invoiced"\)/.test(fnBody),
    "the strip no longer depends on the Invoiced column being visible",
  );
});

// ── The footer is one row tall (2026-09-02) ────────────────────────────────
//
// The reconciliation sentence was rendered as an ordinary footer row, which put a
// twelve-word string into the FIRST column — `qty`, 52px, `overflow-hidden` — where
// it wrapped to ~10 lines and dragged every cell in the row to that height. On a
// sticky footer that is ~200px of the table permanently gone. The cause was one
// long string in the narrowest column, not the sticky positioning.

test("the reconciliation text spans the table instead of being poured into the first column", () => {
  const fnBody = functionBody(CODE, "PartsTableView", "JobProcurement.tsx");
  assert.match(fnBody, /colSpan=\{cols\.length\}/, "one spanning cell, so the sentence has room to be one line");
  assert.ok(
    !/idx === 0\s*\?\s*`Other invoiced/.test(fnBody),
    "it must not be placed in the first column's cell again",
  );
});

test("the totals row cannot grow past one line", () => {
  const fnBody = functionBody(CODE, "PartsTableView", "JobProcurement.tsx");
  const foot = fnBody.slice(fnBody.indexOf("<tfoot"));
  assert.match(foot, /className="h-7 border-t-2/, "a fixed one-row height");
  assert.match(foot, /whitespace-nowrap border-r border-white\/15/, "totals cells never wrap");
});

test("the reconciliation figure says it is outside the visible-row totals", () => {
  // Scope is the whole point of this line: the totals row sums the rows on screen
  // after every filter, while this covers the entire date window and is deliberately
  // not filtered. Two different questions that must not read as one number.
  const fnBody = functionBody(CODE, "PartsTableView", "JobProcurement.tsx");
  assert.match(fnBody, /not included in the totals above/);
  assert.match(fnBody, /rangeLabel \? ` in \$\{rangeLabel\}` : ""/, "the window it covers is named");
});

test("the Invoiced header stays short; the window is explained in the tooltip", () => {
  // "Invoiced $ (window)" in a 96px header truncated away the part that says what
  // the column is.
  assert.ok(!/label: "Invoiced \$ \(window\)"/.test(CODE), "the parenthetical must not return to the header");
  assert.match(CODE, /title: `Invoiced within \$\{windowedRangeLabel\}, not lifetime`/);
});

test("the financial columns are wide enough for their own headers", () => {
  // These were 72px, which cannot hold "Invoiced $" plus a sort chevron plus padding
  // at text-micro — the labels truncated into each other and the group read as one
  // smeared band. The table scrolls horizontally; it does not need to squeeze here.
  const start = CODE.indexOf("const DEFAULT_COL_WIDTH");
  const widths = CODE.slice(start, CODE.indexOf("};", start));
  const px = (key: string) => Number(widths.match(new RegExp(`\\b${key}: (\\d+)`))?.[1] ?? 0);
  for (const key of ["unit", "total", "invoiced", "leftspend"]) {
    assert.ok(px(key) >= 84, `${key} is ${px(key)}px — too narrow for a currency column and its header`);
  }
  assert.ok(px("leftspend") >= 100, "Left to Invoice has the longest header of the group");
  assert.ok(px("status") >= 130, "Status must fit DUE SOON in 2d");
});

test("the footer's leftToSpend/pctInvoiced totals render as unavailable, not a silently-wrong sum, when a window is active", () => {
  const fnBody = functionBody(CODE, "PartsTableView", "JobProcurement.tsx");
  assert.match(fnBody, /if \(p\.leftToSpend !== null\) a\.left \+= p\.leftToSpend/, "null rows must be skipped in the footer sum, not coerced to 0 silently");
  assert.match(fnBody, /windowStatus\.active \? "—" : usd\(tot\.left\)/, "the footer must show — rather than a sum that would always be $0 when windowed");
});

test("a job switch never applies a different job's cached window — the attribution is job-matched", () => {
  const fnBody = functionBody(CODE, "JobProcurement", "JobProcurement.tsx");
  assert.match(
    fnBody,
    /windowResult\.jobId === bom\.jobId && windowResult\.from === from && windowResult\.to === to/,
    "the cached window must be re-validated against the CURRENT job/from/to before being applied",
  );
});

test("RiskCards never references the windowed-invoiced state", () => {
  const fnBody = functionBody(CODE, "RiskCards", "JobProcurement.tsx");
  assert.doesNotMatch(fnBody, /windowStatus|activeAttribution|windowResult/, "RiskCards is about delivery risk/PO status, not money — it must stay untouched by this fix");
});

test("PartsCardView never references the windowed-invoiced state", () => {
  const fnBody = functionBody(CODE, "PartsCardView", "JobProcurement.tsx");
  assert.doesNotMatch(fnBody, /windowStatus|activeAttribution|windowResult/, "the Card view groups by supplier/PO — it must stay untouched by this fix");
});

test("PoPanel never references the windowed-invoiced state", () => {
  const fnBody = functionBody(PO_PANEL_CODE, "PoPanel", "PoDetailPanel.tsx");
  assert.doesNotMatch(fnBody, /windowStatus|activeAttribution|windowResult/, "the PO side panel computes its own independent PO Value figure — it must stay untouched by this fix");
});

// ── "Left to Invoice" (2026-09-02) ──────────────────────────────────────────
//
// The requested column — Total $ − Invoiced $, beside Invoiced $ — already
// existed, computed and summed correctly, under the name "Left to Spend" and
// hidden behind the Columns menu. What changed is the label, the position and the
// default visibility; the arithmetic is untouched, which is the point of these
// guards: it would be easy to "add" this column a second time and end up with two
// that disagree at the edges (the windowed-invoiced case in particular).

const PANEL = readFileSync(join(SRC, "components", "procurement", "PoDetailPanel.tsx"), "utf8");
const PROC = readFileSync(join(SRC, "components", "JobProcurement.tsx"), "utf8");
const PO_DETAIL_LIB = readFileSync(join(SRC, "lib", "po-detail.ts"), "utf8");

test("Left to Invoice is the existing leftToSpend field, not a second calculation", () => {
  // One subtraction, in one place. A duplicate would have to re-derive the
  // windowed-invoiced null rule too, and would eventually stop matching.
  //
  // That "one place" moved on 2026-09-03 and got stricter. This used to pin the
  // literal `totalPrice - invoicedAmount` written out here; the subtraction now lives
  // in lib/left-to-invoice.ts and this column CALLS it, because Monthly ETC's own copy
  // of the same expression had already drifted — it carried no month-end cutoff, so it
  // read $2,238,624.84 against this table's $2,137,726.85 through 08/31. Pinning the
  // shared call rather than the spelled-out arithmetic is the stronger version of the
  // same guard: the two cannot disagree if there is only one of them.
  assert.match(PANEL, /key: "leftspend", label: "Left to Invoice"/);
  assert.match(PO_DETAIL_LIB, /leftToSpend: activeAttribution \? null :[\s\S]{0,120}?lineLeftToInvoice\(l\)/);
  assert.match(PO_DETAIL_LIB, /import \{ lineLeftToInvoice \} from "@\/lib\/left-to-invoice";/);
  // The windowed-invoiced null rule still rides on the same expression, in both the
  // BOM and non-BOM branches — that is what "not a second calculation" protects.
  assert.equal((PO_DETAIL_LIB.match(/leftToSpend: activeAttribution \? null :/g) ?? []).length, 2);
  assert.ok(!/label: "Left to Spend"/.test(PANEL), "the old label must be gone");
});

test("it sits immediately after Invoiced $, before % Inv", () => {
  // ALL_COLS drives header order, body order, footer order and the Columns menu at
  // once, so position is asserted there rather than in four places.
  const cols = PANEL.slice(PANEL.indexOf("export const ALL_COLS"), PANEL.indexOf('{ key: "status"'));
  const at = (key: string) => cols.indexOf(`key: "${key}"`);
  assert.ok(at("total") < at("invoiced"), "Total $ before Invoiced $");
  assert.ok(at("invoiced") < at("leftspend"), "Invoiced $ before Left to Invoice");
  assert.ok(at("leftspend") < at("pctinv"), "Left to Invoice immediately after, ahead of % Inv");
});

test("the negative case is preserved rather than clamped", () => {
  // Over-invoicing is the reason to look at this column at all. A Math.max(0, …)
  // anywhere on this path would hide exactly the rows worth finding.
  assert.ok(
    !/Math\.max\(\s*0[^)]*leftToSpend/.test(PO_DETAIL_LIB) && !/leftToSpend[^;]*Math\.max\(\s*0/.test(PO_DETAIL_LIB),
    "leftToSpend must not be floored at zero",
  );
});

test("it is visible by default, and revealed once for anyone with stored columns", () => {
  // Dropping it from the defaults alone would have shipped the column to new users
  // and to nobody else: every user who has ever opened the Columns menu has
  // "leftspend" written into their stored hidden set from when it was hidden.
  assert.ok(!/DEFAULT_HIDDEN_COLS: ColKey\[\] = \[[^\]]*"leftspend"/.test(PROC), "not hidden by default");
  assert.match(PROC, /stored\.filter\(\(k\) => k !== "leftspend"\)/, "one-shot reveal for stored sets");
  assert.match(PROC, /saved\.leftToInvoiceShown/, "guarded by a marker so it cannot run twice");
  assert.match(PROC, /leftToInvoiceShown: true/, "the marker is persisted");
});

test("sorting and the filtered footer total come along unchanged", () => {
  // Both were already correct for this column; pinned because the rename touched
  // the label and it would be easy to renumber the key with it.
  assert.match(PANEL, /leftspend: \{ type: "currency", value: \(p\) => p\.leftToSpend \}/);
  // The footer sums the rows the table is showing, so it reconciles to what is on
  // screen under any filter — and skips the windowed case rather than summing nulls.
  assert.match(PROC, /if \(p\.leftToSpend !== null\) a\.left \+= p\.leftToSpend/);
  assert.match(PROC, /case "leftspend": return windowStatus\.active \? "—" : usd\(tot\.left\)/);
});
