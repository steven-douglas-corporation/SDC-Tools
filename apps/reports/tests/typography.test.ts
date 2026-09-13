import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ── One type system (§39) ───────────────────────────────────────────────────
//
// §39 asked for consistent typography. What was there: **twenty-two distinct font
// sizes**, counted 2026-08-04 across src/ —
//
//   216 × text-[10px]   140 × text-[11px]   168 × text-xs    135 × text-sm
//    16 × text-[9px]     11 × text-[13px]     8 × text-[12px]
//   plus 9.5, 10.5, 11.5, 12.5, 13.5, 7, 8, 15, 16, 22, 27px one-offs
//
// — several of them within half a pixel of each other, and none of the pixel ones
// reachable by the app's own text-size control (see the rem note below). Now ten, all
// declared in the theme.
//
// These tests guard the three properties that a later change would break silently: the
// vocabulary stays closed, the migration changed no rendered size, and no weight is used
// that next/font does not actually load.

const SRC = join(import.meta.dirname, "..", "src");
const CSS = join(SRC, "app", "globals.css");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(tsx?|css)$/.test(entry)) out.push(path);
  }
  return out;
}
const FILES = walk(SRC);
const COMPONENT_FILES = FILES.filter((f) => /\.tsx?$/.test(f));

// Comments are stripped before searching: several of them quote the classes they
// replaced, and a guard that trips on its own documentation is a guard people delete.
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");
}

// ── The scale is closed (§39.2, §39.10, §39.17) ─────────────────────────────

// Every step, and the pixel size it resolves to at the 15px root default. The three
// app-specific ones are declared in globals.css; the rest are Tailwind's own.
const SCALE_PX: Record<string, number> = {
  "text-micro": 9, // 0.6rem
  "text-label": 10, // 0.6667rem
  "text-note": 11, // 0.7333rem
  "text-xs": 11.25, // 0.75rem
  "text-sm": 13.125, // 0.875rem
  "text-base": 15, // 1rem
  "text-lg": 16.875, // 1.125rem
  "text-xl": 18.75, // 1.25rem
  "text-2xl": 22.5, // 1.5rem
  "text-3xl": 28.125, // 1.875rem
  "text-4xl": 33.75, // 2.25rem — the 404 page's numeral, and nothing else
};

test("no component sets a font size in raw pixels", () => {
  // The whole point of §39.10. A raw `text-[10px]` is invisible to the theme, which is
  // how the app came to have twenty-two sizes.
  //
  // The `length:var(…)` exemption this used to carry is gone with the thing it exempted:
  // the ETC grid's own Text size stepper wrote --etc-font-size, and §45 replaced it and
  // the other four density controls with one application-wide zoom.
  const offenders: string[] = [];
  for (const file of COMPONENT_FILES) {
    for (const match of code(file).matchAll(/text-\[[^\]]*px[^\]]*\]/g)) {
      offenders.push(`${file.replace(SRC, "src")}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `use a theme step (${Object.keys(SCALE_PX).join(", ")}) instead`);
});

test("the three app-specific steps are declared in the theme, in rem", () => {
  // §39.17: defined once, centrally. In rem because that is what makes the text-size
  // control reach them — the point of the whole migration.
  const css = readFileSync(CSS, "utf8");
  for (const [token, px] of [
    ["--text-micro", 9],
    ["--text-label", 10],
    ["--text-note", 11],
  ] as const) {
    const match = css.match(new RegExp(`${token}:\\s*([0-9.]+)rem`));
    assert.ok(match, `${token} must be declared in globals.css, in rem`);
    // At the 15px default root, each must land on the pixel size it replaced — which is
    // what makes the migration a rename rather than a redesign.
    const resolved = parseFloat(match[1]) * 15;
    assert.ok(Math.abs(resolved - px) < 0.05, `${token} resolves to ${resolved}px, expected ${px}px`);
  }
});

test("every size class used in the app is a step of the scale", () => {
  // Catches a stray `text-[0.9rem]` or a Tailwind step nobody meant to introduce.
  const used = new Set<string>();
  for (const file of COMPONENT_FILES) {
    for (const match of code(file).matchAll(/\btext-(micro|label|note|xs|sm|base|lg|xl|[2-9]xl)\b/g)) {
      used.add(match[0]);
    }
  }
  for (const step of used) assert.ok(step in SCALE_PX, `${step} is not a declared step`);
  // …and the scale has not grown a step nobody uses, which is how a scale rots.
  const unused = Object.keys(SCALE_PX).filter((s) => !used.has(s));
  assert.deepEqual(unused, [], "declared but unused steps should be removed");
});

test("the migration mapped every old size onto a step of the same size", () => {
  // The proof that nothing moved on screen. Each pair is (old raw pixels, new step);
  // an entry is only allowed to differ where the change was deliberate, and those are
  // listed with their reason.
  const identical: [number, string][] = [
    [9, "text-micro"],
    [10, "text-label"],
    [11, "text-note"],
  ];
  for (const [px, step] of identical) {
    assert.equal(SCALE_PX[step], px, `${step} must still be exactly ${px}px or the migration moved text`);
  }
  // Two sizes were RAISED rather than collapsed. 7px and 8px are below anything anyone
  // can read, which §39.15 ("keep minimum readable font sizes") does not allow, so the
  // scale has no step there and they moved up to the 9px floor. Three sites: a status
  // pip, a chart caption and a presence initial — all of which had room.
  const raised: [number, string][] = [
    [7, "text-micro"],
    [8, "text-micro"],
  ];
  for (const [px, step] of raised) {
    assert.ok(SCALE_PX[step] > px, `${px}px should have been raised to the ${step} floor`);
    assert.ok(SCALE_PX[step] - px <= 2, `${px}px -> ${step} is a bigger jump than intended`);
  }
  // Deliberate collapses, all sub-pixel or single-pixel, each absorbing a near-duplicate:
  const collapsed: [number, string, string][] = [
    [9.5, "text-micro", "half a pixel from 9"],
    [10.5, "text-label", "half a pixel from 10"],
    [11.5, "text-note", "half a pixel from 11"],
    [12, "text-xs", "0.75px, onto the step that already carries secondary text"],
    [12.5, "text-xs", "1.25px, same step"],
    [13, "text-sm", "an eighth of a pixel"],
    [13.5, "text-sm", "0.375px"],
    [15, "text-base", "identical"],
    [16, "text-base", "1px, the KPI value"],
    [22, "text-2xl", "half a pixel"],
    [27, "text-3xl", "1.1px, one use"],
  ];
  // 1.3px is the widest any of these moves (12.5px onto text-xs). Anything beyond that
  // is a redesign rather than a consolidation, and should be argued for rather than
  // absorbed into this list.
  for (const [px, step, why] of collapsed) {
    const delta = Math.abs(SCALE_PX[step] - px);
    assert.ok(delta <= 1.3, `${px}px -> ${step} moves text by ${delta}px (${why})`);
  }
});

// ── Weights (§39.9, §39.18) ─────────────────────────────────────────────────

test("only the four weights next/font actually loads are used", () => {
  // layout.tsx loads Montserrat at 400/500/600/700. `font-extrabold` (800) was used in
  // five places, and the browser SYNTHESISES a weight it does not have — so those five
  // rendered as a smeared faux bold that matched nothing else on the page. §39.18's "do
  // not load unnecessary weights" has a mirror: do not use weights you did not load.
  const loaded = readFileSync(join(SRC, "app", "layout.tsx"), "utf8").match(/weight:\s*\[([^\]]+)\]/);
  assert.ok(loaded, "could not find the loaded font weights");
  const weights = loaded[1].match(/\d+/g)!.map(Number);
  assert.deepEqual(weights, [400, 500, 600, 700]);

  const CLASS_TO_WEIGHT: Record<string, number> = {
    "font-thin": 100,
    "font-extralight": 200,
    "font-light": 300,
    "font-normal": 400,
    "font-medium": 500,
    "font-semibold": 600,
    "font-bold": 700,
    "font-extrabold": 800,
    "font-black": 900,
  };
  const offenders: string[] = [];
  for (const file of COMPONENT_FILES) {
    for (const match of code(file).matchAll(/\bfont-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/g)) {
      if (!weights.includes(CLASS_TO_WEIGHT[match[0]])) offenders.push(`${file.replace(SRC, "src")}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], "these weights are not loaded and will be synthesised by the browser");
});

// ── One family (§39.1, §39.16) ──────────────────────────────────────────────

test("the font family is declared once and never overridden in a component", () => {
  const css = readFileSync(CSS, "utf8");
  assert.match(css, /--font-sans:\s*var\(--font-montserrat\)/, "the primary family belongs in the theme");
  assert.match(css, /body\s*\{[\s\S]*?font-family:\s*var\(--font-sans\)/, "body must apply it");

  const offenders: string[] = [];
  for (const file of COMPONENT_FILES) {
    const body = code(file);
    // An arbitrary family utility — there is no reason for one. `font-mono` is a
    // deliberate exception (job numbers, section codes, PO lines — §39.1's "unless
    // explicitly required for a specific technical purpose"), as is font-heading, which
    // IS the same family.
    for (const m of body.matchAll(/\bfont-\[[^\]]+\]/g)) offenders.push(`${file.replace(SRC, "src")}: ${m[0]}`);
  }
  assert.deepEqual(offenders, [], "families belong in the theme, not in components");
});

test("nothing names a font face except the theme and the loader", () => {
  // §39.16's "duplicate theme definitions", which is how the charts came to use a
  // DIFFERENT font from the rest of the app: charts/theme.ts had its own hand-written
  // "Montserrat, -apple-system, …" string, and next/font self-hosts the file under a
  // generated family name, so the literal "Montserrat" resolved to whatever the machine
  // had installed — or to the fallback.
  //
  // Two files may say the name: globals.css (the theme) and layout.tsx (the loader).
  // Anything else that needs a real string — a canvas renderer — must resolve it from
  // the document, which is what charts/theme.ts does now.
  const allowed = new Set(["src\\app\\globals.css", "src/app/globals.css", "src\\app\\layout.tsx", "src/app/layout.tsx"]);
  const offenders: string[] = [];
  for (const file of FILES) {
    const relative = file.replace(SRC, "src");
    if (allowed.has(relative)) continue;
    if (/Montserrat|Core Sans/.test(code(file))) offenders.push(relative);
  }
  assert.deepEqual(offenders, [], "resolve the family from the document instead of naming it");
});

test("a third-party grid is told to inherit the app font, not given one", () => {
  // §39.16's "table libraries applying their own font styles". AG Grid takes a theme
  // parameter; the right value is `inherit`, so it cannot drift from the rest of the app.
  const grid = readFileSync(join(SRC, "components", "AuditLogGridInner.tsx"), "utf8");
  assert.match(grid, /fontFamily:\s*"inherit"/, "the grid must inherit the app font");
});

// ── The root size, and the shift it used to cause (§39.18, §45) ─────────────

test("the root font size is declared in CSS and set from nowhere else", () => {
  // Two bugs guarded by one assertion.
  //
  // §39.18: the root size used to be applied ONLY by JavaScript — AppTextSize's mount
  // effect, plus a pre-paint script that ran only when a saved preference existed. So a
  // first visit rendered the whole app at the browser's 16px and snapped to 15px on
  // hydration: a 6.7% reflow of every page.
  //
  // §45: the root size is now a CONSTANT. It was the app's size control (12–20px), which
  // reached rem and ignored px; `zoom` replaced it and scales both. The type scale in
  // this file is measured against 15px — every SCALE_PX number above assumes it — so
  // anything reintroducing a JS writer to `documentElement.style.fontSize` would silently
  // invalidate the whole suite rather than fail it.
  const css = readFileSync(CSS, "utf8");
  const match = css.match(/html\s*\{[\s\S]*?font-size:\s*(\d+)px/);
  assert.ok(match, "globals.css must declare the root font size");
  assert.equal(Number(match[1]), 15, "the scale above is measured against a 15px root");

  const offenders = COMPONENT_FILES.filter((f) => /style\.fontSize|fontSize\s*=/.test(code(f)));
  assert.deepEqual(
    offenders.map((f) => f.replace(SRC, "src")),
    [],
    "the root font size is a constant — size the app with the zoom control (lib/app-zoom.ts)",
  );
});

// ── Page titles (§39.3) ─────────────────────────────────────────────────────

test("every page title goes through PageTitle", () => {
  // §39.3 lists seven pages that must look identical. The way to guarantee that is for
  // none of them to write an <h1> of its own.
  const pages = FILES.filter((f) => /[\\/]app[\\/].*page\.tsx$/.test(f));
  assert.ok(pages.length >= 6, `expected the app's pages, found ${pages.length}`);
  const offenders: string[] = [];
  for (const file of pages) {
    if (/<h1\b/.test(code(file))) offenders.push(file.replace(SRC, "src"));
  }
  assert.deepEqual(offenders, [], "use <PageTitle> from components/ui/Typography");
});

test("the heading components are the only place heading sizes are set", () => {
  const typography = readFileSync(join(SRC, "components", "ui", "Typography.tsx"), "utf8");
  // PageTitle and SectionTitle must each pin a size, a weight and the family.
  for (const name of ["PageTitle", "SectionTitle"]) {
    const start = typography.indexOf(`export function ${name}`);
    assert.ok(start > 0, `${name} must exist`);
    const body = typography.slice(start, start + 400);
    assert.match(body, /font-heading/, `${name} must set the family`);
    assert.match(body, /\btext-(base|lg|xl|[2-9]xl)\b/, `${name} must set a size from the scale`);
    assert.match(body, /\bfont-(semibold|bold)\b/, `${name} must set a weight`);
  }
});
