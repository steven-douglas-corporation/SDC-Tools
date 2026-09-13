// The red/green "variance" colouring for the ETC grid's Diff cells.
//
// Positive (under plan) is green, negative (over plan) is red, and the SHADE now
// carries magnitude — a 4-hour variance and a 400-hour one used to be the same flat
// colour, so the column said only "off plan" and never "by how much" (2026-08-03,
// by request).
//
// ── Why inline styles and not classes ──────────────────────────────────────
// A gradient needs a computed colour, and Tailwind cannot generate one: its JIT
// scans source for literal class names, so `bg-[${c}]` compiles to nothing. Class
// buckets would work but cap the resolution at however many literals get written.
//
// Inline styles also settle a specificity problem the class version had to work
// around: the footer's own rule (`tfoot tr.etc-total-row > td`, 0-2-2) out-specifies
// a lone class, which is why the old footer colours had to be written as the full
// descendant chain in globals.css. An inline style beats every selector, so one
// function now serves both the rows and the footer.
//
// ── One rule, two places ───────────────────────────────────────────────────
// These are applied by the server render (etc/page.tsx, EtcSectionCells) AND by the
// live repaint that patches totals as a manager types (EtcLiveTotals). Until
// 2026-08-03 the repaint updated a Diff cell's number but not its colour, so a total
// crossing zero kept the colour of the value it used to hold.

// Values below this count as zero. Hour sums carry float residue (~1e-13) that would
// otherwise tint a cell that prints a plain "0".
const EPSILON = 0.005;

// The magnitude at which a cell reaches FULL saturation. Past it everything looks
// alike, which is the right message — beyond this the point is just "a lot".
//
// Deliberately different per context, because the figures are different sizes: one
// section cell's variance runs to tens of hours while a column total runs to
// hundreds, and Parts Cost is dollars. A single shared ceiling would leave every cell
// either washed out or fully saturated. Tune here — nothing else hardcodes a scale.
export const DIFF_CEILING = {
  /** One section's hours variance for one job. */
  hoursCell: 80,
  /** A rollup of hours — per-job group totals and the <tfoot> column totals. */
  hoursTotal: 400,
  /** One job's Parts Cost variance, in dollars. */
  moneyCell: 25_000,
  /** The Parts Cost grand total, in dollars. */
  moneyTotal: 250_000,
} as const;

// ── Four bands, not a continuous ramp (2026-08-03, by request) ──────────────
//
//   0–10%    no colour at all
//   10–40%   light
//   40–70%   medium
//   70–100%+ darkest
//
// Discrete steps rather than a smooth gradient, and that is the point: a continuous
// ramp gives every cell a slightly different shade, which is unrankable by eye — you
// cannot tell 31% from 38% on screen, so the colour degrades into decoration. Four
// steps can be read at a glance and compared across rows, like a heat legend.
//
// The first band exists because a small variance is noise: rounding, a half-day, one
// punch landing either side of a month end. Colouring those tinted almost every cell,
// which reads the same as tinting none of them (measured: it took July's coloured Diff
// cells from 111 down to 22).
//
// Bands are shares of DIFF_CEILING, so they scale per context — 20h is the light band
// on an 80h cell but uncoloured on a 400h column total.
//
// `intensity` is the position in the colour ramp each band renders at. Only the darkest
// band crosses WHITE_TEXT_ABOVE, which makes the rule legible in itself: white text
// means the top band.
const DIFF_BANDS: readonly { readonly upTo: number; readonly intensity: number | null }[] = [
  { upTo: 0.1, intensity: null }, // no colour
  { upTo: 0.4, intensity: 0.28 }, // light
  { upTo: 0.7, intensity: 0.58 }, // medium
  { upTo: Infinity, intensity: 1 }, // darkest — also everything past the ceiling
];

// Which band a variance falls in, as a ramp position — or null for "leave it alone".
// Boundaries are inclusive at the top (exactly 10% is uncoloured, exactly 40% is still
// light), so a value sitting precisely on a boundary never lands in the hotter band.
function bandIntensity(diff: number, ceiling: number): number | null {
  const share = Math.abs(diff) / ceiling;
  for (const band of DIFF_BANDS) {
    if (share <= band.upTo) return band.intensity;
  }
  return 1; // unreachable — the last band is Infinity
}

type Rgb = readonly [number, number, number];

function mix(from: Rgb, to: Rgb, t: number): string {
  const c = (i: number) => Math.round(from[i] + (to[i] - from[i]) * t);
  return `rgb(${c(0)}, ${c(1)}, ${c(2)})`;
}

// Body-row backgrounds. The pale ends are barely-there tints, so a small variance
// reads as "slightly off" rather than as an alarm; the strong ends are dark enough to
// need white text, handled below.
const CELL_GREEN: readonly [Rgb, Rgb] = [
  [233, 245, 224],
  [58, 124, 29],
];
const CELL_RED: readonly [Rgb, Rgb] = [
  [253, 234, 232],
  [168, 32, 22],
];

// Above this intensity the background is too dark for the cell's default dark text.
const WHITE_TEXT_ABOVE = 0.62;

/**
 * Background colouring for a Diff cell in the table BODY. Returns an empty object for
 * a zero (or absent) variance, so the cell keeps the background it already has — its
 * zebra stripe or row highlight — instead of being forced to white.
 */
export function diffCellStyle(diff: number | null, ceiling: number): { backgroundColor?: string; color?: string } {
  if (diff == null || Math.abs(diff) < EPSILON) return {};
  const t = bandIntensity(diff, ceiling);
  if (t == null) return {}; // the 0–10% band: leave the cell alone
  const [pale, strong] = diff < 0 ? CELL_RED : CELL_GREEN;
  const style: { backgroundColor?: string; color?: string } = { backgroundColor: mix(pale, strong, t) };
  if (t > WHITE_TEXT_ABOVE) style.color = "#ffffff";
  return style;
}

// The <tfoot> Total row is a dark steel blue, so down there the variance reads as
// TEXT. On a dark fill "stronger" means brighter and more saturated — the opposite
// direction to the body — hence a separate pair rather than reusing the backgrounds,
// which would be near-invisible at their pale end.
const TOTAL_GREEN: readonly [Rgb, Rgb] = [
  [168, 206, 140],
  [126, 239, 102],
];
const TOTAL_RED: readonly [Rgb, Rgb] = [
  [240, 170, 166],
  [255, 110, 96],
];

/**
 * Text colouring for a Diff cell in the <tfoot> Total row. Returns an empty object at
 * zero so the cell inherits the footer's normal pale blue — the same "no news"
 * treatment the flat version gave it.
 */
export function diffTotalStyle(diff: number | null, ceiling: number): { color?: string; fontWeight?: number } {
  if (diff == null || Math.abs(diff) < EPSILON) return {};
  // The same four bands as the body, so a cell and the total beneath it never disagree
  // about which tier a variance is in.
  const t = bandIntensity(diff, ceiling);
  if (t == null) return {};
  const [faint, vivid] = diff < 0 ? TOTAL_RED : TOTAL_GREEN;
  return { color: mix(faint, vivid, t), fontWeight: 700 };
}

// ── "Manually adjusted", at CELL level ─────────────────────────────────────
//
// Replaces the row-wide red wash removed on 2026-09-04 (see lib/etc.ts). The brief for
// this one was explicit: it must "clearly indicate manually adjusted without making the
// whole row look like an error".
//
// So it is amber rather than red — an annotation, not a fault — and it is a left edge
// plus a wash rather than a full repaint, which keeps it legible on top of the strong
// column tints these cells already carry and keeps it visibly DIFFERENT from the Diff
// column’s red/green scale beside it.
const OVERRIDE_BG = "#fdf3d7";
const OVERRIDE_EDGE = "#c8880a";

export function manualOverrideStyle(): {
  backgroundColor: string;
  boxShadow: string;
  fontWeight: number;
} {
  return {
    backgroundColor: OVERRIDE_BG,
    // Inset, so it costs no layout and cannot shift a 450-cell grid by a pixel.
    boxShadow: `inset 3px 0 0 0 ${OVERRIDE_EDGE}`,
    fontWeight: 700,
  };
}
