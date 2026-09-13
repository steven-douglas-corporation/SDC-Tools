"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { requestLiveRefresh, requestThrottledLiveRefresh } from "@/components/LiveRefresh";
import { applyRemoteEtcValues } from "@/lib/etc-remote-values";
import {
  setRealtimeStatus,
  subscribeRealtimeStatus,
  readRealtimeStatus,
  type RealtimeStatus,
} from "@/lib/realtime-status";

// The client half of the realtime layer, mounted once for the whole app.
//
// Holds one EventSource and exposes what the UI needs from it:
//   • who is editing which cell (the indicator — spec 3)
//   • a queue of recent changes (the notification banner — spec 5)
//   • a way for a cell to say "I'm editing this" / "I'm done"
//
// A module-scope store rather than React context, for the same reason as
// etc-dirty-tracker and etc-live-totals: the consumers are ~800 independent cell
// components with no common ancestor short of the page, and putting this in context
// would re-render the entire grid every time anybody's presence changed. Components
// subscribe to the ONE key they care about.

export type PresenceEntry = {
  sessionId: string;
  userName: string;
  tab: string;
  rowRef: string;
  columnName: string;
  cellKey: string;
};

export type ChangeEvent = {
  changeId: string;
  userName: string;
  tab: string;
  rowRef: string;
  columnName: string;
  previousValue: string | null;
  newValue: string | null;
  changeType: string;
  at: string;
  message: string;
  // The cell this change belongs to, when it is one cell: the affected input's
  // form-field name. Lets a browser update that single cell instead of refetching
  // the whole route — see lib/etc-remote-values.ts. `altCellKey` is the same cell's
  // other legitimate name (entry-id form vs job+section form), because two browsers
  // can be holding different ones. Optional on purpose: a bulk change has no cell.
  cellKey?: string;
  altCellKey?: string;
  // Transport only — sync on this event, but draw no card for it. Set by the
  // app's own background work (the refresh pass), whose completion is already
  // reported by the toast the person who clicked it is watching for. See
  // `system` in lib/change-log.ts.
  system?: boolean;
};

// ── This tab's identity ─────────────────────────────────────────────────────
// Per TAB, not per user: one manager with the grid open twice is two editors, and
// closing one window must not clear the indicator the other is holding.
// sessionStorage (not localStorage) is exactly per-tab and survives a reload, so a
// refresh reclaims its own presence rather than orphaning it.
const SESSION_KEY = "sdc-realtime-session";

function tabSessionId(): string {
  if (typeof window === "undefined") return "";
  let id = window.sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = `s_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    window.sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

// ── Presence store ──────────────────────────────────────────────────────────
let presenceByCell = new Map<string, PresenceEntry[]>();
const presenceListeners = new Set<() => void>();
let mySessionId = "";

function emitPresence() {
  for (const l of presenceListeners) l();
}

function setPresence(entries: PresenceEntry[]) {
  const next = new Map<string, PresenceEntry[]>();
  for (const e of entries) {
    // A user's own indicator is not shown to themselves — they know they are in the
    // cell. Filtered here rather than in each component so there is one rule.
    if (e.sessionId === mySessionId) continue;
    const list = next.get(e.cellKey);
    if (list) list.push(e);
    else next.set(e.cellKey, [e]);
  }
  presenceByCell = next;
  emitPresence();
}

export function subscribeCellPresence(cellKey: string, cb: () => void): () => void {
  // Coarse subscription — every listener is notified on any presence change and
  // re-reads its own key. With a few dozen editors that is cheaper than
  // maintaining per-key listener sets, and it cannot go stale.
  void cellKey;
  presenceListeners.add(cb);
  return () => presenceListeners.delete(cb);
}

export function readCellPresence(cellKey: string): PresenceEntry[] {
  return presenceByCell.get(cellKey) ?? EMPTY;
}
const EMPTY: PresenceEntry[] = [];

// ── Telling the server what this tab is editing ─────────────────────────────
const HEARTBEAT_MS = 10_000; // hub TTL is 30s, so two missed beats are tolerated
const held = new Set<string>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

type CellRef = { tab: string; rowRef: string; columnName: string; cellKey: string };
const heldRefs = new Map<string, CellRef>();

function post(body: Record<string, unknown>, viaBeacon = false): void {
  const payload = JSON.stringify({ ...body, sessionId: mySessionId || tabSessionId() });
  const url = "/api/realtime/presence";
  // sendBeacon survives the page going away, which a fetch does not — this is what
  // makes "closed the tab" release the cell rather than waiting out the TTL.
  if (viaBeacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
    return;
  }
  void fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, keepalive: true }).catch(
    () => {
      // Presence is advisory. A failed beat means the entry expires 30s later,
      // which is the correct outcome for a browser that cannot reach the server.
    },
  );
}

// Call when a cell gains focus.
export function beginEditingCell(ref: CellRef): void {
  if (!ref.cellKey) return;
  heldRefs.set(ref.cellKey, ref);
  held.add(ref.cellKey);
  post({ action: "enter", ...ref });
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      // Only beat while the tab is visible. A backgrounded tab is not "actively
      // editing" — spec 3 requires an inactive user's indicator to clear, and
      // simply not beating is what expires it.
      if (document.visibilityState !== "visible") return;
      for (const ref2 of heldRefs.values()) post({ action: "enter", ...ref2 });
    }, HEARTBEAT_MS);
  }
}

// Call on blur, after a save, or on cancel — all three mean "no longer editing".
export function endEditingCell(cellKey: string): void {
  if (!cellKey || !held.has(cellKey)) return;
  held.delete(cellKey);
  heldRefs.delete(cellKey);
  post({ action: "leave", cellKey });
  if (held.size === 0 && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function releaseEverything(viaBeacon: boolean): void {
  if (held.size === 0) return;
  held.clear();
  heldRefs.clear();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  post({ action: "leaveAll" }, viaBeacon);
}

// ── Change notifications ────────────────────────────────────────────────────
// A queue, not a single slot: spec 5 requires multiple notifications to be queued
// or grouped rather than replacing each other. Bounded, because a bulk sync can
// announce hundreds and an unbounded list would grow all day.
const MAX_QUEUED = 40;
let changeQueue: ChangeEvent[] = [];
const changeListeners = new Set<() => void>();

function pushChanges(events: ChangeEvent[]) {
  // Newest first, de-duplicated on the composite identity of a change: the same
  // event can arrive twice if a reconnect replays it.
  const seen = new Set(changeQueue.map((c) => `${c.changeId}|${c.rowRef}|${c.columnName}`));
  const fresh = events.filter((e) => !seen.has(`${e.changeId}|${e.rowRef}|${e.columnName}`));
  if (fresh.length === 0) return;
  changeQueue = [...fresh, ...changeQueue].slice(0, MAX_QUEUED);
  for (const l of changeListeners) l();
}

export function subscribeChanges(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

export function readChanges(): ChangeEvent[] {
  return changeQueue;
}

export function dismissChange(changeId: string, rowRef: string, columnName: string): void {
  changeQueue = changeQueue.filter((c) => !(c.changeId === changeId && c.rowRef === rowRef && c.columnName === columnName));
  for (const l of changeListeners) l();
}

export function dismissAllChanges(): void {
  changeQueue = [];
  for (const l of changeListeners) l();
}

// ── Connection state, for the banner to be honest about ─────────────────────
//
// The store itself is in lib/realtime-status.ts so LiveRefresh can read it without
// an import cycle (this file imports requestLiveRefresh from it). Re-exported here
// because this is where consumers already look for it.
const setStatus = setRealtimeStatus;
export { subscribeRealtimeStatus, readRealtimeStatus };
export type { RealtimeStatus };

export function RealtimeProvider() {
  const retryRef = useRef(0);

  useEffect(() => {
    mySessionId = tabSessionId();
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      source = new EventSource(`/api/realtime/stream?sessionId=${encodeURIComponent(mySessionId)}`);

      source.onopen = () => {
        retryRef.current = 0;
        setStatus("live");
        // A reconnect means events were missed while the connection was down, and
        // presence/changes cannot be replayed. Re-read the page so this tab is
        // correct again — the cells adopt only what the user has not diverged from
        // (see LiveRefresh), so this cannot disturb typing.
        requestLiveRefresh();
      };

      source.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as
            | { type: "presence"; entries: PresenceEntry[] }
            | { type: "changes"; events: ChangeEvent[] }
            | { type: "hello"; sessionId: string }
            | { type: "permissions" };
          if (data.type === "presence") setPresence(data.entries);
          else if (data.type === "permissions") {
            // The Role Permissions matrix changed — no cell to patch, no diff to
            // apply client-side (unlike a "changes" event): every page under
            // this layout re-checks its OWN permission fresh on the next
            // server render, so a plain refresh is what makes the sidebar and
            // any now-unauthorized open page update themselves, with no new
            // client-side permission logic at all. Unconditional, not
            // throttled — this fires only when an ELT user deliberately saves
            // a change, never in a burst.
            requestLiveRefresh();
          } else if (data.type === "changes") {
            pushChanges(data.events);
            // ── Incremental first, refetch only if we must (2026-08-04) ────────
            //
            // This used to be an unconditional requestLiveRefresh(), which is the
            // single most expensive thing this app can do — on Monthly ETC, an
            // 854 KB payload and a ~600ms server render of 4,150 cells — fired on
            // the most frequent event there is. One colleague autosaving eight
            // cells was eight full re-renders of the page, in every open tab,
            // while people were typing in it. That is where "the app feels laggy"
            // came from.
            //
            // A New ETC change is one number in one cell, and the event now says
            // which cell (CellChange.cellKey). So it is applied straight to that
            // cell — no network, no refetch, one component re-rendered.
            const applied = applyRemoteEtcValues(data.events);
            // Anything NOT addressable to a cell still needs the server: a change on
            // another tab, a bulk sync, or an event from a server build that predates
            // cellKey. Throttled rather than immediate, because the case that hurt was
            // always a BURST — twenty cells saved in one pass should cost one refresh,
            // not twenty.
            if (applied < data.events.length) requestThrottledLiveRefresh();
          }
        } catch {
          // A malformed frame must not kill the stream.
        }
      };

      source.onerror = () => {
        setStatus("offline");
        source?.close();
        source = null;
        if (closed) return;
        // Exponential backoff, capped. EventSource reconnects on its own, but only
        // for a clean close — an auth failure or a 500 leaves it retrying in a
        // tight loop, which is what this replaces.
        retryRef.current = Math.min(retryRef.current + 1, 6);
        const delay = Math.min(1000 * 2 ** (retryRef.current - 1), 30_000);
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    // Releasing presence when the tab goes away or is hidden. `pagehide` rather
    // than `unload` (which is unreliable and blocks the back/forward cache), plus
    // visibilitychange for the "became inactive" case.
    const onPageHide = () => releaseEverything(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") releaseEverything(true);
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      releaseEverything(false);
      source?.close();
      setStatus("connecting");
    };
  }, []);

  return null;
}

// ── Reading the stores from React ───────────────────────────────────────────
//
// useSyncExternalStore, not useState-plus-effect: these are external stores, which
// is exactly what it exists for. It also avoids the setState-in-effect pattern this
// repo lints against, and gives a correct server snapshot for the SSR pass (nothing
// is being edited and nothing has changed yet, by definition).
//
// Every getSnapshot below returns a STABLE reference between emits — the stores
// replace their containers rather than mutating them — which is what keeps
// useSyncExternalStore from looping.

export function useRealtimeChanges(): ChangeEvent[] {
  return useSyncExternalStore(subscribeChanges, readChanges, () => NO_CHANGES);
}
const NO_CHANGES: ChangeEvent[] = [];

export function useRealtimeStatus(): RealtimeStatus {
  return useSyncExternalStore(subscribeRealtimeStatus, readRealtimeStatus, () => "connecting" as RealtimeStatus);
}

// Presence for one cell. Used by the indicator on each editable cell, so this runs
// ~800 times on the ETC grid — hence the stable-reference rule above.
export function useCellPresence(cellKey: string): PresenceEntry[] {
  const subscribe = useCallback((cb: () => void) => subscribeCellPresence(cellKey, cb), [cellKey]);
  const read = useCallback(() => readCellPresence(cellKey), [cellKey]);
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}
