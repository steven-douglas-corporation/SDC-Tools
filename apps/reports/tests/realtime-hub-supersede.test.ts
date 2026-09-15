import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { subscribe, enterCell, publishChanges, currentPresence, connectedSessionCount } from "../src/lib/realtime-hub";

// ── Two streams under one session id (2026-09-14) ───────────────────────────
//
// REPORTED: after the browser's Duplicate Tab (which copies sessionStorage, where the
// id lived) or a reconnect after sleep (which reused it), a tab showed "live" and
// received nothing, and its indicators vanished for everyone else. subscribe()
// overwrote the map entry with the newer send, and the OLDER stream's cancel then
// deleted by id — taking the newer subscription and its presence down with it.
//
// Extends tests/realtime-hub.test.ts; kept separate so the hub's module state is
// exercised by ids no other test uses.

type Envelope = { type: string };

function collector() {
  const seen: Envelope[] = [];
  return { seen, send: (e: unknown) => seen.push(e as Envelope) };
}

const cell = (sessionId: string, cellKey: string) => ({
  sessionId,
  userName: "Sarah Jones",
  tab: "Monthly ETC",
  rowRef: "1148",
  columnName: "New ETC (ME Gen)",
  cellKey,
});

const change = {
  changeId: "c1",
  userName: "x",
  tab: "t",
  rowRef: "r",
  columnName: "c",
  previousValue: null,
  newValue: "1",
  changeType: "edited",
  at: "",
  message: "",
};

test("register A, register B under the same id, unsubscribe A: B is still subscribed", () => {
  const a = collector();
  const b = collector();
  const offA = subscribe("dup", a.send);
  const offB = subscribe("dup", b.send);
  const before = connectedSessionCount();

  offA(); // the OLDER stream's cancel() — a duplicated tab closing, or the dead pre-sleep connection
  assert.equal(connectedSessionCount(), before, "the id is still held");
  publishChanges([change]);
  assert.ok(b.seen.some((e) => e.type === "changes"), "B still receives events");
  assert.equal(a.seen.filter((e) => e.type === "changes").length, 0, "A, which was superseded, does not");
  offB();
  assert.equal(connectedSessionCount(), before - 1);
});

test("the superseded stream's cancel does not release the NEWER stream's cells", () => {
  const a = collector();
  const b = collector();
  const offA = subscribe("dup2", a.send);
  const offB = subscribe("dup2", b.send);
  enterCell(cell("dup2", "k1"));
  assert.equal(currentPresence().filter((e) => e.sessionId === "dup2").length, 1);

  offA();
  assert.equal(currentPresence().filter((e) => e.sessionId === "dup2").length, 1, "the cell is still held — it belongs to B now");

  offB();
  assert.equal(currentPresence().filter((e) => e.sessionId === "dup2").length, 0, "the OWNER's cancel releases it");
});

test("the older stream is told it was superseded, so its route handler can close it", () => {
  const a = collector();
  const b = collector();
  const offA = subscribe("dup3", a.send);
  assert.equal(a.seen.filter((e) => e.type === "superseded").length, 0);
  const offB = subscribe("dup3", b.send);
  assert.equal(a.seen.filter((e) => e.type === "superseded").length, 1, "A is told");
  assert.equal(b.seen.filter((e) => e.type === "superseded").length, 0, "B, the owner, is not");
  offA();
  offB();
});

test("a superseded stream that is already dead does not break the newcomer's registration", () => {
  const dead = () => {
    throw new Error("closed");
  };
  const b = collector();
  const offDead = subscribe("dup4", dead);
  const before = connectedSessionCount();
  const offB = subscribe("dup4", b.send); // must not throw
  assert.ok(b.seen.some((e) => e.type === "hello"));
  offDead();
  assert.equal(connectedSessionCount(), before);
  offB();
});

test("unsubscribing twice is harmless, and never touches a later owner", () => {
  const a = collector();
  const offA = subscribe("dup5", a.send);
  offA();
  const b = collector();
  const offB = subscribe("dup5", b.send);
  const before = connectedSessionCount();
  offA(); // stale closure firing again
  assert.equal(connectedSessionCount(), before);
  offB();
  assert.equal(connectedSessionCount(), before - 1);
});

test("the stream route closes itself on `superseded` instead of unsubscribing the new owner", () => {
  const route = readFileSync(join(process.cwd(), "src", "app", "api", "realtime", "stream", "route.ts"), "utf8");
  assert.match(route, /if \(payload\.type === "superseded"\) \{/);
  assert.match(route, /controller\.close\(\);/);
  const hub = readFileSync(join(process.cwd(), "src", "lib", "realtime-hub.ts"), "utf8");
  assert.match(hub, /if \(subscribers\.get\(sessionId\) !== send\) return;/, "only the current owner may release the id");
});
