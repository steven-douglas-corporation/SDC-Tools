"use client";

import { useSyncExternalStore } from "react";
import type { Workspace } from "@/lib/workspace";

// ── The LIVE workspace, shared by the shell and the sidebar ──────────────────
//
// REPORTED 2026-09-04: "a page is already open as a top tab; clicking it in the
// sidebar does not reliably switch to that tab."
//
// ── Why it was unreliable, exactly ──────────────────────────────────────────
//
// The tab strip and the sidebar are on opposite sides of the layout/page boundary —
// Sidebar is rendered by the (app) layout, WorkspaceShell by /w's page — so they had
// no shared state and both read the workspace out of the URL instead.
//
// That worked while every tab action was a router navigation. It stopped working the
// moment switching tabs became instant, because instant means `history.replaceState`,
// and replaceState deliberately does NOT notify the Next router. `useSearchParams()`
// therefore kept returning the params from the last REAL navigation, so the sidebar was
// reading a workspace that could be several tab operations out of date:
//
//   • it resolved "is this page already open?" against a stale tab list, so a tab
//     opened since the last navigation was invisible to it and the click opened a
//     second one;
//   • the href it built carried the stale `a=`, so a click could land on whichever
//     tab happened to be active several switches ago;
//   • tabs opened, closed or reordered since were silently reverted by navigating to
//     that stale URL.
//
// "Not reliably" is exactly the shape that produces: it depended on how many tab
// switches had happened since the last navigation.
//
// ── The fix, and why a module-scope store ──────────────────────────────────
//
// One live copy of the workspace that both sides read, published by whoever owns it.
// A React context cannot span this boundary without hoisting the whole workspace into
// the layout — which would put /w's state above every other route. A module-scope
// store with useSyncExternalStore is the pattern this codebase already uses for
// exactly this shape of problem (lib/etc-dirty-tracker.ts, lib/etc-live-totals.ts):
// state that several components on different branches of the tree must agree on.
//
// The URL is still written on every change and is still what a reload restores. It is
// simply no longer how one live component asks another what is on screen.

let current: Workspace | null = null;
let applyFn: ((next: Workspace, opts?: { navigate?: boolean }) => void) | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const l of listeners) l();
};

/**
 * The shell publishes here on mount and after every change.
 *
 * Null when no workspace is on screen — every ordinary route — which is what tells the
 * sidebar to fall back to plain navigation.
 */
export function publishWorkspace(ws: Workspace | null): void {
  if (current === ws) return;
  current = ws;
  emit();
}

/**
 * The shell registers its commit function so anything else can drive the tabs without
 * a navigation — the sidebar being the whole point.
 *
 * Returns an unregister for the shell's unmount effect. Leaving a stale `apply` behind
 * would let a sidebar click call into an unmounted tree.
 */
export function registerWorkspaceApply(
  fn: (next: Workspace, opts?: { navigate?: boolean }) => void,
): () => void {
  applyFn = fn;
  return () => {
    if (applyFn === fn) {
      applyFn = null;
      current = null;
      emit();
    }
  };
}

/**
 * Drive the live workspace. False when there is nobody to drive — the caller should
 * fall back to navigating.
 */
export function applyWorkspace(next: Workspace, opts?: { navigate?: boolean }): boolean {
  if (!applyFn) return false;
  applyFn(next, opts);
  return true;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const getSnapshot = () => current;
// The server has no live workspace — /w decodes its own from the URL, and the sidebar
// renders plain hrefs until hydration. A stable null keeps useSyncExternalStore from
// looping on a fresh object each call.
const getServerSnapshot = () => null;

/**
 * The workspace as it is RIGHT NOW, or null when none is mounted.
 *
 * Every consumer must treat null as "not in the workspace" rather than as "empty
 * workspace": on an ordinary route there is no tab strip at all, and the two states
 * want opposite behaviour from a sidebar click.
 */
export function useLiveWorkspace(): Workspace | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
