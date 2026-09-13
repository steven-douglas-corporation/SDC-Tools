"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isSavingSomewhere } from "@/lib/autosave";
// The store is in lib/, not in RealtimeProvider, because RealtimeProvider imports
// requestLiveRefresh from THIS file — see lib/realtime-status.ts.
import { readRealtimeGaps, readRealtimeStatus, subscribeRealtimeStatus, type RealtimeStatus } from "@/lib/realtime-status";
import { changeVersionMoved, type ChangeVersion } from "@/lib/change-version";
import { sequenced, abandonLane } from "@/lib/request-sequence";

// Keeps an OPEN page in step with what other people have saved.
//
// ── The bug this exists for (2026-08-04) ────────────────────────────────────
// "When I change a value in any cell, other users are not seeing the updated
// value." The obvious suspect was the missing revalidatePath on the save paths.
// It was not that, and it is worth writing down why, because it is the opposite
// of what the Next.js caching documentation leads you to expect:
//
//   * Every route in this app is DYNAMICALLY rendered. app/(app)/layout.tsx
//     awaits next-auth's auth(), which reads cookies, and that forces every page
//     under the (app) group dynamic. The production build agrees — only /login
//     and /_not-found are static.
//   * Nothing in the app uses a Next server-side cache: no unstable_cache, no
//     "use cache", no route-segment revalidate, and `fetch` is uncached by
//     default in this version. Every page reads through Prisma, which is outside
//     Next's caching entirely.
//
// So there was never a stale server cache to invalidate. Every revalidatePath()
// call in the codebase is, server-side, a no-op — its real effect is to make the
// calling action's own response carry a fresh render, which is exactly why the
// person saving always saw their own change and nobody else did.
//
// The actual cause was simpler and had no Next.js in it at all: NOTHING asked the
// server again. No polling, no websocket, no refetch on focus. A page was a
// snapshot taken when it loaded, and it stayed that snapshot until someone
// reloaded by hand. This component is the missing "ask again".
//
// ── Why router.refresh() is the right instrument ────────────────────────────
// It re-fetches the current route's payload from the server. Because the routes
// are dynamic, that is a real database read every time — no cache to defeat. And
// it preserves component state, which is what makes it safe to fire under
// someone's hands: an input the user is typing in keeps their text (see the
// clean/dirty rule in EtcSectionCells, PartsCostNewEtcCell and MoneyCell, which
// adopt a changed server value ONLY when the user has not diverged from it).
//
// ── When it fires ───────────────────────────────────────────────────────────
//   * on focus / tab becoming visible — the high-value trigger. Coming back to a
//     tab is exactly when you expect to see current numbers.
//   * on a slow interval while visible — so a page left open on a second monitor
//     converges without being touched.
//   * on demand, via requestLiveRefresh(), used after a save is refused because
//     another user got there first.
//
// A hidden tab does nothing at all: no interval, no fetch. There is no point
// re-rendering a page nobody is looking at, and on this grid that render is the
// expensive part (59 jobs x 13 sections).

// ── Why focus no longer refreshes unconditionally (§32.5, 2026-08-04) ────────
//
// The comment above describes focus/visibility as "the high-value trigger". It was,
// when this component was the ONLY thing asking the server again. It is not any
// more, and by the time the realtime layer landed it had become the most expensive
// habit in the app:
//
//   * Every alt-tab — to Excel, to Outlook, to Teams and back, which is what this
//     job consists of — re-rendered the whole Monthly ETC route. 4,150 cells,
//     ~656KB of RSC payload, and a real database read every time, because every
//     route here is dynamically rendered and there is no cache to hit.
//   * It fired on `focus` AND `visibilitychange`, which both arrive on a single tab
//     switch in some browsers. The 50ms coalesce merges them into one refresh, so
//     the cost is one render per switch rather than two — but one is already the
//     wrong number when nothing has changed.
//
// Nothing has usually changed, and — this is the part that makes the refresh
// redundant rather than merely expensive — when something HAS changed, this tab has
// already been told:
//
//   * A colleague's save arrives as a realtime change event naming the cell, and is
//     applied straight to that cell with no network at all (lib/etc-remote-values).
//   * An event that names no cell already asks for a throttled refresh (see
//     RealtimeProvider's onmessage).
//   * A stream that DROPS misses events, and cannot replay them — so the reconnect
//     itself calls requestLiveRefresh() from `onopen`. Any gap is covered at the
//     moment it closes, not the next time someone happens to click the window.
//
// So while the stream is live, a focus refresh cannot learn anything the tab does
// not already know. It is skipped. When the stream is NOT live this tab genuinely
// is a snapshot, and focus is exactly the right moment to correct it — so that path
// is unchanged.
//
// The interval keeps its job as the safety net for changes that never published an
// event at all (a direct database edit, or a future sync that forgets to call
// recordChanges). But it no longer needs to be the primary mechanism, because the
// event feed is both faster and cheaper than it — so while the stream is live it
// backs right off. See INTERVAL_MS / LIVE_INTERVAL_MS.

// The stream is down (or has never connected): this tab has no other way to learn
// anything, so keep the original unhurried cadence.
const DEFAULT_INTERVAL_MS = 45_000;
// The stream is live: purely a backstop for changes that published no event. Five
// minutes rather than 45 seconds, because the event feed already delivers a
// colleague's save within a second — far better than the "within a minute" the
// short interval was chosen for.
const LIVE_INTERVAL_MS = 300_000;

// Callers that want to postpone a refresh: a grid with unsaved typing in it. Not a
// hard lock — the blocker only suppresses the BACKGROUND interval, never an
// explicit requestLiveRefresh(), because a refused write has to be corrected on
// screen immediately whatever else is going on.
type Blocker = () => boolean;
const blockers = new Set<Blocker>();

export function registerRefreshBlocker(fn: Blocker): () => void {
  blockers.add(fn);
  return () => blockers.delete(fn);
}

function backgroundRefreshBlocked(): boolean {
  for (const b of blockers) {
    try {
      if (b()) return true;
    } catch {
      // A throwing blocker must not take the whole refresh loop down with it.
    }
  }
  return false;
}

// Set by the mounted component so any client module can ask for a refresh without
// prop-drilling or a context — the same module-scope-store pattern the dirty
// tracker and the live totals already use in this codebase.
let refreshNow: (() => void) | null = null;

// The stream's gap count as of the last time this tab read the server. Anything
// above this means events were missed since then, so a focus refresh has something
// to learn. Module scope so it survives the component's own remounts (a route
// change unmounts and remounts LiveRefresh, and that is not new information).
let syncedAtGaps = 0;

// The change marker (MAX(AuditLog.id)) as of this tab's last read of the server.
// `null` means "never synced", which changeVersionMoved deliberately treats as stale
// — the first focus after a load therefore refreshes once and establishes a baseline,
// rather than assuming the page it loaded with is still current.
let syncedAtVersion: ChangeVersion = null;

export function requestLiveRefresh(): void {
  refreshNow?.();
}

// ── The same request, but at most once per window ───────────────────────────
//
// For callers reacting to a STREAM of events rather than to one decision. The
// realtime change feed is the case: a colleague autosaving a column announces one
// event per cell, and before 2026-08-04 each one triggered a full route refetch —
// 854 KB and a ~600ms server render, per cell, in every open tab. Most of those
// events are now applied to the individual cell with no network at all
// (lib/etc-remote-values.ts); this is the fallback for the ones that cannot be, and
// a burst of them must cost ONE refresh.
//
// Leading edge, then a quiet window: the first event refreshes immediately (so a
// change is on screen at once) and further ones inside the window collapse into a
// single trailing refresh. A pure debounce would delay the first, and a pure throttle
// would drop the last — which on a stream of changes is the one that matters.
const THROTTLE_MS = 5_000;
let lastThrottledAt = 0;
let trailingTimer: ReturnType<typeof setTimeout> | null = null;

// ── One click, one re-render (§6, §7) ───────────────────────────────────────
//
// The application refresh makes this tab current by TWO independent routes at once,
// and only needs one of them:
//
//   1. refreshApplicationData() calls revalidatePath for every page that shows
//      refreshed figures, so the server action's own response re-renders the route the
//      clicker is looking at — and, just as importantly, invalidates the client router
//      cache for the routes they are not, so navigating to Monthly ETC afterwards does
//      not serve a pre-refresh copy.
//   2. the pass calls recordChanges, which publishes a change event with no cellKey, so
//      every connected tab takes the throttled route refresh. That is what updates
//      OTHER people's screens without them reloading.
//
// For everyone else, (2) is the only route and is exactly right. For the person who
// clicked, (2) is a second full render of the heaviest route in the app — on Monthly
// ETC an 854 KB payload and a ~600ms server render — landing on top of the one (1) is
// already doing, for a page (1) has by then made current.
//
// So the clicker suppresses (2) for the span of their own refresh, and keeps (1),
// because (1) is the one that also fixes the other routes' caches.
//
// ── Why a counter and not a timer ─────────────────────────────────────────
//
// A "ignore refreshes for the next N seconds" window would be a guess about when the
// event arrives, and the event arrives BEFORE the action resolves — recordChanges runs
// while the server action is still open. So suppression is armed before the action is
// called and released when it settles, which brackets the event by construction
// instead of by timing.
//
// Nothing is dropped. `release` reports whether anything was actually suppressed, so a
// caller whose refresh did NOT end up calling revalidatePath — a click refused because
// somebody else's pass held the lock, or one that failed — can replay the single
// refresh it swallowed. That case is real: the other user's pass publishes the event
// this tab needs, and (1) never ran for it.
let suppressDepth = 0;
let suppressedWhileArmed = 0;

export function suppressThrottledLiveRefresh(): (opts?: { replay?: boolean }) => void {
  suppressDepth++;
  const armedAt = suppressedWhileArmed;
  let released = false;
  return ({ replay = false } = {}) => {
    if (released) return; // idempotent: a caller may release on both a normal and an error path
    released = true;
    suppressDepth--;
    const swallowed = suppressedWhileArmed - armedAt;
    if (replay && swallowed > 0) refreshNow?.();
  };
}

export function requestThrottledLiveRefresh(): void {
  if (suppressDepth > 0) {
    suppressedWhileArmed++;
    return;
  }
  const now = Date.now();
  if (now - lastThrottledAt >= THROTTLE_MS) {
    lastThrottledAt = now;
    refreshNow?.();
    return;
  }
  if (trailingTimer) return; // one trailing refresh already scheduled
  trailingTimer = setTimeout(() => {
    trailingTimer = null;
    lastThrottledAt = Date.now();
    refreshNow?.();
  }, THROTTLE_MS - (now - lastThrottledAt));
}

// Whether a refresh triggered by focus/visibility can teach this tab anything.
//
// ── Corrected 2026-08-04, same day: the event feed is NOT complete ───────────
//
// The first version of this gate asked only "is the realtime stream live?", on the
// reasoning that a live stream has already delivered every change. That reasoning is
// wrong today, and checking made it plain: `recordChanges` — the one function that
// publishes a change event — is called from etc-actions, monthly-report-actions and
// refresh-service, and from nowhere else. So the ETC grid's own New ETC cells
// announce themselves and NOTHING ELSE DOES. A Projects hours edit, an ETC Rates
// change, a pool edit, a contingency amount, an employee record: all silent.
//
// Gating on the stream alone would therefore have made the app WORSE for exactly the
// changes users are reporting as invisible — a Projects edit would no longer be
// picked up on tab switch, and the only thing left to catch it would be the interval.
//
// So the gate asks the SERVER, cheaply, instead of trusting the feed:
// `latestChangeVersion()` is MAX(AuditLog.id), and every write path in the app
// records an audit row even when it publishes no event. One indexed read (~ms)
// replaces a 4,150-cell re-render, and the answer does not depend on which paths
// happen to broadcast.
//
// A stream gap is still an independent reason to refresh: presence cannot be
// replayed, so a tab that was disconnected may be showing editing indicators for
// people who have long since left.
//
// Pure and exported so the rule is pinned by tests rather than re-derived: it is the
// difference between "the app re-renders its heaviest route every time you click back
// into the window" and "it doesn't", in both directions.
export function focusRefreshIsWorthIt(
  status: RealtimeStatus,
  gapsSinceLastSync: number,
  versionMoved: boolean,
): boolean {
  // Something was saved somewhere since this tab last read the server.
  if (versionMoved) return true;
  // The stream dropped: events AND presence were missed while it was down.
  if (gapsSinceLastSync > 0) return true;
  // Not connected: this tab has no push channel at all, so it cannot trust that it
  // would have been told.
  return status !== "live";
}

export function LiveRefresh({ intervalMs }: { intervalMs?: number } = {}) {
  const router = useRouter();

  useEffect(() => {
    // Coalesce: focus and visibilitychange both fire on a single tab switch in
    // some browsers, and a burst of requestLiveRefresh() calls should be one
    // render, not five.
    let queued = false;
    const run = () => {
      if (queued) return;
      queued = true;
      // A microtask-ish gap is enough to merge the burst without adding a
      // perceptible delay to the focus case.
      setTimeout(() => {
        queued = false;
        // Checked HERE rather than only on the interval path, so it covers focus and
        // visibility too (found by review 2026-08-04 — those two bypassed it). A
        // refresh mid-save can deliver a payload rendered before the write
        // committed, putting the OLD number on screen for a moment: the next pass
        // corrects it, but "my save was undone" is exactly the complaint being
        // fixed, so don't manufacture it.
        //
        // This does NOT swallow the post-conflict requestLiveRefresh(): the save has
        // already resolved by then, so endSaveTracking() has run before this fires.
        if (isSavingSomewhere()) return;
        // The gap count at the moment we became current. Recorded BEFORE the
        // refresh rather than after, so a drop that happens during it still counts
        // as missed and gets its own pass.
        syncedAtGaps = readRealtimeGaps();
        router.refresh();
      }, 50);
    };

    refreshNow = run;

    // Focus and visibility go through the gate; requestLiveRefresh() does NOT, so a
    // reconnect and a refused save still refresh unconditionally. That split is the
    // whole design: an explicit request means a caller knows something happened, and
    // this gate is only for the two triggers that are guesses.
    //
    // Sequenced so a burst of focus events cannot have an older version answer land
    // after a newer one and wrongly conclude the tab is current (§32.2). The lane is
    // abandoned on unmount, so a reply arriving after a route change is dropped.
    const runIfWorthIt = async () => {
      const outcome = await sequenced("live-refresh-version", "latest", async () => {
        const r = await fetch("/api/realtime/version", { cache: "no-store" });
        // A 401 still parses to { v: null }, which changeVersionMoved treats as
        // "refresh" — the safe direction.
        const body = (await r.json()) as { v: number | null };
        return body.v;
      });
      // A superseded check means another focus event is already deciding this; a
      // failed one means we could not tell, and not being able to tell must not be
      // read as "nothing changed".
      const latest = outcome.ok ? outcome.value : null;
      if (!focusRefreshIsWorthIt(readRealtimeStatus(), readRealtimeGaps() - syncedAtGaps, changeVersionMoved(syncedAtVersion, latest))) {
        return;
      }
      // Recorded BEFORE the refresh, so a save landing during it still counts as
      // newer and gets its own pass.
      syncedAtVersion = latest;
      run();
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void runIfWorthIt();
    };
    const onFocus = () => void runIfWorthIt();

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);

    // Re-armed whenever the connection state changes, because the right cadence
    // depends on it: a live stream needs only the slow backstop, a dead one is this
    // tab's only remaining way to learn anything.
    let timer: ReturnType<typeof setInterval> | null = null;
    const arm = () => {
      if (timer) clearInterval(timer);
      const period = intervalMs ?? (readRealtimeStatus() === "live" ? LIVE_INTERVAL_MS : DEFAULT_INTERVAL_MS);
      timer = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        if (backgroundRefreshBlocked()) return;
        run();
      }, period);
    };
    arm();
    const unsubscribeStatus = subscribeRealtimeStatus(arm);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      unsubscribeStatus();
      if (timer) clearInterval(timer);
      // A version check still in flight must not decide anything for the page that
      // replaced this one.
      abandonLane("live-refresh-version");
      if (refreshNow === run) refreshNow = null;
    };
  }, [router, intervalMs]);

  return null;
}
