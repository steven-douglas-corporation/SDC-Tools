import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTransferRows,
  transferRowsShown,
  transferFooterAdd,
  transferExportValue,
  hiddenTransfersNote,
} from "../src/lib/parts-list-transfer-rows";
import type { JobTransferEntry } from "../src/lib/parts-transfer-netting";

// ── Parts moved between jobs, as rows of the Parts List (2026-10-14) ─────────
//
// The Parts List is PO lines; a transfer is inventory pulls, so the table's footer disagreed
// with the Parts Cost card that already nets it. One pinned row per counterpart job closes
// that, adds the same figure to Total $ and Invoiced $ and nothing to Left to Invoice, shows
// only in the plain whole-job view, and rides along in the export.

const out1160: JobTransferEntry = { direction: "out", otherJob: "1160", amount: -20463.08, transfers: 126, lastDay: "2026-08-24" };
const in1155: JobTransferEntry = { direction: "in", otherJob: "1155", amount: 20406.07, transfers: 126, lastDay: "2026-08-24" };

test("one row per counterpart and direction, in the order the card lists them", () => {
  const rows = buildTransferRows([out1160, { ...in1155, otherJob: "1170", amount: 10, transfers: 1 }]);
  assert.deepEqual(rows.map((r) => [r.direction, r.otherJob, r.amount]), [["out", "1160", -20463.08], ["in", "1170", 10]]);
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, "stable unique keys");
  assert.equal(buildTransferRows([]).length, 0);
});

test("the description names the direction, the other job and the movement count", () => {
  assert.equal(buildTransferRows([out1160])[0].description, "Parts moved to job 1160 — 126 item movements (inventory pulls)");
  assert.equal(buildTransferRows([in1155])[0].description, "Parts moved in from job 1155 — 126 item movements (inventory pulls)");
  assert.match(buildTransferRows([{ ...out1160, transfers: 1 }])[0].description, /1 item movement \(/, "singular");
});

test("1155's footer: the same −$20,463.08 comes off Total $ and Invoiced $, and Left to Invoice is untouched", () => {
  const add = transferFooterAdd(buildTransferRows([out1160]));
  assert.deepEqual(add, { total: -20463.08, invoiced: -20463.08, left: 0 });
  // The Parts List footer today (job 1155): Total $32,200.88 → the Parts Cost card's Purchased.
  assert.equal(Math.round((32200.88 + add.total) * 100) / 100, 11737.8);
});

test("1160's footer: the arriving amount is added to both, nothing to Left to Invoice", () => {
  const add = transferFooterAdd(buildTransferRows([in1155]));
  assert.deepEqual(add, { total: 20406.07, invoiced: 20406.07, left: 0 });
});

test("several rows sum to one figure, without float dust", () => {
  const rows = buildTransferRows([
    { ...out1160, amount: -0.1 },
    { ...out1160, otherJob: "1162", amount: -0.2 },
  ]);
  assert.equal(transferFooterAdd(rows).total, -0.3);
});

test("no rows add nothing", () => {
  assert.deepEqual(transferFooterAdd([]), { total: 0, invoiced: 0, left: 0 });
});

// ── When the rows show ───────────────────────────────────────────────────────

test("shown only in the plain whole-job view", () => {
  assert.equal(transferRowsShown({ filtersActive: false, scope: "all", hasTransfers: true }), true);
});

test("hidden by ANY active filter — status, category, manufacturer, supplier, search, dates, left-to-invoice, rewind", () => {
  // `filtersActive` is the Parts List's own single flag for every one of those controls.
  assert.equal(transferRowsShown({ filtersActive: true, scope: "all", hasTransfers: true }), false);
});

test("hidden when the scope chip narrows to BOM-only or non-BOM-only", () => {
  assert.equal(transferRowsShown({ filtersActive: false, scope: "bom", hasTransfers: true }), false);
  assert.equal(transferRowsShown({ filtersActive: false, scope: "nonbom", hasTransfers: true }), false);
});

test("never shown for a job with no transfers", () => {
  assert.equal(transferRowsShown({ filtersActive: false, scope: "all", hasTransfers: false }), false);
});

test("the hidden-by-filter note states the net and its direction", () => {
  assert.equal(hiddenTransfersNote(buildTransferRows([out1160])), "Parts moved between jobs (−$20,463) are hidden while a filter is on");
  assert.equal(hiddenTransfersNote(buildTransferRows([in1155])), "Parts moved between jobs (+$20,406) are hidden while a filter is on");
});

// ── The export ───────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

test("the export row has a value (or null) for EVERY Parts List column, typed like the column", () => {
  const colKeys = [...read("src", "components", "procurement", "PoDetailPanel.tsx").matchAll(/\{ key: "(\w+)", label:/g)].map((m) => m[1]);
  assert.ok(colKeys.length >= 20, "found the column list");
  const row = buildTransferRows([out1160])[0];
  const MONEY = new Set(["total", "invoiced", "leftspend"]);
  const TEXT = new Set(["pn", "desc", "status"]);
  for (const k of colKeys) {
    const v = transferExportValue(k, row);
    assert.notEqual(v, undefined, `${k} must be a value or null, never undefined`);
    if (MONEY.has(k)) assert.equal(typeof v, "number", `${k} is a number`);
    else if (TEXT.has(k)) assert.equal(typeof v, "string", `${k} is text`);
    else if (k === "invoiceddate") assert.equal(v, "2026-08-24");
    else assert.equal(v, null, `${k} has no value for a transfer`);
  }
});

test("the export's money cells equal the footer additions", () => {
  const rows = buildTransferRows([out1160]);
  assert.equal(transferExportValue("total", rows[0]), transferFooterAdd(rows).total);
  assert.equal(transferExportValue("invoiced", rows[0]), transferFooterAdd(rows).invoiced);
  assert.equal(transferExportValue("leftspend", rows[0]), transferFooterAdd(rows).left);
});

// ── Wiring (source-inspecting, like the sibling Parts List tests) ────────────

const PROC = read("src", "components", "JobProcurement.tsx").replace(/\r\n/g, "\n");
const noComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

test("the rows come from the card's own entries and show only via transferRowsShown", () => {
  const src = noComments(PROC);
  assert.match(src, /buildTransferRows\(reconcile\.transferEntries\)/);
  assert.match(src, /transferRowsShown\(\{ filtersActive, scope, hasTransfers: allTransferRows\.length > 0 \}\)/);
  assert.match(src, /const transferRows = useMemo\(\(\) => \(transfersShown \? allTransferRows : \[\]\), \[transfersShown, allTransferRows\]\);/);
});

test("the part rows, their sort and the footer's own sum are untouched — transfers are added AFTER, never inside", () => {
  const src = noComments(PROC);
  assert.match(src, /const sortedParts = sortRows\(parts, sort\.sort, sortColumns\);/);
  assert.match(src, /const tot = parts\.reduce\(/);
  assert.match(src, /const tAdd = transferFooterAdd\(transferRows\);/);
  assert.match(src, /const footTotal = tot\.total \+ tAdd\.total;/);
  assert.match(src, /const footInvoiced = tot\.invoiced \+ tAdd\.invoiced;/);
  assert.match(src, /case "leftspend": return windowStatus\.active \? "—" : usd\(tot\.left\);/, "Left to Invoice is exactly what it was");
  assert.doesNotMatch(src, /footLeft/, "no transfer amount ever reaches the Left to Invoice column");
  assert.doesNotMatch(src, /parts\.push|parts\.concat|\[\.\.\.parts, \.\.\.transfer/, "no transfer is ever put into the part rows");
});

test("the reconciliation equation and its status are untouched", () => {
  const src = noComments(PROC);
  assert.match(src, /unexplained: jobTotal - \(matchedTotal - estimated\),/);
  assert.match(src, /\}, \[parts, lines\]\);/);
});

test("the rows are drawn after the windowed part rows, with the table's own columns", () => {
  assert.match(PROC, /\{padBottom > 0 && \([\s\S]*?\)\}\n\s*\{\/\*[\s\S]*?\*\/\}\n\s*\{transferRows\.map\(\(t\) => \(\n\s*<tr key=\{t\.key\} data-transfer-row=\{t\.key\} style=\{\{ height: ROW_H \}\}[^>]*>\n\s*<TransferRowCells row=\{t\} cols=\{cols\} \/>/);
});

test("the export appends the same rows and the same footer additions as the screen", () => {
  const src = noComments(PROC);
  assert.match(src, /for \(const t of transferRows\) rows\.push\(visibleCols\.map\(\(c\) => transferExportValue\(c\.key, t\)\)\);/);
  assert.match(src, /const tAdd = transferFooterAdd\(transferRows\);\s*\n\s*tot\.total \+= tAdd\.total;\s*\n\s*tot\.invoiced \+= tAdd\.invoiced;/);
  assert.doesNotMatch(src, /tot\.left \+= tAdd/, "the export's Left to Invoice total is untouched too");
});

test("when a filter hides the rows, the strip says so", () => {
  const src = noComments(PROC);
  assert.match(src, /transfersHiddenNote && <span className="text-white\/45">\{transfersHiddenNote\}<\/span>/);
});
