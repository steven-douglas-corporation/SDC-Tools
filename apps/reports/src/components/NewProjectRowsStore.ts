"use client";

import { useSyncExternalStore } from "react";

// Session-only (not persisted) list of pending "add a new project" rows —
// clicking "+ Add Project" no longer navigates to a separate page; it drops
// a blank editable row into the live Projects table instead. Same
// external-store pattern as Sidebar.tsx's collapse toggle, just for an array
// instead of a boolean, so the button (in the page header) and the row
// renderer (inside <tbody>, far away in the tree) can share state without a
// Context provider wrapping the whole page.
// A stable empty-array reference — useSyncExternalStore requires
// getServerSnapshot (and getSnapshot, before anything's been added) to
// return the SAME reference across calls, or React treats it as a changed
// value on every render and loops (`getServerSnapshot should be cached`).
// A fresh `[]` literal per call, which the naive version of this returned,
// is a new reference every time.
const EMPTY_IDS: string[] = [];

let tempIds: string[] = EMPTY_IDS;
let counter = 0;
const listeners = new Set<() => void>();

function getSnapshot() {
  return tempIds;
}
function getServerSnapshot() {
  return EMPTY_IDS;
}
function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function addNewProjectRow() {
  counter += 1;
  tempIds = [...tempIds, `new-${counter}`];
  listeners.forEach((cb) => cb());
}

export function removeNewProjectRow(tempId: string) {
  tempIds = tempIds.filter((id) => id !== tempId);
  listeners.forEach((cb) => cb());
}

export function useNewProjectRowIds(): string[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
