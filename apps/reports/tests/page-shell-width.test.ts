import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PAGE_SHELL } from "../src/components/ui/classnames";

// ── Every tab fills its workspace (2026-09-01) ──────────────────────────────
//
// Reported as "at 110% zoom the dashboard leaves a ~300px blank column on the
// right". The zoom control was not at fault — CSS `zoom` scales lengths and
// participates in layout, so a width:100% container fills the viewport at every
// level. The cause was `max-w-[1800px]` on the Dashboard wrapper (and
// `max-w-[1440px]` on Jobs): on a workspace wider than the cap, content stopped
// and the rest stayed white.
//
// Everything inside was already fluid, which is why one class could hold the
// whole page back. These tests keep that class from coming back, on any tab.

const APP = join(process.cwd(), "src", "app", "(app)");

/**
 * Pages that are deliberately NOT full-width, with the reason.
 *
 * jobs/[id] and jobs/new are a record detail page and a create form — single
 * columns of fields, not data tabs. A form stretched across an ultrawide monitor
 * is harder to read, not easier, so they keep their own centred `max-w-5xl`.
 * That is a typographic measure, not the layout ceiling this file exists to
 * prevent. Compared with forward slashes so the check behaves the same on
 * Windows.
 *
 * split/page.tsx renders no page content of its own (2026-09-03): it decodes the
 * URL and hands two PANES to SplitViewShell, and each pane renders one of the
 * twelve real views — every one of which applies PAGE_SHELL itself, inside its own
 * pane. So the rule this file enforces is satisfied twice over per render, just one
 * level down from where the scan looks. Applying PAGE_SHELL here as well would add
 * a second set of page padding around a pair of already-padded pages, and its width
 * cap would be measured against the whole workspace rather than against the pane
 * the content actually lives in.
 */
// `split` and `w` host OTHER pages' views rather than having a body of their own, so
// PAGE_SHELL is applied by each view inside them — one gutter, from the page that owns
// the content. Putting it on the host as well would double every pane's padding.
const EXEMPT_PAGES = ["jobs/[id]/page.tsx", "jobs/new/page.tsx", "split/page.tsx", "w/page.tsx"];

const isExempt = (file: string) => EXEMPT_PAGES.some((e) => file.split("\\").join("/").endsWith(e));

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...pageFiles(full));
    else if (entry === "page.tsx") out.push(full);
  }
  return out;
}

/** The wrapper is the first className on the element the page returns. */
function outerWrapperClasses(source: string): string | null {
  const m = source.match(/return\s*\(\s*\n?\s*<(?:div|main|section|form|[A-Z][\w]*)[^>]*?className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([A-Za-z_][\w]*)\})/);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

test("PAGE_SHELL itself imposes no width ceiling", () => {
  assert.ok(PAGE_SHELL.includes("w-full"), "must take the full width of <main>");
  assert.ok(PAGE_SHELL.includes("min-w-0"), "must not let a wide child force a page-level scrollbar");
  assert.ok(!/max-w-/.test(PAGE_SHELL), "a ceiling here would cap every tab at once — this is the bug");
});

test("PAGE_SHELL keeps a real gutter, not a flush edge", () => {
  // "Preserve intentional padding": the ask was to remove hundreds of blank
  // pixels, not the page margin. 24px, 32px from md up.
  assert.ok(/\bpx-6\b/.test(PAGE_SHELL) && /\bmd:px-8\b/.test(PAGE_SHELL), PAGE_SHELL);
  assert.ok(/\bpy-6\b/.test(PAGE_SHELL) && /\bmd:py-7\b/.test(PAGE_SHELL), PAGE_SHELL);
});

test("no tab's outer wrapper caps its width", () => {
  // Two complementary checks, because the wrapper regex below cannot parse every
  // page (5 of 17 open with a component or a multi-line expression rather than a
  // plain <div className="...">). Relying on it alone would have been a guard
  // that silently skipped a third of the app.
  //
  //   (a) where the wrapper IS parsed, it must carry no max-w-*
  //   (b) everywhere, a max-w-* must never sit on the same element as PAGE_SHELL
  //
  // Together these cover every non-exempt page: a page either exposes its wrapper
  // to (a), or reaches the shell through PAGE_SHELL, which (b) keeps uncapped.
  const offenders: string[] = [];
  let parsed = 0;
  for (const file of pageFiles(APP)) {
    if (isExempt(file)) continue;
    const source = readFileSync(file, "utf8");
    const short = file.split("\\").join("/").replace(process.cwd().split("\\").join("/"), "");

    const classes = outerWrapperClasses(source);
    if (classes !== null) {
      parsed++;
      if (/max-w-/.test(classes)) offenders.push(`${short} -> "${classes}"`);
    }
    for (const line of source.split(/\r?\n/)) {
      if (line.includes("PAGE_SHELL") && /max-w-/.test(line)) offenders.push(`${short} -> ${line.trim()}`);
    }
  }
  assert.ok(parsed > 0, "the wrapper regex matched nothing at all — it has gone stale");
  assert.deepEqual(
    offenders,
    [],
    `these page wrappers cap their width and will leave unused space on a wide screen:\n  ${offenders.join("\n  ")}`,
  );
});

test("every tab routes its wrapper through PAGE_SHELL, so the rule has one home", () => {
  const missing: string[] = [];
  for (const file of pageFiles(APP)) {
    if (isExempt(file)) continue;
    const source = readFileSync(file, "utf8");
    if (!source.includes("PAGE_SHELL")) missing.push(file.replace(process.cwd(), ""));
  }
  assert.deepEqual(missing, [], `these tabs set their own page padding instead of using PAGE_SHELL:\n  ${missing.join("\n  ")}`);
});

test("the app shell hands all remaining width to the active tab", () => {
  // The sidebar half of the requirement: collapsing it must give the freed space
  // to the tab with no JS. That works because this is a flex row whose <main> is
  // `min-w-0 flex-1` — the content offset IS the current sidebar width. If either
  // class goes, a collapsed sidebar leaves a gap.
  const shell = readFileSync(join(process.cwd(), "src", "components", "AppShell.tsx"), "utf8");
  const main = shell.match(/<main[^>]*className="([^"]*)"/);
  assert.ok(main, "AppShell no longer renders a <main> with a className");
  assert.ok(main![1].includes("flex-1"), "main must absorb the space the sidebar is not using");
  assert.ok(main![1].includes("min-w-0"), "without min-w-0 a wide grid pushes the whole shell wider than the viewport");
  assert.ok(!/max-w-/.test(main![1]), "a cap here would defeat every tab at once");
});
