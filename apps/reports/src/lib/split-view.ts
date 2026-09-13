// ── Split view: the state model ──────────────────────────────────────────────
//
// Two Reports App views side by side in one document, each holding its own route
// and its own context (job, month, filters). This file is the whole of the state
// model: what a split is, how it survives a reload, and how a single-pane URL and
// a split URL convert into each other. No React, no DOM — so the rules below are
// provable in tests/split-view.test.ts rather than only observable by clicking.
//
// ── Why ONE document and ONE url, rather than two of anything ────────────────
//
// Every page in this app is an async Server Component that reads its context from
// `searchParams` (etc: month/dept/jobname/billables; job-hours: jobs/job/section;
// nine of the twelve do this). Two panes therefore need two sets of params, and
// there is exactly one URL per document. The three ways out, and why this one:
//
//   Two documents (iframes)   Gives independence for free, and costs two of
//                             everything above the panes: the (app) layout mounts
//                             RealtimeProvider and LiveRefresh, so two frames mean
//                             two EventSource connections, two heartbeats, two
//                             autosave clients, and a Refresh Data button that has
//                             to reach across a frame boundary to do its job once.
//   Two routers               Not a thing. Next's App Router is one router per
//                             document; you cannot mount two route trees.
//   One document, namespaced  This file. Both panes' params live in one URL under
//                             `l.` and `r.` prefixes, one route (/split) renders
//                             both, and everything shared — the SSE connection, the
//                             refresh pipeline, the zoom, the sidebar — stays
//                             shared because it never stopped being one page.
//
// The namespacing is what makes pane independence real: `?l.month=2026-08&r.jobs=1131`
// are two separate values that cannot collide, so changing the job on the right
// rewrites `r.jobs` and leaves `l.month` untouched. That is the acceptance
// criterion ("changing job 1131 -> 1105 on the right must not change anything on
// the left") expressed as a data structure instead of as a promise.
//
// ── Why the URL and not session storage ─────────────────────────────────────
//
// The requirement is that App Refresh restores both panes, and App Refresh is a
// full frontend reload (components/AppRefreshButton.tsx) that keeps the URL and
// changes nothing else. A URL therefore satisfies it with no code at all, and
// gets browser refresh, Back/Forward, bookmarking and "send someone this exact
// pair of views" for the same nothing. Session storage would satisfy only the
// first, and would need a hydration dance to avoid rendering the wrong pane on
// the first frame — the same class of bug the sidebar cookie and the job-hours
// selection cookie both exist to avoid.

/** Which side of the divider. `l`/`r` verbatim so they can be URL param prefixes. */
export type Pane = "l" | "r";

export const PANES: readonly Pane[] = ["l", "r"];

export const otherPane = (p: Pane): Pane => (p === "l" ? "r" : "l");

// ── The splittable routes, and the params each one owns ─────────────────────
//
// `params` is not decoration: it is the list of keys that get carried into and out
// of the `l.`/`r.` namespace for that route. A key missing from this list is a key
// that silently fails to survive entering split view, which is the most likely way
// this feature breaks — so the list is asserted against the real page files in
// tests/split-view.test.ts rather than trusted to stay in step by hand.
//
// Note what is NOT here: `section` on /job-hours. It is a deep-link-only scroll
// instruction (see that page's own comment), so carrying it into a pane would
// re-trigger a scroll-to-procurement on every pane navigation. Deliberately
// dropped, and asserted as dropped.
// Every entry below is transcribed from that page's own `searchParams:` type, not
// guessed from what the page looks like it should take. The test asserts each list
// against the real page file for exactly that reason — the first draft of this
// table got six of the twelve wrong (`q`/`status` on /quoted, which actually takes
// `customers`/`statuses`; `month` on the dashboard, which takes `m`; `from`/`to` on
// /cash-flow, which takes `as`/`compare`), and every one of those would have
// presented as "my filters vanish when I open this in split view".
// ── `exclusive`: a route that must not be open in BOTH panes at once ────────
//
// Only Monthly ETC, and for a specific measured reason rather than caution.
//
// lib/etc-dirty-tracker.ts tracks unsaved cells in a MODULE-SCOPE map keyed by the
// form field's name, shared by every mounted grid (deliberately — see that file's
// header; it is what lets the Save button, the autosave and the navigation guards
// agree without prop-drilling through 450 cells). Two panes in one document share
// that module.
//
// For an existing cell the name is `newEtcOverride__<entryId>`, and an EtcEntry id
// is already month-specific, so two months' cells cannot collide. But a cell with
// no row yet is named `newEtcCreate__<jobId>__<sectionCode>` (EtcSectionCells.tsx)
// — and that name contains NO MONTH. So August and September panes render two
// different inputs under one identical name, sharing one baseline and one dirty
// entry. Consequences, all silent:
//
//   • registerEtcField is idempotent by name, so the second pane never records its
//     own baseline — its cells are compared against the first pane's values.
//   • forgetEtcField on either pane's unmount deletes the baseline the OTHER pane
//     is still using; its next edit then posts base "" ("no draft stored"), which
//     is exactly the stale write the base field exists to prevent.
//   • flushEtcAutosave now correctly flushes BOTH panes (fixed 2026-09-03), which
//     makes this worse rather than better: the second pane finds the shared dirty
//     name, reads its OWN empty input, and posts an empty create draft into ITS
//     month for a value the user typed in the other one.
//
// Fixing it properly means threading a pane scope through the tracker,
// EtcSectionCells, EtcAutosave, PartsCostNewEtcCell and PoolAutosave — a large
// change to the most dangerous file in the app, to enable a combination
// (the same editable grid twice, side by side) with no clear use: the point of
// split view here is Monthly ETC beside something you are checking it against.
//
// So the combination is refused, with the reason shown, rather than allowed and
// hoped about. Monthly ETC beside ANY other page is fully supported; it is only
// ETC-beside-ETC that is blocked.
export const SPLIT_ROUTES: readonly {
  path: string;
  label: string;
  params: readonly string[];
  exclusive?: true;
  /**
   * The param that says WHICH thing this instance is about — the job, the month.
   *
   * Added 2026-09-04 with duplicate tabs: three Job Details tabs are three jobs, and a
   * strip of three identical "Job Details" labels is unusable. lib/workspace.ts reads
   * this to build "Job Details — 1101". Absent means the route has no such notion, and
   * its duplicates are told apart by position alone.
   */
  instanceParam?: string;
}[] = [
  { path: "/", label: "Dashboard", params: ["tab", "m", "dqFrom", "dqTo", "dqEmp", "dqFn", "dqMtd"] },
  { path: "/job-hours", label: "Job Details", params: ["jobs", "job"], instanceParam: "jobs" },
  { path: "/etc", label: "Monthly ETC", params: ["month", "dept", "jobname", "billables"], exclusive: true, instanceParam: "month" },
  {
    path: "/quoted",
    label: "Projects",
    params: [
      "cols",
      "sort",
      "dir",
      "customers",
      "types",
      "statuses",
      "billables",
      "hide",
      "view",
      "actuals",
      "dateField",
      "from",
      "to",
    ],
  },
  {
    path: "/hours",
    label: "Hours",
    params: ["jobs", "employees", "sections", "departments", "from", "to", "page", "groupBy", "sort", "dir", "view"],
  },
  { path: "/tm", label: "T&M", params: ["jobs", "start", "end"], instanceParam: "jobs" },
  { path: "/build-readiness", label: "Build Readiness", params: [] },
  { path: "/jobs", label: "Jobs", params: ["q", "status", "type", "customer"] },
  { path: "/job-cost-explorer", label: "Profitability", params: ["asOf"], instanceParam: "asOf" },
  { path: "/cash-flow", label: "Cash Flow", params: ["as", "compare"], instanceParam: "as" },
  { path: "/employees", label: "Employees", params: [] },
  { path: "/audit-log", label: "Audit Log", params: [] },
];

const ROUTE_BY_PATH = new Map(SPLIT_ROUTES.map((r) => [r.path, r]));

/** Every route the split view can host. A path outside this list cannot be a pane. */
export function isSplittable(path: string): boolean {
  return ROUTE_BY_PATH.has(normalizePath(path));
}

export function splitRoute(path: string) {
  return ROUTE_BY_PATH.get(normalizePath(path)) ?? null;
}

/**
 * Trailing slashes and empty strings normalized to "/" so "/etc/" and "/etc" are
 * one route. Anything else is returned as-is — an unknown path must stay
 * recognizably unknown rather than being coerced into a route that exists.
 */
export function normalizePath(path: string): string {
  if (!path) return "/";
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

// ── Ratio ───────────────────────────────────────────────────────────────────
//
// Stored as the LEFT pane's percentage of the available width, an integer. One
// number rather than two, because the two must always sum to 100 and storing both
// invites a state where they don't.
//
// Clamped to 20..80. Not to 0..100: a pane at 5% is not a pane, it is a sliver
// that has to be dragged back before it can be used, and "never create unreadable
// 200px-wide Monthly ETC tables" is an explicit requirement. Closing a pane is the
// way to give the other one all the width — that is what the Expand control is
// for, and it is a state this ratio does not need to be able to represent.
export const MIN_RATIO = 20;
export const MAX_RATIO = 80;
export const DEFAULT_RATIO = 50;

/**
 * Below this, a pane is too narrow to hold a Reports App page and the split
 * collapses to one pane (see `fitsSplit`). 560px is the width at which the
 * narrowest page's own content stops needing horizontal scroll to show its first
 * meaningful column; dense pages (Monthly ETC) scroll horizontally inside the pane
 * at any width, which the requirement explicitly accepts.
 */
export const MIN_PANE_PX = 560;

export const clampRatio = (n: number): number =>
  Math.min(MAX_RATIO, Math.max(MIN_RATIO, Math.round(Number.isFinite(n) ? n : DEFAULT_RATIO)));

/**
 * Whether `available` px of content width can hold two panes at all. Both panes
 * must clear MIN_PANE_PX at the CURRENT ratio, not merely on average — a 70/30
 * split of 1,400px leaves the right pane at 420px, which is exactly the
 * unreadable-sliver case, even though half of 1,400 would have been fine.
 */
export function fitsSplit(available: number, ratio: number = DEFAULT_RATIO): boolean {
  if (!Number.isFinite(available) || available <= 0) return false;
  const r = clampRatio(ratio);
  return (available * r) / 100 >= MIN_PANE_PX && (available * (100 - r)) / 100 >= MIN_PANE_PX;
}

/**
 * The widest ratio range that keeps both panes above MIN_PANE_PX at this width, so
 * a drag can be clamped to what actually fits rather than to the static 20..80.
 * Returns null when the width cannot hold a split at all.
 */
export function ratioBounds(available: number): { min: number; max: number } | null {
  if (!Number.isFinite(available) || available <= 0) return null;
  const edge = (MIN_PANE_PX / available) * 100;
  const min = Math.max(MIN_RATIO, Math.ceil(edge));
  const max = Math.min(MAX_RATIO, Math.floor(100 - edge));
  return min <= max ? { min, max } : null;
}

// ── The state ───────────────────────────────────────────────────────────────

export type PaneState = {
  path: string;
  /** That route's own params, un-namespaced — exactly what the page would read from a single-pane URL. */
  params: Record<string, string>;
};

export type SplitState = {
  l: PaneState;
  /** null = not split. The left pane is then simply the page, at full width. */
  r: PaneState | null;
  ratio: number;
  /** Which pane sidebar navigation targets, and which one shows the active outline. */
  active: Pane;
};

const PARAM_ROUTE: Record<Pane, string> = { l: "l", r: "r" };
const PARAM_RATIO = "ratio";
const PARAM_ACTIVE = "active";

/** `l.month` — the namespaced form of one pane's own param. */
export const namespacedKey = (pane: Pane, key: string): string => `${pane}.${key}`;

// A plain object rather than URLSearchParams, so this module stays usable from a
// Server Component's already-awaited `searchParams` (a plain object) and from a
// client's `useSearchParams()` alike. Array values (`?a=1&a=2`) take the first,
// matching what Next hands a page for a repeated key.
export type RawParams = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * Read a split state out of /split's own params.
 *
 * Deliberately total: every malformed input resolves to a usable state rather than
 * throwing or rendering nothing. A URL is user-editable and also the thing that
 * survives a reload, so a typo in it must not be able to produce a blank app. An
 * unknown or unsplittable `l=` falls back to the dashboard; an unknown `r=` drops
 * the split to one pane, which is the same graceful collapse a too-narrow window
 * produces.
 */
export function decodeSplit(raw: RawParams): SplitState {
  const leftPath = normalizePath(one(raw[PARAM_ROUTE.l]) ?? "/");
  const rightRaw = one(raw[PARAM_ROUTE.r]);

  const l: PaneState = {
    path: isSplittable(leftPath) ? leftPath : "/",
    params: readPaneParams(raw, "l", isSplittable(leftPath) ? leftPath : "/"),
  };

  let r: PaneState | null = null;
  if (rightRaw) {
    const rightPath = normalizePath(rightRaw);
    if (isSplittable(rightPath)) r = { path: rightPath, params: readPaneParams(raw, "r", rightPath) };
  }

  const activeRaw = one(raw[PARAM_ACTIVE]);
  // An `active=r` with no right pane is incoherent, so it resolves to `l` rather
  // than leaving sidebar navigation pointed at a pane that does not exist.
  const active: Pane = activeRaw === "r" && r ? "r" : "l";

  return { l, r, ratio: clampRatio(Number(one(raw[PARAM_RATIO]) ?? DEFAULT_RATIO)), active };
}

/**
 * One pane's own params, lifted out of its namespace and filtered to the keys its
 * route declares. The filter is what stops a stale `l.month` from following the
 * left pane to a route that has no month, where it would sit in the URL looking
 * meaningful and doing nothing.
 */
function readPaneParams(raw: RawParams, pane: Pane, path: string): Record<string, string> {
  const route = splitRoute(path);
  if (!route) return {};
  const out: Record<string, string> = {};
  for (const key of route.params) {
    const v = one(raw[namespacedKey(pane, key)]);
    // Present-but-empty is kept deliberately: /job-hours reads `?jobs=` (empty) as
    // "the user cleared the picker" and distinguishes it from absent, which means
    // "just arrived, pick a default". Dropping empties here would make clearing the
    // picker impossible inside a pane — the server would re-pick a job every render.
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** The `?…` for /split that represents this state, ordered so the URL is stable and diffable. */
export function encodeSplit(state: SplitState): string {
  const sp = new URLSearchParams();
  sp.set(PARAM_ROUTE.l, state.l.path);
  for (const [k, v] of Object.entries(state.l.params)) sp.set(namespacedKey("l", k), v);
  if (state.r) {
    sp.set(PARAM_ROUTE.r, state.r.path);
    for (const [k, v] of Object.entries(state.r.params)) sp.set(namespacedKey("r", k), v);
    // Only meaningful while split, so they are absent from a one-pane URL rather
    // than sitting in it as noise that has to be explained.
    sp.set(PARAM_RATIO, String(clampRatio(state.ratio)));
    if (state.active === "r") sp.set(PARAM_ACTIVE, "r");
  }
  return sp.toString();
}

export const splitHref = (state: SplitState): string => `/split?${encodeSplit(state)}`;

// ── Converting between a single-pane URL and a split ────────────────────────

/**
 * One pane's own single-pane URL — what "Expand this pane" navigates to, and what
 * the pane's title links to.
 *
 * Going back to a real route rather than staying on /split with one pane is the
 * point: the app's twelve routes keep working as themselves, deep links and
 * bookmarks keep resolving, the SDC Tools shell's tiles keep working, and /split
 * is only ever the two-pane case. It also means closing a pane leaves you on a
 * normal URL rather than on a split-shaped one that happens to have one side.
 */
export function paneHref(pane: PaneState): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(pane.params)) sp.set(k, v);
  const q = sp.toString();
  return q ? `${pane.path}?${q}` : pane.path;
}

/**
 * "Open in Split View" from a single-pane page: the page you are on stays where it
 * is and becomes the left pane, the chosen route opens beside it as the right pane,
 * and the new pane becomes active.
 *
 * `currentParams` is the current page's own params, which is what carries your month
 * / job / filters across the transition — the requirement that entering split must
 * not lose your place. It cannot be a no-remount transition (the browser navigates
 * from /etc to /split, so React unmounts the tree either way), but everything the
 * page derives its state FROM travels with it, so the new left pane renders the same
 * month, the same job and the same filters as the page you left.
 */
export function openInSplit(
  current: { path: string; params: Record<string, string> },
  target: { path: string; params?: Record<string, string> },
  ratio: number = DEFAULT_RATIO,
): SplitState {
  const currentPath = normalizePath(current.path);
  const targetPath = normalizePath(target.path);
  return {
    l: { path: isSplittable(currentPath) ? currentPath : "/", params: pickParams(currentPath, current.params) },
    r: { path: targetPath, params: pickParams(targetPath, target.params ?? {}) },
    ratio: clampRatio(ratio),
    // The pane you just asked for is the one you want to act on next.
    active: "r",
  };
}

/** Drop any param the route does not declare — see readPaneParams for why. */
function pickParams(path: string, params: Record<string, string>): Record<string, string> {
  const route = splitRoute(path);
  if (!route) return {};
  const out: Record<string, string> = {};
  for (const key of route.params) if (params[key] !== undefined) out[key] = params[key];
  return out;
}

/** Sidebar navigation while split: replace the ACTIVE pane's route, leave the other pane untouched. */
export function navigateActivePane(state: SplitState, path: string, params: Record<string, string> = {}): SplitState {
  const targetPath = normalizePath(path);
  if (!isSplittable(targetPath)) return state;
  const next: PaneState = { path: targetPath, params: pickParams(targetPath, params) };
  // The other pane is carried over BY REFERENCE, which is the whole contract of
  // this function: nothing about it can change as a side effect of navigating its
  // neighbour, not even by being rebuilt from equal-looking values.
  return state.active === "l" ? { ...state, l: next } : { ...state, r: next };
}

/** Replace one pane's params (a job picked, a month changed) without touching the other. */
export function setPaneParams(state: SplitState, pane: Pane, params: Record<string, string>): SplitState {
  const target = pane === "l" ? state.l : state.r;
  if (!target) return state;
  const next: PaneState = { path: target.path, params: pickParams(target.path, params) };
  return pane === "l" ? { ...state, l: next } : { ...state, r: next };
}

/**
 * Close one pane. The survivor keeps its own route and context and goes back to
 * being a normal full-width page, so this returns the href to navigate to rather
 * than a SplitState — there is no such thing as a one-pane split.
 */
export function closePaneHref(state: SplitState, close: Pane): string {
  const survivor = close === "l" ? state.r : state.l;
  // Closing the left pane when there is no right pane leaves nothing; the caller
  // should not offer that control, and if it does, staying put is the safe answer.
  if (!survivor) return paneHref(state.l);
  return paneHref(survivor);
}

export function swap(state: SplitState): SplitState {
  if (!state.r) return state;
  return {
    l: state.r,
    r: state.l,
    // The ratio describes the LEFT pane, so swapping the panes without inverting it
    // would resize both of them as a side effect of a reorder.
    ratio: clampRatio(100 - state.ratio),
    active: otherPane(state.active),
  };
}

// ── Refusing a pairing, with a reason ───────────────────────────────────────

/**
 * Why `path` cannot open in the pane opposite `otherPath`, or null when it can.
 *
 * A string rather than a boolean because this is shown to the user at the moment
 * they try it: a disabled menu entry with no explanation reads as a bug, and the
 * reason here ("already open in the other pane") is one they can act on.
 */
/**
 * May this route be open more than once at a time?
 *
 * The same `exclusive` flag that already refused it in both split panes, now asked of
 * tab INSTANCES too — because keeping every open tab mounted (see lib/workspace.ts)
 * makes two Monthly ETC grids live simultaneously whether or not they are split, which
 * is the condition the flag exists to prevent.
 */
export function isExclusive(path: string): boolean {
  return splitRoute(normalizePath(path))?.exclusive === true;
}

export function pairingRefusal(path: string, otherPath: string | null | undefined): string | null {
  if (!otherPath) return null;
  const a = splitRoute(normalizePath(path));
  if (!a?.exclusive) return null;
  if (normalizePath(path) !== normalizePath(otherPath)) return null;
  return `${a.label} can only be open in one pane at a time`;
}

/** True when a state has an exclusive route in BOTH panes - the state /split must refuse. */
export function hasExclusiveClash(state: SplitState): boolean {
  return state.r != null && pairingRefusal(state.l.path, state.r.path) != null;
}
