import { test } from "node:test";
import assert from "node:assert/strict";
import { cellSaveStateStyle, type CellSaveState } from "../src/lib/etc-save-state";

// ── The editable-cell state contract (§42.25) ───────────────────────────────
//
// §42.25 lists the states a grid cell can be in and then makes four demands that are
// easy to break by accident and invisible in a diff:
//
//   * do not stack multiple conflicting borders
//   * error and conflict states must be visually distinct
//   * status changes must not shift cell size or table layout
//   * yellow required cells must remain easy to identify
//
// The first three are decidable from the style each state produces, so they are pinned
// here. The fourth belongs to the yellow rule in EtcSectionCells, which has its own
// test (etc-new-etc-yellow) — the relevant part here is that no save state paints a
// BACKGROUND, because that is the channel yellow uses.
//
// This test earned its place immediately: "failed" and "invalid" were both
// `ring-2 ring-inset ring-sdc-red`, i.e. two states demanding opposite responses that
// looked identical. One means the value is wrong and must be edited; the other means
// the value is fine and the save did not land.

const STATES: CellSaveState[] = ["saving", "saved", "failed", "conflict", "invalid"];

test("every save state that renders produces a distinct appearance", () => {
  const seen = new Map<string, CellSaveState>();
  for (const s of STATES) {
    const style = cellSaveStateStyle(s);
    assert.ok(style, `${s} should render something`);
    const clash = seen.get(style.ring);
    assert.equal(clash, undefined, `"${s}" and "${clash}" render identically as "${style.ring}" — §42.25 requires them to be distinct`);
    seen.set(style.ring, s);
  }
  assert.equal(seen.size, STATES.length);
});

test("error, conflict and invalid are three different things and look it", () => {
  const failed = cellSaveStateStyle("failed")!;
  const conflict = cellSaveStateStyle("conflict")!;
  const invalid = cellSaveStateStyle("invalid")!;
  assert.notEqual(failed.ring, conflict.ring);
  assert.notEqual(failed.ring, invalid.ring);
  assert.notEqual(conflict.ring, invalid.ring);
  // Each also has to SAY which it is — colour alone is not a status (§42.23), and a
  // ring is invisible to a screen reader.
  for (const [name, style] of [["failed", failed], ["conflict", conflict], ["invalid", invalid]] as const) {
    assert.ok(style.title.length > 20, `${name} needs a title that explains what to do`);
  }
  assert.notEqual(failed.title, invalid.title);
});

test("no save state paints a background — that channel belongs to the yellow rule", () => {
  // The yellow "a decision is required here" fill is the most important signal on the
  // grid. A save state that set a background would fight it, and the cell would stop
  // saying the one thing it most needs to.
  for (const s of STATES) {
    const ring = cellSaveStateStyle(s)!.ring;
    assert.ok(!/\bbg-/.test(ring), `${s} must not set a background: "${ring}"`);
  }
});

test("no save state can change the cell's size (§42.25)", () => {
  // Rings are box-shadows and are outside the layout system; a border or padding would
  // reflow the row every time a save started or finished, on a grid with ~880 editable
  // cells. `ring-inset` additionally keeps the shadow inside the cell so it cannot
  // overlap its neighbour's frame.
  // Checked per CLASS, not by substring. The first version of this test used a regex
  // over the whole string and failed on `ring-sdc-red-border` — a colour token whose
  // name merely contains "border". A layout utility is one whose class STARTS with the
  // offending prefix; anything beginning `ring-` is the ring itself.
  const LAYOUT_PREFIXES = ["border", "p", "px", "py", "pt", "pb", "pl", "pr", "m", "mx", "my", "w", "h", "text", "inset", "translate"];
  for (const s of STATES) {
    const ring = cellSaveStateStyle(s)!.ring;
    assert.match(ring, /(^|\s)ring-inset(\s|$)/, `${s} must use an inset ring: "${ring}"`);
    for (const cls of ring.split(/\s+/).filter(Boolean)) {
      if (cls.startsWith("ring-") || cls === "ring") continue;
      const prefix = cls.split("-")[0];
      assert.ok(!LAYOUT_PREFIXES.includes(prefix), `${s} must not affect layout or type — "${cls}" in "${ring}"`);
    }
  }
});

test("a cell with nothing to report renders nothing", () => {
  // "editing" deliberately gets no ring: a value differing from the saved one is the
  // normal state of a cell somebody is working in, not something to decorate.
  assert.equal(cellSaveStateStyle("editing"), null);
  assert.equal(cellSaveStateStyle(null), null);
});
