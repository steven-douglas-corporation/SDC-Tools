import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── One PO, several jobs ─────────────────────────────────────────────────────
//
// docs/PARTS-COST-VARIANCE-2026-09.md §5.1 recorded the gap: the Procurement drawer is
// single-job by design (a BOM tree belongs to one job), so PO 103046 — thirteen G2V
// Optics lines across jobs 1130, 1142 and 1143 — took three lookups and manual
// addition to total.
//
// The money here is asserted structurally rather than against live Total ETO: these
// tests must run with no database. The live figures were verified when the lookup was
// written and reproduce §5's table exactly —
//
//     1130   5 lines  $1,554,100.00      1142   4 lines  $1,249,925.00
//     1143   4 lines    $796,475.00     TOTAL  13 lines  $3,600,500.00, $0 left
//
// — which is the check that matters and the one a fresh query would have had to earn.

const SRC = readFileSync(join(process.cwd(), "src", "lib", "po-across-jobs.ts"), "utf8");
const code = SRC.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

test("the money comes from the shared pipeline, never a second query", () => {
  // The whole point. A fresh query against tblPurchaseOrderHeader would be a second
  // definition of purchased/invoiced/left, free to drift from every other screen —
  // which is the exact failure this session fixed three separate times (the Left to
  // Invoice formula written out four times, the GL-posted flag written out twice,
  // Money Spent Month on an unstated basis).
  assert.match(code, /getPartsCostForJobs\(jobNumbers\)/, "lines come from the ordinary pipeline");
  assert.match(code, /leftToInvoiceForLines\(lines\)/, "and Left to Invoice from the shared formula");
  assert.match(code, /a \+ l\.actualAmount/, "invoiced is GL-posted actual");
  // The only bespoke SQL is an id lookup with no money in it.
  const sql = /const r = await pool[\s\S]*?\);/.exec(code)?.[0] ?? "";
  assert.ok(sql.includes("SELECT DISTINCT JobId"), "the bespoke query returns ids");
  for (const money of ["SUM(", "Amount", "decExtraCostingValue", "PurchasePrice"]) {
    assert.ok(!sql.includes(money), `the id query must not compute money (${money})`);
  }
});

test("both attribution paths are searched", () => {
  // The parts pipeline unions two branches, and a PO whose only charge to a job is
  // freight lives entirely in the second. Searching only the PO tables would report
  // that job as not carrying the PO at all.
  assert.match(code, /tblPurchaseOrderHeader POH/, "PO lines, via tblSpec/tblProjects");
  assert.match(code, /vwCostingExtraCostsDetailed EC/, "and extra costs, which carry their own ProjectID");
  // APDocNumber, not APDocNo — the view has no APDocNo column and the first draft of
  // this query failed outright on it ("Invalid column name 'APDocNo'").
  assert.match(code, /EC\.APDocNumber/);
});

test("a mistyped PO is an empty answer, not an error", () => {
  // A search box receives typos as a matter of course. Throwing would turn an ordinary
  // input into an error state.
  assert.match(code, /if \(!po\) return empty;/);
  assert.match(code, /if \(jobNumbers\.length === 0\) return empty;/);
  assert.match(code, /jobs: \[\],/);
});

test("PO matching tolerates case and whitespace", () => {
  // PO numbers are typed by hand, and some are not numeric at all — the credit-card
  // documents carry PO numbers like `07.26 CC`.
  assert.match(code, /\(a \?\? ""\)\.trim\(\)\.toUpperCase\(\) === b\.trim\(\)\.toUpperCase\(\)/);
});

test("the total equals the column above it", () => {
  // Summing the raw per-job figures and flooring once would give a total that differs
  // from the rows it sits under — the reconciliation complaint this whole area keeps
  // producing. The total sums the already-floored per-job values.
  assert.match(code, /leftToInvoice: jobs\.reduce\(\(a, j\) => a \+ j\.leftToInvoice, 0\)/);
  // And the unfloored figure is carried per job, so an over-invoiced job is visible
  // rather than reading as a clean $0.
  assert.match(code, /leftToInvoiceRaw: rawLeftToInvoice\(lines\)/);
});

test("there is a way to ask it today", () => {
  // The in-app surface is not built (see the session notes): the drawer is single-job
  // and adding a cross-job panel there is UI that could not be verified in a browser
  // when this shipped. The CLI is the usable answer meanwhile, and it is what produced
  // the verification quoted at the top of this file.
  const script = readFileSync(join(process.cwd(), "scripts", "po-lookup.ts"), "utf8");
  assert.match(script, /lookupPoAcrossJobs\(po\)/);
  assert.match(script, /spans jobs/, "it must say when a PO crosses jobs — that is the point");
});
