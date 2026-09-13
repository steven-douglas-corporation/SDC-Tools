import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ── One drill-through design (§47) ──────────────────────────────────────────
//
// The "KPI Card Redesign" reference was applied to every drill-through in the app. What
// these tests guard is not the styling — that is one file now — but the three ways it
// comes undone:
//
//   1. a panel hand-rolling its own header band, zebra stripes or total row again, which
//      is the state the redesign found (three drills, three designs, agreeing on none of
//      five decisions);
//   2. the muted text tone going undeclared again, which is what made the whole second
//      tier of the hierarchy render at full body ink for 107 call sites;
//   3. the mockup's palette or its sub-AA greys being copied in alongside the brand
//      tokens.

const SRC = join(import.meta.dirname, "..", "src");
const CSS = readFileSync(join(SRC, "app", "globals.css"), "utf8");
const DRILL = readFileSync(join(SRC, "components", "ui", "Drill.tsx"), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}
const FILES = walk(SRC);

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");
}

/** The three panels the reference was applied to. */
const DRILLS = ["HoursDetailPanel.tsx", "UndefinedHoursPanel.tsx", "DataQualityDrill.tsx"].map((f) =>
  join(SRC, "components", f),
);

// ── The muted tone exists (§47) ─────────────────────────────────────────────

test("the muted text tone is declared, in both places Tailwind needs", () => {
  // The bug this replaces: `sdc-gray-500` was written 107 times and never declared, so
  // `.text-sdc-gray-500` emitted NO CSS — verified in the running app, where the class
  // matched no rule and the text inherited #231f20. Every "secondary" line in the app was
  // rendering at full body ink.
  //
  // Tailwind v4 needs the value in `:root` AND a `--color-*` alias in `@theme`, and a
  // token with only the first half is exactly as invisible as no token at all.
  assert.match(CSS, /--sdc-muted:\s*#6e6a6b/i, "the value belongs in :root");
  assert.match(CSS, /--color-sdc-muted:\s*var\(--sdc-muted\)/, "…and the alias in @theme, or no utility is generated");
});

test("the muted tone passes AA on every surface the app puts it on", () => {
  // Not decoration: these are group counts, record counts, dates and section codes.
  const lum = (hex: string) => {
    const ch = (i: number) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const muted = CSS.match(/--sdc-muted:\s*(#[0-9a-f]{6})/i)![1];
  for (const [name, bg] of [
    ["white", "#ffffff"],
    ["--sdc-gray-50", "#fafafa"],
    ["--sdc-gray-100", "#f2f2f2"],
  ] as const) {
    const r = ratio(muted, bg);
    assert.ok(r >= 4.5, `${muted} on ${name} is ${r.toFixed(2)}:1 — WCAG AA for normal text needs 4.5:1`);
  }
});

test("the undeclared token cannot come back", () => {
  const offenders = FILES.filter((f) => /sdc-gray-500/.test(code(f))).map((f) => f.replace(SRC, "src"));
  assert.deepEqual(offenders, [], "use text-sdc-muted — sdc-gray-500 is not a declared token");
});

// ── The mockup's palette stays in the mockup (§39.16, §47) ──────────────────

test("no drill copies the reference's hex values", () => {
  // The reference is drawn in a warm-gray scheme. Copying it into a component is the
  // "duplicate theme definitions" §39.16 forbids — how the charts came to use a different
  // font from the rest of the app. Its structure was adopted; its colours were mapped.
  const mockupHexes = [
    "#f4f4f2", "#e2e0d9", "#eeece5", "#f3f2ec", "#16233a", "#2b5f8e",
    "#8b8b82", "#9a998f", "#a9a89f", "#6b6b64", "#22221c", "#fcfcfa", "#fbfbf9", "#f4f3ee",
  ];
  const offenders: string[] = [];
  for (const f of [...DRILLS, join(SRC, "components", "ui", "Drill.tsx")]) {
    const body = code(f).toLowerCase();
    for (const hex of mockupHexes) if (body.includes(hex)) offenders.push(`${f.replace(SRC, "src")}: ${hex}`);
  }
  assert.deepEqual(offenders, [], "map the reference onto the brand tokens rather than pasting its palette");
});

// ── One design, not three (§47) ─────────────────────────────────────────────

test("every drill routes its table through the shared components", () => {
  for (const f of DRILLS.slice(0, 2)) {
    const body = code(f);
    assert.match(body, /from "@\/components\/ui\/Drill"/, `${f.replace(SRC, "src")} must use the shared drill design`);
  }
});

test("no drill re-introduces a navy header band or zebra striping", () => {
  // The two treatments the redesign removed, and the two most likely to be pasted back in
  // from one of the big spreadsheet grids — where they belong and here they do not.
  const offenders: string[] = [];
  for (const f of DRILLS) {
    const body = code(f);
    if (/thead[^>]*bg-sdc-navy/.test(body)) offenders.push(`${f.replace(SRC, "src")}: navy header band`);
    if (/i % 2 === 1 \? "bg-sdc-gray-50/.test(body)) offenders.push(`${f.replace(SRC, "src")}: zebra stripes`);
    if (/border-t-2 border-sdc-navy/.test(body)) offenders.push(`${f.replace(SRC, "src")}: heavy navy total rule`);
  }
  assert.deepEqual(offenders, [], "drills read as reports: hairlines and type, not bands and stripes");
});

test("the drills do not use the spreadsheet grid tokens", () => {
  // TABLE_GRID and GRID_SCROLLER give every cell a border and sharp corners, which is
  // right for Monthly ETC and Projects (§41.23) and wrong for a rollup that is read
  // rather than edited. HoursDetailPanel used TABLE_GRID before the redesign.
  const offenders: string[] = [];
  for (const f of DRILLS) {
    const body = code(f);
    for (const token of ["TABLE_GRID", "GRID_SCROLLER"]) {
      if (body.includes(token)) offenders.push(`${f.replace(SRC, "src")}: ${token}`);
    }
  }
  assert.deepEqual(offenders, [], "grids read as spreadsheets, drills read as reports");
});

test("the header, the group rows and the total share one column template", () => {
  // The failure this prevents is specific: a hand-counted colSpan under a table whose
  // column count is `groupBy.length + 1`. Get it wrong and nothing errors — the total
  // simply lands in the wrong column. One `template()` used by all three rows cannot.
  assert.match(DRILL, /function template\(dimensions: number\)/);
  // DrillTable computes it ONCE and hands the same value to its header row and its total
  // row; DrillGroup derives its own from the same function. So there are three
  // references, not four, and no row states its own widths.
  assert.match(DRILL, /const cols = template\(columns\.length\)/, "DrillTable must compute it once");
  const gridTemplateUses = DRILL.match(/gridTemplateColumns: cols/g) ?? [];
  assert.equal(gridTemplateUses.length, 2, "the header row and the total row must both read that one value");
  assert.match(DRILL, /gridTemplateColumns: template\(columns\)/, "a group row derives its own from the same function");
});

test("the caret rotates rather than swapping glyph", () => {
  // UndefinedHoursPanel swapped ▶ for ▼, which jumps; HoursDetailPanel rotated. One
  // control, and it is the rotation — a glyph swap reads as two different marks.
  assert.match(DRILL, /rotate-90/);
  assert.doesNotMatch(code(join(SRC, "components", "UndefinedHoursPanel.tsx")), /open \? "▼" : "▶"/);
});

test("group rows are real buttons that report their state", () => {
  assert.match(DRILL, /aria-expanded=\{open\}/, "the disclosure must announce itself");
  assert.match(DRILL, /aria-pressed=\{on\}/, "the group options are toggles, not links");
});

// ── The card keeps its own height; the drill scrolls (§49) ──────────────────
//
// The layout this replaces used flex's default `stretch` plus `[&>*]:h-full`, which made
// the KPI summary card and the drill panel equal height. That reads as a reasonable
// instruction ("line them up top and bottom") and has one loser: stretch gives a card the
// ROW's height without giving it any more content, so five KPI rows sat above ~200px of
// empty grey whenever a drill was open beside them.
//
// The replacement has two halves, and each half is useless without the other — which is
// why they are guarded together. Independent heights without a ceiling means a
// forty-five-row table sets the row's height and pushes the grid off the screen; a
// ceiling without independent heights means the ceiling never binds, because h-full
// overrides it with the row's height.

const KPI_CARDS = code(join(SRC, "components", "EtcMonthKpiCards.tsx"));

test("the summary card and the drill do not stretch to match each other", () => {
  assert.match(KPI_CARDS, /flex flex-wrap items-start gap-3/, "the row must align at the top, not stretch");
  // The specific mechanism that defeated the ceiling. `h-full` on the drill column's
  // child resolved to the row height, so `max-height` had nothing left to cap.
  assert.doesNotMatch(KPI_CARDS, /\[&>\*\]:h-full/, "nothing may force the drill panel to the row's height");
});

test("side by side is decided by wrapping, not by a viewport breakpoint", () => {
  // §26.2's lesson, which cost a whole round of "the parallel row is not working": this
  // row is inset by a sidebar that is ~276px expanded, so `xl` (1280px viewport) fires on
  // a box that is ~1000px wide. A flex-basis measures the box itself.
  assert.match(KPI_CARDS, /basis-\[28rem\]/, "the drill column needs a basis for the wrap decision");
  const breakpointed = /(?:sm|md|lg|xl|2xl):(?:flex-row|flex-col|items-start|items-stretch)/.exec(KPI_CARDS);
  assert.equal(breakpointed, null, `viewport breakpoints measure the wrong box here — found ${breakpointed?.[0]}`);
});

test("the drill's height ceiling is bounded at both ends", () => {
  const rule = /\.drill-cap\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(rule, ".drill-cap must be declared in globals.css");
  const body = rule[1].replace(/\s+/g, "");
  // Window-relative, so a short laptop never gets a panel taller than its viewport.
  assert.match(body, /100vh/, "the ceiling must respect the window");
  // Floored AND capped, which is the whole reason it is a clamp:
  //
  //   floor — zoom shrinks the viewport in CSS pixels while leaving rem where it is, so at
  //     400% the window bound goes negative and max-height clamps to ZERO. The drill would
  //     disappear at high zoom and nowhere else.
  //   cap   — measured live: with the window bound alone the parts drill took 770px on a
  //     950px viewport and pushed the grid 516px off the screen, which is the §26 problem
  //     reappearing inside its own fix.
  assert.match(body, /^max-height:clamp\(/, "clamp states the floor, the window bound and the cap at once");
  const [floor, , cap] = body.replace(/^max-height:clamp\(|\);?$/g, "").split(",");
  assert.ok(parseFloat(floor) > 0, `the floor must be positive, got ${floor}`);
  assert.ok(parseFloat(cap) > parseFloat(floor), `the cap must exceed the floor, got ${cap} vs ${floor}`);
});

test("every drill card carries the ceiling and exactly one scrolling region", () => {
  // Four drill cards: the shared panel (hours), the undefined-hours panel, and the two
  // hand-rolled ones on the Monthly ETC strip (parts, off-grid). All four read the same
  // two classes, so "how tall may a drill be" is one decision rather than four.
  const sites: [string, string, number][] = [
    ["src/components/ui/Drill.tsx", DRILL, 1],
    ["src/components/UndefinedHoursPanel.tsx", code(join(SRC, "components", "UndefinedHoursPanel.tsx")), 1],
    ["src/components/EtcMonthKpiCards.tsx", KPI_CARDS, 2],
  ];
  for (const [name, body, bodies] of sites) {
    assert.match(body, /DRILL_CAP/, `${name} must cap its drill card`);
    // Counted, not just present: a card with two scrolling regions has two scrollbars and
    // the shorter one wins, which is how the Lines view came to show less than the rollup
    // it toggles with. The declaration and the import are references to the name rather
    // than uses of it, so they come off the count.
    const declared = /export const DRILL_BODY/.test(body) ? 1 : 0;
    // No `s` flag needed, and it is not available at this target: a negated class matches
    // newlines whether or not `.` does.
    const imported = /import \{[^}]*DRILL_BODY/.test(body) ? 1 : 0;
    const used = (body.match(/DRILL_BODY/g) ?? []).length - declared - imported;
    assert.equal(used, bodies, `${name}: expected ${bodies} scrolling ${bodies === 1 ? "region" : "regions"}, found ${used}`);
  }
});

test("the scrolling body is basis-auto, never flex-1", () => {
  // `flex-1` sets `flex-basis: 0`, which makes an auto-height flex column compute its
  // height from a zero-height body — the card collapses to its header instead of growing
  // to its content and then capping. The bug looks like "the drill is empty".
  assert.match(DRILL, /export const DRILL_BODY = "[^"]*basis-auto/);
  assert.doesNotMatch(DRILL, /export const DRILL_BODY = "[^"]*flex-1/);
  // And min-h-0, or the item refuses to go below its own content height and the card
  // overflows its ceiling instead of scrolling.
  assert.match(DRILL, /export const DRILL_BODY = "[^"]*min-h-0/);
});

// ── One scroller, plain flow beneath it (§75) ───────────────────────────────
//
// A `sticky bottom-0` Total row and a per-group height cap were both removed together:
// the sticky Total painted over an open group's own bottom rows for as long as there was
// more of the ONE scroller (DRILL_BODY) left to reach, and it only got bad enough to
// notice once a group could grow past a screen's worth of lines with no cap of its own.
// Removing either alone would not have fixed the report — a capped group with a sticky
// Total would still glue the Total over the group's last visible line whenever the
// panel's OWN scroll (above the group) hadn't reached bottom; an uncapped group with the
// sticky Total kept would just make the glued-over stretch longer. Both go together.

test("the Total row is plain flow, not pinned over the rows above it", () => {
  const total = /role="row"\s*\n?\s*className="([^"]*)"/.exec(
    DRILL.slice(DRILL.indexOf("The total, on the same template")),
  );
  assert.ok(total, "the total row must carry a class list");
  assert.doesNotMatch(
    total[1],
    /sticky|fixed|absolute/,
    "a pinned Total floats over whatever the scroller hasn't reached yet — see §75",
  );
  // Opaque stays relevant even unpinned: DrillGroup's tinted expansion sits directly
  // above it in the DOM, and an opaque row is what keeps the hairline separating them
  // crisp rather than letting the tint bleed through.
  assert.match(total[1], /bg-sdc-gray-50/);
});

test("DrillLines' own total row (the ungrouped case) is plain flow too", () => {
  const tfoot = /<tfoot className="([^"]*)"/.exec(DRILL);
  assert.ok(tfoot, "DrillLines' tfoot must carry a class list");
  assert.doesNotMatch(tfoot[1], /sticky|fixed|absolute/, "same defect, same fix, in the ungrouped table's own footer");
  // The thead stays sticky-TOP — that is the unrelated, non-overlapping "frozen header"
  // pattern (content already scrolled PAST hides under it, which is expected), and §75
  // only targets bottom-pinning.
  assert.match(DRILL, /<thead className="sticky top-0[^"]*">/, "the header stays pinned — only the footer was the bug");
});

test("an expanded group gets its full height — no vertical cap, no nested scroller", () => {
  // The other half of §75: a `max-h-[18rem] overflow-auto` on DrillGroup's own expansion
  // used to bound (and separately scroll) an open group's lines. That scroll position
  // moved independently of DRILL_BODY's, so scrolling THIS box never changed how far the
  // (then-sticky) Total had floated down — it just sat glued over whatever this box's own
  // scrollbar had brought into view. Removing the cap means the group's true height
  // becomes part of the ONE scroller's content, which is what "give each expanded group
  // enough dynamic height for all detail rows" asks for.
  const expansion = /\{open && \(([\s\S]*?)\)\}/.exec(DRILL.slice(DRILL.indexOf("function DrillGroup")));
  assert.ok(expansion, "DrillGroup's expansion must be present");
  assert.doesNotMatch(expansion[1], /max-h-\[18rem\]/, "no fixed height cap on an open group any more");
  assert.doesNotMatch(expansion[1], /overflow-y-auto|(?<!-x-)overflow-auto\b/, "no vertical scroll of its own — DRILL_BODY is the one scroller");
  // Horizontal overflow stays: a group's own lines can still be wider than the panel, and
  // this is what keeps THAT scrolling sideways on its own rather than the whole panel.
  assert.match(expansion[1], /overflow-x-auto/, "wide lines must still scroll sideways within the group, not the panel");
});

test("no drill nests a second fixed-height scroller inside its scrolling body", () => {
  // The two that did: HoursDetailPanel's flat punch list (24rem) and UndefinedHoursPanel's
  // (20rem). Both predate the ceiling, and both capped the ungrouped view shorter than the
  // rollup beside it once the panel itself started scrolling. DrillGroup's own 18rem cap
  // (the shared component, not a per-panel one) is covered by the test above instead — it
  // is gone rather than merely "not this pattern".
  for (const f of ["HoursDetailPanel.tsx", "UndefinedHoursPanel.tsx"]) {
    const body = code(join(SRC, "components", f));
    const offenders = body.match(/max-h-(?:80|\[24rem\])[^"`]*overflow-auto/g) ?? [];
    assert.deepEqual(offenders, [], `${f}: the panel body is the scroller — a nested cap fights it`);
  }
});

test("UndefinedHoursPanel keeps its Group tray, filters and meta line OUTSIDE the scrolling body", () => {
  // The one place §75 required a real layout change, not just removing a class: this
  // panel hand-rolls its own shell (it isn't DrillPanel — see its header note), and
  // until now its `DrillControls` (Group tray + filters) sat INSIDE the same scrolling
  // div as the table, so scrolling to an open group's rows scrolled the filters away too
  // — the opposite of "keep filters visible while the table body scrolls". DrillPanel
  // already got this right (controls sit above its `${DRILL_BODY}` div); this asserts
  // UndefinedHoursPanel now matches it.
  const body = code(join(SRC, "components", "UndefinedHoursPanel.tsx"));
  const controlsAt = body.indexOf("<DrillControls>");
  const scrollerAt = body.lastIndexOf("DRILL_BODY");
  assert.ok(controlsAt > 0 && scrollerAt > 0, "both the controls and the scrolling body must be present");
  assert.ok(controlsAt < scrollerAt, "DrillControls must appear before (outside) the scrolling DRILL_BODY div");
});

// ── No footer, no punch counts (§62) ────────────────────────────────────────
//
// §62 removed "Open full report" / "Export CSV" from every drill and every numeric
// row/group/expanded-detail count ("680 of 680 punches", "262 punches", "45 records") —
// while explicitly keeping Hours/dollar totals and the KPI reconciliation untouched.
// These guard the shared component so neither comes back through a future caller.

test("DrillPanel has no footer slot", () => {
  // The footer band and its two actions (DrillLink, DrillAction) were removed
  // entirely rather than left unused — a component built on this shared shell has
  // nowhere to reintroduce them without editing Drill.tsx itself.
  assert.doesNotMatch(DRILL, /footer\s*[:?]/, "DrillPanel must not accept a footer prop");
  assert.doesNotMatch(DRILL, /function DrillLink|function DrillAction/, "the footer-only exports must be gone");
});

test("no drill panel offers Open full report or Export CSV", () => {
  for (const f of DRILLS) {
    const body = code(f);
    assert.doesNotMatch(body, /Open full report/, `${f.replace(SRC, "src")}: §62 removed this link`);
    assert.doesNotMatch(body, /Export CSV/, `${f.replace(SRC, "src")}: §62 removed this action`);
  }
});

test("DrillGroup no longer takes a row/line count", () => {
  // The count prop rendered "262 punches" beside a group's name and fed the
  // expand/collapse tooltip ("Show the 262 punches behind this"). Both are gone —
  // removed from the component, not merely unused by every current caller, so a
  // future drill cannot pass one back in.
  assert.doesNotMatch(DRILL, /count\?:\s*string/, "DrillGroup's props must not include count");
  for (const f of DRILLS.slice(0, 2)) {
    assert.doesNotMatch(code(f), /count=\{/, `${f.replace(SRC, "src")}: must not pass a count into DrillGroup`);
  }
});

test("no drill states how many rows/punches/records are behind a group or the whole table", () => {
  // The specific shape this catches: a template-string count built from a `.length`
  // sitting next to the words punch(es)/record(s)/line(s) — "680 of 680 punches",
  // "3 groups by department", "45 correctly-excluded records". Hours and dollar
  // figures (fmtHours(...), usd(...)) are untouched by this pattern and must stay.
  const countLike = /\$\{[^}]*\.length[^}]*\}\s*(?:of\s*\{?[^}]*\.length|\s*(?:punch|record|line|group)es?\b)/i;
  for (const f of DRILLS.slice(0, 2)) {
    const body = code(f);
    assert.doesNotMatch(body, countLike, `${f.replace(SRC, "src")}: a row-count pattern survived §62`);
  }
});
