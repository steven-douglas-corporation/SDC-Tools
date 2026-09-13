import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CELL_SPECS,
  EDITABLE_SPECS,
  CALCULATED_SPECS,
  parseCell,
  parseNumericCell,
  expectationText,
  isBlankForSubmit,
  requiredForSubmitMessage,
  roundTo,
  specFor,
  type FieldSpec,
} from "../src/lib/cell-rules";

// ── The centralized cell rules (§27) ────────────────────────────────────────
//
// Before this registry the app had eight different answers to "is this a valid
// number", and the same figure pasted out of the same Excel column was accepted in
// one cell of the grid and refused in the next. These tests exist to make that
// unrepeatable: every rule is asserted here, and the coverage test at the bottom
// fails if a spec is added without one.

const newEtcHours = specFor("etc.newEtc.hours");
const newEtcParts = specFor("etc.newEtc.parts");
const quotedHours = specFor("projects.quotedHours");
const costQuoted = specFor("projects.costQuoted");
const engrRate = specFor("standard.engrRate");
const startDate = specFor("projects.startDate");
const notes = specFor("standard.notes");

function value(raw: unknown, spec: FieldSpec): number | string {
  const out = parseCell(raw, spec);
  assert.equal(out.kind, "value", `expected ${JSON.stringify(raw)} to be a value, got ${out.kind}`);
  return (out as { kind: "value"; value: number | string }).value;
}
function refusal(raw: unknown, spec: FieldSpec) {
  const out = parseCell(raw, spec);
  assert.equal(out.kind, "invalid", `expected ${JSON.stringify(raw)} to be refused, got ${out.kind}`);
  return out as { kind: "invalid"; raw: string; code: string; message: string };
}

// ── §27.10 — blank, null, zero, and the differences between them ────────────

test("absent, blank and zero are three different things", () => {
  // The distinction the whole registry turns on. Collapsing any two of them is how
  // "clearing a value did not stick" happens.
  assert.equal(parseCell(undefined, newEtcHours).kind, "absent", "a field nobody sent");
  assert.equal(parseCell(null, newEtcHours).kind, "absent", "a field nobody sent");
  assert.equal(parseCell("", newEtcHours).kind, "clear", "a box somebody emptied");
  assert.equal(parseCell("   ", newEtcHours).kind, "clear", "whitespace is still empty");
  assert.equal(value("0", newEtcHours), 0, "zero is a real plan, not a blank");
});

test("zero survives every representation of itself", () => {
  for (const raw of ["0", "0.0", " 0 ", "00", "$0", "0.00", "-0"]) {
    const out = parseCell(raw, newEtcParts);
    assert.equal(out.kind, "value", raw);
    assert.equal((out as { value: number }).value, 0, raw);
  }
});

test("a numeric 0 posted as a number, not a string, is still a value", () => {
  assert.equal(value(0, newEtcHours), 0);
});

test("a blank is refused where the field is required", () => {
  // engrRate has allowBlank: false — a rate cannot be "no opinion".
  const out = refusal("", engrRate);
  assert.equal(out.code, "blankRequired");
  assert.match(out.message, /required/i);
});

// ── §27.3 — the value types, including everything Excel pastes ──────────────

test("thousands separators and currency symbols are accepted", () => {
  assert.equal(value("1,234", quotedHours), 1234);
  assert.equal(value("$1,234.50", newEtcParts), 1234.5);
  assert.equal(value("£1 234", newEtcParts), 1234);
  assert.equal(value("€1,000,000", newEtcParts), 1000000);
});

test("the non-breaking spaces Excel and Windows actually paste are handled", () => {
  //   (nbsp) and   (narrow nbsp) are what a copied spreadsheet cell really
  // contains; a plain \s strip in a regex without them leaves the string unparseable.
  assert.equal(value("1 234", quotedHours), 1234);
  assert.equal(value("1 234", quotedHours), 1234);
});

test("leading and trailing spaces never change the stored value", () => {
  assert.equal(value("  42  ", quotedHours), 42);
  assert.equal(value("\t42\n", quotedHours), 42);
});

test("accounting negatives from Excel are read as negatives, not refused as junk", () => {
  // Excel's default currency format renders a negative in parentheses, so "(1,234)"
  // is what a pasted negative literally looks like. A bare Number() reads it as NaN.
  const negatives = specFor("etc.hoursWorked"); // allowNegative — parts credits are real
  assert.equal(value("(1,234)", negatives), -1234);
  assert.equal(value("1234-", negatives), -1234);
  assert.equal(value("-1234", negatives), -1234);
});

test("a leading plus is harmless", () => {
  assert.equal(value("+42", quotedHours), 42);
});

test("pasted text is refused, not coerced", () => {
  for (const junk of ["abc", "N/A", "--", "1.2.3", "12a", "", "$", "()", "-"]) {
    const out = parseCell(junk, quotedHours);
    // "" is a clear, everything else is a refusal — never a silent 0.
    if (junk === "") assert.equal(out.kind, "clear");
    else assert.equal(out.kind, "invalid", junk);
  }
});

test("European grouping is refused rather than guessed at", () => {
  // "1.234,56" could be 1234.56 or 1.234 depending on locale, and guessing wrong
  // changes the figure by a factor of a thousand. Refusing is the safe direction.
  assert.equal(refusal("1.234,56", newEtcParts).code, "notANumber");
});

test("exponent notation is refused — nothing in this app is typed that way", () => {
  assert.equal(refusal("1e5", quotedHours).code, "notANumber");
});

test("a whole-number cell refuses a decimal, and says what it wanted", () => {
  const out = refusal("8.5", quotedHours);
  assert.equal(out.code, "notWhole");
  assert.match(out.message, /whole number/);
});

test("a whole-number cell accepts a decimal that is written out as whole", () => {
  // "8.0" out of a spreadsheet is eight, and refusing it was a real inconsistency
  // between the ETC grid and the Projects grid.
  assert.equal(value("8.0", quotedHours), 8);
  assert.equal(value("8.00", quotedHours), 8);
});

test("currency keeps its cents; hours do not", () => {
  assert.equal(value("1234.567", newEtcParts), 1234.57, "money rounds to cents");
  assert.equal(value("94", newEtcHours), 94);
  assert.equal(refusal("93.75", newEtcHours).code, "notWhole", "hours are whole, and are refused rather than silently rounded");
});

test("a percentage may be typed either way", () => {
  const pct = specFor("standard.percentOfTotal");
  // percentOfTotal is calculated, but the parser must still read both forms for any
  // percent cell — the kind is what decides, not the field.
  assert.equal(value("20%", pct), 0.2);
  assert.equal(value("0.2", pct), 0.2);
});

test("dates are ISO only, and must be real", () => {
  assert.equal(value("2026-08-04", startDate), "2026-08-04");
  assert.equal(refusal("03/04/2026", startDate).code, "notADate", "ambiguous between two real dates");
  assert.equal(refusal("2026-02-31", startDate).code, "notADate", "not a real day");
  assert.equal(parseCell("", startDate).kind, "clear");
});

test("text cells keep their text but lose their surrounding spaces", () => {
  assert.equal(value("  waiting on the customer  ", notes), "waiting on the customer");
});

test("a non-string, non-number payload is refused outright", () => {
  // A hand-crafted request, or a File in a FormData. Certainly not a cell value.
  assert.equal(parseCell({}, quotedHours).kind, "invalid");
  assert.equal(parseCell([1, 2], quotedHours).kind, "invalid");
  assert.equal(parseCell(true, quotedHours).kind, "invalid");
});

// ── §27.2 — bounds and policy ───────────────────────────────────────────────

test("a negative is refused where the column forbids it", () => {
  const out = refusal("-1", newEtcHours);
  assert.equal(out.code, "negative");
  assert.match(out.message, /greater than or equal to 0/);
});

test("a negative is accepted where the business rule allows it", () => {
  // PARTS_COST stores money in the Hours Worked column, and a credit note is real.
  // 2026-06 was once unsubmittable over exactly one such credit.
  assert.equal(value("-500.25", specFor("etc.hoursWorked")), -500.25);
});

test("zero is refused only where zero is genuinely wrong", () => {
  // A 0 Engineering Rate collapses every fee on the sheet to $0.
  assert.equal(refusal("0", engrRate).code, "zero");
  assert.equal(value("0", newEtcHours), 0, "but a 0 New ETC is a real plan");
});

test("rounding cannot smuggle a value past a bound it just failed", () => {
  // 0.4 in a no-zero cell rounds to 0 at whole precision — the bound is re-checked
  // after rounding so the stored figure can never violate the rule.
  const noZeroWhole: FieldSpec = { ...engrRate, kind: "wholeNumber", decimals: 0, label: "Probe" };
  assert.equal(refusal("0.4", noZeroWhole).code, "notWhole");
  const noZeroDecimal: FieldSpec = { ...engrRate, decimals: 0, label: "Probe" };
  assert.equal(refusal("0.4", noZeroDecimal).code, "zero");
});

test("very large numbers are accepted where nothing forbids them", () => {
  assert.equal(value("1000000000", newEtcParts), 1000000000);
  assert.equal(value("$1,300,000", costQuoted), 1300000);
});

test("expectationText reads like the messages §27.9 asks for", () => {
  assert.equal(expectationText(quotedHours), "a whole number greater than or equal to 0");
  assert.match(expectationText(engrRate), /and not zero/);
  // The literal example from the requirement.
  assert.equal(`Enter ${expectationText(quotedHours)}.`, "Enter a whole number greater than or equal to 0.");
});

test("a max is reported as a max, in the requirement's words", () => {
  const capped: FieldSpec = { ...newEtcHours, max: 5000, label: "New ETC" };
  const out = refusal("6000", capped);
  assert.equal(out.code, "aboveMax");
  assert.equal(out.message, "New ETC cannot exceed 5000.");
});

test("a refusal always carries the raw text back, so the cell can keep showing it", () => {
  // §27.9: "Keep the entered value visible so the user can correct it." The parser
  // must therefore hand the original back — not a normalised or blanked version.
  assert.equal(refusal("  abc  ", quotedHours).raw, "  abc  ");
});

// ── §27.18 — rounding, everywhere, the same ─────────────────────────────────

test("roundTo does not lose the cent that float arithmetic loses", () => {
  // 1.005 is stored as 1.00499999999999989, so `Math.round(1.005 * 100) / 100` — what
  // the app used everywhere — gives 1.00. This is the bug that rule exists against.
  assert.equal(roundTo(1.005, 2), 1.01);
  assert.equal(roundTo(2.675, 2), 2.68);
  assert.equal(roundTo(1.0049, 2), 1.0);
  assert.equal(roundTo(0.1 + 0.2, 2), 0.3);
});

test("roundTo handles whole precision, negatives and zero", () => {
  assert.equal(roundTo(93.75, 0), 94);
  assert.equal(roundTo(93.4, 0), 93);
  assert.equal(roundTo(-1.005, 2), -1.0, "JS rounds half toward +Infinity; stated, not accidental");
  assert.equal(roundTo(0, 2), 0);
  // Negative zero is normalised AWAY, deliberately: a stored -0 is numerically equal
  // to 0 but renders as "-0" in a currency formatter, and "-$0.00" in a total is a
  // figure people ask questions about.
  assert.ok(Object.is(roundTo(-0.004, 2), 0), "-0.004 rounds to a plain 0, not -0");
});

test("roundTo never returns NaN for a non-finite input", () => {
  assert.equal(Number.isNaN(roundTo(NaN, 2)), true);
  assert.equal(roundTo(Infinity, 2), Infinity);
});

test("what is parsed is what would be stored, displayed and submitted", () => {
  // §27.18's "do not show one value in the table and submit a different rounded one".
  // The parser rounds to the spec's precision, so there is only ever one figure.
  assert.equal(value("1234.565", newEtcParts), 1234.57);
  assert.equal(value("1234.564", newEtcParts), 1234.56);
});

// ── §27.20 — the submission question is a different question ────────────────

test("required-for-submit is separate from allowed-to-be-blank", () => {
  // New ETC may be SAVED blank all month and may not be SUBMITTED blank. Two rules,
  // and conflating them is what made the yellow-cell logic wrong twice before.
  assert.equal(newEtcHours.allowBlank, true);
  assert.equal(newEtcHours.requiredForSubmit, true);
  assert.equal(parseCell("", newEtcHours).kind, "clear", "saving a blank is fine");
  assert.equal(isBlankForSubmit(newEtcHours, ""), true, "submitting one is not");
  assert.equal(isBlankForSubmit(newEtcHours, "0"), false, "and zero is an answer");
  assert.equal(isBlankForSubmit(newEtcHours, 0), false);
});

test("a field with no submit requirement is never blocked by one", () => {
  assert.equal(isBlankForSubmit(notes, ""), false);
});

test("the required-for-submit message is the requirement's own wording", () => {
  assert.equal(requiredForSubmitMessage(newEtcHours), "New ETC is required before submitting the month.");
});

// ── §27.24 #1/#2 — the registry has to stay honest ──────────────────────────

test("every spec has an id matching its key, and a tab and a label", () => {
  for (const [key, spec] of Object.entries(CELL_SPECS)) {
    assert.equal(spec.id, key, `${key} has a mismatched id`);
    assert.ok(spec.tab.length > 0, `${key} has no tab`);
    assert.ok(spec.label.length > 0, `${key} has no label`);
  }
});

test("every calculated field records its formula, and no editable one pretends to", () => {
  // §27.24 #2: a calculated cell must point at the single definition it comes from.
  for (const spec of CALCULATED_SPECS) {
    assert.ok(spec.formula && spec.formula.length > 10, `${spec.id} is calculated but records no formula`);
  }
  for (const spec of EDITABLE_SPECS) {
    assert.equal(spec.formula, undefined, `${spec.id} is editable and must not claim a formula`);
  }
});

test("every editable numeric spec accepts its own zero-or-blank policy coherently", () => {
  // A spec that forbids blank AND forbids zero AND has min 0 would be unsatisfiable
  // for a user trying to empty it; catching that here beats catching it in production.
  for (const spec of EDITABLE_SPECS) {
    if (spec.kind === "text" || spec.kind === "date" || spec.kind === "select") continue;
    const zero = parseCell("0", spec);
    assert.equal(zero.kind, spec.allowZero ? "value" : "invalid", `${spec.id} disagrees with its own allowZero`);
    const blank = parseCell("", spec);
    assert.equal(blank.kind, spec.allowBlank ? "clear" : "invalid", `${spec.id} disagrees with its own allowBlank`);
    const negative = parseCell("-1", spec);
    assert.equal(negative.kind, spec.allowNegative ? "value" : "invalid", `${spec.id} disagrees with its own allowNegative`);
  }
});

test("every editable numeric spec survives a realistic Excel paste", () => {
  // The single property this whole file exists for: one figure, pasted out of one
  // spreadsheet, is read identically by every cell in the app that can hold it.
  for (const spec of EDITABLE_SPECS) {
    if (spec.kind === "text" || spec.kind === "date" || spec.kind === "select") continue;
    const out = parseNumericCell(" $1,234 ", spec);
    if (spec.kind === "wholeNumber" || spec.kind === "currency" || spec.kind === "decimal") {
      assert.equal(out.kind, "value", `${spec.id} refused a pasted "$1,234"`);
      assert.equal((out as { value: number }).value, 1234, spec.id);
    }
  }
});
