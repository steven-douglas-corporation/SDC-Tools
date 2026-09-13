import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setRealtimeStatus,
  readRealtimeStatus,
  readRealtimeGaps,
  __resetRealtimeStatus,
} from "../src/lib/realtime-status";
import { changeVersionMoved } from "../src/lib/change-version";
import { focusRefreshIsWorthIt } from "../src/components/LiveRefresh";

// The rule that decides whether clicking back into the window re-renders the
// heaviest route in the app (§32.5, §33.13).
//
// Getting it wrong in one direction costs a ~656KB payload and a full database read
// on every alt-tab; getting it wrong in the other leaves a tab showing figures a
// colleague has already changed — which is the §33 complaint. So both directions are
// pinned, and so is the reason the gate cannot simply trust the realtime feed.

const NOT_MOVED = false;
const MOVED = true;

test("nothing saved anywhere and a live stream: a focus refresh is pointless", () => {
  // The common case. Alt-tab to Excel and back twenty times an hour and the grid is
  // never re-rendered.
  assert.equal(focusRefreshIsWorthIt("live", 0, NOT_MOVED), false);
});

test("something WAS saved: refresh, even though the stream is live and never dropped", () => {
  // This is the case the first version of this gate got wrong. Only the ETC grid's
  // save path publishes change events, so a Projects edit, an ETC Rates change or a
  // pool edit is completely silent on the feed. Trusting the stream would have made
  // those changes invisible until the interval — worse than the behaviour being
  // replaced. The version marker is what catches them.
  assert.equal(focusRefreshIsWorthIt("live", 0, MOVED), true);
});

test("a stream that is down means this tab is a snapshot — refresh on focus", () => {
  assert.equal(focusRefreshIsWorthIt("offline", 0, NOT_MOVED), true);
});

test("a stream that has never connected also refreshes", () => {
  // "connecting" covers the first moments after load and the backoff between
  // retries. Neither is a state in which push can be relied on.
  assert.equal(focusRefreshIsWorthIt("connecting", 0, NOT_MOVED), true);
});

test("a stream that dropped and recovered while the tab was hidden still refreshes", () => {
  // Presence cannot be replayed, so this tab may be showing editing indicators for
  // people who left ten minutes ago — worth a refresh even when no VALUE changed.
  assert.equal(focusRefreshIsWorthIt("live", 1, NOT_MOVED), true);
});

// ── The version marker's comparison rule ────────────────────────────────────

test("an unchanged marker is the only 'you are current' answer", () => {
  assert.equal(changeVersionMoved(1200, 1200), false);
});

test("a higher marker means something was saved", () => {
  assert.equal(changeVersionMoved(1200, 1201), true);
});

test("never having synced counts as stale", () => {
  // The first focus after a page load establishes the baseline rather than assuming
  // the payload it loaded with is still current.
  assert.equal(changeVersionMoved(null, 1200), true);
});

test("an unreadable marker counts as stale, not as 'nothing changed'", () => {
  // A failed query, a 401, a malformed body. Refusing to refresh here would let one
  // bad read pin a tab stale indefinitely.
  assert.equal(changeVersionMoved(1200, null), true);
  assert.equal(changeVersionMoved(null, null), true);
});

test("a marker that went BACKWARDS is treated as a misread, so it refreshes", () => {
  // AuditLog is append-only; MAX(id) cannot decrease. A lower value means the reading
  // is wrong, and a wrong reading must not be trusted as proof of currency.
  assert.equal(changeVersionMoved(1200, 900), true);
});

test("the two signals compose: a moved version wins over an otherwise-quiet gate", () => {
  const quiet = focusRefreshIsWorthIt("live", 0, changeVersionMoved(500, 500));
  const changed = focusRefreshIsWorthIt("live", 0, changeVersionMoved(500, 501));
  assert.equal(quiet, false);
  assert.equal(changed, true);
});

// ── The gap counter itself ──────────────────────────────────────────────────

test("losing a live connection counts as a gap", () => {
  __resetRealtimeStatus();
  setRealtimeStatus("live");
  assert.equal(readRealtimeGaps(), 0);
  setRealtimeStatus("offline");
  assert.equal(readRealtimeGaps(), 1);
});

test("never having connected is NOT a gap", () => {
  __resetRealtimeStatus();
  // connecting -> offline on the very first attempt. No events were missed: the page
  // was server-rendered after anything the stream would have carried.
  setRealtimeStatus("offline");
  assert.equal(readRealtimeGaps(), 0);
});

test("a reconnect does not clear the gap that preceded it", () => {
  __resetRealtimeStatus();
  setRealtimeStatus("live");
  setRealtimeStatus("offline");
  setRealtimeStatus("live");
  // Still 1. The reader compares two readings to decide whether IT has caught up; the
  // store must not decide that on the reader's behalf.
  assert.equal(readRealtimeGaps(), 1);
  assert.equal(readRealtimeStatus(), "live");
});

test("repeated identical statuses do not inflate the count", () => {
  __resetRealtimeStatus();
  setRealtimeStatus("live");
  setRealtimeStatus("live");
  setRealtimeStatus("offline");
  setRealtimeStatus("offline");
  assert.equal(readRealtimeGaps(), 1);
});

test("two separate outages count twice, so a reader that synced between them sees the second", () => {
  __resetRealtimeStatus();
  setRealtimeStatus("live");
  setRealtimeStatus("offline");
  setRealtimeStatus("live");
  const syncedAt = readRealtimeGaps(); // a refresh happened here
  setRealtimeStatus("offline");
  setRealtimeStatus("live");
  assert.equal(readRealtimeGaps() - syncedAt, 1, "the outage since the last sync is visible");
  assert.equal(focusRefreshIsWorthIt(readRealtimeStatus(), readRealtimeGaps() - syncedAt, NOT_MOVED), true);
});

test("after a refresh records both markers, a quiet live stream stops asking again", () => {
  __resetRealtimeStatus();
  setRealtimeStatus("live");
  setRealtimeStatus("offline");
  setRealtimeStatus("live");
  const syncedAtGaps = readRealtimeGaps();
  const syncedAtVersion = 4242;
  assert.equal(
    focusRefreshIsWorthIt(readRealtimeStatus(), readRealtimeGaps() - syncedAtGaps, changeVersionMoved(syncedAtVersion, 4242)),
    false,
  );
});
