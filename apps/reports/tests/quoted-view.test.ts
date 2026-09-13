import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ACTUALS_PARAM, decodeParamList, encodeParamList, isActualsOn } from "../src/lib/quoted-display-prefs";

// ── The Projects grid's display params, and the one control over them (§47) ──
//
// This file used to be mostly about `isShowingAll`, which answered "is everything on
// screen?" for the "Show all / Reset" switch. That switch is gone: it set customers,
// types, statuses, billables and cols to everything, deleted `hide` and turned actuals
// on, all in one router.push — so "see the actual hours" also silently changed WHICH
// PROJECTS were listed, and cost a full server render of a grid that went from 50 rows
// to 233.
//
// What survives is the part that was never about that switch: the comma-escaping, which
// is a real data bug with real customer names behind it. Plus new guards on the one
// control that replaced two.

const SRC = join(import.meta.dirname, "..", "src");
const SWITCH = readFileSync(join(SRC, "components", "ProjectsShowActualsSwitch.tsx"), "utf8");
const PAGE = readFileSync(join(SRC, "app", "(app)", "quoted", "page.tsx"), "utf8");
const CSS = readFileSync(join(SRC, "app", "globals.css"), "utf8");

/** Comments stripped — these files' own notes quote the controls they replaced. */
function code(s: string): string {
  return s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

// ── The param (unchanged behaviour, still the source of truth) ───────────────

test("actuals is off unless the param says otherwise", () => {
  const p = new URLSearchParams();
  assert.equal(isActualsOn(p), false, "absent = off, which is the page's default");
  p.set(ACTUALS_PARAM, "0");
  assert.equal(isActualsOn(p), false);
  p.set(ACTUALS_PARAM, "yes");
  assert.equal(isActualsOn(p), false, 'only "1" turns it on');
  p.set(ACTUALS_PARAM, "1");
  assert.equal(isActualsOn(p), true);
});

// ── Comma-bearing customer names (the bug worth keeping) ────────────────────
//
// 16 of 88 customer names contain a comma — "FIRST SOLAR, INC.", "Alcon Research, LTD",
// "Tarkett USA, Inc." — so a raw join(",") is ambiguous: the page split it back and got
// "FIRST SOLAR" + " INC.", which match no job, and those customers' rows silently
// vanished from the grid.

const COMMA_NAMES = ["FIRST SOLAR, INC.", "Alcon Research, LTD", "Tarkett USA, Inc.", "Plain Name"];

test("a comma inside a value survives the round trip", () => {
  assert.deepEqual(decodeParamList(encodeParamList(COMMA_NAMES)), COMMA_NAMES);
});

test("a literal percent survives too, so the escape is reversible", () => {
  // Sequential replaces would turn a name containing a literal "%2C" into a comma; the
  // decoder is one pass over both tokens for exactly this case.
  const tricky = ["100%", "Weird %2C Name", "%25 Off, Ltd"];
  assert.deepEqual(decodeParamList(encodeParamList(tricky)), tricky);
});

test("the round trip survives URLSearchParams re-encoding", () => {
  const p = new URLSearchParams();
  p.set("customers", encodeParamList(COMMA_NAMES));
  const reparsed = new URLSearchParams(p.toString());
  assert.deepEqual(decodeParamList(reparsed.get("customers")), COMMA_NAMES);
});

test('an empty or absent param is an empty list, not [""]', () => {
  assert.deepEqual(decodeParamList(null), []);
  assert.deepEqual(decodeParamList(""), []);
});

// ── One control, and it changes nothing but the values (§47.1–47.4) ──────────

test("the switch is named Show Actuals and is still a switch", () => {
  assert.match(SWITCH, />Show Actuals</, "§47.1: the label");
  assert.match(SWITCH, /aria-pressed=\{on\}/, "§47.2: switch-style, and it reports its state");
  // The track + knob is what makes it read as a switch rather than another toolbar pill.
  assert.match(SWITCH, /rounded-full/);
  assert.match(SWITCH, /translate-x-\[10px\]/, "the knob must move");
});

test("the switch never navigates (§47.6)", () => {
  const body = code(SWITCH);
  assert.doesNotMatch(body, /router\.(push|replace|refresh)/, "a display toggle must not re-render the route");
  assert.doesNotMatch(body, /useRouter/, "…so it should not even hold a router");
  assert.match(body, /history\.replaceState/, "the URL is kept truthful without a navigation");
  // replaceState, not pushState: forty flips must not become forty Back presses.
  assert.doesNotMatch(body, /history\.pushState/);
});

test("the switch touches only the actuals param — never the scope (§47.3)", () => {
  const body = code(SWITCH);
  // The old switch wrote all of these on its way to turning actuals on, which is how
  // "show me the actual hours" quietly became "and also show 183 more projects".
  for (const scope of ["customers", "types", "statuses", "billables", "cols", "hide"]) {
    assert.ok(!body.includes(`"${scope}"`), `the switch must not write the ${scope} param`);
  }
  assert.match(body, /qs\.set\(ACTUALS_PARAM/);
  assert.match(body, /qs\.delete\(ACTUALS_PARAM\)/);
});

test("the switch takes no props, so it cannot smuggle scope in", () => {
  assert.match(SWITCH, /export function ProjectsShowActualsSwitch\(\)/);
  assert.match(PAGE, /<ProjectsShowActualsSwitch \/>/);
});

test("the Display menu and the old switch are gone (§47.4, criteria 7-9)", () => {
  for (const gone of ["ProjectsDisplayMenu.tsx", "ProjectsShowAllSwitch.tsx"]) {
    assert.equal(existsSync(join(SRC, "components", gone)), false, `${gone} must be deleted`);
  }
  const page = code(PAGE);
  assert.ok(!page.includes("ProjectsDisplayMenu"), "the page must not render the Display menu");
  assert.ok(!page.includes("ProjectsShowAllSwitch"));
  assert.ok(!page.includes("Actual hours in cells"), "§47.4: the checkbox is removed");
});

test("exactly one CONTROL over the mode, and one legacy restorer", () => {
  // Criterion 9: "no duplicate quoted/actual toggle remains elsewhere."
  //
  // ProjectViewsMenu is allowed and is not a duplicate: it restores whatever a SAVED VIEW
  // stored, for views published before `actuals` moved from a ViewConfig field into the
  // query string. It offers the user no choice about the mode — it replays one. Dropping
  // it would silently change what those saved views show.
  const allowed = [
    join("src", "components", "ProjectsShowActualsSwitch.tsx"),
    join("src", "components", "ProjectViewsMenu.tsx"),
  ];
  const writers = walk(SRC).filter((f) => {
    const body = code(readFileSync(f, "utf8"));
    return /(set|delete)\(ACTUALS_PARAM/.test(body) || /set\("actuals"/.test(body);
  });
  assert.deepEqual(writers.map((f) => f.replace(SRC, "src")).sort(), allowed.sort());
  // And only ONE of them is a control: the other must not render a toggle for it.
  const views = code(readFileSync(join(SRC, "components", "ProjectViewsMenu.tsx"), "utf8"));
  assert.ok(!/Show Actuals|Actual hours in cells/.test(views), "the views menu must not offer the mode itself");
});

test("nothing references the retired helpers", () => {
  const offenders = walk(SRC)
    .filter((f) => /isShowingAll|QUOTED_VIEW_PARAMS|ShowAllOptions/.test(code(readFileSync(f, "utf8"))))
    .map((f) => f.replace(SRC, "src"));
  assert.deepEqual(offenders, [], "§47.4 asks for the dead code to go, not just the button");
});

// ── ON shows quoted / actual, both (§50) ─────────────────────────────────────
//
// This reverses §47.2, which read "replace the quoted-hours values … with actual-hours
// values" and hid the quoted half. Over/under is a comparison, and a cell showing 2,352
// alone does not make it — you have to remember the figure you saw a click ago.

test("ON shows both halves — nothing hides the quoted value", () => {
  // The failure this catches is the §47.2 rules coming back, in any of their three parts.
  // They were DELETED rather than inverted, so the assertion is on their absence: ON is
  // simply the base layout, and `.hide-actuals` is the only state with rules of its own.
  // Declarations only. The note above the rules names the three selectors it deleted, and
  // matching prose would have this test failing on its own explanation — it did, first run.
  const decls = code(CSS);
  const onRules = decls.match(/table\[data-grid="projects"\]:not\(\.hide-actuals\)[^{]*\{[^}]*\}/g) ?? [];
  const hiders = onRules.filter((r) => /display:\s*none/.test(r));
  assert.deepEqual(hiders, [], "ON must not hide anything — the pair is the point");
  for (const gone of ["input\\[type=\"number\"\\]", "\\[data-total-quoted\\]", "\\.actual-sep"]) {
    const re = new RegExp(`:not\\(\\.hide-actuals\\)[^{]*${gone}`);
    assert.ok(!re.test(decls), `${gone} must not be hidden while actuals are on`);
  }
});

test("the pair shares one column — no duplicate actual columns", () => {
  // §47's other constraint, and the one that still holds: "do not add duplicate
  // actual-hours columns". The actual rides inside the section cell as a suffix, so the
  // grid's column count is identical in both states. A second <td> per section would
  // break the phase header colSpans as well as the requirement.
  assert.match(PAGE, /className="actual-suffix/, "the actual lives inside the quoted cell");
  const cells = [...PAGE.matchAll(/className=\{`qc quoted-actual-cell/g)];
  assert.equal(cells.length, 1, `one section-cell shape, found ${cells.length}`);
});

test("the separator is an element, so the OFF state can hide it with the actual", () => {
  // A bare "/" text node cannot be hidden — only an element can. Nothing hides the
  // separator on its own since §50, but `.hide-actuals` still hides the whole suffix it
  // sits inside, and a separator stranded beside a missing figure is the bug this shape
  // prevents. Both cell shapes carry it: the per-section cell and the ENG/SHOP total.
  const seps = [...PAGE.matchAll(/className="actual-sep"/g)];
  assert.equal(seps.length, 2, `both cell shapes need it, found ${seps.length}`);
});

test("OFF is still the default, and still hides the actuals", () => {
  assert.match(CSS, /\.hide-actuals \.actual-suffix\s*\{\s*display:\s*none/);
  // Server-rendered on the first paint from the same param the switch owns, so the grid
  // arrives in the right state rather than painting one and correcting it a frame later.
  assert.match(PAGE, /showActuals \? "" : "hide-actuals"/);
});

test("the quoted input is hidden, not removed — the dirty tracker reads it", () => {
  // `display: none` rather than conditional markup: the input carries `data-baseline` and
  // its `name`, which ProjectsAutosave and the dirty tracker read. Dropping it from the
  // DOM in actuals mode would make the grid think every edit had been reverted.
  assert.match(PAGE, /data-baseline=/, "the baseline attribute must still be rendered");
  assert.ok(!code(PAGE).includes("showActuals ? null :"), "the cell markup must not branch on the mode");
});

test("the switch does not touch editability", () => {
  // The grid is read-only until Edit Mode is deliberately turned on, with the real
  // enforcement server-side (projects-edit-mode.ts). Show Actuals changes which figure a
  // cell shows, never whether a cell can be typed into — in either state.
  const body = code(SWITCH);
  for (const editish of ["EditMode", "readOnly", "disabled", "projects-edit"]) {
    assert.ok(!body.includes(editish), `the switch must not reach for ${editish}`);
  }
});
