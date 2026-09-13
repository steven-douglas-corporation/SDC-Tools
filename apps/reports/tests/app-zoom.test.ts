import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_KEY,
  ZOOM_STEPS,
  ZOOM_VAR,
  isMaxZoom,
  isMinZoom,
  snapZoom,
  stepZoom,
  zoomLabel,
} from "../src/lib/app-zoom";

// ── One universal zoom (§45) ────────────────────────────────────────────────
//
// §45 replaced six independent size controls — a root font-size stepper in the sidebar
// and, per grid, a font size box and Row height / Column width steppers — with one
// `zoom` on <html>. What these tests guard is not the arithmetic (that is four lines)
// but the four ways the replacement could silently come undone:
//
//   1. a step list that no longer contains its own default or its own limits;
//   2. the pre-paint script's clamp drifting from ZOOM_STEPS, so a saved level is
//      quietly clamped away on load;
//   3. a new component reaching for a raw `vh`/`vw`, which `zoom` does not correct —
//      the one genuine trap in the whole approach;
//   4. a second size control appearing somewhere, which is exactly the state §45
//      exists to end.

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

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
const CSS = readFileSync(join(SRC, "app", "globals.css"), "utf8");

// Comments are stripped before searching: several of them quote the units and controls
// they replaced, and a guard that trips on its own documentation is a guard people delete.
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");
}

// ── The step list (§45: "consistent increments", "safe minimum and maximum") ─

test("the offered levels are an even 10% grid from 50% to 100%, in order", () => {
  // Changed 2026-09-02 from 75/80/90/100/110/125/150. Pinned as a literal list
  // because it IS the spec: exactly six levels, nothing above 100%, nothing below
  // 50%, and one uniform step so the − and + buttons travel the same distance
  // wherever you are on the list.
  assert.deepEqual([...ZOOM_STEPS], [0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  for (let i = 1; i < ZOOM_STEPS.length; i++) {
    assert.equal(Math.round((ZOOM_STEPS[i] - ZOOM_STEPS[i - 1]) * 100), 10, "every gap is exactly 10%");
  }
  const sorted = [...ZOOM_STEPS].sort((a, b) => a - b);
  assert.deepEqual([...ZOOM_STEPS], sorted, "stepZoom walks this list by index, so it must be ordered");
});

test("the default is 80% and it is one of the offered levels", () => {
  // If it were not IN the list, stepping away from it and back would be impossible —
  // snapZoom would round it to a neighbour first.
  assert.equal(DEFAULT_ZOOM, 0.8);
  assert.ok(ZOOM_STEPS.includes(DEFAULT_ZOOM));
});

test("the limits are the ends of the list, so there is no second source of bounds", () => {
  assert.equal(MIN_ZOOM, 0.5);
  assert.equal(MAX_ZOOM, 1);
  assert.equal(MIN_ZOOM, Math.min(...ZOOM_STEPS));
  assert.equal(MAX_ZOOM, Math.max(...ZOOM_STEPS));
});

// ── Snapping (§45: the app must never render at an unusable size) ────────────

test("anything unusable lands on the default rather than on screen", () => {
  // localStorage is user-writable and survives releases. Every one of these is a value
  // the app could actually be handed.
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, "", "abc", {}, []]) {
    assert.equal(snapZoom(bad), DEFAULT_ZOOM, `${JSON.stringify(bad)} must fall back to the default`);
  }
});

test("out-of-range values clamp to the limits instead of applying", () => {
  // 0.02 would make the app unreadable; 8 would show four cells. Neither is reachable —
  // and note these clamp rather than falling back to the default: a hand-edited 8 means
  // "as large as possible", and 100% is that.
  assert.equal(snapZoom(0.02), MIN_ZOOM);
  assert.equal(snapZoom("1e-9"), MIN_ZOOM);
  assert.equal(snapZoom(-3), MIN_ZOOM);
  assert.equal(snapZoom(8), MAX_ZOOM);
});

test("a level retired in a later release snaps to its nearest survivor", () => {
  // The upgrade path, and the whole reason snapZoom compares in whole percent: every
  // one of these was a real saved value under the old 75/80/90/100/110/125/150 list,
  // and 0.75 and 0.85 sit at the EXACT midpoint of two surviving levels. The float
  // distances there are unequal in binary (0.049999999999999996 vs 0.05000000000000004),
  // so comparing the raw factors would resolve both downward. Ties go up.
  assert.equal(snapZoom(0.75), 0.8);
  assert.equal(snapZoom(0.85), 0.9);
  assert.equal(snapZoom(0.95), 1);
  assert.equal(snapZoom(1.1), 1);
  assert.equal(snapZoom(1.25), 1);
  assert.equal(snapZoom(1.5), 1);
  assert.equal(snapZoom(0.4), 0.5);
  assert.equal(snapZoom(1.02), 1);
});

test("the pre-paint script normalizes a retired level the same way snapZoom does", () => {
  // The script cannot import snapZoom, so it inlines the rounding. If the two ever
  // disagree, a saved 75% paints at 75% and the sidebar reads 80% — the app visibly
  // contradicting its own control until the next click.
  const layout = readFileSync(join(SRC, "app", "layout.tsx"), "utf8");
  const script = layout.slice(layout.indexOf("dangerouslySetInnerHTML"));
  const inlined = (n: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(n * 10) / 10));
  assert.ok(script.includes("Math.round(n*10)/10"), "the script must snap, not merely clamp");
  for (const saved of [0.75, 0.85, 0.95, 1.1, 1.25, 1.5, 0.4, 0.02, 8]) {
    assert.equal(inlined(saved), snapZoom(saved), `${saved} must restore where snapZoom puts it`);
  }
});

test("every offered level snaps to itself", () => {
  // The round-trip that matters: applied -> persisted as a string -> read back.
  for (const step of ZOOM_STEPS) {
    assert.equal(snapZoom(step), step);
    assert.equal(snapZoom(String(step)), step, "persisted values come back as strings");
  }
});

// ── Stepping (§45: the two sidebar buttons) ─────────────────────────────────

test("stepping walks the list one level at a time, both ways", () => {
  for (let i = 0; i < ZOOM_STEPS.length - 1; i++) {
    assert.equal(stepZoom(ZOOM_STEPS[i], 1), ZOOM_STEPS[i + 1]);
    assert.equal(stepZoom(ZOOM_STEPS[i + 1], -1), ZOOM_STEPS[i]);
  }
});

test("stepping stops at the ends instead of wrapping or overflowing", () => {
  // Wrapping would take someone who clicked − once too often from 50% to 100%.
  assert.equal(stepZoom(MIN_ZOOM, -1), MIN_ZOOM);
  assert.equal(stepZoom(MAX_ZOOM, 1), MAX_ZOOM);
  assert.ok(isMinZoom(stepZoom(MIN_ZOOM, -1)), "the − button must report itself disabled there");
  assert.ok(isMaxZoom(stepZoom(MAX_ZOOM, 1)), "the + button must report itself disabled there");
});

test("stepping from an off-list value joins the list rather than compounding the error", () => {
  // It snaps FIRST, then steps — so an off-list value takes one click to become an
  // offered level and stays on the list from then on.
  assert.equal(stepZoom(0.86, 1), 1); // 0.86 -> 0.9 -> up one
  assert.equal(stepZoom(0.86, -1), 0.8);
  assert.equal(stepZoom(0.97, 1), 1); // 0.97 -> 1, already at the ceiling
});

test("every level reads as a whole percentage", () => {
  // §45 shows the level as text in a 2.6rem slot. "112.5%" would not fit and would not
  // be a level anyone chose.
  for (const step of ZOOM_STEPS) {
    const label = zoomLabel(step);
    assert.match(label, /^\d{2,3}%$/, `${step} formatted as ${label}`);
    // Rounded, and it has to be: `0.7 * 100` is 70.00000000000001 in binary floating
    // point, which is why zoomLabel rounds rather than interpolating the raw product.
    assert.equal(label, `${Math.round(step * 100)}%`);
  }
  assert.deepEqual(ZOOM_STEPS.map(zoomLabel), ["50%", "60%", "70%", "80%", "90%", "100%"]);
  assert.equal(zoomLabel(DEFAULT_ZOOM), "80%");
});

// ── The pre-paint restore (§45: "apply it immediately", no flash) ────────────

test("the pre-paint script and the step list agree on the key, the variable and the bounds", () => {
  // The script is a string in layout.tsx, so it cannot import any of this. If the range
  // is ever changed here and not there, a saved 175% would be silently clamped to the
  // script's own stale ceiling
  // on every load — the app would just quietly disagree with its own control.
  const layout = readFileSync(join(SRC, "app", "layout.tsx"), "utf8");
  const script = layout.slice(layout.indexOf("dangerouslySetInnerHTML"));
  assert.ok(script.includes(`'${ZOOM_KEY}'`), `the script must read ${ZOOM_KEY}`);
  assert.ok(script.includes(`'${ZOOM_VAR}'`), `the script must write ${ZOOM_VAR}`);
  assert.ok(script.includes(`Math.min(${MAX_ZOOM},`), `the script's upper clamp must be ${MAX_ZOOM}`);
  assert.ok(script.includes(`Math.max(${MIN_ZOOM},`), `the script's lower clamp must be ${MIN_ZOOM}`);
});

test("the zoom is applied by CSS reading one variable, defaulting to DEFAULT_ZOOM", () => {
  // Why it must be declared in CSS: applyZoom only ever writes the custom property, so a
  // browser that has never had a preference set — and the server-rendered first paint —
  // takes its level from the stylesheet. Asserted against DEFAULT_ZOOM rather than a
  // literal, so the no-preference paint and the control can never disagree about what
  // "default" means. And `html { zoom: var(…) }` is what makes changing the level a
  // single property write rather than a re-render (§45's "do not rerender every table
  // cell").
  assert.match(
    CSS,
    new RegExp(`--app-zoom:\\s*${String(DEFAULT_ZOOM).replace(".", "\\.")};`),
    `globals.css must declare the default zoom as ${DEFAULT_ZOOM}`,
  );
  assert.match(CSS, /html\s*\{[^}]*zoom:\s*var\(--app-zoom\)/, "html must apply it");
});

test("the viewport vars divide the zoom back out", () => {
  // The trap measured before any of this was written: `zoom` scales `vh`, but the viewport
  // does not scale, so at 125% a `height: 100vh` element renders 900px against a 720px
  // viewport. These two vars are the correction, and the test below is what keeps them the
  // only way viewport lengths are written.
  assert.match(CSS, /--app-vh:\s*calc\(100vh\s*\/\s*var\(--app-zoom\)\)/);
  assert.match(CSS, /--app-vw:\s*calc\(100vw\s*\/\s*var\(--app-zoom\)\)/);
});

test("no component uses a raw viewport unit", () => {
  // The trap above, guarded. `h-screen`, `min-h-screen` and `max-h-[80vh]` all LOOK
  // correct and all break at any zoom other than 100% — the sidebar hanging off the
  // bottom of the screen at 125% is what this catches.
  const offenders: string[] = [];
  for (const file of COMPONENT_FILES) {
    const body = code(file);
    for (const m of body.matchAll(/\b(?:min-|max-)?[hw]-screen\b/g)) offenders.push(`${file.replace(SRC, "src")}: ${m[0]}`);
    // A vh/vw inside an arbitrary value or an inline style. --app-vh/--app-vw are
    // themselves defined in globals.css, which is not a component file.
    for (const m of body.matchAll(/[\d.]+(?:vh|vw)\b/g)) offenders.push(`${file.replace(SRC, "src")}: ${m[0]}`);
  }
  assert.deepEqual(offenders, [], "use var(--app-vh) / var(--app-vw) — `zoom` does not correct raw viewport units");
});

// ── One control, and only one (§45's acceptance criteria 1-8) ────────────────

test("nothing but the zoom control writes a size onto the document root", () => {
  // Criteria 2-6: the separate text-size, font-size, row-height, column-width and
  // density controls are gone. They all worked the same way — a custom property or the
  // font-size on <html>, plus a localStorage key and a mount effect to restore it — so
  // the way to keep them gone is to allow exactly one file to do that at all.
  //
  // Two files may: app-zoom.ts, which owns the property, and layout.tsx's pre-paint
  // script, which cannot import it (it is a string in the HTML). The test above pins
  // that script to app-zoom's own key, variable and bounds, so it is not a second
  // opinion about zoom — it is the same one, spelled out for the parser.
  const allowed = new Set(["src\\lib\\app-zoom.ts", "src/lib/app-zoom.ts", "src\\app\\layout.tsx", "src/app/layout.tsx"]);
  const offenders: string[] = [];
  for (const file of COMPONENT_FILES) {
    if (allowed.has(file.replace(SRC, "src"))) continue;
    if (/documentElement\.style/.test(code(file))) offenders.push(file.replace(SRC, "src"));
  }
  assert.deepEqual(offenders, [], "size the app through lib/app-zoom.ts, not by writing to <html> directly");
});

test("the retired density variables are referenced nowhere", () => {
  // Criteria 4-6 again, from the consuming end: the two grids' padding used to read
  // --etc-row-py / --etc-col-px / --etc-font-size and --quoted-row-py / --quoted-col-px.
  // A leftover reference is worse than a leftover control — it is a var nothing sets, so
  // it silently falls back and reads as if it still worked.
  const retired = ["--etc-row-py", "--etc-col-px", "--etc-font-size", "--quoted-row-py", "--quoted-col-px"];
  const offenders: string[] = [];
  for (const file of FILES) {
    const body = code(file);
    for (const name of retired) if (body.includes(name)) offenders.push(`${file.replace(SRC, "src")}: ${name}`);
  }
  assert.deepEqual(offenders, [], "these were the per-grid density controls (§45)");
});

test("the zoom control lives in the sidebar, so it is on every page", () => {
  // Criteria 1 and 8: one control, reachable from everywhere, and the same level on every
  // tab. The sidebar is the only chrome every route shares — a toolbar control would be
  // per-page by construction, which is how the app came to have two densities at once.
  const sidebar = readFileSync(join(SRC, "components", "Sidebar.tsx"), "utf8");
  assert.match(sidebar, /<AppZoom\b/, "Sidebar must render the zoom control");
  // Matched inside the tag rather than with the `s` flag, which this tsconfig's target
  // does not allow: the control has to be TOLD about the rail, or it cannot stay usable there.
  assert.match(sidebar, /<AppZoom[^>]*collapsed/, "it must stay usable on the collapsed rail");

  const consumers = COMPONENT_FILES.filter((f) => /<AppZoom\b/.test(code(f)));
  assert.deepEqual(
    consumers.map((f) => f.replace(SRC, "src")),
    [join("src", "components", "Sidebar.tsx")],
    "exactly one place may render it",
  );
});

// ── The chart's category column has a floor (2026-09-02) ───────────────────
//
// Reported as a zoom bug: labels overlapping on Job Hour Details. Measured on
// job 1104 (26 categories), the label row and its slots:
//
//     zoom  80%  row 807px  slot 27px  19 of 26 labels overflowed
//     zoom 100%  row 615px  slot 20px  20 of 26
//     zoom 125%  row 462px  slot 14px  26 of 26
//
// So it was broken at 100% too — zoom aggravates it (fewer layout px for the
// same column count) but does not cause it. The cause was `minmax(0, 1fr)`:
// §55 chose it so the chart never forces a scrollbar, which is right until a
// single WORD cannot fit. "Manufacturing" is 75px and cannot wrap.
test("the chart's columns cannot shrink below the widest single word", () => {
  const src = readFileSync(join(process.cwd(), "src", "components", "JobHoursDashboard.tsx"), "utf8");
  const m = /const CATEGORY_MIN_PX = (\d+)/.exec(src);
  assert.ok(m, "the floor is a named constant, not a literal buried in a template");
  const min = Number(m![1]);
  // 75px is the measured width of "Manufacturing", the widest single word in
  // any category label; the rest is the column's own padding.
  assert.ok(min >= 76, `column floor ${min}px is under the 75px widest word — labels will overflow again`);
  assert.match(src, /minmax\(\$\{CATEGORY_MIN_PX\}px, 1fr\)/, "floor applied to the shared column template");
});

test("bars and all three label tiers scroll inside ONE frame, so they stay aligned", () => {
  const src = readFileSync(join(process.cwd(), "src", "components", "JobHoursDashboard.tsx"), "utf8");
  // Every tier is laid out from the same `colStyle`; a shared scroll parent is
  // what keeps a bar over its own label once the floor forces scrolling.
  assert.match(src, /overflow-x-auto overscroll-x-contain/);
  const frameAt = src.indexOf("overflow-x-auto overscroll-x-contain");
  const barsAt = src.indexOf("ref={barsRef}");
  const tier3At = src.indexOf("Tier 3 — phase");
  assert.ok(frameAt < barsAt, "the frame opens before the bars");
  assert.ok(barsAt < tier3At, "and encloses every tier, not just the bars");
});
