import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FILTER_ALL, resolveFilterChoice, filterOptionValues, sanitizeStatusSelection } from "../src/lib/filter-choice";
import { normalizeVendor, SDC_CANONICAL } from "../src/lib/vendor-normalize";

// ── "No parts match the current filters" on an unfiltered table ──────────────
//
// Reported 2026-09-03: the tab read Parts List 327, the chips read BOM 296 /
// Non-BOM 31, all three dropdowns read "All …", the dates and the search were empty —
// and the table showed nothing over "0 line items".
//
// The dropdowns were telling the truth about the OPTIONS and lying about the FILTER.
// JobProcurement persists category/manufacturer/supplier under one localStorage key
// for the whole app rather than per job, so a value chosen on one job is still in state
// on the next. A controlled `<select>` whose value is not among its options paints its
// FIRST option — "All suppliers" — while React state keeps the old value, and the
// predicate went on testing every row against it.

const JOB_PROCUREMENT = readFileSync(join(process.cwd(), "src", "components", "JobProcurement.tsx"), "utf8");

test("a choice the options do not offer is not a filter", () => {
  const suppliers = ["Allied Electronics", "Grainger", SDC_CANONICAL];
  // The reported state: a supplier carried over from another job.
  assert.equal(resolveFilterChoice("Motion Industries", suppliers), FILTER_ALL);
  // A real one survives untouched.
  assert.equal(resolveFilterChoice("Grainger", suppliers), "Grainger");
  // The sentinel, and the ways "nothing chosen" can arrive from storage.
  assert.equal(resolveFilterChoice(FILTER_ALL, suppliers), FILTER_ALL);
  assert.equal(resolveFilterChoice("", suppliers), FILTER_ALL);
  assert.equal(resolveFilterChoice("   ", suppliers), FILTER_ALL);
  assert.equal(resolveFilterChoice(null, suppliers), FILTER_ALL);
  assert.equal(resolveFilterChoice(undefined, suppliers), FILTER_ALL);
  // No options at all (upstream empty, a job with no purchase lines) restricts nothing
  // rather than restricting everything.
  assert.equal(resolveFilterChoice("Grainger", []), FILTER_ALL);
});

test("the SDC normalization orphans a saved choice — and that no longer empties the table", () => {
  // This is why the bug arrived for everyone at once rather than for one unlucky user.
  // vendor-normalize collapsed the SDC spellings into one canonical option, so every
  // pre-normalization spelling sitting in a browser's localStorage stopped matching
  // anything ON ANY JOB. Not one part was remapped or dropped; a saved choice was
  // orphaned, and the orphan emptied the table.
  const rawSuppliers = ["SDC ASSY", "STEVEN DOUGLAS CORP", "SDC", "Grainger"];
  const options = filterOptionValues(rawSuppliers.map(normalizeVendor));
  assert.deepEqual(options, ["Grainger", SDC_CANONICAL], "every SDC spelling is one option");

  for (const stale of ["SDC ASSY", "STEVEN DOUGLAS CORP", "SDC"]) {
    assert.equal(resolveFilterChoice(stale, options), FILTER_ALL, `${stale} must not survive as a live filter`);
  }
  // And the canonical option still filters, matching every alias behind it — the
  // behaviour the normalization was added for, which this fix must not undo.
  assert.equal(resolveFilterChoice(SDC_CANONICAL, options), SDC_CANONICAL);
  assert.equal(rawSuppliers.filter((s) => normalizeVendor(s) === SDC_CANONICAL).length, 3);
});

test("an 'All' value can never be a literal option", () => {
  // The defensive half. A category or vendor literally spelled "all" would be
  // indistinguishable from the no-restriction sentinel, so selecting it would WIDEN the
  // table — the confusing direction. It is dropped from the options only; the rows
  // themselves are never filtered on a sentinel, so they keep showing.
  const opts = filterOptionValues(["Fasteners", "all", "Pneumatics", "  ", null, undefined, "Fasteners"]);
  assert.deepEqual(opts, ["Fasteners", "Pneumatics"]);
  assert.ok(!opts.includes(FILTER_ALL));
  // Deduped and sorted, so one vendor cannot appear twice in the list.
  assert.deepEqual(filterOptionValues(["Zeta", "alpha", "Zeta"]), ["alpha", "Zeta"]);
});

test("a restored status selection cannot silently hide every BOM row", () => {
  const known = ["received", "ordered", "soon", "overdue", "stock", "process", "noPO", "hold"] as const;
  const fallback = known.filter((k) => k !== "hold");

  // Stale keys — a renamed or retired status — match no row. Kept keys survive; the
  // dead ones go, so the badge counts what is actually doing something.
  assert.deepEqual(sanitizeStatusSelection(["received", "backordered"], known, fallback), ["received"]);
  // Nothing recognisable left means "match no status", which is a fine thing to choose
  // in front of you and a terrible thing to restore into a fresh job.
  assert.deepEqual(sanitizeStatusSelection(["backordered"], known, fallback), [...fallback]);
  assert.deepEqual(sanitizeStatusSelection([], known, fallback), [...fallback]);
  // Nothing stored at all, and junk in storage.
  assert.deepEqual(sanitizeStatusSelection(undefined, known, fallback), [...fallback]);
  assert.deepEqual(sanitizeStatusSelection("received", known, fallback), [...fallback]);
  assert.deepEqual(sanitizeStatusSelection([1, null, {}], known, fallback), [...fallback]);
  // The default itself must leave rows visible — it deliberately hides only On Hold.
  assert.equal(fallback.length, known.length - 1);
});

test("the predicate and the <select> read the SAME resolved value", () => {
  // The actual fix, and the thing a future edit is most likely to undo. The defect was
  // not a wrong comparison — it was two places disagreeing about what the filter was,
  // so checking the value harder in either one alone would not have helped.
  for (const [state, eff] of [["category", "effCategory"], ["manufacturer", "effManufacturer"], ["supplier", "effSupplier"]]) {
    assert.match(
      JOB_PROCUREMENT,
      new RegExp(`const ${eff} = resolveFilterChoice\\(${state}, distinct\\.`),
      `${eff} must be resolved against the live options`,
    );
    assert.match(JOB_PROCUREMENT, new RegExp(`value=\\{${eff}\\}`), `the <select> must display ${eff}`);
    assert.ok(
      !new RegExp(`value=\\{${state}\\}`).test(JOB_PROCUREMENT),
      `the <select> must not display the raw ${state} state`,
    );
    assert.ok(
      !new RegExp(`\\b${state} !== "all"`).test(JOB_PROCUREMENT),
      `the predicate must not test the raw ${state} state against a literal sentinel`,
    );
  }
  // Both halves of every dropdown comparison use the resolved value.
  assert.match(JOB_PROCUREMENT, /if \(effCategory !== FILTER_ALL && p\.category !== effCategory\) return false;/);
  assert.match(JOB_PROCUREMENT, /if \(effManufacturer !== FILTER_ALL && normalizeVendor\(p\.manufacturer\) !== effManufacturer\) return false;/);
  assert.match(JOB_PROCUREMENT, /if \(effSupplier !== FILTER_ALL && normalizeVendor\(p\.supplier\) !== effSupplier\) return false;/);
  // …and so does the Clear button's own test. An orphaned choice showing "Clear" over
  // an empty table was this bug's only visible symptom.
  assert.match(JOB_PROCUREMENT, /const filtersActive =\s*!statusIsDefault \|\|\s*effCategory !== FILTER_ALL/);
});

test("the options come from every row, so changing scope cannot orphan a choice", () => {
  // `allParts`, not the scoped subset. Otherwise switching to Non-BOM would make a
  // manufacturer that only appears on BOM rows look off-list, and resolveFilterChoice
  // would discard it — turning this fix into a new silent reset. It is also the rule
  // the chip counts already follow.
  assert.match(JOB_PROCUREMENT, /const distinct = useMemo\(\(\) => \{[\s\S]{0,900}?for \(const p of allParts\)/);
  assert.match(JOB_PROCUREMENT, /return \{ cats: filterOptionValues\(cats\), mfrs: filterOptionValues\(mfrs\), sups: filterOptionValues\(sups\) \};\s*\}, \[allParts\]\);/);
});

test("a blank date, a blank search and an untouched scope restrict nothing", () => {
  // The rest of the neutral state, pinned because "0 line items on an unfiltered table"
  // has more than one way to happen and only one of them was the reported cause.
  //
  // Dates: the whole range block is behind `from || to`, so two empty inputs never
  // reach a comparison — and never reach the `if (!d) return false` inside it, which
  // WOULD drop every part with no purchase date.
  assert.match(JOB_PROCUREMENT, /if \(from \|\| to\) \{/);
  // Search: the haystack test is behind a trimmed, non-empty query.
  assert.match(JOB_PROCUREMENT, /const q = query\.trim\(\)\.toLowerCase\(\);/);
  assert.match(JOB_PROCUREMENT, /if \(q\) \{[\s\S]{0,400}?hay\.includes\(q\)/);
  // Scope: "all" passes every row through, and is not persisted, so it cannot arrive
  // pre-set from another job.
  assert.match(JOB_PROCUREMENT, /scope === "all" \? parts : parts\.filter\(/);
  assert.match(JOB_PROCUREMENT, /useState<"all" \| "bom" \| "nonbom">\("all"\)/);
  // Status applies only to BOM rows, so it can never be what empties the table on its
  // own — a job with non-BOM charges keeps showing them.
  assert.match(JOB_PROCUREMENT, /if \(!p\.nonBom && status\.size < ALL_STATUS_KEYS\.length\) \{/);
  // Clear returns every one of them to neutral in one click.
  assert.match(
    JOB_PROCUREMENT,
    /const clearFilters = useCallback\(\(\) => \{\s*setStatus\(\(\) => new Set\(DEFAULT_STATUS_KEYS\)\);\s*setCategory\(FILTER_ALL\);\s*setManufacturer\(FILTER_ALL\);\s*setSupplier\(FILTER_ALL\);\s*setQuery\(""\);\s*setDateType\("purchase"\);\s*setFrom\(""\);\s*setTo\(""\);/,
  );
});

test("filters compose — no single one can take the table to zero on its own", () => {
  // A miniature of the predicate over a mixed set, run as ALL of the combinations the
  // report asks about. The point is not any one answer: it is that every filter is
  // independent and additive, so the count moves with what was actually selected.
  type Row = { pn: string; nonBom: boolean; st: string; category: string | null; mfr: string | null; sup: string | null };
  const rows: Row[] = [
    { pn: "A-1", nonBom: false, st: "received", category: "Fasteners", mfr: "SDC ASSY", sup: "Grainger" },
    { pn: "A-2", nonBom: false, st: "ordered", category: "Fasteners", mfr: "Bosch", sup: "Grainger" },
    { pn: "A-3", nonBom: false, st: "hold", category: "Pneumatics", mfr: "SMC", sup: "Motion" },
    { pn: "F-1", nonBom: true, st: "received", category: null, mfr: "STEVEN DOUGLAS CORP", sup: null },
  ];
  const mfrOptions = filterOptionValues(rows.map((r) => normalizeVendor(r.mfr)));
  const catOptions = filterOptionValues(rows.map((r) => r.category));

  const run = (opts: { status?: string[]; category?: string; mfr?: string; scope?: "all" | "bom" | "nonbom"; q?: string }) => {
    const all = ["received", "ordered", "hold"];
    const status = new Set(opts.status ?? all);
    const cat = resolveFilterChoice(opts.category, catOptions);
    const mfr = resolveFilterChoice(opts.mfr, mfrOptions);
    const scope = opts.scope ?? "all";
    const q = (opts.q ?? "").trim().toLowerCase();
    return rows
      .filter((r) => (scope === "all" ? true : scope === "nonbom" ? r.nonBom : !r.nonBom))
      .filter((r) => {
        if (!r.nonBom && status.size < all.length && !status.has(r.st)) return false;
        if (cat !== FILTER_ALL && r.category !== cat) return false;
        if (mfr !== FILTER_ALL && normalizeVendor(r.mfr) !== mfr) return false;
        if (q && !`${r.pn} ${r.mfr ?? ""} ${r.sup ?? ""}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .map((r) => r.pn);
  };

  // Neutral: everything, and the scope chips reconcile to it.
  assert.deepEqual(run({}), ["A-1", "A-2", "A-3", "F-1"]);
  assert.equal(run({ scope: "bom" }).length + run({ scope: "nonbom" }).length, run({}).length);
  // One orphaned choice — the reported failure — is now inert rather than fatal.
  assert.deepEqual(run({ mfr: "Motion Industries" }), ["A-1", "A-2", "A-3", "F-1"]);
  assert.deepEqual(run({ category: "Hydraulics" }), ["A-1", "A-2", "A-3", "F-1"]);
  // Real choices still narrow, and the SDC option catches both spellings.
  assert.deepEqual(run({ mfr: SDC_CANONICAL }), ["A-1", "F-1"]);
  assert.deepEqual(run({ category: "Fasteners" }), ["A-1", "A-2"]);
  // Status hides the BOM rows it names and never the non-BOM charge.
  assert.deepEqual(run({ status: ["received", "ordered"] }), ["A-1", "A-2", "F-1"]);
  // Combinations: each filter removes only what it describes.
  assert.deepEqual(run({ category: "Fasteners", status: ["received"] }), ["A-1"]);
  assert.deepEqual(run({ mfr: SDC_CANONICAL, scope: "nonbom" }), ["F-1"]);
  assert.deepEqual(run({ q: "grainger" }), ["A-1", "A-2"]);
  assert.deepEqual(run({ q: "grainger", mfr: "Bosch" }), ["A-2"]);
  // A genuinely empty result is still reachable — this fix must not make filtering
  // impossible, only make a filter nobody set impossible.
  assert.deepEqual(run({ mfr: "Bosch", category: "Pneumatics" }), []);
});
