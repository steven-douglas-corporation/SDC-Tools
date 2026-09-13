import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── T&M migrated off Power BI (2026-09-02) ─────────────────────────────────
//
// The company moved to this app reading Total ETO and Paylocity directly, and the
// "Job Hours Report - Management Level" model stopped refreshing on 2026-07-31.
// T&M's three dollar cards were the last thing still querying it.
//
// Measured before the change, job 1101: inside the model's own horizon the two
// sources agreed (SDC Manufactured Parts $575 both ways, Expense Reports $72 both
// ways); past it Power BI returned $0 on all three cards while Total ETO found
// $9,771 / $1,025 / $22 of real activity. After the change, KPI equals the sum of
// its own drill rows to the cent on every card, for one job and for all 239.
//
// Source-level guards: this path needs a live Total ETO connection, so the
// arithmetic above was verified by running it, not simulated here.

const SRC = join(import.meta.dirname, "..", "src");
const strip = (raw: string) => raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SOURCE = strip(readFileSync(join(SRC, "lib", "tm-parts-source.ts"), "utf8"));
const REPORT = strip(readFileSync(join(SRC, "lib", "tm-report.ts"), "utf8"));
const PAGE = strip(readFileSync(join(SRC, "app", "(app)", "tm", "page.tsx"), "utf8"));
const DRILL = strip(readFileSync(join(SRC, "lib", "tm-drill-actions.ts"), "utf8"));

test("nothing on the T&M path queries Power BI any more", () => {
  for (const [name, code] of [["tm-parts-source", SOURCE], ["tm-report", REPORT], ["page", PAGE], ["drill-actions", DRILL]] as const) {
    assert.ok(!/runDax\s*\(/.test(code), `${name} must not execute DAX`);
    assert.ok(!/from "@\/lib\/powerbi-client"/.test(code), `${name} must not import the Power BI client`);
  }
});

test("the cards read the same Total ETO function the rest of the app reconciles against", () => {
  // Not a new cross-job query: getJobPartsCost is what the Parts Cost card, the
  // Parts List, Profitability and Cash Flow all agree with, and it already carries
  // the refund-sign rule. A second SQL statement over the same tables would be a
  // second thing to keep in step.
  assert.match(SOURCE, /import \{ getPartsCostForJobs, type PartsCostLine \} from "@\/lib\/sync-totaleto"/);
  assert.match(SOURCE, /withTimeoutOrNull\(/, "one slow job must not hang the page");
});

test("Part Invoiced is the GL-posted figure, like every other 'Invoiced' in the app", () => {
  // Power BI's measure tracked the BILLED amount. On job 1104 that is $809,135
  // against $763,954 GL-posted — a $45,181 difference of definition, two metrics
  // wearing one word on two pages of the same app.
  assert.match(SOURCE, /partInvoicedAmount: \{\s*amount: \(l\) => l\.actualAmount/);
  assert.ok(!/partInvoicedAmount:[\s\S]{0,120}l\.invoicedAmount/.test(SOURCE));
});

test("the drill's invoiced column matches the basis its card is defined on", () => {
  // Otherwise a reader adding the column up lands somewhere the card never claims —
  // and tm-drill-reconcile.ts asserts exactly that sum.
  assert.match(SOURCE, /invoicedAmount: key === "partInvoicedAmount" \? l\.actualAmount : l\.invoicedAmount/);
});

test("each card keeps its own date basis", () => {
  // SDC Manufactured Parts stays on PURCHASE date: these are internal parts SDC
  // never invoices itself for, and 1,026 of 2,257 such rows had no Invoiced Date at
  // all — on that basis the card was structurally $0 for any recent range.
  assert.match(SOURCE, /sdcManufacturedPartsSalesPrice: \{[\s\S]{0,200}basis: "purchaseDate"/);
  assert.match(SOURCE, /partInvoicedAmount: \{[\s\S]{0,200}basis: "invoicedDate"/);
  assert.match(SOURCE, /expenseReports: \{[\s\S]{0,200}basis: "invoicedDate"/);
});

test("a line with no date on the card's basis is excluded, not defaulted in", () => {
  // Defaulting it in would quietly add rows to a windowed figure.
  assert.match(SOURCE, /if \(!d\) return false;/);
});

test("the KPI and its drill are defined once, so they cannot drift", () => {
  // Both go through cardLines — the property the old DAX version achieved by
  // sharing partsCardFilters(), kept here by sharing the predicate itself.
  assert.match(SOURCE, /export function cardLines\(/);
  assert.match(SOURCE, /cardLines\(lines, key, filters\)\.reduce/, "the total sums the card's own rows");
  assert.match(SOURCE, /return cardLines\(source\.lines, key, filters\)\.map\(/, "the drill lists the same rows");
});

test("the date pickers default to this app's freshness, not the retired model's", () => {
  // They prefilled from [Hours Refreshed Thru] on the dead model, so the page opened
  // on a window ending 2026-07-31 and presented that as a choice rather than as the
  // edge of the data. Local marker now reads 2026-09-01.
  assert.match(SOURCE, /source: "hours_actual"/);
  assert.match(PAGE, /loadTmDateDefaults\(\)/);
  assert.ok(!/fetchTmDateDefaults/.test(PAGE));
});

test("the job universe is the same one the hours cards use", () => {
  // Two code paths answering "which jobs is this number about" is how a KPI and its
  // own detail drift apart.
  assert.match(SOURCE, /resolveTmJobPks\(filters\.jobIds \?\? \[\]\)/);
});

// ── One round trip for All Jobs (2026-09-02) ───────────────────────────────
//
// Fanning out per job took 5,766ms over 239 jobs on T&M's default view. The
// cross-job form does the same work in 571ms — a 10x cut — returning the identical
// 30,949 lines and the identical three totals to the cent. Verified separately that
// the per-job path is unchanged by the refactor: 1101, 1131 and 1104 each return
// byte-identical line counts and sums whichever function asks.

const SYNC = strip(readFileSync(join(SRC, "lib", "sync-totaleto.ts"), "utf8"));

test("the two scopes are one SQL template, not two queries", () => {
  // Two near-identical 60-line queries over the same tables would have to be kept in
  // step forever — and this one carries the GL-posted split, the open-balance term
  // and the Extra Costs branch, each of which has already been the subject of a fix.
  assert.match(SYNC, /const partsDetailSql = \(where: \{ pod: string; ec: string \}\) =>/);
  assert.match(SYNC, /WHERE \$\{where\.pod\}/);
  assert.match(SYNC, /WHERE \$\{where\.ec\}/);
  assert.match(SYNC, /const PARTS_DETAIL_SQL = partsDetailSql\(\{ pod: "POD\.ProjectID = @job", ec: "EC\.ProjectID = @job" \}\)/);
});

test("both scopes map rows and filter noise through the same helpers", () => {
  // Otherwise the same line could become a different PartsCostLine depending on
  // which function asked for it.
  assert.match(SYNC, /function toPartsCostLine\(/);
  assert.match(SYNC, /function meaningfulLines\(/);
  assert.match(SYNC, /result\.recordset\.map\(toPartsCostLine\)/, "per-job uses the shared mapper");
  assert.match(SYNC, /applyRefundSign\(toPartsCostLine\(r\)\)/, "cross-job applies the same refund rule");
});

test("the job-id list is coerced to integers before it reaches the SQL", () => {
  // Inlined rather than parameterized, which is safe only because of this coercion:
  // a value that is not a finite positive number never reaches the string.
  assert.match(SYNC, /\.map\(\(j\) => Number\(j\)\)\.filter\(\(n\) => Number\.isFinite\(n\) && n > 0\)/);
  assert.match(SYNC, /POD\.ProjectID IN \(\$\{list\}\)/);
});

test("a failed cross-job read reports every job as failed, never a confident zero", () => {
  // One query means one failure mode. Returning empty lines with failedJobs 0 would
  // render $0 as though it were an answer.
  assert.match(SOURCE, /if \(!byJob\) return \{ lines: \[\], failedJobs: jobs\.length \}/);
});

test("T&M no longer fans out per job", () => {
  assert.match(SOURCE, /getPartsCostForJobs\(jobs\.map\(\(j\) => j\.jobId\)\)/);
  assert.ok(!/mapWithConcurrency/.test(SOURCE), "the per-job fan-out is gone");
});
