import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  jobTypeColor,
  JOB_TYPE_LEGEND,
  rankByCount,
  BRAND_PALETTE,
  TRACK_CLASS,
  SEGMENT_EDGE_CLASS,
} from "../src/lib/job-type-colors";
import { VALID_JOB_TYPES } from "../src/lib/job-filters";

// The Dashboard draws project type in three places — the ranked type bars, the
// per-type segments inside each customer bar, and the Type cell of the
// drill-through those charts open — and a reader compares a segment against a
// bar across them. So the colour map has to cover every valid type, and the
// ranking has to be deterministic.
//
// ── And the palette has to stay closed (2026-08-31) ─────────────────────────
//
// Duplicate rendered `bg-sdc-purple` (#581C87, Tailwind purple-900) for three
// days. It is not in the SDC Brand Guide 2026, it looked plausible next to the
// real tokens, and nothing failed — the map was already centralized and every
// other entry was on-brand, so "centralized" turned out not to mean "correct".
// The tests below close that gap: a fill that is not in BRAND_PALETTE fails, and
// so does a BRAND_PALETTE entry that does not resolve to a real token in
// globals.css.

test("every valid job type has its own colour", () => {
  for (const t of VALID_JOB_TYPES) {
    const c = jobTypeColor(t);
    assert.ok(c.bar.startsWith("bg-"), `${t} has no bar colour`);
    assert.notEqual(c.bar, "bg-sdc-gray-400", `${t} fell through to the unmapped fallback`);
  }
});

test("no two types share a colour — a stacked bar has to be readable", () => {
  const seen = new Map<string, string>();
  for (const t of VALID_JOB_TYPES) {
    const bar = jobTypeColor(t).bar;
    const prior = seen.get(bar);
    assert.equal(prior, undefined, `${t} and ${prior} both render ${bar}`);
    seen.set(bar, t);
  }
});

test("an unknown type renders grey rather than disappearing", () => {
  // A type added to the database but not to the map must still draw something —
  // an invisible segment would silently break the "segments sum to the bar" rule.
  assert.equal(jobTypeColor("Wildcard").bar, "bg-sdc-gray-400");
});

test("the legend is the canonical type order, not a ranked one", () => {
  assert.deepEqual([...JOB_TYPE_LEGEND], [...VALID_JOB_TYPES]);
});

test("rankByCount sorts by count descending", () => {
  const ranked = rankByCount([
    { type: "Custom", count: 3 },
    { type: "Duplicate", count: 9 },
    { type: "T&M", count: 5 },
  ]);
  assert.deepEqual(ranked.map((r) => r.type), ["Duplicate", "T&M", "Custom"]);
});

test("equal counts fall back to the canonical order, so bars cannot swap between renders", () => {
  // Two types on the same count must not depend on input order — the chart would
  // reshuffle itself on every re-render.
  const a = rankByCount([
    { type: "T&M", count: 4 },
    { type: "Custom", count: 4 },
  ]);
  const b = rankByCount([
    { type: "Custom", count: 4 },
    { type: "T&M", count: 4 },
  ]);
  assert.deepEqual(a.map((r) => r.type), b.map((r) => r.type));
  // Custom is declared before T&M in VALID_JOB_TYPES, so it wins the tie.
  assert.deepEqual(a.map((r) => r.type), ["Custom", "T&M"]);
});

test("zero-count types sort last but are NOT dropped", () => {
  const ranked = rankByCount([
    { type: "Service", count: 0 },
    { type: "Custom", count: 2 },
    { type: "Hybrid", count: 0 },
  ]);
  assert.equal(ranked.length, 3, "a zero-count type was dropped — the charts de-emphasise, they do not hide");
  assert.equal(ranked[0].type, "Custom");
  assert.deepEqual(ranked.slice(1).map((r) => r.type), ["Hybrid", "Service"]);
});

test("rankByCount does not mutate its input", () => {
  const input = [
    { type: "Custom", count: 1 },
    { type: "Duplicate", count: 7 },
  ];
  const before = input.map((r) => r.type);
  rankByCount(input);
  assert.deepEqual(input.map((r) => r.type), before);
});


// ── The palette is closed ──────────────────────────────────────────────────

const GLOBALS = readFileSync(join(import.meta.dirname, "..", "src", "app", "globals.css"), "utf8");

// The brand guide's own hex codes (SDC Brand Guide 2026 §04, as transcribed in
// SDC-PowerBI-DEV/REDESIGN-PROMPT.md and packages/design-system/tokens.css).
// Written out here so the test is checking against the GUIDE, not against
// whatever the app happens to define.
const BRAND_HEXES: Record<string, string> = {
  "sdc-blue": "#1574c4",
  "sdc-navy": "#061d39",
  "sdc-blue-100": "#aacee8",
  "sdc-yellow": "#ffde51",
  "sdc-green": "#74c415",
  "sdc-lime": "#befa4f",
  "sdc-gray-700": "#231f20",
  // Not a brand-guide colour — the neutral track. Here so the separation tests
  // can resolve TRACK_CLASS to a hex like any other class.
  "sdc-gray-100": "#f2f2f2",
};

test("every project type's fill comes from the SDC brand palette", () => {
  const allowed = new Set<string>(Object.values(BRAND_PALETTE));
  for (const t of VALID_JOB_TYPES) {
    const c = jobTypeColor(t);
    assert.ok(allowed.has(c.bar), `${t} renders ${c.bar}, which is not in BRAND_PALETTE`);
    assert.equal(BRAND_PALETTE[c.brand], c.bar, `${t} claims brand "${c.brand}" but renders ${c.bar}`);
  }
});

test("no project type uses the off-brand purple, or any non-sdc colour", () => {
  for (const t of VALID_JOB_TYPES) {
    const { bar, swatch, dot } = jobTypeColor(t);
    for (const cls of [bar, swatch, dot]) {
      assert.doesNotMatch(cls, /purple/, `${t} is back on the off-brand purple`);
      // Catches a raw Tailwind palette class (bg-indigo-500, bg-orange-400 ...)
      // or an arbitrary hex, both of which would bypass the brand tokens.
      assert.match(cls, /^bg-sdc-[a-z0-9-]+$/, `${t} renders ${cls}, which is not an sdc-* brand token`);
    }
  }
});

test("every BRAND_PALETTE entry is a real token, at the brand guide's hex", () => {
  // A token that does not exist in globals.css compiles to no colour at all —
  // the bar renders transparent and the chart silently loses a category.
  for (const [name, cls] of Object.entries(BRAND_PALETTE)) {
    const token = cls.replace(/^bg-/, "");
    assert.ok(
      GLOBALS.includes(`--color-${token}:`),
      `BRAND_PALETTE.${name} -> ${cls}, but --color-${token} is not declared in globals.css`,
    );
    const hex = BRAND_HEXES[token];
    assert.ok(hex, `BRAND_PALETTE.${name} -> ${token} has no brand-guide hex recorded in this test`);
    assert.match(
      GLOBALS,
      new RegExp(`--${token}:\\s*${hex}\\s*;`, "i"),
      `--${token} must be the brand guide's ${hex}`,
    );
  }
});

test("Tailwind can actually see every fill — no runtime-assembled class names", () => {
  // Tailwind v4 finds classes by scanning source text. `bg-${token}` compiles to
  // nothing, and the failure is invisible in review: types still map, the test
  // above still passes, and the bar renders transparent in the browser.
  const SRC = readFileSync(
    join(import.meta.dirname, "..", "src", "lib", "job-type-colors.ts"),
    "utf8",
  );
  for (const cls of Object.values(BRAND_PALETTE)) {
    assert.ok(SRC.includes(`"${cls}"`), `${cls} must appear as a literal string, not be built at runtime`);
  }
  // Comments are stripped first: this module's own header explains the
  // `bg-${token}` trap by name, and the check has to read code, not prose.
  const code = SRC.split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  assert.doesNotMatch(code, /`bg-\$\{/, "fills must not be assembled from a template literal");
});

test("the legend swatch is the identical string to the bar fill", () => {
  // Not "the same colour" — the same string. A legend that has drifted from its
  // bars is worse than no legend, so this is built rather than maintained.
  for (const t of VALID_JOB_TYPES) {
    const c = jobTypeColor(t);
    assert.equal(c.swatch, c.bar, `${t}: legend swatch ${c.swatch} != bar ${c.bar}`);
    assert.equal(c.dot, c.bar, `${t}: drill-through dot ${c.dot} != bar ${c.bar}`);
  }
});

test("the unfilled track is a neutral, and is never a category colour", () => {
  assert.match(TRACK_CLASS, /^bg-sdc-gray-/, "the track must be a neutral grey");
  const categoryFills = new Set(VALID_JOB_TYPES.map((t) => jobTypeColor(t).bar));
  assert.ok(!categoryFills.has(TRACK_CLASS), "the track must not share a fill with a project type");
});

test("the stacked-segment edge costs no layout", () => {
  // The customer chart's segment widths sum to exactly the bar. A border or a
  // gap would break that arithmetic; only an inset shadow does not.
  assert.match(SEGMENT_EDGE_CLASS, /shadow-\[inset_/, "the segment separator must be an INSET shadow");
  assert.doesNotMatch(SEGMENT_EDGE_CLASS, /\bborder\b|\bgap-/, "a border or gap would change segment widths");
});

test("the charts and the drill-through all colour type through jobTypeColor", () => {
  // Three call sites, one map. A component that hardcodes a fill is how the two
  // charts stop agreeing, which is the whole reason this module exists.
  const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", "src", ...p), "utf8");
  const consumers = [
    ["ActiveJobsSection.tsx", read("components", "dashboard", "ActiveJobsSection.tsx")],
    ["CustomerBars.tsx", read("components", "dashboard", "CustomerBars.tsx")],
    ["JobDrillPanel.tsx", read("components", "dashboard", "JobDrillPanel.tsx")],
  ] as const;
  for (const [name, src] of consumers) {
    assert.match(src, /jobTypeColor\(/, `${name} must resolve type colour through the shared map`);
    for (const t of VALID_JOB_TYPES) {
      // e.g. a literal `Custom: "bg-sdc-blue"` reappearing in a component.
      assert.doesNotMatch(
        src,
        new RegExp(`${t.replace("&", "&")}\\s*:\\s*"bg-`),
        `${name} hardcodes a fill for ${t}`,
      );
    }
  }
});


// ── Two types must never be hard to tell apart ─────────────────────────────
//
// The test that would have caught the Lime mistake. T&M was assigned Lime Green
// for one revision: a real brand colour, in the centralized map, passing every
// check above — and 1.07:1 in luminance against the Yellow beside it, at a
// neighbouring hue. Both charts drew Service and T&M as one indistinguishable
// blob.
//
// So "on-brand" and "centralized" are not the whole requirement. A pair of
// category fills has to differ in LIGHTNESS or in HUE by enough to survive a 1px
// boundary, and VALID_JOB_TYPES order decides which pairs end up adjacent.

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Hue in degrees, 0-360. Undefined for a pure grey, which returns 0. */
function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

/** Shortest angular distance between two hues, 0-180. */
function hueGap(a: string, b: string): number {
  const d = Math.abs(hue(a) - hue(b)) % 360;
  return d > 180 ? 360 - d : d;
}

// The rendered hex for each type, resolved from the brand token it maps to. Kept
// as a lookup off BRAND_HEXES rather than re-listed, so this test cannot disagree
// with the palette check above about what a token's colour is.
const typeHex = (t: string): string => {
  const token = jobTypeColor(t).bar.replace(/^bg-/, "");
  const hex = BRAND_HEXES[token];
  assert.ok(hex, `no brand hex recorded for ${token}`);
  return hex;
};

test("no two project types are hard to tell apart", () => {
  // ONE rule, deliberately: a pair of fills must separate on LIGHTNESS or on
  // HUE. Two thresholds ANDed together looked more rigorous and was simply
  // wrong — it failed Custom (#1574C4) against Duplicate (#061D39), which are
  // 6 degrees apart in hue and completely unmistakable because one is a mid
  // blue and the other is near-black at 3.48:1.
  //
  // Calibration, against the real palette and the real failure:
  //
  //   Lime / Yellow        1.07:1   24 deg   <- the defect. Fails both.
  //   Hybrid / Service     1.64:1   34 deg   passes on lightness
  //   Custom / Duplicate   3.48:1    6 deg   passes on lightness
  //   Service / T&M        1.25:1  154 deg   passes on hue
  //   Hybrid / T&M         1.32:1  120 deg   passes on hue
  //
  // So 1.5:1 OR 60 degrees sits in the gap: every pair the palette actually
  // produces clears it, and the pair that read as one blob does not.
  const MIN_CONTRAST = 1.5;
  const MIN_HUE_GAP = 60;
  const failures: string[] = [];
  for (let i = 0; i < VALID_JOB_TYPES.length; i++) {
    for (let j = i + 1; j < VALID_JOB_TYPES.length; j++) {
      const [a, b] = [VALID_JOB_TYPES[i], VALID_JOB_TYPES[j]];
      const [ha, hb] = [typeHex(a), typeHex(b)];
      const c = contrast(ha, hb);
      const h = hueGap(ha, hb);
      // Adjacent types share a 1px boundary inside a customer's stacked bar and
      // sit side by side in the legend, so they are the likeliest to be merged
      // by eye. Noted in the failure message rather than given a separate
      // threshold — the rule is the same, the consequence is just worse.
      const adjacent = j === i + 1;
      if (c < MIN_CONTRAST && h < MIN_HUE_GAP) {
        failures.push(
          `${a} (${ha}) vs ${b} (${hb}): ${c.toFixed(2)}:1 contrast, ${h.toFixed(0)}\u00b0 hue` +
            (adjacent ? " — and these two are ADJACENT in the legend and the stack" : ""),
        );
      }
    }
  }
  assert.deepEqual(failures, [], `indistinguishable project-type colours:\n  ${failures.join("\n  ")}`);
});

test("Lime specifically is not assigned to a type while Yellow is", () => {
  // Named rather than left to the generic rule, because this is the concrete
  // regression: Lime and Yellow cannot both be category fills in this chart.
  const fills = VALID_JOB_TYPES.map((t) => jobTypeColor(t).bar);
  if (fills.includes(BRAND_PALETTE.yellow)) {
    assert.ok(
      !fills.includes(BRAND_PALETTE.lime),
      "Lime Green and Yellow are 1.07:1 apart at a similar hue — only one of them can be a project-type fill",
    );
  }
});

test("every category fill is distinguishable from the unfilled track", () => {
  // A segment that matches the track is an invisible segment, and the customer
  // chart's segments are supposed to sum visibly to the bar.
  const trackHex = BRAND_HEXES[TRACK_CLASS.replace(/^bg-/, "")] ?? "#f2f2f2";
  for (const t of VALID_JOB_TYPES) {
    const c = contrast(typeHex(t), trackHex);
    assert.ok(c >= 1.08, `${t} (${typeHex(t)}) is only ${c.toFixed(2)}:1 against the track ${trackHex}`);
  }
});
