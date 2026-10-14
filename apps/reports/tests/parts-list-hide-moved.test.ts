import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  indexMovedOut,
  isFullyMoved,
  buildTransferRows,
  transferFooterAdd,
  transferExportValue,
  hiddenMovedNote,
  type HideCandidate,
} from "../src/lib/parts-list-transfer-rows";
import type { JobTransferEntry, JobTransferItem } from "../src/lib/parts-transfer-netting";

// ── "Hide parts moved to other jobs" (2026-10-14) ────────────────────────────
//
// After a transfer, the rows of parts that left a job say little about it, but they are still
// the only record of the PO, supplier and invoice — so they hide behind a toggle (on by default)
// and never go away. Hiding a row takes its Total $ and Invoiced $ out of the footer, so the
// TRANSFER row carries only the RESIDUAL. The footer is the same with the toggle on or off.

const item = (itemId: number, amount: number, otherJob = "1160", direction: "in" | "out" = "out"): JobTransferItem => ({
  direction, otherJob, itemId, partNumber: null, description: null, qty: 1, amount: direction === "out" ? -Math.abs(amount) : Math.abs(amount), day: "2026-08-24", pullIds: [],
});
const row = (id: number, totalPrice: number, o: Partial<HideCandidate> = {}): HideCandidate => ({
  id, nonBom: false, matchReason: "matched", totalPrice, invoicedAmount: totalPrice, leftToSpend: 0, ...o,
});
const entry = (otherJob: string, amount: number, direction: "in" | "out" = "out", transfers = 1): JobTransferEntry => ({
  direction, otherJob, amount, transfers, lastDay: "2026-08-24",
});

// ── Which parts count as fully moved ─────────────────────────────────────────

test("a part moved out for its whole cost is fully moved; the cost is split by destination", () => {
  const idx = indexMovedOut([item(2744, 101.6), item(2744, 8.4, "1162")]);
  assert.equal(idx.get(2744)!.total, 110);
  assert.deepEqual([...idx.get(2744)!.byJob], [["1160", 101.6], ["1162", 8.4]]);
});

test("only movements OUT count — an arrival never hides a row", () => {
  assert.equal(indexMovedOut([item(5, 50, "1155", "in")]).size, 0);
});

test("fully moved: exact, within half a dollar, and over-moved (pulls are costed at pull cost)", () => {
  const moved = indexMovedOut([item(1, 20), item(2, 19.7), item(3, 81.6)]);
  assert.equal(isFullyMoved(row(1, 20), moved), true, "exact");
  assert.equal(isFullyMoved(row(2, 20), moved), true, "within $0.50 of the row");
  assert.equal(isFullyMoved(row(3, 64), moved), true, "moved more than the row cost (item 612: $64 bought, $81.60 pulled)");
});

test("a PARTLY moved part stays visible — its remainder is real (item 2707: $2,541 bought, $1,694 moved)", () => {
  assert.equal(isFullyMoved(row(2707, 2541), indexMovedOut([item(2707, 1694)])), false);
});

test("never hidden: non-BOM rows (freight, fees, cards), parts nothing was bought for, and $0 rows", () => {
  const moved = indexMovedOut([item(812, 7317.67), item(9, 10), item(8, 0.2)]);
  assert.equal(isFullyMoved(row(812, 7317.67, { nonBom: true }), moved), false, "shipping is a non-BOM row");
  assert.equal(isFullyMoved(row(9, 10, { matchReason: "no-purchase" }), moved), false, "a BOM estimate is not spend");
  assert.equal(isFullyMoved(row(8, 0.2), moved), false, "nothing worth hiding");
  assert.equal(isFullyMoved(row(77, 100), moved), false, "never moved at all");
});

// ── The residual TRANSFER row ────────────────────────────────────────────────

test("nothing hidden: the row is the whole transfer, exactly as before", () => {
  const [r] = buildTransferRows([entry("1160", -20463.08, "out", 126)]);
  assert.deepEqual([r.amount, r.total, r.invoiced, r.hiddenParts], [-20463.08, -20463.08, -20463.08, 0]);
  assert.equal(r.description, "Parts moved to job 1160 — 126 item movements (inventory pulls)");
});

test("1155-shaped: hiding the fully moved rows leaves only the residual on the TRANSFER row", () => {
  // 108 fully moved rows worth $18,440.88 (here three stand in), the rest of the $20,463.08 is partials/orphans.
  const rows = [row(1, 10000), row(2, 8000), row(3, 440.88)];
  const moved = indexMovedOut([item(1, 10000), item(2, 8000), item(3, 440.88), item(2707, 1694), item(9999, 328.2)]);
  const [r] = buildTransferRows([entry("1160", -20463.08, "out", 126)], { rows, moved });
  assert.equal(r.total, -2022.2, "$20,463.08 less the $18,440.88 the hidden rows already took out");
  assert.equal(r.invoiced, -2022.2);
  assert.equal(r.hiddenParts, 3);
  assert.match(r.description, /3 fully moved parts are hidden above, this is the rest$/);
});

test("THE INVARIANT: the footer is identical with the toggle on or off, and equals rows + transfer", () => {
  // Rows 1 and 3 carry an open PO balance (the live 1155 case: $2,065 of it sat on hidden rows).
  const all = [row(1, 10000, { leftToSpend: 1500 }), row(2, 8000), row(3, 440.88, { leftToSpend: 565 }), row(4, 2541, { leftToSpend: 494 }), row(5, 1396, { nonBom: true }), row(6, 7317.67, { nonBom: true })];
  const moved = indexMovedOut([item(1, 10000), item(2, 8000), item(3, 440.88), item(4, 1694)]);
  const entries = [entry("1160", -20134.88, "out", 4)];
  const sum = (rs: HideCandidate[], f: (r: HideCandidate) => number) => rs.reduce((s, r) => s + f(r), 0);
  const hidden = all.filter((r) => isFullyMoved(r, moved));
  const visible = all.filter((r) => !hidden.includes(r));
  assert.deepEqual(hidden.map((r) => r.id), [1, 2, 3]);
  const off = transferFooterAdd(buildTransferRows(entries));
  const on = transferFooterAdd(buildTransferRows(entries, { rows: hidden, moved }));
  const r2 = (n: number) => Math.round(n * 100) / 100;
  assert.equal(r2(sum(all, (r) => r.totalPrice) + off.total), r2(sum(visible, (r) => r.totalPrice) + on.total), "Total $");
  assert.equal(r2(sum(all, (r) => r.invoicedAmount) + off.invoiced), r2(sum(visible, (r) => r.invoicedAmount) + on.invoiced), "Invoiced $");
  // Left to Invoice: a transfer adds nothing, but the hidden rows' open balance must stay in the footer.
  assert.equal(off.left, 0, "no rows hidden: a transfer adds nothing to Left to Invoice");
  assert.equal(on.left, 2065, "the hidden rows' $1,500 + $565 rides on the TRANSFER row");
  const leftOf = (rs: HideCandidate[]) => sum(rs, (r) => r.leftToSpend ?? 0);
  assert.equal(r2(leftOf(all) + off.left), r2(leftOf(visible) + on.left), "Left to Invoice is the same on or off (it matches the card)");
});

test("the TRANSFER row's Left to Invoice cell and export value are the hidden rows' open balance", () => {
  const rows = [row(1, 500, { leftToSpend: 120 })];
  const moved = indexMovedOut([item(1, 500)]);
  const [r] = buildTransferRows([entry("1160", -500)], { rows, moved });
  assert.equal(r.left, 120);
  assert.equal(transferExportValue("leftspend", r), 120);
});

test("Invoiced $ and Total $ residuals differ when a hidden row's invoiced is not its total (SDC lines read N/A)", () => {
  const rows = [row(1, 500, { invoicedAmount: 0 })]; // supplied by SDC itself: no external invoice
  const moved = indexMovedOut([item(1, 500)]);
  const [r] = buildTransferRows([entry("1160", -500)], { rows, moved });
  assert.equal(r.total, 0, "the row's $500 of Total already left the footer");
  assert.equal(r.invoiced, -500, "but it never contributed to Invoiced, so the transfer still comes off it");
});

test("a part moved to two jobs is split between their rows in proportion to what it sent each", () => {
  const rows = [row(1, 100)];
  const moved = indexMovedOut([item(1, 75, "1160"), item(1, 25, "1162")]);
  const [a, b] = buildTransferRows([entry("1160", -75), entry("1162", -25)], { rows, moved });
  assert.deepEqual([a.total, b.total], [0, 0]);
  assert.deepEqual([a.hiddenParts, b.hiddenParts], [1, 1]);
});

test("arrivals are untouched by hiding: an 'in' row is always the whole amount", () => {
  const rows = [row(1, 100)];
  const moved = indexMovedOut([item(1, 100)]);
  const [r] = buildTransferRows([entry("1155", 20406.07, "in", 126)], { rows, moved });
  assert.deepEqual([r.total, r.invoiced, r.hiddenParts], [20406.07, 20406.07, 0]);
});

test("the export carries the residual, so the file matches the screen", () => {
  const rows = [row(1, 18000)];
  const moved = indexMovedOut([item(1, 18000), item(2, 2000)]);
  const [r] = buildTransferRows([entry("1160", -20000)], { rows, moved });
  assert.equal(transferExportValue("total", r), -2000);
  assert.equal(transferExportValue("invoiced", r), -2000);
});

test("the strip says how many parts are hidden and where they went", () => {
  assert.equal(hiddenMovedNote(108, ["1160"]), "108 parts moved to job 1160 are hidden");
  assert.equal(hiddenMovedNote(1, ["1160"]), "1 part moved to job 1160 is hidden");
  assert.equal(hiddenMovedNote(5, ["1160", "1162"]), "5 parts moved to jobs 1160, 1162 are hidden");
  assert.equal(hiddenMovedNote(0, ["1160"]), null);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

const PROC = readFileSync(join(import.meta.dirname, "..", "src", "components", "JobProcurement.tsx"), "utf8").replace(/\r\n/g, "\n");
const noComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

test("the toggle is ON by default, remembered, and not reset by Clear filters", () => {
  const src = noComments(PROC);
  assert.match(src, /useState<boolean>\(\(\) => saved\.hideMoved \?\? true\)/);
  assert.match(src, /rewind, hideMoved, hiddenPartCols:/, "persisted");
  const clear = src.slice(src.indexOf("const clearFilters"), src.indexOf("const clearFilters") + 900);
  assert.doesNotMatch(clear.slice(0, clear.indexOf("const partsState")), /hideMoved/, "a preference, not a filter");
});

test("it hides only in the lifetime view and only after every other filter has run", () => {
  const src = noComments(PROC);
  assert.match(src, /const filteredBase = useMemo\(\(\) => \{/);
  assert.match(src, /const lifetimeView = from === "" && to === "" && rewind === "" && !windowStatus\.requested;/);
  assert.match(src, /const hideMovedActive = hideMoved && lifetimeView && movedIndex\.size > 0;/);
  assert.match(src, /hideMovedActive \? filteredBase\.filter\(\(p\) => isFullyMoved\(p, movedIndex\)\) : \[\]/);
});

test("the TRANSFER rows are built from the rows ACTUALLY hidden, so the footer cannot drift", () => {
  const src = noComments(PROC);
  assert.match(src, /buildTransferRows\(reconcile\.transferEntries, \{ rows: hiddenMovedRows, moved: movedIndex \}\)/);
});

test("the button only appears on a job with fully moved parts, and stands down outside the lifetime view", () => {
  const src = noComments(PROC);
  assert.match(src, /\{movedPartCount > 0 && \(\s*\n\s*<button/);
  assert.match(src, /disabled=\{!lifetimeView\}/);
  assert.match(src, /Hide moved parts \(\{movedPartCount\}\)/);
});

test("the strip names what is hidden and offers a way back", () => {
  const src = noComments(PROC);
  assert.match(src, /hiddenMovedLine && \(/);
  assert.match(src, /onClick=\{onShowMoved\}/);
  assert.match(src, /onShowMoved=\{\(\) => setHideMoved\(false\)\}/);
});

test("the export lists the hidden parts among its filters", () => {
  const src = noComments(PROC);
  assert.match(src, /onlyLeftToInvoice \? "Left to invoice only" : null,\s*\n\s*hiddenMovedLine,/);
});

test("rows hidden are removed from `filtered` only — the whole-job reconciliation still reads every row", () => {
  const src = noComments(PROC);
  assert.match(src, /unexplained: jobTotal - \(matchedTotal - estimated\),/);
  assert.match(src, /\}, \[parts, lines\]\);/);
  assert.doesNotMatch(src, /parts\.splice|parts\.pop|parts\.shift/);
});
