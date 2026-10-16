import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { concentrationSlices, OTHER_KEY, TOP_CUSTOMERS } from "../src/lib/customer-concentration";
import type { CustomerSummary } from "../src/lib/dashboard-overview";

// The customer donut names the biggest customers and lumps the rest. What has to
// hold: the slices always add back up to the active book (so the ring is honest),
// the lumped slice is never a real customer id, and colour follows rank — never a
// project-type colour, which already means something on this same card.

function customer(id: string, activeCount: number): CustomerSummary {
  return {
    canonicalCustomerId: id,
    name: id.toUpperCase(),
    activeCount,
    byType: [],
    jobIds: [],
    rawNames: [{ name: id, count: activeCount }],
    internal: false,
    matchedBy: "none",
  };
}

const ranked = (counts: number[]) => counts.map((n, i) => customer(`c${i + 1}`, n));

test("with few customers every one is named and there is no Other", () => {
  const slices = concentrationSlices(ranked([5, 3, 1]), 9);
  assert.deepEqual(slices.map((s) => s.key), ["c1", "c2", "c3"]);
  assert.ok(slices.every((s) => !s.isOther));
});

test("a long tail is lumped into one Other slice after the top five", () => {
  const slices = concentrationSlices(ranked([10, 9, 8, 7, 6, 3, 2, 1]), 46);
  assert.equal(slices.length, TOP_CUSTOMERS + 1);
  const other = slices[slices.length - 1];
  assert.equal(other.key, OTHER_KEY);
  assert.equal(other.isOther, true);
  assert.equal(other.count, 3 + 2 + 1);
  assert.equal(other.customerCount, 3);
});

test("a tail of exactly one customer is named, not lumped", () => {
  // "Other (1 customer)" would hide a name for no saving.
  const slices = concentrationSlices(ranked([6, 5, 4, 3, 2, 1]), 21);
  assert.equal(slices.length, 6);
  assert.ok(slices.every((s) => !s.isOther));
  assert.equal(slices[5].key, "c6");
});

test("the slices add back up to the active book", () => {
  const counts = [24, 9, 7, 5, 4, 3, 3, 2, 1, 1];
  const slices = concentrationSlices(ranked(counts), counts.reduce((a, b) => a + b, 0));
  assert.equal(
    slices.reduce((n, s) => n + s.count, 0),
    counts.reduce((a, b) => a + b, 0),
  );
});

test("slices keep the order they were given — the ranking is not redefined here", () => {
  const slices = concentrationSlices(ranked([10, 9, 8, 7, 6, 5, 4]), 49);
  assert.deepEqual(slices.slice(0, 5).map((s) => s.key), ["c1", "c2", "c3", "c4", "c5"]);
});

test("percent is of the active book, to one decimal, like the bars", () => {
  const slices = concentrationSlices(ranked([1, 1, 1]), 3);
  assert.equal(slices[0].pct, 33.3);
});

test("an empty book gives no slices, and zero total never divides by zero", () => {
  assert.deepEqual(concentrationSlices([], 0), []);
  assert.deepEqual(concentrationSlices(ranked([0, 0]), 0), []);
  assert.equal(concentrationSlices(ranked([2]), 0)[0].pct, 0);
});

test("the lumped slice is the neutral grey and the named ones are a distinct ramp", () => {
  const slices = concentrationSlices(ranked([10, 9, 8, 7, 6, 3, 2, 1]), 46);
  const named = slices.filter((s) => !s.isOther);
  assert.equal(new Set(named.map((s) => s.stroke)).size, named.length, "each named slice has its own colour");
  assert.equal(slices[slices.length - 1].stroke, "stroke-sdc-border");
  assert.ok(!named.some((s) => s.stroke === "stroke-sdc-border"), "no customer takes the Other grey");
});

test("customers never borrow a project-type colour", () => {
  // Custom/Duplicate/Hybrid/Service/T&M own Primary Blue, Navy, Green, Yellow and
  // Light Blue on this card. The ramp is allowed to use the BLUE FAMILY as tints,
  // but never Green or Yellow, which would read as a type at a glance.
  const slices = concentrationSlices(ranked([10, 9, 8, 7, 6, 3, 2, 1]), 46);
  for (const s of slices) {
    assert.doesNotMatch(s.stroke, /green|yellow|lime|purple/, `${s.label} uses ${s.stroke}`);
  }
});

test("Tailwind can see every ramp class — literal strings, none assembled at runtime", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "lib", "customer-concentration.ts"), "utf8");
  for (const cls of ["stroke-sdc-navy", "stroke-sdc-blue-dark", "stroke-sdc-blue/55", "stroke-sdc-blue-100", "stroke-sdc-border"]) {
    assert.ok(src.includes(`"${cls}"`), `${cls} must appear as a literal string`);
  }
  const code = src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  assert.doesNotMatch(code, /`(?:stroke|bg)-\$\{/, "ramp classes must not be built from a template literal");
});
