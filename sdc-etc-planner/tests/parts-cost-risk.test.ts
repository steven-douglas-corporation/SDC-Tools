import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { suggestNewEtc, redrivenDraft } from "../src/lib/etc";
import { isDerivedPartsDraft } from "../src/lib/parts-breakout-scope";
import { PARTS_COST_SECTION } from "../src/lib/sections";

// ── Parts Cost: the column set, the two typed halves, and what New ETC needs ─
//
// This file used to be about a red under-planned warning. That feature was removed on
// 2026-09-04 by request ("do not use row-level red backgrounds for Parts Cost"), and its
// tests went with it — what remains is the row SHAPE, which is the thing that silently
// breaks, plus the rules the columns actually have now.

// ── The Parts Cost column set and its cells must stay in step ───────────────
//
// Added 2026-09-03 with the Left to Invoice / Left to Purchase columns. The grid is
// one wide table with hand-written body cells and a `colSpan` computed from the
// column array, so adding a column in one place and not the other shifts every job
// row by one column against its own headers — silent, and wrong in a way that looks
// like a data bug rather than a layout one.

const ETC_PAGE = readFileSync(join(process.cwd(), "src", "app", "(app)", "etc", "page.tsx"), "utf8");

const withoutComments = (t: string) =>
  t
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** How many of that row's cells sit inside a `{showBreakout && (<>…</>)}` fragment. */
const gatedCellsIn = (key: string) => {
  const start = ETC_PAGE.indexOf(`<Fragment key="${key}">`);
  assert.ok(start > -1, `no <Fragment key="${key}"> in the ETC page`);
  const body = withoutComments(ETC_PAGE.slice(start, ETC_PAGE.indexOf("</Fragment>", start)));
  const gate = /\{showBreakout && \(\s*<>([\s\S]*?)<\/>\s*\)\}/.exec(body);
  if (!gate) return 0;
  return (gate[1].match(/<td[\s>]/g)?.length ?? 0) + (gate[1].match(/<PartsBreakoutCell[\s>]/g)?.length ?? 0);
};

const fragmentCells = (key: string) => {
  const start = ETC_PAGE.indexOf(`<Fragment key="${key}">`);
  assert.ok(start > -1, `no <Fragment key="${key}"> in the ETC page`);
  const body = withoutComments(ETC_PAGE.slice(start, ETC_PAGE.indexOf("</Fragment>", start)));
  // Comments must be stripped first: this file discusses `<td>` in prose, and counting
  // those was how the first version of this check reported a false mismatch.
  return (
    (body.match(/<td\b/g)?.length ?? 0) +
    (body.match(/<PartsCostNewEtcCell\b/g)?.length ?? 0) +
    // The breakout columns are client components too, not <td>s — they are the two
    // cells a manager types into (2026-09-03).
    (body.match(/<PartsBreakoutCell\b/g)?.length ?? 0)
  );
};

test("the Parts Cost columns include the New ETC breakout, in reading order", () => {
  const declared = /const PARTS_COST_SUB_COLUMNS = \[([\s\S]*?)\] as const;/.exec(ETC_PAGE);
  assert.ok(declared, "PARTS_COST_SUB_COLUMNS changed shape");
  const cols = [...declared[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cols, [
    "Prior ETC",
    "Money Spent Month",
    "Money Left",
    "Left to Invoice",
    "Left to Purchase",
    "New ETC",
    "Diff",
  ]);
  // The two new ones sit immediately before New ETC, so the row reads left-to-right
  // as the sum it is: Left to Invoice + Left to Purchase = the New ETC seed.
  assert.equal(cols.indexOf("Left to Purchase") + 1, cols.indexOf("New ETC"));
});

test("every Parts Cost row renders exactly one cell per declared column", () => {
  const declared = /const PARTS_COST_SUB_COLUMNS = \[([\s\S]*?)\] as const;/.exec(ETC_PAGE)!;
  const count = [...declared[1].matchAll(/"([^"]+)"/g)].length;
  assert.equal(fragmentCells("parts-cost"), count, "a job row is out of step with its headers");
  assert.equal(fragmentCells("parts-cost-total"), count, "the grand-total row is out of step");
  // The no-entry placeholder maps the RENDERED list, so it cannot drift. That is
  // `partsCostCols`, not the full constant — see the month test below.
  assert.match(ETC_PAGE, /partsCostCols\.map\(\(col, ci\)/);
});

test("before August 2026 the Parts Cost rows shrink by exactly the two breakout columns", () => {
  // The constant above is the SUPERSET of columns. What renders is `partsCostCols`,
  // which drops Left to Invoice and Left to Purchase on any month before 2026-08 (see
  // lib/parts-breakout-scope.ts). So the header can be seven or five wide, and every
  // row has to shrink WITH it — a body one cell wider than its header shifts every
  // Parts Cost column after the gap, which is wrong without looking broken.
  const declared = /const PARTS_COST_SUB_COLUMNS = \[([\s\S]*?)\] as const;/.exec(ETC_PAGE)!;
  const superset = [...declared[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  // The derivation drops exactly the two, and nothing else.
  const dropped = superset.filter((c) => !["Left to Invoice", "Left to Purchase"].includes(c));
  assert.equal(dropped.length, superset.length - 2, "the derivation must remove exactly two columns");
  assert.match(
    ETC_PAGE,
    /PARTS_COST_SUB_COLUMNS\.filter\(\(c\) => c !== "Left to Invoice" && c !== "Left to Purchase"\)/,
    "the pre-August list must be derived from the constant, not typed out again",
  );

  // And each row hides exactly two cells behind the same flag the header uses, so the
  // five-column month is the layout every month had before this feature existed.
  for (const key of ["parts-cost", "parts-cost-total"]) {
    const gated = gatedCellsIn(key);
    assert.equal(gated, 2, `the ${key} row hides ${gated} cells behind showBreakout, not 2`);
    assert.equal(fragmentCells(key) - gated, superset.length - 2, `the ${key} row's pre-August width is wrong`);
  }
});



test("a Total ETO outage costs two columns, not the month-end page", () => {
  // This is the page managers close the month on, and these columns are the only
  // upstream call on it. The fetch is awaited with a catch that degrades to nulls.
  assert.match(ETC_PAGE, /readPartsEtcBreakout\(/);
  assert.match(ETC_PAGE, /\.catch\(\(e\) => \{[\s\S]{0,200}return null;/);
});

// ── The derived draft may not be redriven ────────────────────────────────────
//
// On a breakout month `newEtcDraft` is not a typed figure, it is
// `leftToInvoice + leftToPurchase`. Everything downstream — the submission, the
// export, next month's Prior ETC — reads that column, while the grid renders the sum
// of the two halves. The moment a writer moves one without the other they disagree,
// and nothing on screen says so.

test("Left to Invoice is editable, with the computed figure as its DEFAULT", () => {
  // Third revision of this cell, and the tests move with it. 2026-09-03 made it
  // editable, 2026-09-04 made it computed and read-only, and this request settles it:
  // editable, defaulted from the Parts List figure, and HIGHLIGHTED when overridden.
  // Reconciliation is the default state rather than an enforced one.
  assert.match(withoutComments(ETC_PAGE), /<PartsBreakoutCell[\s\S]{0,200}?which="invoice"/);
  assert.match(withoutComments(ETC_PAGE), /<PartsBreakoutCell[\s\S]{0,200}?which="purchase"/);

  // Both halves post a field, so both can be saved. Matched against the page with
  // comments stripped: the props carry long explanatory blocks between them, and a
  // character window over the raw source measures prose rather than structure.
  const page = withoutComments(ETC_PAGE);
  assert.match(page, /which="invoice"[\s\S]{0,300}?name=\{`partsLeftToInvoice__/);
  assert.match(page, /which="purchase"[\s\S]{0,300}?name=\{`partsLeftToPurchase__/);
  // And neither is read-only any more — the prop is gone from the component entirely.
  const cell = readFileSync(join(process.cwd(), "src", "components", "PartsBreakoutCell.tsx"), "utf8");
  assert.ok(!/readOnly/.test(cell), "the read-only mode must be gone, not left as dead code");

  // The value is the override when there is one, else the computed default.
  assert.match(ETC_PAGE, /const resolvedInvoice = resolveLeftToInvoice\(\{[\s\S]{0,400}?\}\);/);
  assert.match(ETC_PAGE, /const leftToInvoiceValue = resolvedInvoice\.value;/);
});

test("an overridden Left to Invoice is highlighted, at CELL level", () => {
  // "Highlight that individual cell… without making the whole row look like an error."
  assert.match(ETC_PAGE, /overridden=\{resolvedInvoice\.overridden\}/);
  const cell = readFileSync(join(process.cwd(), "src", "components", "PartsBreakoutCell.tsx"), "utf8");
  assert.match(cell, /style=\{overridden \? manualOverrideStyle\(\) : undefined\}/);
  // Amber, not red, and an edge rather than a full repaint — it has to read as an
  // annotation and stay distinct from the Diff column's red/green scale beside it.
  const colors = readFileSync(join(process.cwd(), "src", "components", "ui", "etc-diff-colors.ts"), "utf8");
  assert.match(colors, /export function manualOverrideStyle\(\)/);
  assert.match(colors, /boxShadow: `inset 3px 0 0 0 \$\{OVERRIDE_EDGE\}`/);
  // And it survives a refresh, because it is derived from stored-vs-default rather than
  // held in component state.
  assert.match(ETC_PAGE, /stored:\s*\r?\n?\s*partsCostEntry\.leftToInvoice != null/);
});

test("typing the default back removes the highlight", () => {
  // "If the value is restored back to the original/default amount, remove the
  // manual-change highlight." The save stores NULL for a value equal to the default,
  // so there is nothing left to differ from — reversible with no flag to get stale.
  const actions = readFileSync(join(process.cwd(), "src", "lib", "etc-actions.ts"), "utf8");
  assert.match(
    actions,
    /next\.invoice !== null && defaultInvoice !== null && Math\.abs\(next\.invoice - defaultInvoice\) <= 0\.004/,
  );
  assert.match(actions, /\? null\s*\r?\n?\s*: next\.invoice,/);
});

test("New ETC stays blank until BOTH halves have a value", () => {
  // The headline change. A blank half used to count as 0 the moment the other had a
  // figure, which displayed and STORED a forecast nobody had made.
  assert.match(ETC_PAGE, /const breakoutSum = partsNewEtc\(leftToInvoiceValue, leftToPurchaseValue\);/);

  // Every consumer asks the same function, which is the only way the four of them
  // cannot disagree about what a blank means.
  for (const [file, path] of [
    ["the save", ["src", "lib", "etc-actions.ts"]],
    ["the submission", ["src", "lib", "monthly-report.ts"]],
    ["the live client sum", ["src", "lib", "etc-live-totals.ts"]],
  ] as const) {
    const src = readFileSync(join(process.cwd(), ...path), "utf8");
    assert.match(src, /partsNewEtc\(/, `${file} must use the shared rule`);
  }
  // And none of them may reconstruct the old blank-is-zero sum.
  for (const path of [
    ["src", "lib", "etc-actions.ts"],
    ["src", "lib", "etc-live-totals.ts"],
    ["src", "app", "(app)", "etc", "page.tsx"],
  ] as const) {
    const code = readFileSync(join(process.cwd(), ...path), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(
      !/\(\s*\w*[Ii]nvoice\s*\?\?\s*0\s*\)\s*\+\s*\(\s*\w*[Pp]urchase\s*\?\?\s*0\s*\)/.test(code),
      `${path.join("/")} still treats a blank half as 0`,
    );
  }
});

test("New ETC is calculated, never typed, on a breakout month", () => {
  // Unchanged by this revision, and still load-bearing: one authoritative value. The
  // cell renders as text from the live breakout store, and the SERVER derives what it
  // stores rather than trusting a figure the browser posts.
  const cell = readFileSync(join(process.cwd(), "src", "components", "PartsCostNewEtcCell.tsx"), "utf8");
  assert.match(cell, /readPartsBreakoutSum\(jobId\)/);
  assert.match(cell, /\{derived \? \(/, "a derived cell must render text, not an input");
  assert.match(ETC_PAGE, /derived=\{showBreakout\}/);

  const actions = readFileSync(join(process.cwd(), "src", "lib", "etc-actions.ts"), "utf8");
  assert.match(
    actions,
    /if \(breakoutInScope && entry\.section === PARTS_COST_SECTION\) \{\s*handlePartsBreakoutEntry\(entry\);/,
    "a breakout month's Parts Cost New ETC must never be taken from the posted field",
  );
});

test("the row-wide red warning is gone, everywhere", () => {
  // "Remove the existing feature that highlights an entire row red. Do not use
  // row-level red backgrounds for Parts Cost validation/differences."
  //
  // Both halves had to go together — a live repaint with no first paint, or the
  // reverse, is worse than either — so this checks the whole chain rather than the one
  // file where the bug would first be noticed.
  const gone = [
    ["the rule", ["src", "lib", "etc.ts"], /partsCostRisk|partsCostRiskTitle/],
    ["the style", ["src", "components", "ui", "etc-diff-colors.ts"], /partsRiskStyle|paintPartsRisk|PARTS_RISK_BG/],
    ["the first paint", ["src", "app", "(app)", "etc", "page.tsx"], /partsRiskCss|partsRiskTip|data-parts-risk/],
    ["the New ETC cell", ["src", "components", "PartsCostNewEtcCell.tsx"], /partsCostRisk|riskTip|risk\.atRisk/],
    ["the live repaint", ["src", "components", "EtcLiveTotals.tsx"], /writePartsRisk|paintPartsRisk|data-parts-risk/],
  ] as const;
  for (const [what, path, pattern] of gone) {
    const code = readFileSync(join(process.cwd(), ...path), "utf8")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!pattern.test(code), `${what} still references the removed red-row warning`);
  }
  // The hours cells never knew about it and still must not.
  const sectionCells = readFileSync(join(process.cwd(), "src", "components", "EtcSectionCells.tsx"), "utf8");
  assert.ok(!/partsCostRisk|parts-risk/.test(sectionCells), "the hours cells must stay out of it");
});

test("isDerivedPartsDraft names exactly the rows whose New ETC is a sum", () => {
  // Parts Cost from August 2026 on, and nothing else. Hours sections type their New
  // ETC on every month, so redriving theirs stays correct.
  assert.equal(isDerivedPartsDraft("2026-08", PARTS_COST_SECTION), true);
  assert.equal(isDerivedPartsDraft("2026-09", PARTS_COST_SECTION), true);
  assert.equal(isDerivedPartsDraft("2026-07", PARTS_COST_SECTION), false);
  assert.equal(isDerivedPartsDraft("2026-08", "ELECTRICAL_ENGINEERING"), false);
  // Unparseable month answers false for the same reason showsPartsBreakout does: the
  // safe direction is the behaviour every month had before the columns existed.
  assert.equal(isDerivedPartsDraft(null, PARTS_COST_SECTION), false);
  assert.equal(isDerivedPartsDraft("garbage", PARTS_COST_SECTION), false);
});

test("the guard blocks the redrive that would break the invariant", () => {
  // The collision is not exotic — it fires precisely when the halves add up to the
  // figure the grid suggested, which is what a manager who agreed with the suggestion
  // typed. Here: Left to Invoice 2,500 + Left to Purchase 500 = 3,000, and 3,000 is
  // also suggestNewEtc(oldPrior=10,000, worked=7,000).
  const oldPriorEtc = 10_000;
  const hoursWorked = 7_000;
  const invoice = 2_500;
  const purchase = 500;
  const storedDraft = invoice + purchase;
  assert.equal(storedDraft, suggestNewEtc(oldPriorEtc, hoursWorked), "the premise of this test");

  // Prior ETC moves — a later parts sync, a cascade, a reopened upstream month.
  const newPriorEtc = 12_000;
  const unguarded = redrivenDraft({ draft: storedDraft, oldPriorEtc, newPriorEtc, hoursWorked });
  assert.notEqual(unguarded, invoice + purchase, "without the guard the draft stops being the sum");

  const guarded = isDerivedPartsDraft("2026-08", PARTS_COST_SECTION)
    ? storedDraft
    : redrivenDraft({ draft: storedDraft, oldPriorEtc, newPriorEtc, hoursWorked });
  assert.equal(guarded, invoice + purchase, "New ETC must stay equal to the two halves beside it");

  // And the same row one month earlier, where the draft IS typed, still moves.
  const july = isDerivedPartsDraft("2026-07", PARTS_COST_SECTION)
    ? storedDraft
    : redrivenDraft({ draft: storedDraft, oldPriorEtc, newPriorEtc, hoursWorked });
  assert.equal(july, unguarded, "a typed draft that echoed the old suggestion still follows Prior ETC");
});

test("every redrivenDraft caller is guarded — including ones not written yet", () => {
  // The point of scanning rather than naming the two known files: this invariant broke
  // because two writers existed that nobody checked against it, and a third would break
  // it the same way. A new call site fails this test until it decides about derived
  // rows.
  const libDir = join(process.cwd(), "src", "lib");
  const callers = readdirSync(libDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: f, src: readFileSync(join(libDir, f), "utf8") }))
    // etc.ts DEFINES redrivenDraft; parts-breakout-scope.ts only discusses it in prose.
    .filter(({ file, src }) => file !== "etc.ts" && file !== "parts-breakout-scope.ts" && /\bredrivenDraft\(/.test(src));

  assert.ok(callers.length >= 2, `expected the known writers, found ${callers.map((c) => c.file).join(", ")}`);
  for (const { file, src } of callers) {
    assert.match(
      src,
      /isDerivedPartsDraft\(/,
      `${file} rewrites newEtcDraft but never asks whether the row's draft is derived from ` +
        `Left to Invoice + Left to Purchase — see lib/parts-breakout-scope.ts`,
    );
  }
});
