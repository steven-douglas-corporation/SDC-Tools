import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AP_DOC_FLAGGED, SAGE_FIRST_VENDORS, glPostedAp, sageFirstJoin, PO_LINE_ORDERED_AMOUNT } from "../src/lib/gl-posted-sql";

// ── Cash Flow applies the SAME GL-posted rule and the SAME currency term as
//    Parts Actual (2026-09-14) ────────────────────────────────────────────────
//
// Two defects in cash-flow-totaleto.ts and cash-flow-drill.ts:
//
//   * They hard-coded `ISNULL(APBD.APDocDoNotExport, 0) = 0` — the rule as it
//     stood BEFORE 2026-09-04, when accounting corrected what the flag means. A
//     flagged document from a Sage-first vendor (the company card) is paid and
//     on the ledger; sync-totaleto.ts counts it, the forecast dropped it.
//   * OrderedAmount was PurchaseQty x PurchasePrice with NO PurchaseCurrRate,
//     while the InvoicedAmount it was netted against carried APDocCurrRate — so a
//     foreign-currency PO's remaining commitment mixed two currencies.
//
// lib/gl-posted-sql.ts is where the two files now read both from. sync-totaleto.ts
// still owns its own copy (another change in flight), so the first test is a
// PARITY test: the copy here must match that file's spelling byte for byte, or
// the two figures the business compares drift apart again with nothing saying so.

const SRC = join(import.meta.dirname, "..", "src", "lib");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");
const strip = (raw: string) => raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("the shared predicate is byte-identical to sync-totaleto.ts's own", () => {
  const sync = read("sync-totaleto.ts");
  const vendors = sync.match(/const SAGE_FIRST_VENDORS = (".*?");/);
  const flagged = sync.match(/const AP_DOC_FLAGGED = (".*?");/);
  assert.ok(vendors && flagged, "sync-totaleto.ts must still define both constants");
  assert.equal(SAGE_FIRST_VENDORS, JSON.parse(vendors[1]));
  assert.equal(AP_DOC_FLAGGED, JSON.parse(flagged[1]));
  // The composed predicate, evaluated the way both files evaluate it.
  const composed = sync.match(/const glPostedAp = \(companyAlias: string\) =>\s*`([^`]+)`/);
  assert.ok(composed, "sync-totaleto.ts must still compose glPostedAp from the two constants");
  const expected = composed[1].replace("${AP_DOC_FLAGGED}", AP_DOC_FLAGGED).replace("${companyAlias}", "SFC").replace("${SAGE_FIRST_VENDORS}", SAGE_FIRST_VENDORS);
  assert.equal(glPostedAp("SFC"), expected);
  const join_ = sync.match(/const sageFirstJoin = \(alias: string\) =>\s*`([^`]+)`/);
  assert.ok(join_, "and the tblCompany join");
  assert.equal(sageFirstJoin("SFC"), join_[1].replaceAll("${alias}", "SFC"));
});

test("the predicate counts an unflagged document, and a flagged one only from a Sage-first vendor", () => {
  const p = glPostedAp("SFC");
  assert.equal(p, "(NOT ISNULL(APBD.APDocDoNotExport, 0) = 1 OR SFC.CName IN ('SDC Credit Card', 'Steven Douglas Corp. Expense Reports'))");
  assert.doesNotMatch(p, /LIKE/, "matched exactly, never by pattern — see the 'onlinecomponents.com  CREDIT CARD' case");
});

test("the ordered-amount term carries the same currency rate LINE_TOTAL_PRICE multiplies by", () => {
  const sync = read("sync-totaleto.ts");
  const ltp = sync.match(/const LINE_TOTAL_PRICE = `([\s\S]*?)`;/);
  assert.ok(ltp, "LINE_TOTAL_PRICE must still exist");
  assert.match(ltp[1], /\* POD\.PurchasePrice \* POH\.PurchaseCurrRate/);
  assert.equal(PO_LINE_ORDERED_AMOUNT, "(POD.PurchaseQty * POD.PurchasePrice * POH.PurchaseCurrRate)");
});

for (const file of ["cash-flow-totaleto.ts", "cash-flow-drill.ts"]) {
  test(`${file} reads the GL-posted rule from lib/gl-posted-sql.ts and never spells the flag by hand`, () => {
    const code = strip(read(file));
    assert.match(code, /from "@\/lib\/gl-posted-sql"/);
    assert.doesNotMatch(code, /APDocDoNotExport/, "the flag appears only inside the shared predicate");
    // Every place the predicate is applied has the vendor join it reads through.
    const applied = (code.match(/\$\{GL_POSTED_AP\}/g) ?? []).length;
    const joined = (code.match(/\$\{sageFirstJoin\("SFC"\)\}/g) ?? []).length;
    assert.ok(applied >= 2, `${file}: the predicate is applied to both the AP and the PO query`);
    assert.equal(joined, applied, `${file}: each application of glPostedAp("SFC") needs its tblCompany SFC join`);
  });

  test(`${file} orders PO value in the job's currency`, () => {
    const code = strip(read(file));
    assert.match(code, /\$\{PO_LINE_ORDERED_AMOUNT\} AS OrderedAmount/);
    assert.doesNotMatch(code, /\(POD\.PurchaseQty \* POD\.PurchasePrice\) AS OrderedAmount/, "no unrated ordered amount beside a rated invoiced one");
  });
}
