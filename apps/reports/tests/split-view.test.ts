import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  SPLIT_ROUTES,
  MIN_PANE_PX,
  DEFAULT_RATIO,
  MIN_RATIO,
  MAX_RATIO,
  clampRatio,
  fitsSplit,
  ratioBounds,
  decodeSplit,
  encodeSplit,
  splitHref,
  paneHref,
  openInSplit,
  navigateActivePane,
  setPaneParams,
  closePaneHref,
  swap,
  isSplittable,
  normalizePath,
  namespacedKey,
  otherPane,
  pairingRefusal,
  hasExclusiveClash,
  type SplitState,
} from "../src/lib/split-view";

const SRC = join(process.cwd(), "src");
const pageFile = (path: string) =>
  path === "/" ? join(SRC, "app", "(app)", "page.tsx") : join(SRC, "app", "(app)", path.slice(1), "page.tsx");

// ── The table cannot drift from the pages it describes ───────────────────────
//
// SPLIT_ROUTES.params is the list of keys carried into and out of a pane's `l.`/`r.`
// namespace. A key the page reads but the table omits is a filter that silently
// vanishes when you open that page in split view — the most likely way this whole
// feature breaks, and invisible in every other test because nothing throws.
//
// The first draft of the table got six of the twelve routes wrong by writing down
// what the params looked like they should be, so this reads the real page files.

test("every splittable route points at a page that exists", () => {
  for (const r of SPLIT_ROUTES) {
    assert.ok(existsSync(pageFile(r.path)), `${r.path} has no page file at ${pageFile(r.path)}`);
  }
});

test("every param a page reads from the URL is declared in SPLIT_ROUTES", () => {
  // Pulls the keys out of the page's own `searchParams:` type. Both shapes the
  // codebase uses are covered: an inline `Promise<{ a?: string }>` and a named type
  // (/hours declares `type HoursPageSearchParams = { ... }`).
  const declaredKeys = (src: string): string[] => {
    const inline = /searchParams:\s*Promise<\{([\s\S]*?)\}>/.exec(src);
    let body = inline?.[1];
    if (!body) {
      const named = /searchParams:\s*Promise<(\w+)>/.exec(src);
      if (!named) return [];
      const decl = new RegExp(`type\\s+${named[1]}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`).exec(src);
      body = decl?.[1] ?? "";
    }
    // Strip comments first, then read `key?:` / `key:` anywhere in the body — NOT
    // anchored per line: /job-hours declares all three of its params on ONE line
    // (`Promise<{ jobs?: string; job?: string; section?: string }>`), and a
    // line-anchored match saw only the first, which made this test report the table
    // as wrong when the table was right.
    const clean = body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    return [...clean.matchAll(/(?:^|[{;])\s*(\w+)\??:/g)].map((m) => m[1]);
  };

  for (const r of SPLIT_ROUTES) {
    const src = readFileSync(pageFile(r.path), "utf8");
    const keys = declaredKeys(src);
    for (const key of keys) {
      // `section` on /job-hours is deliberately dropped — see SPLIT_ROUTES' comment.
      if (r.path === "/job-hours" && key === "section") continue;
      assert.ok(
        r.params.includes(key),
        `${r.path} reads ?${key}= but SPLIT_ROUTES does not declare it — it would be lost entering split view`,
      );
    }
    // The reverse direction too: a declared key the page does not read is dead
    // weight that sits in the URL looking meaningful.
    for (const key of r.params) {
      assert.ok(keys.includes(key), `SPLIT_ROUTES declares ?${key}= for ${r.path}, but that page does not read it`);
    }
  }
});

test("the deep-link-only scroll param is not carried into a pane", () => {
  // /job-hours' `section` only tells the page to scroll itself to Procurement. Carried
  // into a pane it would re-fire that scroll on every navigation of that pane.
  const jobHours = SPLIT_ROUTES.find((r) => r.path === "/job-hours")!;
  assert.ok(!jobHours.params.includes("section"));
});

// ── Ratio and fit ───────────────────────────────────────────────────────────

test("the ratio never reaches a width that is not a pane", () => {
  assert.equal(clampRatio(50), 50);
  assert.equal(clampRatio(0), MIN_RATIO);
  assert.equal(clampRatio(100), MAX_RATIO);
  assert.equal(clampRatio(-40), MIN_RATIO);
  // Garbage resolves to the DEFAULT, not to the nearest edge: a non-finite ratio
  // means the input was never a measurement (a NaN out of a bad parse, an Infinity
  // out of a divide by a zero-width container), and answering "80%" to that would
  // silently resize the user's panes off a value that meant nothing.
  assert.equal(clampRatio(NaN), DEFAULT_RATIO);
  assert.equal(clampRatio(Number.POSITIVE_INFINITY), DEFAULT_RATIO);
  // Fractions from a pixel drag land on whole percentages.
  assert.equal(clampRatio(63.4), 63);
});

test("a split is refused at a width that cannot hold two readable panes", () => {
  assert.equal(fitsSplit(MIN_PANE_PX * 2 + 10), true);
  assert.equal(fitsSplit(MIN_PANE_PX * 2 - 10), false);
  assert.equal(fitsSplit(0), false);
  assert.equal(fitsSplit(NaN), false);
  // Judged at the CURRENT ratio, not on average: 70/30 of 1400 leaves 420px on the
  // right, which is the unreadable sliver, even though 50/50 of 1400 is fine.
  assert.equal(fitsSplit(1400, 50), true);
  assert.equal(fitsSplit(1400, 70), false);
});

test("drag bounds keep both panes above the minimum, or report that no split fits", () => {
  const wide = ratioBounds(4000)!;
  // Plenty of room, so the static clamp is what binds.
  assert.equal(wide.min, MIN_RATIO);
  assert.equal(wide.max, MAX_RATIO);

  const tight = ratioBounds(1400)!;
  // 560/1400 = 40%, so the ratio can only live between 40 and 60.
  assert.equal(tight.min, 40);
  assert.equal(tight.max, 60);
  for (const r of [tight.min, tight.max]) assert.ok(fitsSplit(1400, r), `${r}% should fit at 1400px`);

  assert.equal(ratioBounds(MIN_PANE_PX * 2 - 1), null);
  assert.equal(ratioBounds(0), null);
});

// ── Encode / decode ─────────────────────────────────────────────────────────

const state = (over: Partial<SplitState> = {}): SplitState => ({
  l: { path: "/etc", params: { month: "2026-08" } },
  r: { path: "/job-hours", params: { jobs: "1131" } },
  ratio: 50,
  active: "l",
  ...over,
});

test("a split round-trips through the URL unchanged", () => {
  const s = state({ ratio: 65, active: "r" });
  const back = decodeSplit(Object.fromEntries(new URLSearchParams(encodeSplit(s))));
  assert.deepEqual(back, s);
});

test("each pane's params live in their own namespace and cannot collide", () => {
  // Both panes on the same route, each with its own job: the case that proves the
  // panes are independent rather than merely looking it.
  const s: SplitState = {
    l: { path: "/job-hours", params: { jobs: "1131" } },
    r: { path: "/job-hours", params: { jobs: "1105" } },
    ratio: 50,
    active: "l",
  };
  const q = encodeSplit(s);
  assert.match(q, /l\.jobs=1131/);
  assert.match(q, /r\.jobs=1105/);
  const back = decodeSplit(Object.fromEntries(new URLSearchParams(q)));
  assert.equal(back.l.params.jobs, "1131");
  assert.equal(back.r!.params.jobs, "1105");
  assert.equal(namespacedKey("r", "jobs"), "r.jobs");
});

test("a one-pane URL carries no split noise", () => {
  const q = encodeSplit(state({ r: null }));
  assert.ok(!q.includes("ratio"), "ratio is meaningless without a second pane");
  assert.ok(!q.includes("active"));
  assert.ok(!/(^|&)r=/.test(q));
});

test("decoding is total — no malformed URL can produce a blank app", () => {
  // A URL is user-editable and is also what survives a reload, so every bad input
  // has to land on something usable.
  assert.equal(decodeSplit({}).l.path, "/");
  assert.equal(decodeSplit({}).r, null);
  assert.equal(decodeSplit({ l: "/nope" }).l.path, "/", "an unknown left route falls back to the dashboard");
  assert.equal(decodeSplit({ l: "/etc", r: "/nope" }).r, null, "an unknown right route collapses to one pane");
  assert.equal(decodeSplit({ l: "/etc", ratio: "not-a-number" }).ratio, DEFAULT_RATIO);
  assert.equal(decodeSplit({ l: "/etc", r: "/jobs", ratio: "999" }).ratio, MAX_RATIO);
  // active=r with no right pane would leave sidebar navigation aimed at nothing.
  assert.equal(decodeSplit({ l: "/etc", active: "r" }).active, "l");
  assert.equal(decodeSplit({ l: "/etc", r: "/jobs", active: "r" }).active, "r");
  // Repeated keys (?l=a&l=b) take the first, matching what Next hands a page.
  assert.equal(decodeSplit({ l: ["/etc", "/jobs"] }).l.path, "/etc");
});

test("a param that does not belong to a pane's route is dropped", () => {
  // A stale l.month following the left pane to a route with no month would sit in
  // the URL looking meaningful and doing nothing.
  const s = decodeSplit({ l: "/jobs", "l.month": "2026-08", "l.q": "1131" });
  assert.deepEqual(s.l.params, { q: "1131" });
});

test("present-but-empty is preserved, because a page distinguishes it from absent", () => {
  // /job-hours reads ?jobs= (empty) as "the user cleared the picker" and absent as
  // "just arrived, pick a default". Dropping empties would make clearing the picker
  // inside a pane impossible — the server would re-pick a job on every render.
  const s = decodeSplit({ l: "/job-hours", "l.jobs": "" });
  assert.deepEqual(s.l.params, { jobs: "" });
  assert.ok("jobs" in s.l.params);
});

test("trailing slashes are one route, unknown paths stay unknown", () => {
  assert.equal(normalizePath("/etc/"), "/etc");
  assert.equal(normalizePath(""), "/");
  assert.equal(normalizePath("/"), "/");
  assert.equal(isSplittable("/etc/"), true);
  assert.equal(isSplittable("/admin/users"), false, "admin routes are not panes");
  assert.equal(isSplittable("/login"), false);
});

// ── Transitions ─────────────────────────────────────────────────────────────

test("Open in Split View keeps the current page on the left, with its context", () => {
  // The headline workflow: on Monthly ETC in August, open Job Hour Details beside it.
  const s = openInSplit({ path: "/etc", params: { month: "2026-08", dept: "ENG" } }, { path: "/job-hours" });
  assert.equal(s.l.path, "/etc");
  assert.deepEqual(s.l.params, { month: "2026-08", dept: "ENG" }, "the month and department must survive the transition");
  assert.equal(s.r!.path, "/job-hours");
  // The pane you just asked for is the one you want to act on next.
  assert.equal(s.active, "r");
  assert.equal(s.ratio, DEFAULT_RATIO);
});

test("sidebar navigation replaces the active pane and cannot touch the other", () => {
  const before = state({ active: "r" });
  const after = navigateActivePane(before, "/jobs");
  assert.equal(after.r!.path, "/jobs");
  // Identity, not deep equality: nothing about the inactive pane may be rebuilt as a
  // side effect of navigating its neighbour.
  assert.equal(after.l, before.l);

  const leftActive = navigateActivePane(state({ active: "l" }), "/hours");
  assert.equal(leftActive.l.path, "/hours");
  assert.equal(leftActive.r!.path, "/job-hours");
});

test("navigating to an unsplittable route is refused rather than half-applied", () => {
  const before = state();
  assert.equal(navigateActivePane(before, "/admin/users"), before);
});

test("changing one pane's job leaves the other pane's job alone", () => {
  // The requirement, verbatim: changing job 1131 -> 1105 on the right must not
  // change anything on the left.
  const before: SplitState = {
    l: { path: "/job-hours", params: { jobs: "1131" } },
    r: { path: "/job-hours", params: { jobs: "1131" } },
    ratio: 50,
    active: "r",
  };
  const after = setPaneParams(before, "r", { jobs: "1105" });
  assert.equal(after.r!.params.jobs, "1105");
  assert.equal(after.l.params.jobs, "1131");
  assert.equal(after.l, before.l);
});

test("setting params on a pane that does not exist changes nothing", () => {
  const before = state({ r: null });
  assert.equal(setPaneParams(before, "r", { jobs: "1105" }), before);
});

test("closing a pane returns the survivor to its own normal URL, context intact", () => {
  // There is no such thing as a one-pane split, so this yields a real route — which
  // is what keeps deep links, bookmarks and the SDC Tools tiles working.
  assert.equal(closePaneHref(state(), "r"), "/etc?month=2026-08");
  assert.equal(closePaneHref(state(), "l"), "/job-hours?jobs=1131");
  // Closing the only pane has nowhere to go; staying put is the safe answer.
  assert.equal(closePaneHref(state({ r: null }), "l"), "/etc?month=2026-08");
});

test("a pane's own href is the page it would be on its own", () => {
  assert.equal(paneHref({ path: "/build-readiness", params: {} }), "/build-readiness");
  assert.equal(paneHref({ path: "/etc", params: { month: "2026-08" } }), "/etc?month=2026-08");
});

test("swapping panes inverts the ratio, so a reorder is not also a resize", () => {
  const s = swap(state({ ratio: 70, active: "l" }));
  assert.equal(s.l.path, "/job-hours");
  assert.equal(s.r!.path, "/etc");
  assert.equal(s.ratio, 30);
  assert.equal(s.active, "r", "the same pane stays active through a swap");
  // Nothing to swap with.
  const single = state({ r: null });
  assert.equal(swap(single), single);
});

test("splitHref is the route the app navigates to", () => {
  assert.match(splitHref(state()), /^\/split\?/);
});

test("otherPane", () => {
  assert.equal(otherPane("l"), "r");
  assert.equal(otherPane("r"), "l");
});

// ── Monthly ETC cannot be open twice ────────────────────────────────────────
//
// Not caution: lib/etc-dirty-tracker.ts keys unsaved-cell state by FORM FIELD NAME
// in module scope, and a not-yet-created cell is named
// `newEtcCreate__<jobId>__<sectionCode>` with NO MONTH in it. Two ETC panes on two
// months therefore render two different inputs under one identical name, sharing one
// baseline and one dirty entry — so one pane can post an empty create draft into the
// other pane's month. SPLIT_ROUTES' `exclusive` comment has the full mechanism.

test("only Monthly ETC is exclusive, and it is actually flagged", () => {
  const exclusive = SPLIT_ROUTES.filter((r) => r.exclusive).map((r) => r.path);
  assert.deepEqual(exclusive, ["/etc"], "if another route becomes exclusive, say why in its own comment");
});

test("the ETC field name really does lack a month, which is why the flag exists", () => {
  // The guard is only justified while this is true. If the create-cell name ever
  // gains a month, the two panes stop colliding and this restriction can be lifted
  // — so pin the fact the decision rests on rather than the decision alone.
  const cells = readFileSync(join(SRC, "components", "EtcSectionCells.tsx"), "utf8");
  const name = /`newEtcCreate__\$\{([^}]*)\}__\$\{([^}]*)\}`/.exec(cells);
  assert.ok(name, "the newEtcCreate field name is no longer built the way split-view.ts assumes");
  assert.ok(
    !/month/i.test(name[1]) && !/month/i.test(name[2]),
    "newEtcCreate now carries a month — two ETC panes may no longer collide, so revisit `exclusive`",
  );
});

test("a page open in the other pane is refused, with a reason to show", () => {
  assert.equal(pairingRefusal("/etc", "/etc"), "Monthly ETC can only be open in one pane at a time");
  // Trailing-slash forms are the same route, so the guard must not be evadable by one.
  assert.ok(pairingRefusal("/etc/", "/etc"));
  // Everything else pairs freely, including with itself.
  assert.equal(pairingRefusal("/job-hours", "/job-hours"), null);
  assert.equal(pairingRefusal("/etc", "/job-hours"), null);
  assert.equal(pairingRefusal("/etc", null), null, "not split yet - nothing to clash with");
});

test("hasExclusiveClash names exactly the state /split must refuse", () => {
  const etcBoth: SplitState = {
    l: { path: "/etc", params: { month: "2026-08" } },
    r: { path: "/etc", params: { month: "2026-09" } },
    ratio: 50,
    active: "l",
  };
  assert.equal(hasExclusiveClash(etcBoth), true);
  // The dangerous case is specifically two months, so check the same month too —
  // it is equally refused, because the collision is on the field name, not the data.
  assert.equal(hasExclusiveClash({ ...etcBoth, r: { path: "/etc", params: { month: "2026-08" } } }), true);
  assert.equal(hasExclusiveClash(state()), false);
  assert.equal(hasExclusiveClash(state({ r: null })), false);
});
