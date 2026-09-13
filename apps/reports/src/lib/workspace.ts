import { SPLIT_ROUTES, isSplittable, normalizePath, splitRoute, clampRatio, DEFAULT_RATIO, isExclusive } from "@/lib/split-view";

// ── The workspace: one source of truth for tab INSTANCES and the split ───────
//
// Requested 2026-09-03: browser-style tabs across the top of the Reports content
// area, and a Split View that picks a second OPEN TAB to show beside the active one.
//
// The architecture requirement was explicit — "one centralized source of truth for
// open tabs → active tab → tab state → split-view state → left/right split tabs",
// at the shell level, not inside any page. This file is that source of truth, and it
// is deliberately pure: no React, no DOM, no Prisma. Every rule below is provable in
// tests/workspace.test.ts rather than only observable by clicking.
//
// ── Tabs are INSTANCES, not routes (rewritten 2026-09-04) ───────────────────
//
// The first version identified a tab by its index and matched "is this already open?"
// on PATH, so one route could occupy at most one tab. Reported as two problems that
// turn out to be one:
//
//   • "I must be able to open Job Details three times" — three jobs, three tabs.
//   • Switching tabs was slow, because a tab was a URL and switching was a server
//     round-trip. Fixing that means keeping every open tab MOUNTED and toggling
//     visibility (React's <Activity>, see WorkspaceShell) — and a mounted pane needs
//     a stable identity that survives reordering, closing and duplication. An index
//     is exactly what does not.
//
// So a tab now carries its own `id`. Everything that referenced a tab by position —
// `active`, both split sides, the MRU list — references that id instead, which is
// also why `closeTab`/`moveTab` lost their index-repair arithmetic: there are no
// positions left to repair.
//
//     { id: "t3", path: "/job-hours", params: { jobs: "1101" } }
//
// The same `path` may appear any number of times. `pageType` in the request's
// vocabulary IS `path` here; there is no second concept, because the route already
// names the page and adding a parallel identifier would let the two disagree.
//
// ── Why the URL ─────────────────────────────────────────────────────────────
//
// Same reasoning as split-view.ts: App Refresh is a full frontend reload that keeps
// only the URL, so a URL satisfies "restore my tabs" with no code, and gets browser
// refresh, Back/Forward and "send someone my exact workspace" for free.
//
//     /w?t=t1~/etc,t2~/job-hours,t3~/job-hours&a=t2&t1.month=2026-08&t2.jobs=1101&t3.jobs=1148
//
// `t` is the ordered tab list as `id~path` pairs, so reordering is a reordering of
// that array and identity rides along. Params are namespaced by tab ID (`t2.`, `t3.`)
// rather than by index, which is what keeps two tabs on the SAME route from
// colliding — the exact property the old `t0.`/`t1.` prefixes gave, now stable under
// a reorder.

/** A tab instance's identity. Opaque, stable for the life of the tab. */
export type TabId = string;

export type Tab = {
  id: TabId;
  /** The route this instance hosts — the "pageType". */
  path: string;
  /** That route's own params, un-namespaced — what the page would read from its own URL. */
  params: Record<string, string>;
};

export type Workspace = {
  /** Ordered, as shown in the tab bar. Left to right. */
  tabs: Tab[];
  /** The active tab's id. Always an id that exists when there is at least one tab. */
  active: TabId;
  /**
   * Which two tab INSTANCES the split shows, or null for the ordinary
   * one-tab-at-a-time view. Holds ids, so `Job Details | Job Details` is expressible.
   */
  split: { left: TabId; right: TabId; ratio: number } | null;
  /**
   * Most-recently-active first. What a sidebar click uses to pick WHICH instance of a
   * page to return you to, and what `closeTab` uses to decide where to land.
   *
   * Kept explicitly rather than derived from tab order because the two answer
   * different questions: order is where the user filed a tab, MRU is where they were
   * working. Reordering tabs must not change which one a sidebar click resumes.
   */
  mru: TabId[];
};

export const MAX_TABS = 8;

/** The workspace a bare visit lands on. */
export const EMPTY_WORKSPACE: Workspace = { tabs: [], active: "", split: null, mru: [] };

/** Only the params a route declares — see split-view.ts's SPLIT_ROUTES comment. */
function pickParams(path: string, params: Record<string, string>): Record<string, string> {
  const route = splitRoute(path);
  if (!route) return {};
  const out: Record<string, string> = {};
  for (const key of route.params) if (params[key] !== undefined) out[key] = params[key];
  return out;
}

export const tabById = (ws: Workspace, id: TabId): Tab | undefined => ws.tabs.find((t) => t.id === id);
export const hasTab = (ws: Workspace, id: TabId): boolean => ws.tabs.some((t) => t.id === id);
export const tabIndex = (ws: Workspace, id: TabId): number => ws.tabs.findIndex((t) => t.id === id);

/**
 * A fresh id for this workspace.
 *
 * `t` + one past the highest number CURRENTLY in use, so ids stay short and readable
 * in a URL. Closing the highest tab does free its number again, and that is fine: a
 * closed tab is gone from `tabs`, so WorkspaceShell stops rendering its <Activity> and
 * React unmounts the pane. There is no surviving state for a later tab to inherit. What
 * has to hold is uniqueness among LIVE tabs — two mounted panes sharing a key is what
 * would actually break — and that is what this guarantees.
 */
export function nextTabId(ws: Workspace): TabId {
  let max = 0;
  for (const t of ws.tabs) {
    const n = Number(/^t(\d+)$/.exec(t.id)?.[1] ?? 0);
    if (n > max) max = n;
  }
  return `t${max + 1}`;
}

// ── Labels ──────────────────────────────────────────────────────────────────

/** The route's plain name — "Job Details", "Monthly ETC". */
export const tabLabel = (t: Tab): string => splitRoute(t.path)?.label ?? t.path;

/**
 * The bit that tells two instances of one page apart: the value of the param that
 * route is "about". `/job-hours` is about a job, `/etc` about a month.
 *
 * Null when the route declares no such param or the tab has not set it — a label with
 * a dangling separator ("Job Details – ") reads as a bug.
 */
export function tabInstanceHint(t: Tab): string | null {
  const key = splitRoute(t.path)?.instanceParam;
  if (!key) return null;
  const raw = t.params[key];
  if (!raw || !raw.trim()) return null;
  // Multi-select params arrive comma-joined (`?jobs=1101,1148`). Name the first and
  // count the rest rather than overflowing the strip with all of them.
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const head = formatHint(t.path, parts[0]);
  return parts.length > 1 ? `${head} +${parts.length - 1}` : head;
}

/** `2026-08` reads as `August 2026` on a tab; a job number reads as itself. */
function formatHint(path: string, value: string): string {
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    const [y, m] = value.split("-").map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  }
  return value;
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * What the tab strip shows.
 *
 * The hint is appended only when this workspace actually holds more than one instance
 * of the route — otherwise every tab would carry a qualifier that distinguishes it
 * from nothing, which is noise in a strip that is already tight. The Split View picker
 * asks for `detailed: true` instead, because there the whole job of the label is
 * telling two otherwise-identical entries apart.
 */
export function tabTitle(ws: Workspace, id: TabId, opts?: { detailed?: boolean }): string {
  const tab = tabById(ws, id);
  if (!tab) return "";
  const base = tabLabel(tab);
  const duplicated = ws.tabs.filter((t) => t.path === tab.path).length > 1;
  if (!duplicated && !opts?.detailed) return base;
  const hint = tabInstanceHint(tab);
  return hint ? `${base} — ${hint}` : base;
}

/** Every route the tab bar's "+" can offer. */
export const openableRoutes = () => SPLIT_ROUTES;

// ── MRU ─────────────────────────────────────────────────────────────────────

/** `id` to the front; drop ids that no longer exist. */
function touchMru(ws: Workspace, id: TabId, tabs: Tab[] = ws.tabs): TabId[] {
  const live = new Set(tabs.map((t) => t.id));
  return [id, ...ws.mru.filter((m) => m !== id && live.has(m))].filter((m) => live.has(m));
}

/**
 * The instance of `path` a single sidebar click should resume, or null for none.
 *
 * Most-recently-active wins. The ACTIVE tab is checked first only because it is
 * already at the head of a well-formed MRU — the ordering does the work, so a
 * reordered strip cannot change the answer.
 */
export function mostRecentInstance(ws: Workspace, path: string): TabId | null {
  const p = normalizePath(path);
  for (const id of touchMru(ws, ws.active)) {
    const tab = tabById(ws, id);
    if (tab && tab.path === p) return id;
  }
  // MRU can be incomplete on a hand-written URL; fall back to strip order.
  return ws.tabs.find((t) => t.path === p)?.id ?? null;
}

// ── Opening ─────────────────────────────────────────────────────────────────

export type OpenOptions = {
  /**
   * Force a NEW instance even when one is already open — middle-click, "Open in New
   * Tab", Duplicate Tab, and the "+" menu.
   *
   * Without it a sidebar click RESUMES the most recent instance, which is the
   * behaviour asked for in as many words: "Do not make duplicate tabs accidental on
   * every sidebar click."
   */
  newInstance?: boolean;
};

/**
 * Open `path` — resuming the most recent instance, or creating one.
 *
 * ── The one route that stays single-instance ────────────────────────────────
 *
 * `isExclusive(path)` (only Monthly ETC) refuses a second instance even when one is
 * explicitly asked for. lib/split-view.ts carries the measured reason: the unsaved-cell
 * tracker is module-scope and keyed by field name, and a cell with no row yet is named
 * `newEtcCreate__<jobId>__<sectionCode>` — which contains NO MONTH. Two grids alive in
 * one document therefore share one baseline and one dirty entry, and the documented
 * consequence is an empty create-draft posted into the WRONG MONTH, silently.
 *
 * That was already why ETC could not be in both split panes. Keeping every open tab
 * mounted makes it strictly worse: two ETC tabs would both be live all the time rather
 * than only while split. So the refusal now covers instances, and resuming the existing
 * tab is what a second request gets — never a second grid.
 *
 * Unblocking this means threading an instance scope through etc-dirty-tracker,
 * EtcSectionCells, EtcAutosave, PartsCostNewEtcCell and PoolAutosave so every field
 * name carries its month. Deliberately not done here (2026-09-04, by decision): it is a
 * large change to the file that guards unsaved month-end edits, and it does not belong
 * in the same change as the tab manager.
 */
export function openTab(
  ws: Workspace,
  path: string,
  params: Record<string, string> = {},
  opts: OpenOptions = {},
): Workspace {
  const p = normalizePath(path);
  if (!isSplittable(p)) return ws;

  const resume = mostRecentInstance(ws, p);
  if (resume && (!opts.newInstance || isExclusive(p))) {
    // Resuming carries the requested params in — a sidebar click that names a job
    // should take you to the open Job Details tab AND show that job, not to whatever
    // job it was last pointed at. No params requested means "just take me there".
    const next = Object.keys(pickParams(p, params)).length > 0 ? setTabParams(ws, resume, params) : ws;
    return activateTab(next, resume);
  }

  // At the cap, the LEAST recently used tab that is neither active nor in the split is
  // closed to make room. Refusing to open would leave a click doing nothing, which
  // reads as broken; dropping a tab the user is looking at would be worse than either.
  let base = ws;
  if (ws.tabs.length >= MAX_TABS) {
    const protectedIds = new Set<TabId>([ws.active, ...(ws.split ? [ws.split.left, ws.split.right] : [])]);
    const victim = [...ws.mru].reverse().find((id) => !protectedIds.has(id) && hasTab(ws, id))
      ?? ws.tabs.map((t) => t.id).find((id) => !protectedIds.has(id));
    if (!victim) return ws; // every tab is in use; leave the workspace alone
    base = closeTab(ws, victim);
  }

  const id = nextTabId(base);
  const tabs = [...base.tabs, { id, path: p, params: pickParams(p, params) }];
  return { ...base, tabs, active: id, mru: touchMru(base, id, tabs) };
}

/**
 * A second tab on the same page, carrying the original's params as its starting point.
 *
 * "Duplicate Tab" in the tab context menu. Inserted immediately to the right of its
 * source rather than at the end — a duplicate belongs beside what it was duplicated
 * from, which is what every browser does.
 */
export function duplicateTab(ws: Workspace, id: TabId): Workspace {
  const src = tabById(ws, id);
  if (!src) return ws;
  if (isExclusive(src.path)) return activateTab(ws, id); // see openTab's note
  if (ws.tabs.length >= MAX_TABS) {
    const opened = openTab(ws, src.path, src.params, { newInstance: true });
    return opened;
  }
  const newId = nextTabId(ws);
  const tabs = [...ws.tabs];
  tabs.splice(tabIndex(ws, id) + 1, 0, { id: newId, path: src.path, params: { ...src.params } });
  return { ...ws, tabs, active: newId, mru: touchMru(ws, newId, tabs) };
}

/**
 * Point an EXISTING tab at a different route, keeping its position in the strip.
 *
 * This is what a sidebar click does while the split is open, and it is deliberately
 * different from `openTab`. Opening a new tab there would leave the split showing the
 * two tabs it already had, so the page the user just asked for would render nowhere
 * they can see — the click would look like it did nothing. Replacing the active tab's
 * route instead means the pane they were working in changes and the other pane is
 * untouched, which is the same contract /split has had since it shipped
 * (`navigateActivePane`).
 *
 * Params are dropped rather than carried across: they belong to the route being left.
 * A stale `month` following you to a route with no month would sit in the URL looking
 * meaningful and doing nothing — the same reason pickParams filters.
 */
export function navigateTab(ws: Workspace, id: TabId, path: string, params: Record<string, string> = {}): Workspace {
  const p = normalizePath(path);
  if (!isSplittable(p)) return ws;
  const i = tabIndex(ws, id);
  if (i < 0) return ws;
  const tabs = [...ws.tabs];
  tabs[i] = { id, path: p, params: pickParams(p, params) };
  return { ...ws, tabs, active: id, mru: touchMru(ws, id, tabs) };
}

export function activateTab(ws: Workspace, id: TabId): Workspace {
  if (!hasTab(ws, id)) return ws;
  return { ...ws, active: id, mru: touchMru(ws, id) };
}

/** Replace one tab's params — a job picked, a month changed — touching no other tab. */
export function setTabParams(ws: Workspace, id: TabId, params: Record<string, string>): Workspace {
  const i = tabIndex(ws, id);
  if (i < 0) return ws;
  const tab = ws.tabs[i];
  const tabs = [...ws.tabs];
  tabs[i] = { id, path: tab.path, params: pickParams(tab.path, params) };
  return { ...ws, tabs };
}

// ── Closing ─────────────────────────────────────────────────────────────────

/**
 * Close a tab.
 *
 * Every reference is by id now, so this is a filter plus "where do we land" — the
 * index arithmetic the first version needed (and the class of bug it invited, a stale
 * index rendering the wrong page) is simply gone.
 *
 * Landing goes to the most recently used SURVIVOR, not to the neighbour. With
 * duplicates open, the neighbour is very often another instance of the same page,
 * which makes closing look like nothing happened.
 */
export function closeTab(ws: Workspace, id: TabId): Workspace {
  if (!hasTab(ws, id)) return ws;
  const tabs = ws.tabs.filter((t) => t.id !== id);
  if (tabs.length === 0) return EMPTY_WORKSPACE;

  const live = new Set(tabs.map((t) => t.id));
  const mru = ws.mru.filter((m) => live.has(m));

  // Closing a tab that is IN the split ends the split rather than leaving one pane
  // pointing at nothing. The survivor becomes the ordinary active tab.
  if (ws.split && (ws.split.left === id || ws.split.right === id)) {
    const survivor = ws.split.left === id ? ws.split.right : ws.split.left;
    const active = live.has(survivor) ? survivor : (mru[0] ?? tabs[0].id);
    return { tabs, active, split: null, mru: [active, ...mru.filter((m) => m !== active)] };
  }

  const active = id === ws.active ? (mru.find((m) => m !== id) ?? tabs[0].id) : ws.active;
  return {
    tabs,
    active,
    split: ws.split,
    mru: [active, ...mru.filter((m) => m !== active)],
  };
}

/**
 * "Close Other Tabs" — keep exactly one.
 *
 * Exits the split, because a split whose panes were both just closed is not a state
 * worth defining. The kept tab becomes the whole view.
 */
export function closeOtherTabs(ws: Workspace, keep: TabId): Workspace {
  const tab = tabById(ws, keep);
  if (!tab) return ws;
  return { tabs: [tab], active: keep, split: null, mru: [keep] };
}

// ── Reordering ──────────────────────────────────────────────────────────────

/**
 * Move a tab.
 *
 * `active`, the split and the MRU all hold ids, so none of them needs remapping — the
 * whole hazard the index-based version carried (a reorder silently repointing them at
 * whatever slid into place) does not exist here.
 */
export function moveTab(ws: Workspace, id: TabId, toIndex: number): Workspace {
  const from = tabIndex(ws, id);
  if (from < 0) return ws;
  const target = Math.max(0, Math.min(toIndex, ws.tabs.length - 1));
  if (from === target) return ws;
  const tabs = [...ws.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(target, 0, moved);
  return { ...ws, tabs };
}

// ── Split view ──────────────────────────────────────────────────────────────

/**
 * Show `other` beside the active tab.
 *
 * Takes a tab id rather than a path, because the requested dialog offers "currently
 * open tabs as the primary choices" — the split is a view onto instances that already
 * exist, which is what keeps a page's params in exactly one place AND what makes
 * `Job Details [A] | Job Details [B]` a valid split rather than a special case.
 */
export function enterSplit(ws: Workspace, other: TabId, ratio: number = DEFAULT_RATIO): Workspace {
  if (!hasTab(ws, other)) return ws;
  if (other === ws.active) return ws; // an instance cannot be split against itself
  return { ...ws, split: { left: ws.active, right: other, ratio: clampRatio(ratio) } };
}

/** Leave the split, keeping `keep` (default: the left pane) as the active tab. */
export function exitSplit(ws: Workspace, keep?: TabId): Workspace {
  if (!ws.split) return ws;
  const target = keep ?? ws.split.left;
  const active = hasTab(ws, target) ? target : ws.tabs[0]?.id ?? "";
  return { tabs: ws.tabs, active, split: null, mru: touchMru(ws, active) };
}

export function setSplitRatio(ws: Workspace, ratio: number): Workspace {
  if (!ws.split) return ws;
  return { ...ws, split: { ...ws.split, ratio: clampRatio(ratio) } };
}

/**
 * Which tab a sidebar click should land in.
 *
 * While split, the sidebar targets the tab the user was last in — `active` — and the
 * split keeps showing it, so navigating one pane leaves the other alone. That is the
 * same contract the earlier `navigateActivePane` had.
 */
export function sidebarTarget(ws: Workspace): TabId {
  return ws.active;
}

// ── URL ─────────────────────────────────────────────────────────────────────

export type RawParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export const tabParamKey = (id: TabId, key: string): string => `${id}.${key}`;

/** Ids must survive the URL's own separators. `t` + digits does; anything else is refused. */
const ID_RE = /^t\d+$/;

export function encodeWorkspace(ws: Workspace): string {
  const sp = new URLSearchParams();
  if (ws.tabs.length === 0) return "";
  sp.set("t", ws.tabs.map((t) => `${t.id}~${t.path}`).join(","));
  for (const t of ws.tabs) {
    for (const [k, v] of Object.entries(t.params)) sp.set(tabParamKey(t.id, k), v);
  }
  // Absent means "the first tab", so the commonest workspace carries no noise.
  if (ws.active && ws.active !== ws.tabs[0].id) sp.set("a", ws.active);
  if (ws.split) {
    sp.set("s", `${ws.split.left}:${ws.split.right}`);
    sp.set("r", String(clampRatio(ws.split.ratio)));
  }
  // Only when it says something the tab order does not — which is most of the time
  // once a tab has been revisited, but never on a freshly-opened strip.
  const naturalMru = ws.tabs.map((t) => t.id);
  const mru = ws.mru.filter((m) => hasTab(ws, m));
  if (mru.length > 1 && mru.join(",") !== naturalMru.join(",")) sp.set("m", mru.join(","));
  return sp.toString();
}

export const workspaceHref = (ws: Workspace): string => {
  const q = encodeWorkspace(ws);
  return q ? `/w?${q}` : "/w";
};

/**
 * Read a workspace out of the URL.
 *
 * Deliberately total: a URL is user-editable and is also what survives a reload, so
 * every malformed input resolves to something usable rather than a blank app. An
 * unknown route is dropped from the list; an `a`, `s` or `m` naming a tab that does
 * not exist falls back rather than pointing at nothing.
 *
 * Accepts the OLD index-based form too (`t=/etc,/job-hours&t0.month=…`), because
 * bookmarks and the SDC Tools shell's tiles carry those URLs and a workspace that
 * silently lost its params would read as data loss. Ids are minted for them.
 */
export function decodeWorkspace(raw: RawParams): Workspace {
  const segments = (one(raw.t) ?? "")
    .split(",")
    // Empty segments are dropped BEFORE normalizePath, not after. That order matters:
    // normalizePath("") returns "/", which is a real route (the Dashboard), so
    // `?t=` or `?t=/etc,,/jobs` would otherwise conjure Dashboard tabs nobody asked
    // for. An absent segment means no tab.
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return EMPTY_WORKSPACE;

  const seen = new Set<TabId>();
  const tabs: Tab[] = [];
  segments.slice(0, MAX_TABS).forEach((seg, i) => {
    const tilde = seg.indexOf("~");
    const rawId = tilde >= 0 ? seg.slice(0, tilde) : "";
    const rawPath = tilde >= 0 ? seg.slice(tilde + 1) : seg;
    const path = normalizePath(rawPath);
    if (!isSplittable(path)) return;
    // A hand-edited URL is the other way two Monthly ETC grids could reach one
    // document, and it bypasses openTab entirely. Same refusal, at the door — see
    // openTab's note for what two live ETC grids do to unsaved cells.
    if (isExclusive(path) && tabs.some((t) => t.path === path)) return;
    // A duplicate or malformed id is replaced rather than honoured — two tabs sharing
    // an id would share their params and their mounted pane.
    const id = ID_RE.test(rawId) && !seen.has(rawId) ? rawId : `t${100 + i}`;
    seen.add(id);
    const route = splitRoute(path);
    const params: Record<string, string> = {};
    for (const key of route?.params ?? []) {
      // The id-namespaced key, then the legacy index-namespaced one.
      const v = one(raw[tabParamKey(id, key)]) ?? one(raw[`t${i}.${key}`]);
      // Present-but-empty is kept: /job-hours reads `?jobs=` as "the picker was
      // cleared" and distinguishes it from absent. See split-view.ts.
      if (v !== undefined) params[key] = v;
    }
    tabs.push({ id, path, params });
  });
  if (tabs.length === 0) return EMPTY_WORKSPACE;

  const ids = new Set(tabs.map((t) => t.id));
  const byIndex = (v: string | undefined): TabId | undefined => {
    if (v === undefined) return undefined;
    if (ids.has(v)) return v;
    // Legacy numeric form.
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n < tabs.length ? tabs[n].id : undefined;
  };

  const active = byIndex(one(raw.a)) ?? tabs[0].id;

  let split: Workspace["split"] = null;
  const s = one(raw.s);
  if (s) {
    const [l, r] = s.split(":");
    const left = byIndex(l);
    const right = byIndex(r);
    if (left && right && left !== right) {
      split = { left, right, ratio: clampRatio(Number(one(raw.r) ?? DEFAULT_RATIO)) };
    }
  }

  const mruRaw = (one(raw.m) ?? "").split(",").map((x) => x.trim()).filter((x) => ids.has(x));
  const mru = [active, ...mruRaw.filter((m) => m !== active), ...tabs.map((t) => t.id)].filter(
    (m, i, arr) => arr.indexOf(m) === i,
  );

  return { tabs, active, split, mru };
}

/** One tab's own single-page URL — what "open this on its own" navigates to. */
export function tabHref(tab: Tab): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(tab.params)) sp.set(k, v);
  const q = sp.toString();
  return q ? `${tab.path}?${q}` : tab.path;
}
