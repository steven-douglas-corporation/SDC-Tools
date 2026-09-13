import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pressKindFor } from "../src/components/DragScroll";

// ── What a press on a grid means (§34.2, then §38.1) ────────────────────────
//
// This file used to test `shouldBlurOnCellPress`, the §34.2 stale-border fix. That rule
// and the bug it fixed are both gone, and the history is worth keeping because the
// second bug was CAUSED by the first fix's premise:
//
//   §34.2  DragScroll called preventDefault() on mousedown over an unfocused grid
//          input, so a press on a grid full of inputs panned instead of dropping a
//          caret into live data. preventDefault() suppresses the whole default focus
//          change though — including moving focus AWAY from the cell that had it — so
//          cell A kept the `td > input:focus` outline while cell B did nothing.
//          shouldBlurOnCellPress did explicitly what preventDefault had suppressed.
//
//   §38.1  …but "cell B did nothing" was never only about the border. Focus is this
//          grid's entire selection model — the input IS the cell — so suppressing focus
//          suppressed SELECTION, and a single click on a cell genuinely did nothing.
//          That is the first symptom §38 reports: "the first click must never be
//          ignored". Restoring the border was treating half of it.
//
// So the preventDefault is gone. A press is now classified, and only a press that turns
// into MOVEMENT becomes a pan — which is what actually distinguishes a pan from a click.
// The browser does its own focusing again, which means no cell can be left outlined
// after the pointer has moved on: the §34.2 bug cannot recur because its cause is gone,
// not because a rule compensates for it.

const press = (o: Partial<Parameters<typeof pressKindFor>[0]> = {}) =>
  pressKindFor({ neverPan: false, scrollable: true, isTextish: false, alreadyFocused: false, ...o });

test("a press on an unfocused cell is a pan candidate — and must not be suppressed", () => {
  // The §38.1 case. "pan" means "watch for movement", NOT "cancel this press": the
  // browser is left to focus the cell, so a press that never moves is a plain click that
  // selects the cell on the first try.
  assert.equal(press({ isTextish: true, alreadyFocused: false }), "pan");
});

test("a press inside the cell being edited is left completely alone", () => {
  // Otherwise dragging to select part of a value would pan the grid instead.
  assert.equal(press({ isTextish: true, alreadyFocused: true }), "editing");
});

test("a press on a dead area of the grid still pans", () => {
  // The gesture people actually use to move a wide grid sideways.
  assert.equal(press({ isTextish: false }), "pan");
});

test("controls whose mousedown IS the interaction never pan", () => {
  // A <select> must open its dropdown, a date input its picker, a button must act. This
  // is the NEVER_PAN list; panning from one would break it outright.
  assert.equal(press({ neverPan: true }), "ignore");
  assert.equal(press({ neverPan: true, isTextish: true }), "ignore");
});

test("a grid with nothing to scroll does not pan", () => {
  // No misleading grab cursor and no swallowed clicks on a table that fits.
  assert.equal(press({ scrollable: false }), "ignore");
  assert.equal(press({ scrollable: false, isTextish: true }), "ignore");
});

test("every press resolves to exactly one kind", () => {
  // Exhaustive over the four inputs: no combination falls through to undefined, which
  // would leave a press doing nothing at all.
  const kinds = new Set<string>();
  for (const neverPan of [true, false])
    for (const scrollable of [true, false])
      for (const isTextish of [true, false])
        for (const alreadyFocused of [true, false]) {
          const kind = pressKindFor({ neverPan, scrollable, isTextish, alreadyFocused });
          assert.ok(["ignore", "editing", "pan"].includes(kind), `${kind} is not a press kind`);
          kinds.add(kind);
        }
  assert.deepEqual([...kinds].sort(), ["editing", "ignore", "pan"]);
});

// ── The invariant a unit test cannot reach (§38.1, §38.5) ───────────────────
//
// The whole fix is the ABSENCE of a call: mousedown must not preventDefault, or focus —
// and therefore cell selection — is suppressed again and the first click is ignored.
// A pure function cannot express "and the caller does not cancel the event", so this is
// checked at the source, the same way tests/motion.test.ts guards against a component
// reintroducing its own duration.
test("mousedown does not cancel the press", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "components", "DragScroll.tsx"), "utf8");
  const start = src.indexOf("function onMouseDown");
  assert.ok(start > 0, "onMouseDown not found — this guard needs updating");
  // Up to the next top-level function in the component.
  const end = src.indexOf("\n  function ", start + 10);
  const body = src.slice(start, end === -1 ? src.length : end);
  const withoutComments = body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(
    !/preventDefault\s*\(/.test(withoutComments),
    "onMouseDown must not call preventDefault: it suppresses the focus change, which IS this grid's cell selection (§38.1)",
  );
});

test("the pan still swallows the click at the end of a drag", () => {
  // The one preventDefault that must STAY: without it, releasing a 400px pan also
  // triggers whatever was under the cursor. It is in onClickCapture, guarded by the
  // movement flag, so it can only fire for a press that actually panned.
  const src = readFileSync(join(import.meta.dirname, "..", "src", "components", "DragScroll.tsx"), "utf8");
  const start = src.indexOf("function onClickCapture");
  const body = src.slice(start, src.indexOf("\n  function ", start + 10));
  assert.match(body, /moved\.current/);
  assert.match(body, /preventDefault/);
});

// ── One drag surface: panning from links, buttons and the frozen columns ─────
//
// Reported 2026-09-01 as "horizontal drag only works on the table header". The
// numeric cells always panned (bare <input type="number"> -> "pan" while
// unfocused); what did not was the STICKY LEFT column block — the frozen job
// information anyone actually grabs to pan a wide grid. Job Id and Job Name are
// <Link>s, the row menu is a [role=button], so every press there returned
// "ignore" and did nothing at all.
//
// Links and buttons are safe to pan from because mousedown does not activate
// them; the click does, and DragScroll's onClickCapture swallows that click when
// a pan actually happened. These tests pin the rule in both directions, because
// getting it wrong either way is a reported bug.

test("a link pans — a job name is a drag handle, not a dead zone", () => {
  // neverPan is false for an <a> now: the caller's NEVER_PAN selector no longer
  // lists it, so pressKindFor is asked the ordinary question.
  assert.equal(press({ neverPan: false, isTextish: false }), "pan");
});

test("the elements that genuinely cannot pan still return ignore", () => {
  // select / date input / contenteditable / checkbox / radio — for each, the
  // mousedown IS the interaction, so the caller passes neverPan: true.
  assert.equal(press({ neverPan: true }), "ignore");
  // ...and that verdict does not depend on anything else about the press.
  assert.equal(press({ neverPan: true, isTextish: true, alreadyFocused: true }), "ignore");
  assert.equal(press({ neverPan: true, scrollable: false }), "ignore");
});

test("a grid with nothing to scroll never pans, whatever was pressed", () => {
  assert.equal(press({ scrollable: false }), "ignore");
  assert.equal(press({ scrollable: false, isTextish: true }), "ignore");
});

test("an already-focused text cell is left alone so its value can be text-selected", () => {
  assert.equal(press({ isTextish: true, alreadyFocused: true }), "editing");
  // But the FIRST press on that same cell still pans — this is the movement-
  // decides-the-gesture rule, not a click-count rule.
  assert.equal(press({ isTextish: true, alreadyFocused: false }), "pan");
});

test("an empty cell, a totals cell and a parts-cost cell all pan", () => {
  // No interactive content, nothing focused: every one of these is "anything
  // else", which is the pan case. Named explicitly because the request lists
  // them as places dragging must work.
  for (const isTextish of [false, true]) {
    assert.equal(press({ neverPan: false, isTextish, alreadyFocused: false }), "pan");
  }
});
