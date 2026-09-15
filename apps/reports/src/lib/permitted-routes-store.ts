"use client";

import { useSyncExternalStore } from "react";

// ── The role's visible routes, shared with the workspace's chrome ────────────
//
// app/(app)/layout.tsx computes `visibleHrefs` on the server (from the live Role
// Permissions matrix) and hands it to Sidebar. The tab bar lives on the other side
// of the layout/page boundary — WorkspaceShell is rendered by /w's page — so it
// cannot receive that prop without hoisting the workspace into the layout. Same
// shape of problem, same answer, as lib/workspace-store.ts: a module-scope store
// published by the component that has the value and read by the ones that need it.
//
// `null` means "not published yet" (the first client render before Sidebar's
// effect runs), which readers treat as "no filtering" rather than as "nothing
// permitted" — an empty tab-bar menu on every cold load would read as broken.

let current: readonly string[] | null = null;
const listeners = new Set<() => void>();

export function publishPermittedRoutes(hrefs: readonly string[]): void {
  // Compared by value: the layout hands Sidebar a fresh array on every server
  // render, and republishing an equal list would wake every reader for nothing.
  if (current && current.length === hrefs.length && current.every((h, i) => h === hrefs[i])) return;
  current = [...hrefs];
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const getSnapshot = () => current;
const getServerSnapshot = () => null;

/** The routes this role may open as tabs, or null before the sidebar has said. */
export function usePermittedRoutes(): readonly string[] | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Test seam. */
export function __resetPermittedRoutes(): void {
  current = null;
  listeners.clear();
}
