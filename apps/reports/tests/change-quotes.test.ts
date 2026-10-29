import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCents,
  parseWholeHours,
  compactHours,
  splitBySection,
  splitParts,
  planApply,
  planReverse,
  reconcile,
  cleanDraft,
  type CqInput,
  type TotalsState,
} from "../src/lib/change-quotes";

// The 1169-CQ4 example from the request: $155,300 = labor + $33,050 parts.
const CQ4_HOURS = {
  "10-211": 70, "10-312": 40, "10-313": 40, "10-515": 20, "10-517": 60,
  "10-411": 30, "10-412": 80, "40-211": 90, "40-411": 50, "50-211": 30, "50-411": 40,
};
const cq = (over: Partial<CqInput> = {}): CqInput => ({ hours: CQ4_HOURS, partsCents: 3_305_000, status: "Draft", addedToTotals: false, ...over });
const totals = (): TotalsState => ({
  hours: { "10-211": 160, "10-312": 120, "10-313": 160, "10-411": 120, "10-412": 170, "10-518": 60 },
  partsCents: 15_297_000,
});

test("money parses to whole cents without float drift", () => {
  assert.equal(parseCents("155,300"), 15_530_000);
  assert.equal(parseCents("$33,050.10"), 3_305_010);
  assert.equal(parseCents("0.29"), 29); // 0.29*100 is 28.999… as a float
  assert.equal(parseCents(19.99), 1999);
  assert.equal(parseCents(""), null);
  assert.equal(parseCents(null), null);
  assert.equal(parseCents("12.345"), "invalid");
  assert.equal(parseCents("-5"), "invalid");
  assert.equal(parseCents("abc"), "invalid");
});

test("hours are whole, non-negative; blank is zero", () => {
  assert.equal(parseWholeHours(""), 0);
  assert.equal(parseWholeHours("40"), 40);
  assert.equal(parseWholeHours("40.5"), "invalid");
  assert.equal(parseWholeHours("-1"), "invalid");
  assert.equal(parseWholeHours(12), 12);
  assert.equal(parseWholeHours(1.5), "invalid");
});

test("compactHours drops zeros so 'not entered' and '0' store the same", () => {
  assert.deepEqual(compactHours({ a: 0, b: 5 }), { b: 5 });
});

test("original is total minus applied change quotes only — a Draft is not in the totals", () => {
  const t = { "10-211": 160, "10-312": 120 };
  const applied: { hours: Record<string, number> }[] = [{ hours: { "10-211": 70 } }, { hours: { "10-211": 10, "10-312": 40 } }];
  const { bySection, negative } = splitBySection(t, applied);
  assert.deepEqual(bySection["10-211"], { total: 160, changeQuote: 80, original: 80 });
  assert.deepEqual(bySection["10-312"], { total: 120, changeQuote: 40, original: 80 });
  assert.deepEqual(negative, []);
  // no applied change quotes → original equals total, nothing else changes
  const none = splitBySection(t, []);
  assert.deepEqual(none.bySection["10-211"], { total: 160, changeQuote: 0, original: 160 });
});

test("a negative original is reported, never clamped", () => {
  const { bySection, negative } = splitBySection({ "10-211": 50 }, [{ hours: { "10-211": 70 } }]);
  assert.equal(bySection["10-211"].original, -20);
  assert.deepEqual(negative, ["10-211"]);
});

test("parts split; a never-entered total reads as zero", () => {
  assert.deepEqual(splitParts(15_297_000, [{ partsCents: 3_305_000 }]), { total: 15_297_000, changeQuote: 3_305_000, original: 11_992_000 });
  assert.deepEqual(splitParts(null, []), { total: 0, changeQuote: 0, original: 0 });
});

test("applying adds hours and parts to the totals and leaves untouched sections alone", () => {
  const before = totals();
  const r = planApply(before, cq(), "add");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.hours["10-211"], 230);
  assert.equal(r.hours["10-312"], 160);
  assert.equal(r.hours["10-518"], 60); // not in the change quote
  assert.equal(r.hours["40-211"], 90); // section the total never had
  assert.equal(r.partsCents, 15_297_000 + 3_305_000);
  assert.equal(r.addedToTotals, true);
  assert.ok(r.partsChanged);
  // planning never mutates its input
  assert.equal(before.hours["10-211"], 160);
});

test("applying an already-applied change quote is refused (no double count)", () => {
  const r = planApply(totals(), cq({ status: "Applied", addedToTotals: true }), "add");
  assert.equal(r.ok, false);
});

test("an empty change quote can't be applied", () => {
  assert.equal(planApply(totals(), cq({ hours: {}, partsCents: 0 }), "add").ok, false);
  assert.equal(planApply(totals(), cq({ hours: { a: 0 }, partsCents: 0 }), "add").ok, false);
});

test("'already included' changes nothing in the totals", () => {
  const big: TotalsState = { hours: { ...Object.fromEntries(Object.entries(CQ4_HOURS).map(([k, v]) => [k, v + 100])) }, partsCents: 9_000_000 };
  const r = planApply(big, cq(), "included");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.hours, big.hours);
  assert.equal(r.partsCents, 9_000_000);
  assert.deepEqual(r.changedSections, []);
  assert.equal(r.addedToTotals, false);
  assert.equal(r.partsChanged, false);
});

test("'already included' is refused when a total is smaller than the change quote", () => {
  const r = planApply(totals(), cq(), "included"); // totals lack 40-211 etc.
  assert.equal(r.ok, false);
});

test("'already included' is refused when parts total is smaller", () => {
  const t: TotalsState = { hours: Object.fromEntries(Object.entries(CQ4_HOURS)), partsCents: 100 };
  assert.equal(planApply(t, cq(), "included").ok, false);
});

test("apply then reverse restores the totals exactly", () => {
  const before = totals();
  const applied = planApply(before, cq(), "add");
  assert.ok(applied.ok);
  if (!applied.ok) return;
  const rev = planReverse({ hours: applied.hours, partsCents: applied.partsCents }, cq({ status: "Applied", addedToTotals: true }));
  assert.ok(rev.ok);
  if (!rev.ok) return;
  // sections the original never had come back as 0, which the grid treats as blank
  for (const [s, h] of Object.entries(before.hours)) assert.equal(rev.hours[s], h);
  for (const s of Object.keys(CQ4_HOURS)) assert.equal(rev.hours[s] ?? 0, before.hours[s] ?? 0);
  assert.equal(rev.partsCents, before.partsCents);
});

test("reversing an 'included' change quote never touches the totals", () => {
  const t = totals();
  const r = planReverse(t, cq({ status: "Applied", addedToTotals: false }));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.hours, t.hours);
  assert.equal(r.partsCents, t.partsCents);
  assert.deepEqual(r.changedSections, []);
});

test("reversing is refused if it would take a total below zero", () => {
  const r = planReverse({ hours: { "10-211": 10 }, partsCents: 5_000_000 }, cq({ status: "Applied", addedToTotals: true, hours: { "10-211": 70 }, partsCents: 0 }));
  assert.equal(r.ok, false);
  const p = planReverse({ hours: {}, partsCents: 100 }, cq({ status: "Applied", addedToTotals: true, hours: {}, partsCents: 3_305_000 }));
  assert.equal(p.ok, false);
});

test("reversing a Draft is refused", () => {
  assert.equal(planReverse(totals(), cq()).ok, false);
});

test("the $155,300 reconciliation: labor, hours and effective rate", () => {
  const r = reconcile(15_530_000, 3_305_000, CQ4_HOURS);
  assert.ok(r);
  assert.equal(r!.laborCents, 12_225_000); // $122,250
  assert.equal(r!.hours, 550);
  assert.equal(r!.ratePerHourCents, 22_227); // $222.27/hr
  assert.equal(r!.partsExceedAmount, false);
  assert.equal(reconcile(null, 0, CQ4_HOURS), null);
  assert.equal(reconcile(1_000_000, 2_000_000, CQ4_HOURS)!.partsExceedAmount, true);
  assert.equal(reconcile(1_000_000, 0, {})!.ratePerHourCents, null);
});

const VALID = new Set(Object.keys(CQ4_HOURS));
const base = { label: " CQ4 ", note: "", amount: "155,300", partsCost: "33,050", quoteDate: "2026-10-29", hours: { "10-211": "70", "10-312": "", "10-313": "0" } };

test("cleanDraft trims, parses and drops zero hours", () => {
  const r = cleanDraft(base, VALID);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.label, "CQ4");
  assert.equal(r.value.note, null);
  assert.equal(r.value.amountCents, 15_530_000);
  assert.equal(r.value.partsCents, 3_305_000);
  assert.deepEqual(r.value.hours, { "10-211": 70 });
});

test("cleanDraft rejects bad input with a message a manager can act on", () => {
  assert.equal(cleanDraft({ ...base, label: "  " }, VALID).ok, false);
  assert.equal(cleanDraft({ ...base, amount: "12x" }, VALID).ok, false);
  assert.equal(cleanDraft({ ...base, partsCost: "999,999" }, VALID).ok, false); // parts > amount
  assert.equal(cleanDraft({ ...base, quoteDate: "10/29/2026" }, VALID).ok, false);
  assert.equal(cleanDraft({ ...base, hours: { "99-999": "5" } }, VALID).ok, false);
  assert.equal(cleanDraft({ ...base, hours: { "10-211": "7.5" } }, VALID).ok, false);
});

test("a blank amount is allowed (hours-only change quote) and parts default to zero", () => {
  const r = cleanDraft({ ...base, amount: "", partsCost: "" }, VALID);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.value.amountCents, null);
  assert.equal(r.value.partsCents, 0);
});
