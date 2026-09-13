"use client";

import { useSyncExternalStore } from "react";

// ── Another user's saved value, applied to ONE cell ─────────────────────────
//
// THE PERFORMANCE BUG THIS EXISTS FOR (measured 2026-08-04):
//
// Realtime worked, but it worked by asking the server to render the entire page
// again. RealtimeProvider called requestLiveRefresh() on every `changes` frame, and
// on Monthly ETC that means:
//
//     854 KB RSC payload · ~600ms server render · 4,150 table cells reconciled
//
// per event. One colleague autosaving a column of eight cells is eight of those, in
// every open tab, while people are typing. That is the "app feels laggy" report at
// its source — the app was doing its heaviest possible operation as its response to
// its most frequent possible event.
//
// A New ETC change is one number in one cell. This store carries exactly that: the
// server names the cell (CellChange.cellKey — the same form-field name the presence
// indicators already use), the event delivers the new value, and the one cell that
// cares picks it up. No refetch, no re-render of anything else, ~0 bytes.
//
// The route refetch is still the fallback for anything NOT addressable this way (a
// change on another tab, a bulk sync, an event from an older server build) — see
// RealtimeProvider, which now throttles it as well.
//
// ── Why a module store rather than context ──────────────────────────────────
// Same reason as etc-dirty-tracker.ts and etc-live-totals.ts: the readers are ~1,180
// independent cell components with no common ancestor short of the page, and a
// context update would re-render every one of them on every event — which is the
// cost being removed. With useSyncExternalStore each cell reads its OWN key, so a
// value arriving for one cell re-renders one cell: the other 1,179 run their
// getSnapshot (a Map lookup), see the same string back, and React skips them.
//
// ── Staleness: a server render always wins ──────────────────────────────────
// A remote value is a patch on top of the last server render, so it must not outlive
// it. If a full refetch happens afterwards, that payload is newer and more complete
// than anything cached here (it may carry changes whose events this tab never saw —
// a dropped SSE frame, a reconnect gap), so the cell DROPS its remote value the
// moment its server-rendered value changes. See the callers of forgetRemoteEtcValue.
// This is the rule behind acceptance 14/18: an older response can never replace a
// newer result, and a cleared value can never be restored from this cache.

// cellKey -> the raw value the server last announced for it. "" means the cell was
// CLEARED — distinct from having no entry at all, which means "nothing to say about
// this cell". The whole clearing fix (DEVLOG §16) depends on that difference, so it
// is preserved here rather than collapsed to a falsy check.
const remote = new Map<string, string>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

// One change event, reduced to what a cell needs. `cellKey`/`altCellKey` are the two
// names the same cell can post under — an existing row is addressed by entry id
// (`newEtcOverride__123`), a section with no row yet by job+section
// (`newEtcCreate__9__10-211`) — and two browsers can legitimately be holding
// different ones for the same cell, depending on whether the row existed when each
// page rendered. Indexing both is what makes the incremental path work for the
// half of the grid that is create-cells.
export type RemoteCellValue = {
  cellKey?: string | null;
  altCellKey?: string | null;
  // The value as the SERVER stated it, unformatted. null and "" both mean cleared.
  newValue: string | null;
};

// Apply a batch. Returns how many events were cell-addressable, so the caller can
// tell whether a full refetch is still needed for the rest.
export function applyRemoteEtcValues(events: RemoteCellValue[]): number {
  let applied = 0;
  let changed = false;
  for (const e of events) {
    const keys = [e.cellKey, e.altCellKey].filter((k): k is string => typeof k === "string" && k.length > 0);
    if (keys.length === 0) continue;
    applied++;
    const value = e.newValue ?? "";
    for (const k of keys) {
      if (remote.get(k) === value) continue;
      remote.set(k, value);
      changed = true;
    }
  }
  if (changed) emit();
  return applied;
}

// A newer server render has spoken for this cell — see the staleness note above.
export function forgetRemoteEtcValue(cellKey: string): void {
  if (remote.delete(cellKey)) emit();
}

// Test seam / month switch: nothing here survives a change of month, because every
// key belongs to a specific entry in a specific month.
export function clearRemoteEtcValues(): void {
  if (remote.size === 0) return;
  remote.clear();
  emit();
}

export function readRemoteEtcValue(cellKey: string): string | null {
  return remote.has(cellKey) ? remote.get(cellKey)! : null;
}

// Every cell that has had a value announced for it.
//
// The ETC grid does not need this — each of its ~1,180 cells subscribes for its OWN
// key through useRemoteEtcValue, which is what keeps one event from waking the other
// 1,179. The Projects grid is the opposite shape: its cells are server-rendered and
// uncontrolled, so there is no per-cell subscriber to ask, and one component patches
// the named cells in the DOM instead (components/ProjectsRemoteCells.tsx). That
// component needs to know WHICH cells were named.
//
// A fresh array each call, deliberately NOT a live view of the Map: a caller iterating
// this while something else applies a batch would otherwise see the collection change
// under it. It is only ever called from an event handler, so the copy is cheap.
export function remoteCellKeys(): string[] {
  return [...remote.keys()];
}

// Exported as well as used by the hook below: the "no spurious notifications"
// property is a performance claim (every notification wakes ~1,180 cells), so it is
// worth being able to assert it.
export function subscribeRemoteEtcValues(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const subscribe = subscribeRemoteEtcValues;

// null = nothing has been announced for this cell, so the server-rendered value
// stands. A string (including "") IS the announcement.
export function useRemoteEtcValue(cellKey: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => readRemoteEtcValue(cellKey),
    // Server render: there is no store, and the cell's own prop is the truth.
    () => null,
  );
}
