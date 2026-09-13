import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Parts Spent drill-through: invoiced AND month-scoped (§77, then 2026-08-07) ──
//
// The second-level "purchase lines" panel behind a job row in the Monthly ETC Parts
// Spent drill used to show a job's WHOLE purchase history, unwindowed by month —
// ordered-but-unbilled parts included, and (found 2026-08-07) an invoice from any
// month at all, sitting under a total that only counted the currently-open month.
// A row bigger than its own total is exactly the bug this guards against.
//
// getJobPartsInvoicedInMonth (lib/sync-totaleto.ts) replaced getJobPartsCost +
// invoicedOnly for this ONE caller: it queries tblAPDocumentDetails/
// tblAPBatchDocument directly, filtered by APBD.APDocDate BEFORE aggregating (one
// row per real invoice event in the window), using the SAME job attribution
// (APDD.ProjectID, not the PO chain) getPartsCostBookedByJob uses for the row's own
// "Money spent" figure — verified live to reconcile to the cent across 10 real jobs
// for July 2026. This can't be a live-DB test (no TotalETO connection in CI), so it
// inspects the source the way tests/parts-cost-spent-by-job.test.ts does for the
// same reason.

const SRC = join(import.meta.dirname, "..", "src");
function code(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");
}

// Slices from a function's `export async function NAME` declaration to the start of
// whatever comes next (another top-level export, or end of file) — robust to the
// function being last in the file, where a search for a specific closing-brace pattern
// can run past the end and return an empty slice.
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} must exist in the source`);
  const nextExport = source.indexOf("\nexport ", start + 1);
  return nextExport === -1 ? source.slice(start) : source.slice(start, nextExport);
}

const SYNC_TOTALETO = () => code("lib", "sync-totaleto.ts");

test("getJobPartsCost itself is never filtered or windowed — other pages still need every line", () => {
  // job-hours/page.tsx (Job Hour Details / Procurement) reaches this via
  // getPartsCostFinancials (lib/parts-cost-financials.ts), not the drill's
  // action, and it must keep seeing ordered-but-unbilled parts across the
  // job's whole history — exactly what a procurement reader opens the page to find.
  const fnBody = functionBody(SYNC_TOTALETO(), "getJobPartsCost");
  assert.doesNotMatch(fnBody, /invoicedAmount > 0/, "getJobPartsCost must return every line, invoiced or not");
  assert.doesNotMatch(fnBody, /@start|@end/, "getJobPartsCost must stay unwindowed — Job Hour Details needs the whole history");
});

test("loadJobPartsLines — the Parts Spent drill's own action — calls getJobPartsInvoicedInMonth", () => {
  const ACTIONS = code("lib", "hours-detail-actions.ts");
  const fnBody = functionBody(ACTIONS, "loadJobPartsLines");
  assert.match(fnBody, /getJobPartsInvoicedInMonth\(/, "the drill's action must call the month-scoped query");
  assert.doesNotMatch(fnBody, /getJobPartsCost\(/, "must not also call the unwindowed whole-history query");
});

// Widened 2026-08-09: loadPartsListInvoicedInWindow (the Parts List
// Invoiced+range fix, see tests/parts-list-invoiced-window-action.test.ts) is
// now a second, deliberate caller — it reuses this exact query so Parts List
// reconciles to the cent with this same drill. Only these two may call it;
// everything else in the file (the punch drill, the job-level rows) is about
// a different grain of data entirely.
test("only loadJobPartsLines and loadPartsListInvoicedInWindow call getJobPartsInvoicedInMonth", () => {
  const ACTIONS = code("lib", "hours-detail-actions.ts");
  const known = functionBody(ACTIONS, "loadJobPartsLines") + functionBody(ACTIONS, "loadPartsListInvoicedInWindow");
  const others = ACTIONS.replace(functionBody(ACTIONS, "loadJobPartsLines"), "").replace(functionBody(ACTIONS, "loadPartsListInvoicedInWindow"), "");
  assert.match(known, /getJobPartsInvoicedInMonth\(/g, "sanity check: the two known callers must actually call it");
  assert.doesNotMatch(others, /getJobPartsInvoicedInMonth\(/, "no OTHER action in this file should call the month-scoped query");
});

test("getJobPartsInvoicedInMonth filters by APDocDate BEFORE aggregating, not by a lifetime max()", () => {
  // The first attempt at this fix filtered getJobPartsCost's already-aggregated lines by
  // "does invoicedDate fall in the month" — wrong, because that field is MAX(APDocDate)
  // across a PO line's ENTIRE invoice history, grouped by PurchaseDetailID alone. A line
  // invoiced across several different months would dump its whole cumulative total into
  // whichever one contains its latest invoice — found live on job 1142, a single PO line
  // spanning 2025-11 through 2026-08, $1,207,300. Guards against that regressing: the
  // date filter must sit in the SQL's WHERE clause (evaluated per AP document, before any
  // GROUP BY), never as a JS filter over a pre-aggregated result.
  const fnBody = functionBody(SYNC_TOTALETO(), "getJobPartsInvoicedInMonth");
  assert.match(fnBody, /WHERE[\s\S]*APBD\.APDocDate >= @start AND APBD\.APDocDate < @end/, "the date window must be a SQL WHERE clause on the individual AP document date");
  assert.doesNotMatch(fnBody, /max\(APDocDate\)|MAX\(APDocDate\)/, "must not read a MAX(APDocDate)-per-PO-line aggregate — that is getJobPartsCost's lifetime shape, not a monthly one");
});

test("getJobPartsInvoicedInMonth attributes by APDD.ProjectID directly, matching getPartsCostBookedByJob — not the PO chain", () => {
  // Found live: job 1122 had 5 AP lines in July ($5,252.77 — freight, a tariff, an
  // expense reimbursement) with no purchase order at all. Filtering on POD.ProjectID
  // (the PO chain) — even with the PO tables LEFT JOINed — would still exclude them,
  // because a LEFT JOIN with no matching row makes POD.ProjectID NULL, and NULL never
  // equals @job. The WHERE clause has to name the AP line's own ProjectID.
  const fnBody = functionBody(SYNC_TOTALETO(), "getJobPartsInvoicedInMonth");
  assert.match(fnBody, /WHERE\s+APDD\.ProjectID = @job/, "job attribution must be the AP line's own ProjectID");
  assert.doesNotMatch(fnBody, /WHERE\s+POD\.ProjectID = @job/, "must not filter on the PO chain's ProjectID — that silently drops non-PO AP lines");
});

test("getJobPartsInvoicedInMonth does not require a PurchaseDetailID — non-PO AP lines must surface as rows", () => {
  const fnBody = functionBody(SYNC_TOTALETO(), "getJobPartsInvoicedInMonth");
  assert.doesNotMatch(
    fnBody,
    /PurchaseDetailID IS NOT NULL/,
    "excluding rows with no PurchaseDetailID is exactly how the old query dropped freight/tariffs/expense-reimbursement lines that have a job but no PO",
  );
  assert.match(fnBody, /LEFT JOIN tblPurchaseOrderDetails/, "the PO tables must be LEFT JOINed, not INNER — a non-PO line has no matching row there");
});

// §82: getJobPartsInvoicedInMonth used to hand-type its own copy of the AP-line-amount
// expression, twice over (once for InvoicedAmount, once inside the ActualAmount CASE) —
// a THIRD and FOURTH copy of the exact formula getPartsCostBookedByJob (Money Spent
// Month), getPartsInvoicedByJob and getPartsActualByJob already shared as one
// AP_LINE_AMOUNT constant. Both copies happened to still agree with the shared one, kept
// in sync by hand — which is exactly how a Money-Spent-Month-vs-Parts-Spent-drill
// mismatch would (re)appear the moment someone edited the constant and not these two
// inline copies, or vice versa. This guards against that regressing rather than against
// today's numbers being wrong, since (per this repo's convention) a live-DB check
// belongs in scripts/verify-parts-invoiced-reconciliation.ts, not here.
test("getJobPartsInvoicedInMonth computes its dollar amount from the one shared AP_LINE_AMOUNT constant", () => {
  const fnBody = functionBody(SYNC_TOTALETO(), "getJobPartsInvoicedInMonth");
  assert.match(fnBody, /const amt = AP_LINE_AMOUNT;/, "must alias the shared constant, the same pattern getPartsCostBookedByJob/getPartsInvoicedByJob use");
  assert.match(fnBody, /AS InvoicedAmount/, "sanity check: still produces the InvoicedAmount column");
  assert.doesNotMatch(
    fnBody,
    /APDD\.APDocQty \* APDD\.APDocUnitPrice \* \(1 - APDD\.APDocItemPctDisc\) \* APBD\.APDocCurrRate/,
    "must not re-inline the formula — reference ${amt} so a future change to AP_LINE_AMOUNT reaches this query too",
  );
});
