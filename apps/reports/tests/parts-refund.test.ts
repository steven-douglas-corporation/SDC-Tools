import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  REFUND_KEYWORD,
  isRefundLabel,
  refundSignedAmount,
  applyRefundSign,
  sqlRefundSigned,
} from "../src/lib/parts-refund";

// ── Refund lines are negative spend (2026-08-31) ───────────────────────────
//
// Found live: job 1148 carried a $31,765.20 AP line described simply "Refund",
// booked POSITIVE, so it was adding to August's parts spend instead of coming
// off it.
//
// The rule is `-abs(x)`, not `x * -1`, and that distinction is the reason most
// of these tests exist. The two halves of the pipeline OVERLAP deliberately —
// the SQL rule reads APDD.APDocItemDesc, the TypeScript rule reads the resolved
// COALESCE description — so a line can be signed twice. With `-abs` that is a
// no-op; with `* -1` the second pass would flip a genuine credit memo back to
// positive spend.

// ── Matching ───────────────────────────────────────────────────────────────

test("refund is matched case-insensitively, anywhere in the description", () => {
  for (const d of ["Refund", "REFUND", "refund", "Customer Refund", "Parts refund", "PARTS REFUND - Q3", "prepaid refunds"]) {
    assert.ok(isRefundLabel(d), `${JSON.stringify(d)} should be a refund`);
  }
});

test("non-refund descriptions are not matched", () => {
  for (const d of ["Gearbox", "Surge protector", "shipping", "TARIFF", "Anodizing - CLEAR", "", "   ", null, undefined]) {
    assert.ok(!isRefundLabel(d), `${JSON.stringify(d)} should NOT be a refund`);
  }
});

// ── Signing ────────────────────────────────────────────────────────────────

test("a positive refund amount becomes negative", () => {
  assert.equal(refundSignedAmount("Refund", 31765.2), -31765.2);
  assert.equal(refundSignedAmount("Customer Refund", 100), -100);
});

test("an already-negative refund amount STAYS negative — no double negative", () => {
  // The whole reason the rule is -abs() and not * -1. A credit memo already
  // stored negative must not be flipped back into positive spend.
  assert.equal(refundSignedAmount("Refund", -31765.2), -31765.2);
  assert.equal(refundSignedAmount("REFUND", -100), -100);
});

test("signing is idempotent, because both pipeline halves may sign the same line", () => {
  for (const amount of [31765.2, -31765.2, 0]) {
    const once = refundSignedAmount("Refund", amount);
    assert.equal(refundSignedAmount("Refund", once), once, `re-signing ${amount} changed it`);
  }
});

test("non-refund amounts are untouched, in both signs", () => {
  assert.equal(refundSignedAmount("Gearbox", 500), 500);
  assert.equal(refundSignedAmount("Gearbox", -500), -500, "a genuine credit memo keeps its own sign");
  assert.equal(refundSignedAmount(null, 10), 10);
});

test("a non-finite amount passes through rather than becoming a confident number", () => {
  assert.ok(Number.isNaN(refundSignedAmount("Refund", Number.NaN)));
});

// ── Whole lines ────────────────────────────────────────────────────────────

const line = (description: string | null, amount: number) => ({
  description,
  quantity: 1,
  unitPrice: amount,
  totalPrice: amount,
  invoicedAmount: amount,
  actualAmount: amount,
});

test("a zero refund stays POSITIVE zero, never -0", () => {
  // -Math.abs(0) is negative zero, and Intl.NumberFormat renders that as
  // "-$0.00" — a zero-value refund line would display as a negative nothing.
  assert.ok(Object.is(refundSignedAmount("Refund", 0), 0), "must be +0, not -0");
  assert.ok(Object.is(applyRefundSign(line("Refund", 0)).invoicedAmount, 0));
  assert.equal(new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(refundSignedAmount("Refund", 0)), "$0.00");
});

test("every money amount on a refund line is signed", () => {
  const signed = applyRefundSign(line("Refund", 31765.2));
  assert.equal(signed.totalPrice, -31765.2);
  assert.equal(signed.invoicedAmount, -31765.2);
  assert.equal(signed.actualAmount, -31765.2);
});

test("quantity and unit price are deliberately left alone", () => {
  // A unit price is a RATE, not an amount. Negating it would say the part costs
  // minus-something each, and on a line recorded as a negative QUANTITY against
  // a positive rate it would flip the row back to positive spend.
  const signed = applyRefundSign(line("Refund", 31765.2));
  assert.equal(signed.quantity, 1);
  assert.equal(signed.unitPrice, 31765.2);
});

test("a non-refund line is returned unchanged, by identity", () => {
  const original = line("Gearbox", 500);
  assert.equal(applyRefundSign(original), original, "the common path must not allocate a copy");
});

test("applying the line rule twice changes nothing", () => {
  const once = applyRefundSign(line("Refund", 31765.2));
  const twice = applyRefundSign(once);
  assert.deepEqual(twice, once);
});

// ── Totals ─────────────────────────────────────────────────────────────────

test("a job total falls by the refund amount, and by exactly twice the swing", () => {
  // The real August 1148 shape: a refund among ordinary lines. Summed the way
  // sync-totaleto.ts sums them.
  const raw = [line("shipping", 10.32), line("Refund", 31765.2), line("Gearbox", 19440)];
  const before = raw.reduce((s, l) => s + l.invoicedAmount, 0);
  const after = raw.map(applyRefundSign).reduce((s, l) => s + l.invoicedAmount, 0);
  assert.equal(Math.round((before - after) * 100) / 100, 63530.4, "the swing is 2x the refund");
  assert.equal(Math.round(after * 100) / 100, -12314.88);
});

test("the rows a drill displays sum to the total it shows", () => {
  const rows = [line("Refund", 31765.2), line("Widget", 100), line("Bracket", 50)].map(applyRefundSign);
  const total = rows.reduce((s, l) => s + l.invoicedAmount, 0);
  assert.equal(Math.round(total * 100) / 100, -31615.2);
  assert.equal(rows.filter((r) => r.invoicedAmount < 0).length, 1, "only the refund is negative");
});

// ── The SQL half ───────────────────────────────────────────────────────────

test("the SQL rule uses -ABS, not a blind negation", () => {
  const expr = sqlRefundSigned("AMT", "DESCR");
  assert.match(expr, /-ABS\(AMT\)/, "must be -ABS so an already-negative amount stays negative");
  assert.doesNotMatch(expr, /\*\s*-1/, "a blind * -1 would double-negate");
});

test("the SQL rule is collation-independent and null-safe", () => {
  const expr = sqlRefundSigned("AMT", "DESCR");
  assert.match(expr, /LOWER\(ISNULL\(DESCR, ''\)\)/, "lower-cased so it does not depend on the server collation");
  assert.match(expr, /LIKE '%refund%'/);
});

test("the SQL and TypeScript halves share one keyword", () => {
  // Two definitions of "what is a refund" is exactly how the row-level sign and
  // the aggregate sign come to disagree.
  assert.equal(REFUND_KEYWORD, "refund");
  assert.ok(sqlRefundSigned("A", "D").includes(REFUND_KEYWORD));
  assert.ok(isRefundLabel(REFUND_KEYWORD.toUpperCase()));
});

// ── Wiring: applied once, in the shared layer ──────────────────────────────

const SRC = join(import.meta.dirname, "..", "src");
const read = (...p: string[]) => readFileSync(join(SRC, ...p), "utf8");
const codeOf = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("the canonical AP-line amount carries the rule, so every aggregate inherits it", () => {
  const sync = codeOf(read("lib", "sync-totaleto.ts"));
  assert.match(sync, /const AP_LINE_AMOUNT = sqlRefundSigned\(AP_LINE_AMOUNT_RAW, "APDD\.APDocItemDesc"\)/);
  // Every AP aggregate must still go through the wrapped constant, not the raw one.
  const rawUses = sync.match(/AP_LINE_AMOUNT_RAW/g) ?? [];
  assert.equal(rawUses.length, 2, "the raw expression is only declared and wrapped, never queried directly");
});

test("both line builders apply the rule before they total anything", () => {
  const sync = codeOf(read("lib", "sync-totaleto.ts"));
  const applied = sync.match(/\.map\(applyRefundSign\)/g) ?? [];
  assert.equal(applied.length, 2, "getJobPartsCost and getJobPartsInvoicedInMonth must both sign their lines");
  // The reduces that build purchased/paid/actual must come AFTER the map, so the
  // totals are built from signed lines rather than raw ones.
  for (const marker of ["const meaningful = lines.filter", "const paid = meaningful.reduce"]) {
    assert.ok(sync.indexOf(".map(applyRefundSign)") < sync.lastIndexOf(marker), `${marker} must follow the signing`);
  }
});

test("no UI component reimplements the refund rule", () => {
  // The rule is a data-layer concern. A component doing its own `includes("refund")`
  // would sign a displayed row without signing the total above it.
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const full = join(dir, e);
      return statSync(full).isDirectory() ? walk(full) : full.endsWith(".tsx") ? [full] : [];
    });
  const offenders = walk(join(SRC, "components")).filter((f) => /refund/i.test(codeOf(readFileSync(f, "utf8"))));
  assert.deepEqual(offenders, [], "components must not know about refunds");
});
