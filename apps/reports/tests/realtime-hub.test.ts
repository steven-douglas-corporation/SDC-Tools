import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRESENCE_TTL_MS,
  isPresenceLive,
  subscribe,
  enterCell,
  leaveCell,
  leaveAll,
  publishChanges,
  currentPresence,
  connectedSessionCount,
} from "../src/lib/realtime-hub";

// The realtime hub backs two requirements that are only as good as their edge cases:
// the "who is editing this cell" indicator (spec 3) and the change-notification
// broadcast (spec 5). What matters is that an indicator NEVER outlives the editing:
// a stale "Sarah is here" is worse than none, because it is the thing people are
// meant to trust before typing over somebody.
//
// Spec 3 lists five ways editing must stop — left the cell, saved, cancelled,
// disconnected, went inactive. The first three are one signal (leave), the fourth is
// the subscription ending, and the fifth is the TTL. All five are covered below.
//
// Module-scope state, so every test cleans up after itself.

type Envelope = { type: string; entries?: unknown[]; events?: unknown[]; sessionId?: string };

function collector() {
  const seen: Envelope[] = [];
  return { seen, send: (e: unknown) => seen.push(e as Envelope) };
}

const cell = (over: Partial<Parameters<typeof enterCell>[0]> = {}) => ({
  sessionId: "s1",
  userName: "Sarah Jones",
  tab: "Monthly ETC",
  rowRef: "1148",
  columnName: "New ETC (ME Gen)",
  cellKey: "newEtcOverride__501",
  ...over,
});

// ── The expiry rule (the "went inactive" case) ──────────────────────────────

test("a fresh heartbeat is live", () => {
  assert.equal(isPresenceLive(1_000_000, 1_000_000), true);
});

test("presence expires once the TTL has passed with no heartbeat", () => {
  const now = 1_000_000;
  assert.equal(isPresenceLive(now - PRESENCE_TTL_MS + 1, now), true, "just inside the window");
  assert.equal(isPresenceLive(now - PRESENCE_TTL_MS, now), false, "exactly at the edge is expired");
  assert.equal(isPresenceLive(now - PRESENCE_TTL_MS - 1, now), false);
});

test("the TTL tolerates at least two missed 10s heartbeats", () => {
  // The client beats every 10s. If the TTL were tighter than 20s a single dropped
  // request would make a colleague's indicator flicker off while they were typing.
  assert.ok(PRESENCE_TTL_MS >= 20_000, `TTL ${PRESENCE_TTL_MS}ms is too tight for a 10s heartbeat`);
});

// ── Subscribe / broadcast ───────────────────────────────────────────────────

test("a new subscriber is handed the current state immediately", () => {
  const a = collector();
  const unsubA = subscribe("s1", a.send);
  // hello + presence, so a tab that just opened is not blank until the next event.
  assert.deepEqual(a.seen.map((e) => e.type), ["hello", "presence"]);
  unsubA();
});

test("entering a cell tells the OTHER subscribers", () => {
  const a = collector();
  const b = collector();
  const unsubA = subscribe("s1", a.send);
  const unsubB = subscribe("s2", b.send);
  b.seen.length = 0;

  enterCell(cell());
  const presenceFrames = b.seen.filter((e) => e.type === "presence");
  assert.equal(presenceFrames.length, 1, "one presence broadcast per new claim");
  assert.equal((presenceFrames[0].entries as { cellKey: string }[])[0].cellKey, "newEtcOverride__501");

  leaveAll("s1");
  unsubA();
  unsubB();
});

test("a heartbeat on a cell already held does NOT wake everyone", () => {
  // ~800 cells and a beat every 10s per editor: re-broadcasting on every beat would
  // be constant traffic saying nothing new.
  const b = collector();
  const unsubA = subscribe("s1", () => {});
  const unsubB = subscribe("s2", b.send);
  enterCell(cell());
  b.seen.length = 0;

  enterCell(cell()); // same session, same cell — a heartbeat
  assert.equal(b.seen.filter((e) => e.type === "presence").length, 0);

  leaveAll("s1");
  unsubA();
  unsubB();
});

// ── The five ways editing stops ─────────────────────────────────────────────

test("leaving a cell releases exactly that cell", () => {
  const unsub = subscribe("s1", () => {});
  enterCell(cell({ cellKey: "cellA" }));
  enterCell(cell({ cellKey: "cellB" }));
  assert.equal(currentPresence().length, 2);

  leaveCell("s1", "cellA");
  const keys = currentPresence().map((p) => p.cellKey);
  assert.deepEqual(keys, ["cellB"], "only the cell that was left is released");

  leaveAll("s1");
  unsub();
});

test("leaveAll releases every cell that session held, and nobody else's", () => {
  const unsub1 = subscribe("s1", () => {});
  const unsub2 = subscribe("s2", () => {});
  enterCell(cell({ sessionId: "s1", cellKey: "cellA" }));
  enterCell(cell({ sessionId: "s1", cellKey: "cellB" }));
  enterCell(cell({ sessionId: "s2", cellKey: "cellC", userName: "Nick" }));

  leaveAll("s1");
  const left = currentPresence();
  assert.equal(left.length, 1);
  assert.equal(left[0].sessionId, "s2", "another user's presence is untouched");

  leaveAll("s2");
  unsub1();
  unsub2();
});

test("DISCONNECTING releases that session's cells immediately, not after the TTL", () => {
  // A closed tab must not hold a cell for 30 seconds — that is exactly the stale
  // indicator this is all guarding against.
  const b = collector();
  const unsub1 = subscribe("s1", () => {});
  const unsub2 = subscribe("s2", b.send);
  enterCell(cell({ sessionId: "s1", cellKey: "cellA" }));
  b.seen.length = 0;

  unsub1(); // the SSE stream closed

  assert.equal(currentPresence().length, 0, "the disconnected session holds nothing");
  assert.equal(b.seen.filter((e) => e.type === "presence").length, 1, "others are told at once");

  unsub2();
});

test("two tabs of the same user are independent editors", () => {
  // One manager with the grid open twice: closing one window must not clear the
  // indicator the other is holding.
  const unsubA = subscribe("tabA", () => {});
  const unsubB = subscribe("tabB", () => {});
  enterCell(cell({ sessionId: "tabA", cellKey: "shared" }));
  enterCell(cell({ sessionId: "tabB", cellKey: "shared" }));
  assert.equal(currentPresence().length, 2, "same cell, two sessions, two entries");

  unsubA();
  assert.equal(currentPresence().length, 1, "the other tab still holds it");

  leaveAll("tabB");
  unsubB();
});

// ── Change broadcast ────────────────────────────────────────────────────────

const change = (over: Record<string, unknown> = {}) => ({
  changeId: "c1",
  userName: "John Smith",
  tab: "Monthly ETC",
  rowRef: "ABC",
  columnName: "New ETC",
  previousValue: "120",
  newValue: "110",
  changeType: "edited",
  at: "2026-08-04T14:42:00.000Z",
  message: "John Smith changed New ETC from 120 to 110 for ABC in Monthly ETC",
  ...over,
});

test("a change reaches every connected session, including the author's other tabs", () => {
  // Not excluded from the author's own session: their second monitor showing the
  // same month needs the update as much as anybody's.
  const a = collector();
  const b = collector();
  const unsubA = subscribe("s1", a.send);
  const unsubB = subscribe("s2", b.send);
  a.seen.length = 0;
  b.seen.length = 0;

  publishChanges([change()]);

  for (const [who, c] of [["A", a], ["B", b]] as const) {
    const frames = c.seen.filter((e) => e.type === "changes");
    assert.equal(frames.length, 1, `session ${who} received the change`);
    assert.equal((frames[0].events as { newValue: string }[])[0].newValue, "110");
  }

  unsubA();
  unsubB();
});

test("publishing nothing broadcasts nothing", () => {
  const a = collector();
  const unsub = subscribe("s1", a.send);
  a.seen.length = 0;
  publishChanges([]);
  assert.equal(a.seen.length, 0);
  unsub();
});

test("one dead subscriber does not stop the others being told", () => {
  // A stream can be half-closed when we write to it. The others must still get the
  // event; the route handler's cancel() is what removes the dead one.
  const good = collector();
  const unsubBad = subscribe("bad", () => {
    throw new Error("stream closed");
  });
  const unsubGood = subscribe("good", good.send);
  good.seen.length = 0;

  publishChanges([change()]);
  assert.equal(good.seen.filter((e) => e.type === "changes").length, 1);

  unsubBad();
  unsubGood();
});

test("connectedSessionCount tracks subscribe/unsubscribe", () => {
  const before = connectedSessionCount();
  const unsub = subscribe("counted", () => {});
  assert.equal(connectedSessionCount(), before + 1);
  unsub();
  assert.equal(connectedSessionCount(), before);
});
