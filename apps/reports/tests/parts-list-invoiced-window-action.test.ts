import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Parts List's own Invoiced+range fix (2026-08-09) ─────────────────────────
//
// Job Hour Details → Parts List never received the fix loadJobPartsLines/
// getJobPartsInvoicedInMonth got for the Monthly ETC Parts Spent drill (see
// tests/parts-spent-drill-invoiced.test.ts) — its own date-range picker
// filtered getJobPartsCost's LIFETIME, PurchaseDetailID-collapsed
// invoicedAmount by a row's single most-recent invoice date, the same wrong
// shape that test file guards the ETC drill against. loadPartsListInvoicedInWindow
// reuses the ALREADY-correct, ALREADY-tested getJobPartsInvoicedInMonth
// directly — this file guards that it stays a thin, unmodified reuse rather
// than growing its own (unverified) query logic.
//
// Can't be a live-DB test (no TotalETO connection in CI) — inspects the
// source the same way tests/parts-cost-spent-by-job.test.ts and
// tests/parts-spent-drill-invoiced.test.ts do, for the same reason.

const SRC = join(import.meta.dirname, "..", "src");
function code(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} must exist in the source`);
  const nextExport = source.indexOf("\nexport ", start + 1);
  return nextExport === -1 ? source.slice(start) : source.slice(start, nextExport);
}

const ACTIONS = () => code("lib", "hours-detail-actions.ts");

test("loadPartsListInvoicedInWindow calls getJobPartsInvoicedInMonth, not getJobPartsCost", () => {
  const fnBody = functionBody(ACTIONS(), "loadPartsListInvoicedInWindow");
  assert.match(fnBody, /getJobPartsInvoicedInMonth\(/, "must reuse the already-correct, already-tested month-scoped query");
  assert.doesNotMatch(fnBody, /getJobPartsCost\(/, "must not fall back to the lifetime, PurchaseDetailID-collapsed query");
});

test("loadPartsListInvoicedInWindow validates the job number the same way its sibling actions do", () => {
  const fnBody = functionBody(ACTIONS(), "loadPartsListInvoicedInWindow");
  assert.match(fnBody, /\/\^\\d\{1,10\}\$\//, "job numbers must be validated as digits-only before reaching a SQL parameter");
});

test("loadPartsListInvoicedInWindow requires at least one of from/to", () => {
  const fnBody = functionBody(ACTIONS(), "loadPartsListInvoicedInWindow");
  assert.match(fnBody, /!from && !to/, "an unbounded (both-empty) window must be rejected rather than silently treated as lifetime");
});

test("loadPartsListInvoicedInWindow is signed-in only, like every other action in this file", () => {
  const fnBody = functionBody(ACTIONS(), "loadPartsListInvoicedInWindow");
  assert.match(fnBody, /auth\(\)/, "a server action is a public endpoint of its own and must check for a session itself");
});

test("no other action in hours-detail-actions.ts was changed to call getJobPartsInvoicedInMonth", () => {
  // Only loadJobPartsLines (the ETC drill's own action) and the new
  // loadPartsListInvoicedInWindow should reach for this function.
  const source = ACTIONS();
  const fnBody = functionBody(source, "loadPartsListInvoicedInWindow");
  const others = source.replace(fnBody, "").replace(functionBody(source, "loadJobPartsLines"), "");
  assert.doesNotMatch(others, /getJobPartsInvoicedInMonth\(/, "no unrelated action should call the month-scoped query");
});

test("getJobPartsCost itself is untouched — Job Hour Details / Procurement still need every line, unwindowed", () => {
  const fnBody = functionBody(code("lib", "sync-totaleto.ts"), "getJobPartsCost");
  assert.doesNotMatch(fnBody, /invoicedAmount > 0/, "getJobPartsCost must return every line, invoiced or not");
  assert.doesNotMatch(fnBody, /@start|@end/, "getJobPartsCost must stay unwindowed");
});

test("getJobPartsInvoicedInMonth was not modified to add a new parameter or filter for this fix", () => {
  // The whole point of reusing it live is that it needed ZERO changes — its
  // window was already fully generic. Pin its signature so a future edit
  // can't quietly narrow it back to "month-only" and break this reuse.
  const fnBody = functionBody(code("lib", "sync-totaleto.ts"), "getJobPartsInvoicedInMonth");
  assert.match(
    fnBody,
    /export async function getJobPartsInvoicedInMonth\(jobId: string, monthStart: Date, monthEndExclusive: Date\)/,
    "signature must still accept an arbitrary Date window, not a calendar-month-only parameter",
  );
});
