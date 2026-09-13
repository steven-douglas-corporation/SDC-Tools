import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Parts Actual must never again report commitment or forecast (2026-08-10) ──
//
// Reported by Dan: job 1116's Parts Cost actual/projection read ~$400K against a
// job ledger of ~$340K on a ~$300K budget. Audited against Lisa's own
// "1116 Molex as of 7.31.26" Job Ledger export ($349,732.10 net, re-derivable by
// scripts/_analyze_1116_ledger.ts). The app said $399,176.51, and TWO general
// causes produced it — neither specific to 1116:
//
//   1. SUM([Total Price]) carries each open PO's UNINVOICED remaining balance, so
//      a job's undelivered commitment was reported as money already spent.
//      $32,986.24 on 1116; $2,108,517.44 across all jobs.
//   2. AP documents flagged APDocDoNotExport never post to the general ledger, so
//      they can never appear on a job ledger — but were counted as spend anyway.
//      $19,950.40 on 1116; $621,483.80 across the database.
//
// After the fix all 100 TotalETO-tracked jobs reconcile to their source figure to
// the cent (scripts/parts-actual-recon.ts re-proves it live, which is where the
// real verification lives — these are the cheap structural guards that stop the
// specific shapes of the bug returning).
//
// Source-inspecting rather than live, for the same reason the sibling parts tests
// are: there is no TotalETO connection in CI.

const ROOT = join(import.meta.dirname, "..");
function code(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");
}

function functionSpan(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} must exist in the source`);
  const nextExport = source.indexOf("\nexport ", start + 1);
  return nextExport === -1 ? source.slice(start) : source.slice(start, nextExport);
}

const SYNC_TOTALETO = () => code("src", "lib", "sync-totaleto.ts");

// ── Root cause 1: commitment must not be reported as actual ─────────────────

test("syncPartsCostActual fills the Parts Actual column from getPartsActualByJob", () => {
  const fn = functionSpan(SYNC_TOTALETO(), "syncPartsCostActual");
  assert.match(fn, /getPartsActualByJob\(\)/, "the column labelled ACTUAL must come from the GL-posted AP basis");
  assert.doesNotMatch(
    fn,
    /getPartsCostSpentByJob/,
    "SUM([Total Price]) includes every open PO's undelivered balance — that is a commitment, and reporting it as actual is the original 1116 bug",
  );
});

test("getPartsActualByJob sums AP document lines, never [Total Price]", () => {
  const fn = functionSpan(SYNC_TOTALETO(), "getPartsActualByJob");
  assert.match(fn, /tblAPDocumentDetails/, "Parts Actual is an AP-document sum");
  assert.doesNotMatch(fn, /\[Total Price\]/, "[Total Price] is remaining-open-balance + invoiced-to-date, i.e. a commitment");
  assert.doesNotMatch(fn, /PurchasePrice/, "a PO's own price is what was committed, not what was spent");
});

test("the projection is based on Parts Actual, not on the committed total", () => {
  const proj = code("src", "lib", "parts-budget-projection.ts");
  const fn = functionSpan(proj, "computePartsBudgetProjection");
  assert.match(fn, /actualTotal\(lines\)/, "the projection's actual term must be the GL-posted actual");
  assert.match(
    fn,
    /committedNotPosted/,
    "open/unposted commitment must ride as its OWN term, computed and returned for display, even though it no longer feeds `total`",
  );
});

// ── Left to be invoiced must never be summed into Projection again (2026-08-17) ─
//
// Reported and confirmed on real project data: Invoiced $47,192 + Left to be
// invoiced $84,877 + ETC $165,313 summed to $297,382, well past the $212,505
// (Invoiced + ETC) a manager's own New ETC — already an estimate of what's
// left to FINISH the job, which has to account for whatever's on order —
// actually implies. Root cause: the Parts New ETC that becomes
// `estimateToPurchase` is drawn down by GL-posted spend only
// (getPartsCostBookedByJob, the same basis as `actual`), never by an open
// PO's balance, so `committedNotPosted` money stays inside it, undiminished,
// until that PO is actually invoiced. Summing it in on top of `actual` counted
// it twice.

test("computePartsBudgetProjection's total is actual + projectionResidual(...), NOT actual + committedNotPosted + estimateToPurchase", () => {
  const proj = code("src", "lib", "parts-budget-projection.ts");
  const fn = functionSpan(proj, "computePartsBudgetProjection");
  assert.match(
    fn,
    /total:\s*actual\s*\+\s*projectionResidual\(committedNotPosted,\s*estimateToPurchase\)/,
    "total must route through the one shared residual helper, not re-sum the two terms inline",
  );
  assert.doesNotMatch(
    fn,
    /total:\s*actual\s*\+\s*committedNotPosted\s*\+\s*estimateToPurchase/,
    "this is the exact formula that double-counted Left to be invoiced — it must not come back",
  );
});

// ── 2026-08-19: Projection must never fall below Total Parts Cost Spent ────
//
// Reported live on job 1119 (Karl Storz Stamping Machine): Total Parts Cost
// Spent $133,428 (Invoiced $124,581 + Left to be invoiced $8,847) read GREATER
// than Actual/Projection $127,219 (Invoiced $124,581 + ETC $2,638) — the job's
// ETC hadn't caught up to its own open PO balance. See
// tests/parts-cost-projection-invariant.test.ts for the numeric proof (real
// arithmetic, not a source-pattern match) that projectionResidual fixes this
// for every combination of committed/ETC, including that exact job's figures.

test("projectionResidual takes the LARGER of committedNotPosted/estimateToPurchase, never their sum", () => {
  // Lives in parts-cost-financials-shared.ts, not parts-budget-projection.ts
  // (which has `import "server-only"`) — see that file's own header for why:
  // it has to be value-importable from a plain node:test file with no live
  // database, same reason reconcilePartsCostRounding/sharedBarMax live there.
  const shared = code("src", "lib", "parts-cost-financials-shared.ts");
  const start = shared.indexOf("export function projectionResidual");
  assert.ok(start >= 0, "projectionResidual must exist in parts-cost-financials-shared.ts");
  const fn = shared.slice(start, shared.indexOf("\n}", start) + 2);
  assert.match(fn, /Math\.max\(committedNotPosted,\s*estimateToPurchase\)/, "must be a max, not a sum — summing both is the 2026-08-17 double-count returning");
});

test("the audit script's own defining identity checks invoiced+max(leftToInvoice,etc), not invoiced+etc alone", () => {
  const audit = code("scripts", "parts-cost-projection-audit.ts");
  assert.match(
    audit,
    /const expectedProjection = invoiced \+ Math\.max\(leftToInvoice,\s*etc \?\? 0\)/,
    "the audit's PROJECTION FORMULA MISMATCH check must match the 2026-08-19 fix",
  );
  assert.doesNotMatch(audit, /invoiced \+ leftToInvoice \+ \(etc \?\? 0\)/, "the audit must not silently re-assert the original (pre-2026-08-17) formula");
});

test("the audit script flags a projection that reads below total spent", () => {
  const audit = code("scripts", "parts-cost-projection-audit.ts");
  assert.match(audit, /projectionTotal < totalSpent - CENT/, "the audit must independently assert the business rule (projection >= total spent)");
  assert.match(audit, /PROJECTION BELOW SPENT/, "the check must be a named, reportable flag, not a silent condition");
});

test("the Parts Cost bar stacks Invoiced, Adjusted ETC and only the uncovered excess", () => {
  const src = code("src", "components", "PartsCostSummary.tsx");
  // ── Rebuilt 2026-09-03 to Dan's model ────────────────────────────────────
  //
  // The invariant these guards have always protected is unchanged: Invoiced is the
  // base segment, and the open PO balance is never stacked on top of the forecast as
  // a third addend — that double-counts the part the forecast already covers.
  //
  // What changed is the middle segment. It has been, in order: the residual (the
  // larger of ETC and the open balance), then a coverage split of the open balance by
  // the CURRENT month's submitted ETC, and now the PRIOR month's ETC drawn down by
  // this month's spend. Only the last is Dan's model, and §20 is explicit that the
  // current month's New ETC must not be substituted for it.
  assert.match(src, /key: "invoiced", label: "Invoiced actual"/, "Invoiced is still the base segment");
  assert.match(src, /key: "etc",[\s\S]{0,300}label: "Adjusted ETC remaining"/);
  assert.match(src, /key: "uncovered",[\s\S]{0,300}label: "Uncovered invoice exposure"/);
  assert.doesNotMatch(
    src,
    /key: "left-to-invoice"/,
    "the open balance must never be its own bar segment on top of the forecast",
  );

  // ── §16: only the UNCOVERED difference is added ──────────────────────────
  //
  // The red band is `additionalExposure`, which the shared library floors at
  // `yetToInvoice - adjustedEtc`. The card must draw THAT, not the whole exposure —
  // stacking the full `yetToInvoice` on top of `adjustedEtc` is the double-count the
  // spec forbids by name.
  assert.match(src, /heightPct: pct\(additionalAmount\)/);
  assert.doesNotMatch(
    src,
    /heightPct: pct\(yetToInvoiceAmount\)/,
    "the whole exposure must never be a segment height — only the uncovered excess",
  );
  // And the three printed figures must reconcile against the printed total.
  // ── The residue absorber, and why it is Invoiced (fixed 2026-09-03) ──────
  //
  // It used to be the ETC-adjusted figure, derived by subtraction so the three
  // printed segments would sum to the printed total. That produced a reported bug on
  // job 1101: prior ETC $5,621.59 against $10,795.96 spent leaves a NEGATIVE adjusted
  // ETC, floored to exactly $0 — no yellow segment — and yet the row printed "$1",
  // sitting directly under its own subtraction that gives a negative.
  //
  // So the two remainder terms are now rounded from their own values, and INVOICED
  // absorbs the difference: it is larger by orders of magnitude, so ±$1 is invisible
  // in it, and a term that is genuinely zero prints as zero.
  assert.match(src, /const adjustedEtcDisplay = Math\.round\(adjustedEtcAmount\)/);
  assert.match(src, /const additionalDisplay = Math\.round\(additionalAmount\)/);
  assert.match(
    src,
    /const invoicedDisplay = projTotalDisplay - adjustedEtcDisplay - additionalDisplay/,
    "Invoiced must absorb the residue, so a zero adjusted ETC cannot print as $1",
  );
});

test("the open balance is stated, and never added on top of the forecast", () => {
  const src = code("src", "components", "PartsCostSummary.tsx");
  // The table was cut to five rows by request (2026-09-03): Purchased, Invoiced,
  // Left to invoice, ETC adjusted, Total projection. The figures that had their own
  // rows before — prior-month ETC, in-house excluded, uncovered exposure — now live
  // inside the derivation of the row they feed.
  //
  // The invariant is unchanged: the open balance is COMPARED against the forecast,
  // never stacked on top of it (§16). What proves that here is the total's own
  // derivation, which adds Invoiced + ETC adjusted (+ only the excess beyond it),
  // and never Invoiced + ETC + the whole balance.
  assert.match(src, /label: "Left to invoice"/);
  assert.match(src, /label: "Total projection"/);
  assert.match(
    src,
    /invoiced \+ \$\{usd\(adjustedEtcDisplay\)\} ETC adjusted \+ \$\{usd\(additionalDisplay\)\} beyond it/,
    "the total must add only the excess beyond the forecast, not the whole open balance",
  );
  assert.ok(!/label="Left to be invoiced"/.test(src), "unexplained duplicate wording");
  assert.ok(!/label: "To complete"/.test(src), "the bare phrase the spec rules out");

  // CORRECTED 2026-09-03. "Left to invoice" is now the WHOLE open balance, so the row
  // IS exactly Purchased − Invoiced and ties without a caveat. The in-house figure is
  // reported beside it rather than subtracted from it — it is committed cost either
  // way, and taking it out of the total made the projection fall below Purchased on 7
  // of 10 audited jobs.
  assert.match(src, /value: Math\.round\(openBalanceAmount\)/, "the row is the whole open balance");
  assert.match(src, /in-house \(no supplier invoice\)/, "the in-house split is reported, not subtracted");
});

test("the ETC row is the PRIOR month's, drawn down by this month's spend", () => {
  const src = code("src", "components", "PartsCostSummary.tsx");
  // §20, as a guard: substituting the current month's New ETC is the specific mistake
  // the spec calls out, and an earlier version of this card made it. The prior-month
  // figure no longer has its own row — it is the first term of this row's derivation,
  // which is a stronger statement than a bare row was, because it shows the drawdown.
  assert.match(src, /label: "ETC adjusted"/);
  assert.match(
    src,
    /prior-month ETC − \$\{usd\(Math\.round\(spentThisMonth\)\)\} spent this month/,
    "the row must show prior ETC minus this month's spend, not just the result",
  );
  assert.ok(!/label="Current Parts ETC"/.test(src), "the current month's entry is not the forecast the bar draws");
  assert.ok(!/etcIsDriving/.test(src), "nothing competes with the forecast for the segment any more");
});

test("Invoiced + the open balance is still stated, now as the table's Purchased row", () => {
  // This sum was never the bug; only Projection (which also added ETC) was. It stood
  // as its own "Total Parts Cost Spent" line until 2026-09-03, when the breakdown
  // table replaced the legend and that line was what the table collided with.
  //
  // Folding it in was not a loss: the row states the same figure WITH its arithmetic,
  // which the line never did. And it no longer sits a foot below a different total —
  // under Dan's model the projection excludes in-house SDC while this figure includes
  // it ($780,324 against $821,469 on job 1104), so leaving the two as unexplained
  // neighbours was itself the confusion.
  const src = code("src", "components", "PartsCostSummary.tsx");
  assert.match(src, /label: "Purchased"/);
  assert.match(src, /value: Math\.round\(financials\.purchased\)/);
  assert.ok(!/Total Parts Cost Spent:/.test(src), "the standalone line is gone, not duplicated");
});

// ── Root cause 2: the GL-posted rule ────────────────────────────────────────

test("the GL-posted rule tests the DoNotExport flag, not the export date", () => {
  const src = SYNC_TOTALETO();
  // Spelled `= 1` and negated since 2026-09-04: the diagnostic that names unclassified
  // flagged vendors needs the flag in the POSITIVE direction, and two hand-written
  // copies is how the extra-costs branch escaped that correction. One constant, two
  // readers. The rule this test is about — the flag, not the export date — is unchanged.
  assert.match(src, /const AP_DOC_FLAGGED = "ISNULL\(APBD\.APDocDoNotExport, 0\) = 1";/, "the flag is the rule");
  assert.match(src, /`\(NOT \$\{AP_DOC_FLAGGED\} OR \$\{companyAlias\}\.CName IN/, "and posted is its negation");
  // Measured 2026-08-10: 45 job-attributed AP lines / $41,352.47 had no export
  // date while NOT being flagged, every one of them dated within the previous
  // week — real invoices merely queued for the next export run. Filtering on the
  // date would delete real current cost every time someone looked before a run.
  assert.doesNotMatch(
    src,
    /APDocExportDate\s+IS\s+(?:NOT\s+)?NULL/i,
    "APDocExportDate IS NULL also matches invoices that are merely PENDING export — filtering on it silently deletes real, current cost",
  );
});

test("both branches of the per-line parts query carry an ActualAmount", () => {
  const src = SYNC_TOTALETO();
  const detail = src.slice(src.indexOf("const partsDetailSql"), src.indexOf("export async function getJobPartsInvoicedInMonth"));
  const occurrences = detail.match(/AS ActualAmount/g) ?? [];
  assert.equal(
    occurrences.length,
    2,
    "the PO branch AND the Extra Costs branch both need it — on job 1116 the Extra Costs branch alone held $9,789.30 of never-posted cost, so covering only the PO branch would leave a third of the problem in place",
  );
  assert.match(detail, /LEFT JOIN tblAPBatchDocument APBD WITH\(NOLOCK\) ON APBD\.APDocID = EC\.APDocID/, "vwCostingExtraCostsDetailed exposes APDocID but not the flag, so it must join back for it");
});

test("narrowing the money must not narrow InvoicedQty", () => {
  const src = SYNC_TOTALETO();
  const detail = src.slice(src.indexOf("const partsDetailSql"), src.indexOf("export async function getJobPartsInvoicedInMonth"));
  const inv = detail.slice(detail.indexOf("LEFT JOIN ( SELECT APDD.PurchaseDetailID"));
  assert.match(inv, /SUM\(APDocQty\) AS InvoicedQty/, "InvoicedQty must still count every billed document");
  assert.doesNotMatch(
    inv.slice(0, inv.indexOf("AS InvoicedQty")),
    /APDocDoNotExport/,
    "a part billed on a never-exported invoice HAS been billed; gating InvoicedQty on the flag would inflate the open-balance term and overstate the very commitment this fix removes",
  );
});

// ── Deliberate non-changes, guarded so they stay deliberate ─────────────────

test("Money Spent Month keeps its own rule and does NOT get the GL-posted filter", () => {
  // getPartsCostBookedByJob is reconciled to the business's own TotalETO pivot as
  // it stands (§41) and feeds ETC months that have been submitted and locked.
  // Applying the GL-posted rule here would move July 2026 by $13,672.97 on a
  // $491,206.43 month across 21 jobs — a retroactive change to signed-off figures.
  // That is a business decision about which reference report the monthly measure
  // follows, not a bug to fix in passing.
  const fn = functionSpan(SYNC_TOTALETO(), "getPartsCostBookedByJob");
  assert.doesNotMatch(
    fn,
    /APDocDoNotExport/,
    "changing the monthly measure would retroactively alter submitted ETC months — raise it as a decision, do not fold it into the Parts Actual fix",
  );
});

test("the per-line invoiced subquery does not group by BatchEntryTypeID", () => {
  // PART_PURCHASE_SQL does, which is a latent join fan-out: a PO line billed under
  // two different batch-entry types joins to two rows and counts its remaining
  // balance twice. Measured at zero jobs affected on 2026-08-10, so it was left
  // alone rather than "fixed" blind — but PARTS_DETAIL_SQL, which feeds every
  // per-line view and the new ActualAmount, must never acquire it.
  const src = SYNC_TOTALETO();
  const detail = src.slice(src.indexOf("const partsDetailSql"), src.indexOf("export async function getJobPartsInvoicedInMonth"));
  assert.doesNotMatch(
    detail,
    /GROUP BY APDD\.PurchaseDetailID,\s*BatchEntryTypeID/,
    "grouping by BatchEntryTypeID multiplies rows per PO line and double-counts its open balance",
  );
});

// ── Every view resolves to the one definition ───────────────────────────────

test("getPartsActualByJob zero-fills jobs that have parts activity but no GL-posted spend", () => {
  const fn = functionSpan(SYNC_TOTALETO(), "getPartsActualByJob");
  assert.match(fn, /UNION ALL/, "jobs with only open POs must still appear in the map");
  // Without this, syncPartsCostActual (which iterates the map) never visits such a
  // job and its stale figure survives. Found live: after the first pass of this
  // fix, 5 of 100 jobs stayed wrong — job 1158 still reporting $99,606.54 of pure
  // open-PO commitment as actual spend, because it had no AP rows at all.
  assert.match(fn, /SELECT EC\.ProjectID AS JobId, 0 AS Actual/, "the Extra Costs job set must be zero-filled too");
});

test("Job Cost Explorer's actual column uses the shared definition", () => {
  const src = code("src", "lib", "job-cost-source.ts");
  assert.match(src, /getPartsActualByJob\(\)/, "must resolve to the same function the Projects grid does");
  assert.doesNotMatch(
    src,
    /getPartsInvoicedByJob\(/,
    "that is the same AP sum WITHOUT the GL-posted rule, so it disagreed with the Projects grid by every never-exported invoice a job had",
  );
});

test("the Parts Cost card's base bar segment comes from `financials.invoiced`, never `paid` or `purchased`", () => {
  // 2026-08-15 (audit "Audit Parts Cost Projection Formula Across All
  // Projects"): PartsCostSummary stopped taking `purchased`/`actual` as
  // separate props and now reads them off one shared `PartsCostFinancials`
  // object (src/lib/parts-cost-financials.ts) — so this guard now pins that
  // `invoiced` traces to `financials.invoiced`, one hop from the same
  // GL-posted-only source (`actualTotal`, see the test below) it always did.
  const src = code("src", "components", "PartsCostSummary.tsx");
  assert.match(src, /const invoiced = financials\.invoiced/, "the base segment is Parts Actual, not `paid` or `purchased`");
  // "Total Parts Cost Spent" was GL-posted-only (`invoiced`) from 2026-08-10
  // through 2026-08-11a — the original assertion here pinned that value. A
  // later, deliberate, by-request redesign (2026-08-11c, see that caption's
  // own comment in PartsCostSummary.tsx) intentionally moved it to
  // Invoiced + Left-to-invoice so the caption reconciles with the two bar
  // segments actually on screen instead of with the external ledger. That is
  // NOT a resurgence of the original bug: `financials.invoiced` itself — the
  // figure every OTHER test in this file guards — is untouched, still
  // GL-posted, and still what the bar's base segment and the legend's
  // "Invoiced" value show. `leftToInvoice` is an explicitly labelled, visibly
  // separate "Left to be invoiced" segment, not commitment silently relabelled
  // as spend.
  //
  // 2026-08-15: the caption now reads a pre-reconciled `totalSpentDisplay`
  // (largest-remainder rounding of [invoiced, leftToInvoice], see
  // reconcilePartsCostRounding) rather than the raw `invoiced + spentIncrement`
  // sum directly — a fix for a real, if usually sub-dollar, display artifact
  // where three independently-rounded segments didn't always sum to a
  // separately-rounded total. `totalSpentDisplay` is BY CONSTRUCTION
  // `invoicedDisplay + leftToInvoiceDisplay`, so this still guards the same
  // invariant: the caption is the bar's own two segments, not the GL-posted
  // figure alone.
  // `totalSpentDisplay` is gone (2026-09-03): the "Total Parts Cost Spent" line it
  // fed is folded into the breakdown table's "Purchased / committed" row, which
  // states the same figure WITH its derivation. The guard's intent — that the figure
  // is the sum of what is displayed rather than re-derived from another source —
  // moves to that row's own arithmetic, asserted above.
  // The table was cut to five rows, and "Purchased / committed" became simply
  // "Purchased" as the first of them. Its own derivation is now plain English rather
  // than a sum, because the row directly beneath it (Left to invoice) is what shows
  // the split.
  assert.match(src, /label: "Purchased"/);
  assert.match(src, /value: Math\.round\(financials\.purchased\)/);
  assert.ok(!/Total Parts Cost Spent:/.test(src), "the standalone line is gone, not duplicated");
});

test("the aggregate Parts Actual sums the per-line field, via the one shared function", () => {
  // 2026-08-15: the per-job-selection aggregation this test used to pin
  // inline on job-hours/page.tsx moved into the shared
  // getPartsCostFinancials (src/lib/parts-cost-financials.ts), which is now
  // every page's one source for this number rather than each page
  // re-deriving it.
  const financials = code("src", "lib", "parts-cost-financials.ts");
  assert.match(
    financials,
    /const invoiced = actualTotal\(lines\)/,
    "getPartsCostFinancials must source Invoiced from the shared actualTotal helper, not re-sum the lines itself",
  );
  const projection = code("src", "lib", "parts-budget-projection.ts");
  assert.match(
    projection,
    /function actualTotal\(lines: PartsCostLine\[\]\)[\s\S]{0,80}total \+= l\.actualAmount/,
    "actualTotal must be summed from the same per-line field every other view uses",
  );
});

// ── What APDocDoNotExport actually means (corrected 2026-09-04) ──────────────
//
// The rule above excluded every flagged AP document on the stated grounds that such a
// document "is never posted to the general ledger, so it never appears on a job
// ledger". Lisa in accounting corrected both halves:
//
//   "Our norm is to enter all purchasing activity for jobs into ETO and then export it
//    from ETO and import into Sage for payments. However there are times when items are
//    entered into Sage first but need to be reflected in ETO — these are then reflected
//    as do not export and have been paid."
//
// So the flag means "do not export to Sage AGAIN". Verified rather than taken on
// trust: all six of job 1101's flagged SDC Credit Card charges appear in the August
// job ledger draft as GENJ rows, reconciling to the cent.
//
// But it is NOT simply "stop excluding". Of the 33 jobs with flagged spend only 6
// reconcile to the ledger; $296,091 has no counterpart, because job 1106's $253,667 is
// five accounting corrections whose entire purpose is to make ETO agree with Sage.
// Counting those would double-count the figure they correct toward.

const TOTALETO = readFileSync(join(process.cwd(), "src", "lib", "sync-totaleto.ts"), "utf8");
/** Source with // and SQL -- comments removed: these assertions are about code. */
const totalEtoCode = TOTALETO.replace(/^\s*\/\/.*$/gm, "").replace(/--.*$/gm, "");

test("the flag is tested in exactly ONE place, and every site calls it", () => {
  // This is the bug that made the fix miss on its first pass. The extra-costs branch —
  // which is where the monthly credit-card charges actually live — had the flag test
  // spelled out by hand instead of using the shared predicate, so narrowing the
  // predicate changed nothing for them and the figures came back untouched.
  //
  // One definition, N call sites. A fifth site that writes the flag out again fails
  // here rather than silently opting itself out of the rule.
  assert.equal(
    (totalEtoCode.match(/APDocDoNotExport/g) ?? []).length,
    1,
    "APDocDoNotExport may appear once, inside glPostedAp",
  );
  assert.match(totalEtoCode, /const glPostedAp = \(companyAlias: string\) =>/);
  // Five call sites: getPartsActualByJob, the per-PO-line invoiced/posted split, the
  // AP drill, the extra-costs branch, and — added 2026-09-04 —
  // getPartsCostBookedByJob, which produces "money spent this month" and carried no
  // GL-posted test at all while parts-budget-projection.ts asserted it shared a basis
  // with Parts Actual. $56,740.45 of August was counted by one and not the other.
  // The arrow definition does not self-match.
  assert.equal(
    (totalEtoCode.match(/glPostedAp\(/g) ?? []).length,
    5,
    "every site that decides posted-vs-billed must call the shared predicate",
  );
  // Money Spent Month specifically, because it is the one that drives the forecast.
  assert.match(
    TOTALETO,
    /AND \$\{glPostedAp\("SFC"\)\}[\s\S]{0,40}?GROUP BY APDD\.ProjectID/,
    "getPartsCostBookedByJob must share the basis it claims to share",
  );
  // The extra-costs branch specifically, because it is the one that decides the
  // credit-card charges and the one that was missed.
  assert.match(
    TOTALETO,
    /CASE WHEN \$\{glPostedAp\("SFC"\)\} THEN EC\.decExtraCostingValue ELSE 0 END AS ActualAmount/,
    "the extra-costs branch must use the shared predicate",
  );
});

test("a Sage-first vendor is matched EXACTLY, never by pattern", () => {
  // `CName LIKE '%credit card%'` would also match `onlinecomponents.com  CREDIT CARD`
  // (CompanyID 1071) — a genuine outside supplier. It has 8 AP documents and zero of
  // them flagged, so the mistake would be invisible today and would appear the first
  // time someone ticked the box on one of its invoices. Same hazard, same treatment as
  // the "SDC" acronym in lib/vendor-normalize.ts: match narrowly.
  // The list itself is asserted by the audit-parity test below; here the point is only
  // that entries are quoted literals in an IN list, never a pattern.
  assert.match(totalEtoCode, /const SAGE_FIRST_VENDORS = "(?:'[^']+'(?:, )?)+";/);
  const predicate = /glPostedAp = \(companyAlias: string\) =>[\s\S]{0,240}?;/.exec(totalEtoCode)?.[0] ?? "";
  assert.ok(predicate.includes("IN (${SAGE_FIRST_VENDORS})"), "an IN list");
  assert.ok(!/LIKE/i.test(predicate), "never a LIKE — it would catch unrelated vendors");
});

test("the predicate takes a joined alias, because a subquery is illegal in an aggregate", () => {
  // The first attempt used a correlated EXISTS. SQL Server refuses it inside
  // SUM(CASE WHEN ...) outright: "Cannot perform an aggregate function on an
  // expression containing an aggregate or a subquery" (error 130), which is a runtime
  // failure of the whole parts pipeline, not a wrong number.
  const predicate = /glPostedAp = \(companyAlias: string\) =>[\s\S]{0,240}?;/.exec(totalEtoCode)?.[0] ?? "";
  assert.ok(!/SELECT/i.test(predicate), "no subquery in the predicate");
  assert.match(totalEtoCode, /const sageFirstJoin = \(alias: string\) =>/);
  // Every site that passes an alias must have joined a company table under that alias.
  for (const alias of totalEtoCode.match(/glPostedAp\("(\w+)"\)/g) ?? []) {
    const name = /glPostedAp\("(\w+)"\)/.exec(alias)![1];
    const joined =
      totalEtoCode.includes(`sageFirstJoin("${name}")`) ||
      new RegExp(`JOIN tblCompany ${name}\\b`).test(totalEtoCode);
    assert.ok(joined, `${name} is used by glPostedAp but no tblCompany is joined as ${name}`);
  }
});

test("the audit script's allow-list is the same one the query uses", () => {
  // Two lists that can disagree is how the audit ends up reporting a vendor as counted
  // when the query excludes it, which is worse than not auditing at all.
  const audit = readFileSync(join(process.cwd(), "scripts", "audit-sage-first-vendors.ts"), "utf8");
  const inQuery = /const SAGE_FIRST_VENDORS = "([^"]+)";/.exec(totalEtoCode)?.[1] ?? "";
  const inAudit = /const ALLOWED = new Set\(\[([^\]]*)\]\)/.exec(audit)?.[1] ?? "";
  const names = (s: string) => (s.match(/'[^']+'|"[^"]+"/g) ?? []).map((x) => x.slice(1, -1)).sort();
  assert.deepEqual(names(inQuery), names(inAudit), "SAGE_FIRST_VENDORS and the audit's ALLOWED must match");
  assert.deepEqual(names(inQuery), ["SDC Credit Card", "Steven Douglas Corp. Expense Reports"].sort());
});

test("only the verified category counts — corrections stay excluded", () => {
  // The allow-list is one vendor on purpose. Job 1106's $253,667 is five correction
  // entries ("Adjustment to match Sage", PO `1106 correction`, two "DISCOUNT
  // Correction" lines against a -$675,000 reversal); Steven Douglas Corp. internal
  // billings and Expense Reports have no ledger counterpart either. Widening this list
  // without checking the ledger the way 1101's charges were checked is how a quarter of
  // a million dollars of corrections becomes reported job cost.
  const inQuery = /const SAGE_FIRST_VENDORS = "([^"]+)";/.exec(totalEtoCode)?.[1] ?? "";
  // Expense Reports joined the list 2026-09-04 on the SAME evidence the card had:
  // job 1101's three in-period lines reconcile to the cent as GENJ "Payroll" postings
  // ($57.64 + $61.02 + $10.49 = $129.15), one of them split across two employees on
  // one day exactly as the card charges split into freight and food.
  //
  // These three have NOT earned it. `Reconciling With Sage - SDC` in particular is
  // the counter-example that proves the rule: job 1101's flagged $480 entry has no
  // ledger counterpart at all, while its unflagged siblings ($9,430.05, $4.34)
  // already count — the flag is applied inconsistently within one vendor.
  for (const notYet of ["Reconciling With Sage", "Innovations", "BlackHawk"]) {
    assert.ok(!inQuery.includes(notYet), `${notYet} must not be allow-listed without ledger evidence`);
  }
  // The bare internal-billing vendor is NOT the expense-report one, and only the
  // second is allow-listed. `Steven Douglas Corp.` alone carries $430,729 of flagged
  // spend with no ledger match found.
  assert.ok(!/'Steven Douglas Corp\.'/.test(inQuery), "the bare internal-billing vendor stays excluded");
});
