import test from "node:test";
import assert from "node:assert/strict";
import {
  SDC_CANONICAL,
  isSdcVendor,
  normalizeVendor,
  normalizedVendorOptions,
} from "../src/lib/vendor-normalize";

// ── The values actually in the data ─────────────────────────────────────────
//
// Measured over 7,582 parts lines across 41 jobs. These five are every value matching
// /sdc|steven|douglas/i, with their real line counts.

test("the three real SDC spellings all normalize to one value", () => {
  for (const raw of ["SDC", "SDC ASSY", "Steven Douglas Corp."]) {
    assert.equal(normalizeVendor(raw), SDC_CANONICAL, `${raw} should normalize`);
  }
});

test("the spellings named in the request normalize too, even though none are in the data yet", () => {
  // Matched by pattern rather than enumerated, so a new spelling is absorbed without
  // a code change — which is the point of having one function.
  for (const raw of [
    "Steven Douglas",
    "Steven Douglas Corp",
    "Steven Douglas Corporation",
    "steven douglas corp.",
    "  STEVEN   DOUGLAS   CORP  ",
    "sdc",
    "  SDC  ",
    "SDC Assembly",
  ]) {
    assert.equal(normalizeVendor(raw), SDC_CANONICAL, `${JSON.stringify(raw)} should normalize`);
  }
});

test("the canonical value is stable under a second pass", () => {
  // Normalizing already-normalized data must not drift — this runs at several layers.
  assert.equal(normalizeVendor(SDC_CANONICAL), SDC_CANONICAL);
  assert.equal(normalizeVendor(normalizeVendor(normalizeVendor("SDC"))), SDC_CANONICAL);
});

// ── The two that must NOT be merged ────────────────────────────────────────
//
// "Do not accidentally combine unrelated suppliers/manufacturers." Both carry SDC's
// name and neither is SDC supplying a part.

test("the credit-card conduit is not SDC as a vendor", () => {
  // 33 lines. A PAYMENT METHOD — the real vendor is in the manufacturer field. And it
  // has a financial consequence: isInHouseSdc keys on manufacturer to exclude in-house
  // work from external invoice exposure, so merging this would reclassify genuine
  // outside spend as work SDC never invoices.
  assert.equal(isSdcVendor("SDC Credit Card (Approved)"), false);
  assert.equal(normalizeVendor("SDC Credit Card (Approved)"), "SDC Credit Card (Approved)");
});

test("the expense-report conduit is not SDC as a vendor", () => {
  // 11 lines. Note it would otherwise match the "steven douglas" pattern, which is why
  // the exclusions are tested BEFORE the patterns.
  const raw = "Steven Douglas Corp. Expense Reports [Concord] (Unapproved)";
  assert.equal(isSdcVendor(raw), false);
  assert.equal(normalizeVendor(raw), raw);
});

test("the Sage reconciliation account is not SDC as a vendor", () => {
  assert.equal(isSdcVendor("Reconciling With Sage - SDC"), false);
});

// ── Unrelated vendors must survive untouched ───────────────────────────────

test("a three-letter substring match cannot swallow an unrelated vendor", () => {
  // 356 distinct manufacturers in the data. An unanchored "SDC" match across that many
  // names is how unrelated vendors get merged, so the acronym only matches as its own
  // leading word.
  for (const raw of ["SDCO Inc", "MSDC Ltd", "TRANSDUCERS INC", "SDCOM", "Douglas Fir Supply"]) {
    assert.equal(isSdcVendor(raw), false, `${raw} must not be treated as SDC`);
    assert.equal(normalizeVendor(raw), raw, `${raw} must pass through unchanged`);
  }
});

test("real vendors from the data pass through with only whitespace trimmed", () => {
  for (const raw of ["KEYENCE CORP OF AMERICA", "McMASTER-CARR", "EPSON", "G2V OPTICS INC", "Mersen"]) {
    assert.equal(normalizeVendor(raw), raw);
  }
  assert.equal(normalizeVendor("  Mersen  "), "Mersen", "trimmed, not otherwise altered");
});

test("blank and missing values stay absent rather than becoming a vendor", () => {
  assert.equal(normalizeVendor(null), null);
  assert.equal(normalizeVendor(undefined), null);
  assert.equal(normalizeVendor(""), null);
  assert.equal(normalizeVendor("   "), null);
  assert.equal(isSdcVendor(null), false);
  assert.equal(isSdcVendor(""), false);
});

// ── The filter dropdown: one SDC option, and it must match the table ───────

test("the filter offers exactly one SDC option", () => {
  // The reported bug: the dropdown listed more than one SDC entry and each returned a
  // subset of the job's SDC parts.
  const options = normalizedVendorOptions([
    "SDC",
    "SDC ASSY",
    "Steven Douglas Corp.",
    "steven douglas corporation",
    "KEYENCE CORP OF AMERICA",
    "Mersen",
    null,
    "",
  ]);
  assert.equal(options.filter((o) => o === SDC_CANONICAL).length, 1);
  assert.deepEqual(options, ["KEYENCE CORP OF AMERICA", "Mersen", SDC_CANONICAL]);
});

test("the conduits keep their own filter options, so their lines stay reachable", () => {
  const options = normalizedVendorOptions([
    "Steven Douglas Corp.",
    "SDC Credit Card (Approved)",
    "Steven Douglas Corp. Expense Reports [Concord] (Unapproved)",
  ]);
  assert.equal(options.length, 3, "three distinct things, not one");
  assert.ok(options.includes(SDC_CANONICAL));
  assert.ok(options.includes("SDC Credit Card (Approved)"));
});

test("selecting the canonical option matches every aliased line", () => {
  // What filtering actually does: compare normalized line value against the chosen
  // option. Every alias must land in the same bucket.
  const lines = [
    { supplier: "SDC" },
    { supplier: "SDC ASSY" },
    { supplier: "Steven Douglas Corp." },
    { supplier: "  steven douglas corp  " },
    { supplier: "Mersen" },
    { supplier: "SDC Credit Card (Approved)" },
  ];
  const matched = lines.filter((l) => normalizeVendor(l.supplier) === SDC_CANONICAL);
  assert.equal(matched.length, 4, "all four SDC spellings, and neither the card nor Mersen");
});
