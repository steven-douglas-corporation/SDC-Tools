import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCents,
  parseWholeHours,
  compactHours,
  splitBySection,
  splitParts,
  planApply,
  planReverse,
  planColumnAmount,
  allInCents,
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
  const r = planApply(before, cq());
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
  const r = planApply(totals(), cq({ status: "Applied", addedToTotals: true }));
  assert.equal(r.ok, false);
});

test("an empty change quote can't be applied", () => {
  assert.equal(planApply(totals(), cq({ hours: {}, partsCents: 0 })).ok, false);
  assert.equal(planApply(totals(), cq({ hours: { a: 0 }, partsCents: 0 })).ok, false);
});

test("apply then reverse restores the totals exactly", () => {
  const before = totals();
  const applied = planApply(before, cq());
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

test("a change quote that was never added to the totals is not subtracted on reverse (guard)", () => {
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

test("applying adds the amount to the Change Quote column, reversing takes it back out", () => {
  const a = planColumnAmount(null, 15_530_000, "apply", true);
  assert.deepEqual(a, { ok: true, nextCents: 15_530_000, changed: true });
  const b = planColumnAmount(1_000_000, 15_530_000, "apply", true);
  assert.deepEqual(b, { ok: true, nextCents: 16_530_000, changed: true });
  // apply then reverse is a round trip, including back to "nothing entered"
  const r = planColumnAmount(15_530_000, 15_530_000, "reverse", true);
  assert.deepEqual(r, { ok: true, nextCents: null, changed: true });
  const r2 = planColumnAmount(16_530_000, 15_530_000, "reverse", true);
  assert.deepEqual(r2, { ok: true, nextCents: 1_000_000, changed: true });
});

test("a never-added change quote, no amount, or a zero amount never touch the column", () => {
  assert.deepEqual(planColumnAmount(15_530_000, 15_530_000, "apply", false), { ok: true, nextCents: 15_530_000, changed: false });
  assert.deepEqual(planColumnAmount(15_530_000, 15_530_000, "reverse", false), { ok: true, nextCents: 15_530_000, changed: false });
  assert.deepEqual(planColumnAmount(100, null, "apply", true), { ok: true, nextCents: 100, changed: false });
  assert.deepEqual(planColumnAmount(null, 0, "apply", true), { ok: true, nextCents: null, changed: false });
});

test("reversing is refused when the column is below the change quote's amount", () => {
  assert.equal(planColumnAmount(100, 15_530_000, "reverse", true).ok, false);
  assert.equal(planColumnAmount(null, 15_530_000, "reverse", true).ok, false);
});

test("Total is Sales Price + Change Quote; blank only when neither is entered", () => {
  assert.equal(allInCents(49_500_000, 15_530_000), 65_030_000);
  assert.equal(allInCents(49_500_000, null), 49_500_000);
  assert.equal(allInCents(null, 15_530_000), 15_530_000);
  assert.equal(allInCents(null, null), null);
  assert.equal(allInCents(0, 0), 0);
});

test("applying then reversing leaves Total back at Sales Price", () => {
  const sales = 49_500_000;
  const applied = planColumnAmount(null, 15_530_000, "apply", true);
  assert.ok(applied.ok);
  if (!applied.ok) return;
  assert.equal(allInCents(sales, applied.nextCents), 65_030_000);
  const reversed = planColumnAmount(applied.nextCents, 15_530_000, "reverse", true);
  assert.ok(reversed.ok);
  if (!reversed.ok) return;
  assert.equal(allInCents(sales, reversed.nextCents), sales);
});

// The server is the control, not the markup: a hand-built form post for these two columns must
// be ignored, so neither may be in the list of fields saveJobFields writes.
test("the Projects save never writes Change Quote or Total from a posted form", () => {
  const src = readFileSync(join(__dirname, "..", "src", "lib", "quoted-actions.ts"), "utf8");
  const m = src.match(/const MONEY_FIELDS = \[([^\]]*)\]/);
  assert.ok(m, "MONEY_FIELDS not found");
  assert.ok(!/changeQuote|totalPrice/.test(m![1]), "changeQuote/totalPrice must not be editable fields");
  assert.match(m![1], /salesPrice/);
});
