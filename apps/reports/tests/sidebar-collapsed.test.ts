import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COLLAPSED_COOKIE,
  COLLAPSED_WIDTH,
  DEFAULT_PREFS,
  DEFAULT_WIDTH,
  MAX_WIDTH,
  MIN_WIDTH,
  WIDTH_COOKIE,
  clampWidth,
  parseSidebarPrefs,
  sidebarWidthCss,
} from "../src/lib/sidebar-prefs";

// ── The collapsed sidebar (§46) ─────────────────────────────────────────────
//
// §46 was reported from a screenshot: controls clipped, labels overlapping, bottom
// items half-visible. The audit found nine distinct defects, and these tests guard the
// four that a later edit would reintroduce silently — the ones whose symptom is a
// rendering fault rather than an error:
//
//   1. `flex-1` on a footer control. In the collapsed `flex-col` it becomes
//      `flex-basis: 0`, which beats `h-[30px]` on the main axis — Refresh Data and the
//      collapse toggle rendered 14px tall with the label clipped to "Refresh Dat".
//   2. The state living anywhere the server cannot read. localStorage made every page
//      load paint the expanded sidebar and snap to the rail after hydration.
//   3. A label REMOVED rather than hidden, which takes the control's accessible name
//      with it and leaves `title` as the only source.
//   4. The rail's background spelled as an arbitrary colour, which quietly opted the
//      whole sidebar out of the app's high-contrast focus ring.

const SRC = join(import.meta.dirname, "..", "src");
const SIDEBAR = readFileSync(join(SRC, "components", "Sidebar.tsx"), "utf8");
const SHELL = readFileSync(join(SRC, "components", "AppShell.tsx"), "utf8");
const LAYOUT = readFileSync(join(SRC, "app", "(app)", "layout.tsx"), "utf8");
const REFRESH = readFileSync(join(SRC, "components", "RefreshDataButton.tsx"), "utf8");
const CSS = readFileSync(join(SRC, "app", "globals.css"), "utf8");

/** Comments stripped: several of them quote the classes and units they replaced. */
function code(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");
}
const SIDEBAR_CODE = code(SIDEBAR);

// ── One width, one source (§46.1) ───────────────────────────────────────────

test("the collapsed width is a token, stated once", () => {
  // It used to be a `w-16` class on the aside AND an inline width when expanded — two
  // places to say how wide the rail is, and the server reserved a third value. The token
  // is what the aside, the server's --sidebar-w and this test all read.
  assert.equal(COLLAPSED_WIDTH, "4rem", "60px at the 15px root — the rail's measured width");
  assert.match(SIDEBAR_CODE, /COLLAPSED_WIDTH/, "the aside must size itself from the token");
  assert.doesNotMatch(SIDEBAR_CODE, /\bw-16\b/, "no second statement of the rail's width");
});

test("the shared layout variable is published and kept in step", () => {
  // §46.9. The offset itself is structural — the aside is shrink-0 and main is flex-1 —
  // but the variable has to exist and, more importantly, must not go stale: it is
  // rendered from the SERVER's value, so a client-side collapse has to update it or it
  // reports the expanded width forever.
  assert.match(SHELL, /--sidebar-w/, "AppShell must publish --sidebar-w");
  assert.match(SHELL, /data-app-shell/, "…and mark the element so the client can update it");
  assert.match(SIDEBAR_CODE, /data-app-shell/, "Sidebar must update it on toggle");
  assert.match(SIDEBAR_CODE, /setProperty\("--sidebar-w"/, "…by writing the same variable");
  // Both writers must derive it from one formula, or they can disagree.
  assert.match(SHELL, /sidebarWidthCss\(/);
  assert.match(SIDEBAR_CODE, /sidebarWidthCss\(/);
});

test("width preferences are clamped, and the defaults agree", () => {
  assert.equal(clampWidth(NaN), DEFAULT_WIDTH);
  assert.equal(clampWidth(10), MIN_WIDTH);
  assert.equal(clampWidth(9999), MAX_WIDTH);
  assert.equal(clampWidth(300), 300);
  assert.deepEqual(DEFAULT_PREFS, { collapsed: false, width: DEFAULT_WIDTH });
});

test("the width the layout reserves follows the collapse flag", () => {
  assert.equal(sidebarWidthCss({ collapsed: true, width: 400 }), COLLAPSED_WIDTH, "collapsed wins over the stored width");
  assert.equal(sidebarWidthCss({ collapsed: false, width: 300 }), "300px");
  assert.equal(sidebarWidthCss({ collapsed: false, width: 9999 }), `${MAX_WIDTH}px`, "clamped here too");
});

// ── No flash on load (§46.14) ───────────────────────────────────────────────

test("the collapse state is read on the SERVER, from cookies", () => {
  // The measurement that forced this: with the flag set, a request for /etc returned
  // `<aside style="width:276px">` with every label, the search field and the version
  // string — then hydration snapped it to a 60px rail. One flash per page load.
  // localStorage cannot fix that, because the server cannot see it.
  assert.match(LAYOUT, /cookies\(\)/, "the (app) layout must read cookies");
  assert.match(LAYOUT, /parseSidebarPrefs/, "…through the shared parser");
  assert.match(LAYOUT, /sidebar=\{sidebar\}/, "…and hand the result to AppShell");
  assert.match(SIDEBAR_CODE, /initial\.collapsed/, "which becomes the store's server snapshot");
  assert.match(SIDEBAR_CODE, /initial\.width/);
});

test("nothing keeps a second copy of the sidebar state in localStorage", () => {
  // Two sources would drift, and the one the server cannot read would win on the client
  // — reintroducing the flash while the cookie looked correct.
  assert.doesNotMatch(SIDEBAR_CODE, /localStorage/, "the cookie is the only source");
  const prefs = readFileSync(join(SRC, "lib", "sidebar-prefs.ts"), "utf8");
  assert.doesNotMatch(code(prefs), /localStorage/);
});

test("parsing is identical on both sides, and tolerates rubbish", () => {
  // One parser for `cookies()` and for `document.cookie`. If they disagreed, the value
  // React hydrated with would differ from the value the server painted — the very flash
  // this removes.
  assert.deepEqual(parseSidebarPrefs("1", "300"), { collapsed: true, width: 300 });
  assert.deepEqual(parseSidebarPrefs("0", null), { collapsed: false, width: DEFAULT_WIDTH });
  assert.deepEqual(parseSidebarPrefs(undefined, ""), { collapsed: false, width: DEFAULT_WIDTH });
  assert.deepEqual(parseSidebarPrefs("yes", "abc"), { collapsed: false, width: DEFAULT_WIDTH }, "only \"1\" collapses");
  assert.deepEqual(parseSidebarPrefs("1", "99999"), { collapsed: true, width: MAX_WIDTH }, "a hand-edited width is clamped");
  assert.equal(COLLAPSED_COOKIE, "sdc-sidebar-collapsed");
  assert.equal(WIDTH_COOKIE, "sdc-sidebar-width");
});

// ── The clipping, and its actual cause (§46.3, §46.4, §46.11) ───────────────

test("no footer control carries flex-1 unconditionally", () => {
  // THE bug behind the screenshot. `flex-1` is `flex: 1 1 0%`; in the collapsed
  // `flex-col` that flex-basis beats `h-[30px]` on the main axis, so both 30px buttons
  // rendered 14px tall. Measured before the fix: Refresh h=14, Expand h=14. After:
  // h=30 for both.
  //
  // The rule is not "never use flex-1" — expanded, the two share a row and need it. It
  // is that the class must be conditional on NOT being collapsed.
  // From the JSX usage, not the import at the top of the file — the expanded search
  // field above it has its own legitimate horizontal `flex-1`.
  const footer = SIDEBAR_CODE.slice(SIDEBAR_CODE.lastIndexOf("<RefreshDataButton"));
  const flexOnes = [...footer.matchAll(/flex-1/g)];
  assert.ok(flexOnes.length > 0, "expanded still wants it, so this test should have something to check");
  for (const m of flexOnes) {
    // Each occurrence must sit inside a `collapsed ? … : …` arm — i.e. the 120 characters
    // before it mention `collapsed`.
    const before = footer.slice(Math.max(0, m.index - 120), m.index);
    assert.match(before, /collapsed/, `flex-1 at ${m.index} must be conditional on the collapsed state`);
  }
});

test("the footer refuses to shrink", () => {
  // The other half: the aside is a fixed-height column with a `flex-1` nav, so without
  // `shrink-0` the footer gives up its own height when the nav is tall — bottom controls
  // pushed past the viewport, which is §46.5's "do not allow items to extend beyond the
  // viewport".
  const footerStart = SIDEBAR_CODE.indexOf("<AppZoom");
  const openingTag = SIDEBAR_CODE.lastIndexOf("<div", footerStart);
  assert.match(SIDEBAR_CODE.slice(openingTag, footerStart), /shrink-0/, "the footer block must be shrink-0");
});

test("the rail's scroll area cannot steal the centring", () => {
  // Measured at 150% zoom on an 820px viewport: the nav's scrollbar took 10px out of the
  // content box (offsetWidth 59, clientWidth 49), so every nav icon sat 5px left of
  // centre while the footer icons stayed centred. Two visibly misaligned columns, and
  // only when the rail happened to overflow.
  assert.match(CSS, /\.rail-scroll\s*\{[^}]*scrollbar-width:\s*none/, "the rail hides its scrollbar");
  assert.match(CSS, /\.rail-scroll::-webkit-scrollbar\s*\{[^}]*width:\s*0/);
  assert.match(SIDEBAR_CODE, /rail-scroll/, "…and the collapsed nav must use it");
  // It must stay scrollable — hiding the bar is not hiding the overflow (§46.5).
  assert.match(SIDEBAR_CODE, /overflow-y-auto/);
});

test("Refresh Data is an icon in the rail, not its own label", () => {
  // It used to render the words "Refresh Data" when compact: a 73px span in a 59px
  // button, clipped by the button's own overflow-hidden to "Refresh Dat" — the clipped
  // label §46.2 names.
  const refreshCode = code(REFRESH);
  assert.match(refreshCode, /compact && !running/, "compact must have its own icon branch");
  assert.match(refreshCode, /<svg[\s\S]{0,400}?M13\.5 8 A5\.5/, "…drawing a refresh glyph");
  // And the label must survive as the accessible name rather than being dropped.
  assert.match(refreshCode, /compact \? "sr-only"/, "the label is hidden, not removed");
  assert.match(refreshCode, /title=\{[\s\S]{0,200}?Refresh Data —/, "§46.3 asks for a tooltip labelled Refresh Data");
});

// ── Hidden, never removed (§46.2, §46.15) ───────────────────────────────────

test("every collapsed label is hidden with sr-only rather than unmounted", () => {
  // §46.15: "do not remove navigation labels from screen readers when visually hiding
  // them". Unmounting a label takes the link's accessible name with it and leaves
  // `title` as the only source, which the same clause forbids.
  //
  // Guarded structurally: a `{!collapsed && …}` around a label is the pattern that was
  // there, so what this checks is that the labels now go through the collapsed ? sr-only
  // ternary instead.
  for (const label of [
    /collapsed \? "sr-only" : "truncate"\}>\{item\.label\}/, // nav links
    /collapsed \? "sr-only" : ""\}>Back</, // the Back button
    /collapsed \? "sr-only" : ""\}>\{collapsed \? "Expand sidebar"/, // the toggle
    /collapsed \? "sr-only" : ""\}>Sign out</, // sign out
  ]) {
    assert.match(SIDEBAR_CODE, label, `a label still disappears instead of being hidden: ${label}`);
  }
  // The group headings, the wordmark and the version string too.
  assert.match(SIDEBAR_CODE, /collapsed\s*\?\s*"sr-only"\s*:\s*"min-w-0"/, "the wordmark");
  assert.ok(
    (SIDEBAR_CODE.match(/"sr-only"/g) ?? []).length >= 7,
    "every label that disappears in the rail should be hidden instead",
  );
});

test("sign out is reachable from the rail", () => {
  // It was not: the email and the Sign out button were both inside a `{!collapsed && …}`,
  // so there was no way to sign out without expanding the sidebar first (§46.5 lists it
  // among the controls that must remain available).
  const accountStart = SIDEBAR_CODE.indexOf("signOutAction}");
  assert.ok(accountStart > 0, "the sign-out form must exist");
  const account = SIDEBAR_CODE.slice(accountStart - 400, accountStart + 900);
  assert.doesNotMatch(account, /\{!collapsed && \(/, "the account row must not be expanded-only");
  assert.match(account, /title=\{collapsed \? "Sign out"/, "…and must be labelled in the rail");
});

// ── The current page, announced (§46.7, §46.15) ─────────────────────────────

test("the active link says so, not just in colour", () => {
  // aria-current was missing app-wide. In the rail the label is not visible either, so
  // there was no non-visual way at all to tell which page you were on.
  assert.match(SIDEBAR_CODE, /aria-current=\{active \? "page" : undefined\}/);
  // The accent bar is a 2px strip on the item's left edge; when the item was 32px wide in
  // a 60px rail it floated mid-rail pointing at nothing. §46.7 wants ONE compact
  // highlight, so the bar is expanded-only and the tinted pill is the rail's indicator.
  assert.match(SIDEBAR_CODE, /active && !collapsed/, "the accent bar must not be drawn in the rail");
});

test("the collapse toggle reports the state it controls", () => {
  assert.match(SIDEBAR_CODE, /aria-expanded=\{!collapsed\}/);
  assert.match(SIDEBAR_CODE, /aria-controls=\{SIDEBAR_ID\}/);
  assert.match(SIDEBAR_CODE, /id=\{SIDEBAR_ID\}/, "…and the thing it names must exist");
  assert.match(SIDEBAR_CODE, /"Expand sidebar"/, "§46.4 asks for these exact labels");
  assert.match(SIDEBAR_CODE, /"Collapse sidebar"/);
});

// ── Focus, on a navy panel (§46.15) ─────────────────────────────────────────

test("the rail uses the navy TOKEN, so the high-contrast focus ring applies", () => {
  // The app's default focus ring is --sdc-blue, which on this panel is blue on navy.
  // globals.css already carries a white override for navy surfaces — and it had never
  // applied to the sidebar, because the sidebar spelled its background as the arbitrary
  // value `bg-[#061D39]` instead of the token that is the same colour. Confirmed in the
  // running app: `aside.closest('.bg-sdc-navy')` was null; afterwards the focused link's
  // outline is solid 2px white.
  assert.match(SIDEBAR_CODE, /\bbg-sdc-navy\b/, "the aside must carry the token class");
  assert.doesNotMatch(SIDEBAR_CODE, /bg-\[#061D39\]/i, "…not an arbitrary copy of it");
  assert.match(CSS, /--sdc-navy:\s*#061d39/i, "the token must still be that colour");
  assert.match(CSS, /\.bg-sdc-navy\s+:focus-visible[^{]*\{[^}]*outline-color:\s*#ffffff/i, "the override must exist");
});

// ── The transition (§46.10) ─────────────────────────────────────────────────

test("only the width animates, once, at a short duration", () => {
  // §46.10 wants the sidebar and the content offset to move together. They do by
  // construction — main is flex-1 off the aside's width, so there is one animation and
  // the content cannot lag it. Verified frame by frame in the running app: 276 -> 178 ->
  // 80 -> 60 with the gap between the aside's right edge and main's left edge at 0 on
  // every intermediate frame.
  assert.match(CSS, /\.motion-panel-size\s*\{[^}]*transition-property:\s*width/, "width only — not `all`");
  assert.match(CSS, /\.motion-panel-size\s*\{[^}]*transition-duration:\s*var\(--motion-panel\)/);
  assert.match(CSS, /--motion-panel:\s*200ms/, "§46.10 asks for a short transition");
  // Suppressed while dragging the resize handle, or the drag lags the pointer.
  assert.match(SIDEBAR_CODE, /dragWidth === null \? "motion-panel-size" : ""/);
});
