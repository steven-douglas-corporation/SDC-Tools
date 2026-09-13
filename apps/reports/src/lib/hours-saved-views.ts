import type { ViewConfig } from "@/lib/hours-saved-views-actions";

export type { ViewConfig };

// ── The I/O-free half of Hours Saved Views ──────────────────────────────────
//
// Same split as table-sort.ts/hours-filters.ts: no React, no localStorage/window
// access here (functions take strings/objects in, return values out) — so the tricky
// parts (a rename's name-collision check, and especially fixupDefaultPointer's "does
// this rename/delete affect the pointer" logic) have a test that doesn't need a DOM.
// hours-saved-views-actions.ts and HoursViewsMenu.tsx do the I/O this composes with.

// The full set of /hours query params a view snapshots. `page` is deliberately
// excluded — a view is "what you're filtering/grouping/sorting to," not which page you
// happened to be on, consistent with the app's existing rule that any filter change
// clears `page`. `view` is excluded too — it's the label param itself, never data.
export const HOURS_VIEW_PARAMS = ["jobs", "employees", "sections", "departments", "from", "to", "groupBy", "sort", "dir"] as const;

export const HOURS_MY_VIEWS_KEY = "hours-my-views";
export const HOURS_DEFAULT_VIEW_KEY = "hours-default-view";

export type MyViews = Record<string, ViewConfig>;
export type DefaultPointer = { tier: "mine"; name: string };

function isViewConfig(v: unknown): v is ViewConfig {
  return typeof v === "object" && v !== null && typeof (v as { params?: unknown }).params === "object" && (v as { params?: unknown }).params !== null;
}

export function parseMyViews(raw: string | null): MyViews {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: MyViews = {};
    for (const [name, config] of Object.entries(parsed as Record<string, unknown>)) {
      if (isViewConfig(config)) out[name] = config;
    }
    return out;
  } catch {
    return {};
  }
}

export function parseDefaultPointer(raw: string | null): DefaultPointer | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { tier?: unknown }).tier === "mine" &&
      typeof (parsed as { name?: unknown }).name === "string" &&
      (parsed as { name: string }).name.length > 0
    ) {
      return { tier: "mine", name: (parsed as { name: string }).name };
    }
    return null;
  } catch {
    return null;
  }
}

/** Snapshots the allowlisted params out of a search string (pass `window.location.search`
 *  — this takes the string directly, not `window`, so it's testable). Works whether or
 *  not `search` has a leading "?". Only keys actually present are stored, so an absent
 *  filter stays absent rather than round-tripping as an explicit empty string. */
export function snapshotFromSearch(search: string): ViewConfig {
  const params: Record<string, string> = {};
  const sp = new URLSearchParams(search);
  for (const k of HOURS_VIEW_PARAMS) {
    const val = sp.get(k);
    if (val !== null) params[k] = val;
  }
  return { params };
}

/** Builds a `/hours?...` href for applying a view — the caller decides push vs.
 *  replace (loading a view from the menu vs. auto-applying a default on mount need
 *  different history behavior, see HoursViewsMenu.tsx). `?view=` is label-only,
 *  ignored for data, same convention ProjectViewsMenu already uses. */
export function hrefForView(config: ViewConfig, name: string): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(config.params)) sp.set(k, v);
  sp.set("view", name);
  return `/hours?${sp.toString()}`;
}

export function renameMyView(
  all: MyViews,
  oldName: string,
  newName: string,
): { ok: true; views: MyViews; name: string } | { ok: false; error: string } {
  const clean = newName.trim();
  if (!clean) return { ok: false, error: "Give the view a name." };
  if (!(oldName in all)) return { ok: false, error: `"${oldName}" no longer exists.` };
  if (clean !== oldName && clean in all) return { ok: false, error: `You already have a view named "${clean}".` };
  if (clean === oldName) return { ok: true, views: all, name: clean }; // no-op rename
  const { [oldName]: config, ...rest } = all;
  return { ok: true, views: { ...rest, [clean]: config }, name: clean };
}

export function deleteMyView(all: MyViews, name: string): MyViews {
  const { [name]: _removed, ...rest } = all;
  return rest;
}

/**
 * What the default pointer SHOULD become after a rename or delete elsewhere touches
 * the "mine" view it names. Never CREATES a pointer, only clears or repoints an
 * existing one — renaming/deleting a view nobody had defaulted to is always a no-op.
 * Pulled out on its own because it is the one place this feature is easy to get subtly
 * wrong: skip it and a stale pointer either silently stops resolving, or — worse —
 * starts resolving to a different view that later reuses the same name.
 */
export function fixupDefaultPointer(
  ptr: DefaultPointer | null,
  change: { kind: "rename"; from: string; to: string } | { kind: "delete"; name: string },
): DefaultPointer | null {
  if (!ptr) return null;
  if (change.kind === "rename") {
    return ptr.name === change.from ? { tier: "mine", name: change.to } : ptr;
  }
  return ptr.name === change.name ? null : ptr;
}
