import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quantityReadiness } from "../src/lib/job-bom-rules";
import { safePct, pct } from "../src/components/ui/format";

// ── The reported bug: `NaN%` on the Procurement readiness bar ───────────────
//
// The divisor was ALREADY guarded (`requiredQty > 0`), which is why this looked
// impossible on a first read — a NaN total fails that test and returns 0. The
// numerator was not: `Math.min(undefined, 5)` is NaN, so one row with no `receivedQty`
// poisoned `coveredQty`, and NaN over a perfectly good total is NaN. Guarding the
// bottom half of a division and not the top is the whole defect.
//
// And `receivedQty` was undefined because po-detail.ts built its non-BOM rows with
// `as FlatPart` — a cast that silenced the missing-property check on FOURTEEN required
// fields. Removing it is the actual root-cause fix; everything below is what stops the
// same class of thing reaching a screen again.

/** The shape quantityReadiness takes, built loosely so bad inputs can be tested. */
const row = (qty: unknown, receivedQty: unknown) => ({ qty, receivedQty }) as { qty: number; receivedQty: number };

// ── Normal data ────────────────────────────────────────────────────────────

test("normal data: quantity-weighted, rounded, and it reconciles", () => {
  const r = quantityReadiness([row(10, 10), row(10, 5), row(20, 0)]);
  assert.equal(r.requiredQty, 40);
  assert.equal(r.coveredQty, 15);
  assert.equal(r.pct, 38, "15/40 = 37.5, rounded");
  assert.equal(r.counted, 3);
});

test("fully covered is 100, nothing covered is 0", () => {
  assert.equal(quantityReadiness([row(4, 4), row(6, 6)]).pct, 100);
  assert.equal(quantityReadiness([row(4, 0), row(6, 0)]).pct, 0);
});

test("over-receiving cannot push a job past 100%", () => {
  // `Math.min(received, qty)` per row is what caps it, and it must stay per-row: one
  // row over-received by 90 would otherwise cover another row's shortfall.
  const r = quantityReadiness([row(10, 100), row(10, 0)]);
  assert.equal(r.coveredQty, 10);
  assert.equal(r.pct, 50);
});

// ── The failure that was reported ──────────────────────────────────────────

test("a missing receivedQty can no longer produce NaN", () => {
  // The exact reported shape: valid quantities, one row with no receipt figure at all.
  const r = quantityReadiness([row(5, undefined), row(5, 5)]);
  assert.ok(Number.isFinite(r.pct), `pct must be a number, got ${r.pct}`);
  assert.equal(r.pct, 50, "the bad row counts as nothing received, not as nothing at all");
  assert.equal(r.requiredQty, 10, "and its requirement still counts");
});

test("every kind of non-number reads as zero, per row", () => {
  for (const bad of [undefined, null, "", " ", "abc", "628 parts", NaN, Infinity, -Infinity, {}, []]) {
    const r = quantityReadiness([row(10, bad), row(10, 10)]);
    assert.ok(Number.isFinite(r.pct), `receivedQty ${JSON.stringify(bad)} produced ${r.pct}`);
    assert.equal(r.pct, 50);
  }
});

test("a numeric STRING is honoured rather than discarded", () => {
  // "valid numeric string → number". Discarding them would silently understate
  // readiness, which is a quieter bug than NaN and harder to notice.
  const r = quantityReadiness([row("10", "5")]);
  assert.equal(r.requiredQty, 10);
  assert.equal(r.coveredQty, 5);
  assert.equal(r.pct, 50);
});

test("a bad QUANTITY drops that row instead of poisoning the total", () => {
  const r = quantityReadiness([row(undefined, 5), row(10, 10)]);
  assert.equal(r.counted, 1, "the unmeasurable row is not counted");
  assert.equal(r.requiredQty, 10);
  assert.equal(r.pct, 100, "the row that CAN be measured is fully covered");
});

test("negative quantities are floored, not summed", () => {
  // Total ETO carries real negative purchase quantities (job 1143 PO 103689, qty -1).
  // A negative requirement would drag a percentage below zero, or cancel a real
  // requirement out of the denominator when summed against a positive one.
  const r = quantityReadiness([row(-1, 0), row(10, 5)]);
  assert.equal(r.requiredQty, 10, "the negative row must not reduce the denominator");
  assert.equal(r.pct, 50);
  assert.ok(r.pct >= 0);
});

// ── Zero parts, and partially loaded data ──────────────────────────────────

test("zero parts reports 0% and says nothing was measured", () => {
  const r = quantityReadiness([]);
  assert.equal(r.pct, 0, "never NaN from 0/0");
  assert.equal(r.counted, 0, "and the caller can tell this apart from a real 0%");
});

test("rows that exist but carry no requirement are 'nothing to measure'", () => {
  // The partially-loaded case, and the non-BOM-only case: rows are present, none of
  // them is a requirement. `counted` is what lets the UI say so instead of reporting a
  // confident 0%.
  const r = quantityReadiness([row(0, 0), row(0, 0)]);
  assert.equal(r.pct, 0);
  assert.equal(r.counted, 0);
});

test("a loading transition — no rows, then some — never passes through NaN", () => {
  // Refresh/loading: the array is empty, then partial, then complete. Every
  // intermediate state has to be renderable.
  const stages = [[], [row(10, undefined)], [row(10, 5)], [row(10, 5), row(10, 10)]];
  for (const stage of stages) {
    const r = quantityReadiness(stage);
    assert.ok(Number.isFinite(r.pct), `stage produced ${r.pct}`);
    assert.ok(r.pct >= 0 && r.pct <= 100, `stage produced ${r.pct}%`);
  }
});

test("the result is always inside 0..100", () => {
  const cases = [
    [row(1, 1_000_000)],
    [row(1_000_000, 1)],
    [row(0.0001, 0)],
    [row(1, -5)],
  ];
  for (const c of cases) {
    const { pct: p } = quantityReadiness(c);
    assert.ok(Number.isFinite(p) && p >= 0 && p <= 100, `got ${p}`);
  }
});

// ── The render boundary ────────────────────────────────────────────────────

test("safePct refuses to emit anything a screen cannot show", () => {
  for (const [input, want] of [
    [62.5, 63],
    [0, 0],
    [100, 100],
    [-10, 0],
    [140, 100],
    [NaN, 0],
    // Infinity reads as 0, NOT as a clamped 100. Clamping would be the arithmetically
    // tidy answer and the wrong one: a readiness bar claiming "100% ready" off a
    // corrupt number could let somebody ship a job. 0 is the safe direction, and the
    // caller says "not yet measurable" in words when it has nothing to report.
    [Infinity, 0],
    [-Infinity, 0],
    [undefined, 0],
    [null, 0],
    ["", 0],
    ["73", 73],
    ["73.4", 73],
    ["abc", 0],
  ] as const) {
    assert.equal(safePct(input), want, `safePct(${JSON.stringify(input)})`);
  }
});

test("pct() never renders NaN%, Infinity% or undefined%", () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, "", "abc", {}]) {
    const out = pct(bad);
    assert.match(out, /^\d{1,3}%$/, `pct(${JSON.stringify(bad)}) = ${out}`);
    for (const forbidden of ["NaN", "Infinity", "undefined", "null"]) {
      assert.ok(!out.includes(forbidden), `pct(${JSON.stringify(bad)}) rendered "${out}"`);
    }
  }
});

// ── Structural: the root cause, and the boundaries ─────────────────────────

test("the cast that hid fourteen missing fields is gone", () => {
  // This is the actual root-cause fix. `as FlatPart` silenced the missing-property
  // check on the synthesized non-BOM rows, and `receivedQty` was only the one that
  // happened to surface — poQty, costBasis, source, release, status, hold and seven
  // more were absent too, each waiting on a different consumer.
  const src = readFileSync(join(process.cwd(), "src", "lib", "po-detail.ts"), "utf8");
  assert.ok(!/\}\s*as FlatPart\)/.test(src), "the non-BOM row must be type-checked, not cast");
  for (const field of ["receivedQty:", "poQty:", "costBasis:", "source:", "release:", "status:", "hold:"]) {
    assert.ok(src.includes(field), `the non-BOM row must set ${field}`);
  }
});

test("a non-BOM row is not a procurement gap", () => {
  // `isUncoveredPart` is `status === "noPO" && !hold`, so giving these rows "noPO"
  // would have turned every non-BOM purchase into an uncovered part — on job 1101 that
  // is 95 rows, taking the readiness line's "4 uncovered" to 99. They are the opposite
  // of a gap: each stands for a purchase that HAS been made.
  //
  // Before the cast was removed the field was undefined, so the count was right by
  // accident. This is what makes it right by rule.
  const src = readFileSync(join(process.cwd(), "src", "lib", "po-detail.ts"), "utf8");
  const nonBom = src.slice(src.indexOf("id: syntheticId--"), src.indexOf("nonBom: true"));
  assert.match(nonBom, /status: "ordered"/, "a non-BOM row is purchased, not a gap");
  assert.ok(!/status: "noPO"/.test(nonBom));
});

test("readiness is measured over BOM requirements, from the same array as the counts", () => {
  // Two requirements in one: a non-BOM row cannot be "not ready" (it is already
  // bought), and the percentage has to come from the same data as the counts printed
  // beside it rather than from a separate variable.
  const src = readFileSync(join(process.cwd(), "src", "components", "JobProcurement.tsx"), "utf8");
  assert.match(src, /const requirements = parts\.filter\(\(p\) => !p\.nonBom\);/);
  assert.match(src, /const readiness = quantityReadiness\(requirements\);/);
  // Same `parts` array the counts are filtered from, inside the same memo.
  const memo = src.slice(src.indexOf("const summary = useMemo("), src.indexOf("}, [parts]);"));
  for (const line of ["const total = parts.length", "parts.filter(isUncoveredPart)", "quantityReadiness(requirements)"]) {
    assert.ok(memo.includes(line), `the summary must derive ${line} in one place`);
  }
});

test("nothing measurable is said in words, not as a confident 0%", () => {
  const src = readFileSync(join(process.cwd(), "src", "components", "JobProcurement.tsx"), "utf8");
  assert.match(src, /measurable: readiness\.counted > 0/);
  assert.match(src, /summary\.measurable \? \(/);
  assert.ok(src.includes("Not yet measurable"));
});

test("every percentage render boundary clamps, and none keeps its own copy", () => {
  // One helper, several boundaries — a second copy is how one of them ends up not
  // clamping. Each of these took a plain `number` and interpolated it raw, which is
  // exactly how a broken figure reached the screen while the bar beside it looked fine.
  for (const [what, path] of [
    ["the readiness bar", ["src", "components", "JobProcurement.tsx"]],
    ["the readiness pill", ["src", "components", "build-readiness", "ReadinessPill.tsx"]],
    ["the assembly detail", ["src", "components", "build-readiness", "BuildReadinessAssemblyDetail.tsx"]],
  ] as const) {
    const src = readFileSync(join(process.cwd(), ...path), "utf8");
    assert.match(src, /from "@\/components\/ui\/format"/, `${what} must use the shared helper`);
    assert.match(src, /safePct|pct\(/, `${what} must clamp before rendering`);
  }
});
