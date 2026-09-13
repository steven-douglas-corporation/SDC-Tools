import { test } from "node:test";
import assert from "node:assert/strict";
import { diffCellStyle, diffTotalStyle, DIFF_CEILING } from "../src/components/ui/etc-diff-colors";

// The Diff cells' variance colouring: green under plan, red over plan, and the SHADE
// carries magnitude (2026-08-03, by request — a 4-hour variance and a 400-hour one
// used to be the same flat colour).
//
// Two things these tests exist to protect:
//
//  1. The gradient is MONOTONIC. If a bigger variance ever produced a paler colour,
//     the column would actively mislead — worse than not being coloured at all.
//  2. Zero yields an EMPTY style object. That is how "no variance" is expressed, and
//     the live repaint relies on it: it clears backgroundColor/color/fontWeight and
//     reapplies whatever comes back, so anything non-empty at zero would strand a
//     colour on a cell that prints "0".

// rgb(r, g, b) -> [r, g, b]
function rgb(s: string | undefined): [number, number, number] {
  assert.ok(s, "expected a colour");
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(s!);
  assert.ok(m, `not an rgb() string: ${s}`);
  return [Number(m![1]), Number(m![2]), Number(m![3])];
}

// Perceived lightness, good enough to rank two shades of the same hue.
function luminance(s: string | undefined): number {
  const [r, g, b] = rgb(s);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Colourfulness — how far the channels spread. This, NOT luminance, is what ranks
// strength on the dark footer row: a saturated red is inherently dark (pure red sits
// at luminance ~54), so a red gradient can never brighten as it intensifies. Chroma
// rises for both hues, which is what "reads as more urgent" actually tracks.
function chroma(s: string | undefined): number {
  const [r, g, b] = rgb(s);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

const H = DIFF_CEILING.hoursCell;

test("positive is green, negative is red", () => {
  const under = rgb(diffCellStyle(20, H).backgroundColor);
  const over = rgb(diffCellStyle(-20, H).backgroundColor);
  // Green: green channel dominates. Red: red channel dominates.
  assert.ok(under[1] > under[0], `expected green-dominant, got rgb(${under})`);
  assert.ok(over[0] > over[1], `expected red-dominant, got rgb(${over})`);
});

// ── The 10% dead band ───────────────────────────────────────────────────────
// Below a tenth of the ceiling there is NO colour at all (2026-08-03, by request:
// "10 percent white, from then on increase the gradient"). A small variance is noise —
// rounding, a half-day, a punch landing either side of a month end — and colouring it
// tinted nearly every cell on the grid, which reads the same as tinting none of them.

test("inside the dead band a cell keeps its own background", () => {
  // 10% of an 80h ceiling is 8h.
  for (const v of [0.1, 1, 4, 7.9, 8, -0.1, -1, -4, -7.9, -8]) {
    assert.deepEqual(diffCellStyle(v, H), {}, `${v}h should be uncoloured`);
  }
});

test("just past the dead band, colour begins", () => {
  assert.ok(diffCellStyle(8.5, H).backgroundColor, "8.5h should be tinted");
  assert.ok(diffCellStyle(-8.5, H).backgroundColor, "-8.5h should be tinted");
});

test("the band scales with the ceiling, not a fixed hour count", () => {
  // 20h is inside the band for a 400h total but well past it for an 80h cell.
  assert.deepEqual(diffCellStyle(20, DIFF_CEILING.hoursTotal), {});
  assert.ok(diffCellStyle(20, H).backgroundColor);
});

// The four bands, on an 80h ceiling: none <=8h, light 8-32h, medium 32-56h, dark 56h+.

test("colour is CONSTANT inside a band — that is what makes tiers readable", () => {
  // A continuous ramp gave every cell a slightly different shade, which cannot be
  // ranked by eye. Four steps can.
  for (const band of [
    [9, 15, 24, 32], // light
    [33, 40, 50, 56], // medium
    [57, 70, 80, 200], // darkest, incl. past the ceiling
  ]) {
    const shades = band.map((v) => diffCellStyle(v, H).backgroundColor);
    assert.equal(new Set(shades).size, 1, `band ${band.join("/")} should be one shade, got ${[...new Set(shades)].join(" ")}`);
  }
});

test("each band is strictly stronger than the one below it", () => {
  const light = luminance(diffCellStyle(20, H).backgroundColor);
  const medium = luminance(diffCellStyle(45, H).backgroundColor);
  const dark = luminance(diffCellStyle(70, H).backgroundColor);
  // Stronger = darker for a body background.
  assert.ok(medium < light, `medium (${medium}) should be darker than light (${light})`);
  assert.ok(dark < medium, `dark (${dark}) should be darker than medium (${medium})`);
});

test("the same three tiers apply to red", () => {
  const light = luminance(diffCellStyle(-20, H).backgroundColor);
  const medium = luminance(diffCellStyle(-45, H).backgroundColor);
  const dark = luminance(diffCellStyle(-70, H).backgroundColor);
  assert.ok(medium < light);
  assert.ok(dark < medium);
});

test("band boundaries are inclusive at the top — a value on a line stays cooler", () => {
  // Exactly 10% is uncoloured; exactly 40% is still light; exactly 70% is still medium.
  assert.deepEqual(diffCellStyle(8, H), {}, "8h (10%) should be uncoloured");
  assert.notDeepEqual(diffCellStyle(8.01, H), {}, "just past 10% should be light");
  assert.equal(diffCellStyle(32, H).backgroundColor, diffCellStyle(20, H).backgroundColor, "32h (40%) is still light");
  assert.notEqual(diffCellStyle(32.01, H).backgroundColor, diffCellStyle(20, H).backgroundColor, "just past 40% is medium");
  assert.equal(diffCellStyle(56, H).backgroundColor, diffCellStyle(45, H).backgroundColor, "56h (70%) is still medium");
  assert.notEqual(diffCellStyle(56.01, H).backgroundColor, diffCellStyle(45, H).backgroundColor, "just past 70% is dark");
});

test("only the darkest band flips the text to white", () => {
  // Makes the rule legible in itself: white text means top band.
  assert.equal(diffCellStyle(20, H).color, undefined, "light keeps the cell's own text");
  assert.equal(diffCellStyle(45, H).color, undefined, "medium keeps the cell's own text");
  assert.equal(diffCellStyle(70, H).color, "#ffffff", "dark needs white text");
  assert.equal(diffCellStyle(-70, H).color, "#ffffff");
});

test("the light band is a genuine tint, the dark band genuinely dark", () => {
  assert.ok(luminance(diffCellStyle(20, H).backgroundColor) > 195, "light should read as a pale tint");
  assert.ok(luminance(diffCellStyle(70, H).backgroundColor) < 135, "dark should read as strong");
});

test("both sides ramp together, with red allowed to read hotter", () => {
  // Deliberately NOT exact parity. Red is the more urgent side — being OVER plan
  // matters more than being under it — so its ramp is steeper, and the two hues have
  // different natural chroma ranges anyway. What must hold is that they stay in the
  // same league, so neither is invisible beside the other.
  for (const m of [10, 30, 60, 80]) {
    const green = chroma(diffCellStyle(m, H).backgroundColor);
    const red = chroma(diffCellStyle(-m, H).backgroundColor);
    assert.ok(red >= green, `red should read at least as hot as green at ${m}`);
    assert.ok(red < green * 2, `red is running away from green at ${m}: ${red} vs ${green}`);
  }
});

test("the white-text threshold trips at the same magnitude on both sides", () => {
  // This one IS exact parity, and matters: it is a legibility switch, so a value that
  // flips it for green must flip it for red or one side ends up unreadable.
  for (const m of [1, 10, 30, 40, 60, 80, 500]) {
    assert.equal(
      diffCellStyle(m, H).color,
      diffCellStyle(-m, H).color,
      `white-text threshold disagrees at ${m}`,
    );
  }
  assert.equal(diffCellStyle(80, H).color, "#ffffff");
});

test("beyond the ceiling it saturates rather than overflowing", () => {
  const at = diffCellStyle(H, H).backgroundColor;
  assert.equal(diffCellStyle(H * 5, H).backgroundColor, at);
  assert.equal(diffCellStyle(H * 1000, H).backgroundColor, at);
  // And no channel ever leaves 0-255.
  for (const v of rgb(diffCellStyle(H * 1000, H).backgroundColor)) {
    assert.ok(v >= 0 && v <= 255, `channel out of range: ${v}`);
  }
});

test("dark backgrounds get white text, pale ones keep the cell's own", () => {
  // A dark green with dark text is the one way this change could hurt legibility.
  assert.equal(diffCellStyle(2, H).color, undefined);
  assert.equal(diffCellStyle(H, H).color, "#ffffff");
});

test("zero and null produce an EMPTY style, so nothing is stranded", () => {
  assert.deepEqual(diffCellStyle(0, H), {});
  assert.deepEqual(diffCellStyle(null, H), {});
  assert.deepEqual(diffTotalStyle(0, DIFF_CEILING.hoursTotal), {});
  assert.deepEqual(diffTotalStyle(null, DIFF_CEILING.hoursTotal), {});
});

test("float residue counts as zero, matching what the formatter prints", () => {
  // Hour sums carry ~1e-13. The epsilon existed before the dead band and is now
  // subsumed by it for any realistic ceiling — but it still guards the case of a
  // ceiling small enough that 1e-13 would otherwise escape the band.
  assert.deepEqual(diffCellStyle(1e-13, H), {});
  assert.deepEqual(diffCellStyle(-1e-13, H), {});
  assert.deepEqual(diffCellStyle(1e-13, 1e-9), {});
  assert.deepEqual(diffTotalStyle(1e-13, 1e-9), {});
});

test("body and footer agree on the dead-band boundary", () => {
  // A cell and the total beneath it must not disagree about what is worth colouring.
  for (const v of [4, 8, -8, 20]) {
    const cellColoured = diffCellStyle(v, DIFF_CEILING.hoursTotal).backgroundColor != null;
    const totalColoured = diffTotalStyle(v, DIFF_CEILING.hoursTotal).color != null;
    assert.equal(cellColoured, totalColoured, `disagreement at ${v}`);
  }
});

// ── The dark <tfoot> ────────────────────────────────────────────────────────
// The Total row's fill wins over any cell background, so down there the variance is
// TEXT — and "stronger" means BRIGHTER, the opposite direction to the body.

test("footer colours text, never a background", () => {
  // A background would cover the Total row's own dark fill, which is the whole
  // reason the footer uses text colour at all.
  assert.ok(!("backgroundColor" in diffTotalStyle(50, DIFF_CEILING.hoursTotal)));
  assert.ok(!("backgroundColor" in diffTotalStyle(-50, DIFF_CEILING.hoursTotal)));
  assert.ok(diffTotalStyle(50, DIFF_CEILING.hoursTotal).color);
});

// The footer uses the same four bands. On a 400h ceiling: none <=40h, light 40-160h,
// medium 160-280h, dark 280h+. One value per band, since colour is flat inside one.
const T = DIFF_CEILING.hoursTotal;

test("footer green steps up a tier at a time", () => {
  const steps = [60, 200, 350].map((v) => chroma(diffTotalStyle(v, T).color));
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i] > steps[i - 1], `footer green should intensify: ${steps[i - 1]} -> ${steps[i]}`);
  }
});

test("footer red steps up a tier at a time too, and both sides come out bold", () => {
  const steps = [-60, -200, -350].map((v) => chroma(diffTotalStyle(v, T).color));
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i] > steps[i - 1], `footer red should intensify: ${steps[i - 1]} -> ${steps[i]}`);
  }
  assert.equal(diffTotalStyle(60, T).fontWeight, 700);
  assert.equal(diffTotalStyle(-60, T).fontWeight, 700);
});

test("footer colour is flat inside a band, like the body", () => {
  assert.equal(diffTotalStyle(60, T).color, diffTotalStyle(150, T).color, "both light");
  assert.equal(diffTotalStyle(200, T).color, diffTotalStyle(270, T).color, "both medium");
  assert.deepEqual(diffTotalStyle(30, T), {}, "30h of 400h is inside the uncoloured band");
});

test("footer text stays clear of the row's own fill wherever it IS coloured", () => {
  // The Total row is #1e3a5f. Any variance colour has to stay well clear of it or the
  // number disappears into the background. Only meaningful outside the dead band —
  // inside it the cell keeps the footer's own legible pale blue.
  const ROW = luminance("rgb(30, 58, 95)");
  for (const v of [50, -50, 400, -400, 5000, -5000]) {
    const l = luminance(diffTotalStyle(v, DIFF_CEILING.hoursTotal).color);
    assert.ok(l - ROW > 60, `variance ${v} is too close to the row fill (${l} vs ${ROW})`);
  }
});

test("the ceilings are ordered: cell < total, and money above hours", () => {
  // A column total is a bigger number than one cell, and dollars are bigger than
  // hours. If these ever invert, totals saturate instantly and say nothing.
  assert.ok(DIFF_CEILING.hoursCell < DIFF_CEILING.hoursTotal);
  assert.ok(DIFF_CEILING.moneyCell < DIFF_CEILING.moneyTotal);
  assert.ok(DIFF_CEILING.hoursTotal < DIFF_CEILING.moneyCell);
});

test("the same figure reads differently against a cell vs a total ceiling", () => {
  // 60 hours is most of one cell's range but a small share of a column total's — the
  // whole reason the ceilings are separate.
  const asCell = luminance(diffCellStyle(60, DIFF_CEILING.hoursCell).backgroundColor);
  const asTotal = luminance(diffCellStyle(60, DIFF_CEILING.hoursTotal).backgroundColor);
  assert.ok(asCell < asTotal, "60h should be far stronger against the cell ceiling");
});
