import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── The visible ⋮ menu, and the one thing that must not erode ───────────────
//
// Requested 2026-09-04: "Do not rely on right-click… Most users will never discover
// that interaction", and — the part these tests exist for — "Use the exact same
// centralized actions for both entry points. Do not create separate sidebar-specific
// tab logic."
//
// That second instruction is not stylistic. Before this change three different pieces
// of code decided what opening a tab meant: an inline openTab + applyWorkspace in
// Sidebar's onClick, two href builders in useSplitNav that navigated instead, and the
// tab strip's own calls. Only one of them knew about the live workspace, which is why
// "clicking a sidebar page does not reliably switch to its open tab" was a bug at all.
// A fourth caller — this menu — is exactly how that comes back, so the guard is that
// the sidebar owns no tab logic whatsoever.

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

/** Source with comments stripped: a rule quoted in a comment is not a use of it. */
const code = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SIDEBAR = code(read("src", "components", "Sidebar.tsx"));
const MENU = code(read("src", "components", "NavItemMenu.tsx"));
const ACTIONS = code(read("src", "components", "useWorkspaceActions.ts"));
const SPLITNAV = code(read("src", "components", "useSplitNav.ts"));

// ── The four centralized actions ───────────────────────────────────────────

test("the four requested actions exist, by name", () => {
  // Named exactly as asked so the request and the code can be read against each other.
  for (const fn of ["openExistingTab", "openNewTab", "openInSplitView", "duplicateTab"]) {
    assert.match(ACTIONS, new RegExp(`const ${fn} = useCallback`), `${fn} is missing`);
    assert.match(ACTIONS, new RegExp(`^    ${fn},$`, "m"), `${fn} is not returned`);
  }
});

test("the sidebar decides nothing about tabs itself", () => {
  // The specific regression: any of these appearing in Sidebar means a second answer to
  // "what does opening a tab do" has grown back beside useWorkspaceActions.
  const forbidden = ["openTab(", "applyWorkspace(", "enterSplit(", "duplicateTab(ws", "mostRecentInstance("];
  const found = forbidden.filter((f) => SIDEBAR.includes(f));
  assert.deepEqual(found, [], `Sidebar reimplements tab logic: ${found.join(", ")} — call the actions instead`);
});

test("every sidebar entry point calls the actions", () => {
  for (const call of [
    "tabs.openExistingTab(item.href)",
    "tabs.openNewTab(item.href)",
    "tabs.openNewTab(navMenu.href)",
    "tabs.openInSplitView(navMenu.href",
    "tabs.duplicateTab(id)",
  ]) {
    assert.ok(SIDEBAR.includes(call), `the sidebar should reach the action as ${call}`);
  }
});

test("the href builders the actions replaced are gone", () => {
  // Keeping them would leave a second way to express "open a new tab" — one that
  // navigates and cannot see the live workspace, which is where the original bug was.
  for (const dead of ["newTabHrefFor", "splitHrefFor"]) {
    assert.ok(!SPLITNAV.includes(dead), `${dead} still exists; nothing should be able to reach it`);
  }
  // What useSplitNav still owes the sidebar: the plain href for the markup, and refusals.
  assert.ok(SPLITNAV.includes("hrefFor"), "the <Link> still needs a static href");
});

// ── Discoverability: the point of the request ──────────────────────────────

test("the menu is rendered by the button AND by right-click, and it is the same component", () => {
  // Two entry points, one component — so they cannot present different options.
  assert.ok(SIDEBAR.includes("<NavItemMenuButton"), "the visible ⋮ button must be on the row");
  assert.ok(SIDEBAR.includes("onContextMenu"), "right-click stays as an optional shortcut");
  assert.equal(
    (SIDEBAR.match(/<NavItemMenu\b/g) ?? []).length,
    1,
    "there must be exactly one menu render site, shared by both entry points",
  );
});

test("the button is a sibling of the link, not inside it", () => {
  // A <button> nested in an <a> is invalid markup and its click would activate the link
  // on the way past — which is the "not trigger normal sidebar navigation" requirement.
  const linkStart = SIDEBAR.indexOf("<Link");
  const linkEnd = SIDEBAR.indexOf("</Link>", linkStart);
  const insideLink = SIDEBAR.slice(linkStart, linkEnd);
  assert.ok(!insideLink.includes("NavItemMenuButton"), "the ⋮ button must not be inside the <Link>");
  assert.ok(SIDEBAR.indexOf("<NavItemMenuButton") > linkEnd, "it should follow the link in the row");
  // And it must stop the gesture reaching the row.
  assert.match(MENU, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);/);
});

test("the button carries the asked-for tooltip and the right ARIA", () => {
  assert.match(MENU, /title="More options"/);
  assert.match(MENU, /aria-haspopup="menu"/);
  assert.match(MENU, /aria-expanded=\{open\}/);
  assert.match(MENU, /aria-label=\{`More options for \$\{label\}`\}/);
});

test("it is offered for pages that support tabs, and only those", () => {
  // "Appear consistently for pages that support tabs" — which is exactly the set the
  // workspace can host, so the flag comes from the actions rather than a second list.
  assert.match(SIDEBAR, /const hostable = tabs\.canHost\(item\.href\)/);
  assert.match(SIDEBAR, /\{hostable && !collapsed && \(/);
  // Right-click is gated on the same flag, so the two entry points agree about which
  // rows have options at all.
  assert.match(SIDEBAR, /if \(!hostable\) return;/);
});

// ── The menu's own contents ────────────────────────────────────────────────

test("the menu offers the two required entries", () => {
  assert.ok(MENU.includes("Open in new tab"));
  assert.ok(MENU.includes("Open in Split View"));
});

test("Duplicate is offered only when an instance is already open", () => {
  // The request's own condition. `duplicable` is null when nothing is open, so the
  // entry is absent rather than present-and-disabled.
  assert.match(MENU, /\{duplicable && !refusesSecondInstance && \(/);
  assert.ok(MENU.includes("Duplicate current tab"));
  assert.match(ACTIONS, /const duplicableInstance = useCallback/);
});

test("Split View asks which instance only when there is a choice to make", () => {
  // "If multiple instances exist, allow the user to select one or create a new
  // instance." One instance needs no question; none means it just opens one.
  assert.match(MENU, /const choosable = instances\.length > 1/);
  assert.match(MENU, /choosable \? setStep\("split"\) : run\(\(\) => onOpenInSplitView\(\)\)/);
  assert.ok(MENU.includes("Open a new instance"), "the picker must offer a fresh instance too");
});

test("Split View keeps the tab you were working in on one side", () => {
  // The anchor is the sidebar's target (the active tab), and it stays active so it is
  // the left pane — "keep the current active tab on one side".
  assert.match(ACTIONS, /const anchor = sidebarTarget\(workspace\)/);
  assert.match(ACTIONS, /enterSplit\(\{ \.\.\.next, active: anchor \}, target\)/);
  assert.match(ACTIONS, /if \(target === anchor\) return false/, "a tab cannot be split against itself");
});

test("with no workspace at all, Split View just opens the page", () => {
  // "If there is no active tab, simply open the requested page normally."
  assert.match(ACTIONS, /if \(!canHost\(pathname\) \|\| pairingRefusal\(path, pathname\)\)[\s\S]{0,120}router\.push\(path\)/);
});

// ── Keyboard and dismissal ────────────────────────────────────────────────

test("the menu is keyboard navigable and closes the way the request asked", () => {
  assert.match(MENU, /e\.key === "Escape"/, "Esc must close it");
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
    assert.ok(MENU.includes(`"${key}"`), `${key} should move between entries`);
  }
  assert.match(MENU, /window\.addEventListener\("pointerdown", onDown, true\)/, "clicking elsewhere must close it");
  // Focus moves into the menu on open, or the arrow keys have nothing to move from.
  assert.match(MENU, /\[role='menuitem'\]:not\(\[aria-disabled='true'\]\)"\)\?\.focus\(\)/);
});

test("Esc backs out of the instance picker rather than closing the whole menu", () => {
  assert.match(MENU, /if \(step === "split"\) setStep\("root"\);\s*else onClose\(\)/);
});

test("a refused entry stays readable instead of being an unexplained dead row", () => {
  // A disabled <button> is skipped by the arrow walk and unreachable by Tab, so the
  // reason on it could never be read. This renders a span that keeps its place.
  assert.match(MENU, /aria-disabled="true"/);
  assert.match(MENU, /role="menuitem"\s*\n\s*aria-disabled="true"/);
});
