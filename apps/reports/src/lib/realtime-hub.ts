// ── Server-only, enforced at runtime ────────────────────────────────────────
//
// This module holds PROCESS state — every connected browser's subscription and
// every claimed cell. Bundling it into a client component would give each browser
// its own private copy, and presence would silently stop working: everyone would
// see only themselves.
//
// A runtime throw rather than `import "server-only"`, deliberately. That import is
// a Next build-time alias with no installed package behind it, so any module using
// it cannot be unit-tested with the repo's plain `tsx --test` runner — which is why
// e.g. standard-sheet-gate.ts has no tests of its own. This check is strictly
// stronger for our purposes: it fails just as loudly if the module is ever bundled
// to the browser, AND it lets the concurrency tests below exist.
if (typeof window !== "undefined") {
  throw new Error(
    "lib/realtime-hub.ts is server-only — it holds per-process subscriber and presence state. " +
      "A client component must talk to it over /api/realtime/* instead of importing it.",
  );
}

// ── The realtime hub ────────────────────────────────────────────────────────
//
// One in-process fan-out for two kinds of event:
//
//   • PRESENCE — who is editing which cell, right now. Backs the "Sarah is
//     editing this" indicator, so a second manager sees it BEFORE typing over
//     somebody (spec 3).
//   • CHANGE — what was just added, edited or removed, by whom, from what to
//     what. Backs the notification banner and removes the need to reload to see
//     another user's value (spec 5).
//
// ── Why in-memory is legitimate here, and exactly when it stops being ───────
//
// This app is served by ONE non-cluster `next start` process (ecosystem.config.js
// declares a single app with no `instances`), on a LAN, for a handful of users. A
// module-scope map is therefore genuinely global: every browser is talking to the
// same Node process, so a presence entry written by one request is visible to
// every other.
//
// **This breaks the day anyone adds `instances: 2` or `exec_mode: 'cluster'` to
// ecosystem.config.js, or runs a second instance behind a load balancer.** Each
// process would hold its own map and users would see only the subset of colleagues
// who happened to land on the same worker. If that day comes, the fix is to move
// `subscribers` and `presence` behind Redis pub/sub (or MySQL LISTEN-equivalent
// polling) — the interface below is deliberately narrow so that swap touches this
// file and nothing else. There is a runtime warning for it at the bottom.
//
// SSE rather than WebSockets: the traffic is one-directional (server → browser;
// presence goes up through an ordinary POST), Next route handlers stream natively,
// and there is no extra server, upgrade path or dependency to operate.

export type PresenceEntry = {
  // Stable per browser tab, so one user with two tabs is two editors and closing
  // one does not clear the other.
  sessionId: string;
  userName: string;
  tab: string;
  rowRef: string;
  columnName: string;
  // Opaque key identifying the exact cell, so the client can match an indicator to
  // an input without re-deriving it from the three fields above.
  cellKey: string;
  // Server clock, always — a browser with a wrong clock would otherwise expire
  // instantly or never.
  lastSeen: number;
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
};

type Envelope =
  | { type: "presence"; entries: Omit<PresenceEntry, "lastSeen">[] }
  | { type: "changes"; events: ChangeEvent[] }
  | { type: "hello"; sessionId: string }
  | { type: "permissions" };

// How long a presence entry survives without a heartbeat. The client beats every
// 10s (see useRealtime), so 30s tolerates two missed beats before an editor
// disappears — long enough to ride out a momentary network stall, short enough
// that a closed laptop stops claiming a cell within half a minute.
//
// Spec 3 requires the indicator to clear on leaving the cell, saving, cancelling,
// disconnecting OR going inactive. The first four are explicit signals the client
// sends; THIS is what covers the last one and any signal that never arrives.
export const PRESENCE_TTL_MS = 30_000;

// Extracted so the expiry rule is testable without faking the clock: the hub calls
// it with Date.now(), a test calls it with whatever it likes. `lastSeen` is always a
// SERVER timestamp (see PresenceEntry), so this never compares clocks across
// machines.
export function isPresenceLive(lastSeen: number, now: number, ttlMs: number = PRESENCE_TTL_MS): boolean {
  return lastSeen > now - ttlMs;
}

type Subscriber = (envelope: Envelope) => void;

// ── One hub per PROCESS, not one per bundle (§43, 2026-08-05) ───────────────
//
// These two Maps used to be plain module scope, and that is why saved values never
// reached anybody's screen while presence did.
//
// Three things import this module, and they are not all bundled together:
//
//   api/realtime/stream/route.ts    route handler  — holds the subscribers
//   api/realtime/presence/route.ts  route handler  — same bundle, so presence WORKED
//   lib/change-log.ts               server action  — a DIFFERENT bundle
//
// Next builds server actions and route handlers separately, so each got its own
// instance of this module. `publishChanges`, reached from a server action, was
// broadcasting to an empty `subscribers` Map while the stream route sat holding the
// real one. Nothing errored — the loop simply had nothing to iterate.
//
// That is the exact reported signature: the presence marker appears instantly (route
// handler to route handler), a saved value never arrives over SSE at all, and it shows
// up "late" only when LiveRefresh's poll or a window focus re-fetches the route. It
// also explains why shortening the autosave debounce changed nothing: the broadcast was
// never reaching a subscriber, so saving sooner only made a message nobody received.
//
// globalThis is the standard remedy and the one this repo already uses for Prisma
// (lib/prisma.ts) — with one difference: Prisma only pins it outside production,
// because there the concern is HMR. Here the concern is bundling, which applies in
// production too, so this is unconditional.
//
// This makes the hub one per PROCESS. It is still not shared ACROSS processes, so the
// pre-existing caveat stands: PM2 must run this app with a single instance, or two
// browsers can land on different processes and never see each other. It runs as one
// today (checked 2026-08-05).
type HubState = { subscribers: Map<string, Subscriber>; presence: Map<string, PresenceEntry> };
const globalForHub = globalThis as unknown as { __sdcRealtimeHub?: HubState };
const hub: HubState = (globalForHub.__sdcRealtimeHub ??= {
  subscribers: new Map<string, Subscriber>(), // sessionId -> send
  presence: new Map<string, PresenceEntry>(), // cellKey+session -> entry
});
const { subscribers, presence } = hub;

function presenceKey(sessionId: string, cellKey: string): string {
  return `${sessionId}::${cellKey}`;
}

function livePresence(): PresenceEntry[] {
  const now = Date.now();
  const out: PresenceEntry[] = [];
  for (const [key, e] of presence) {
    if (!isPresenceLive(e.lastSeen, now)) {
      presence.delete(key); // swept lazily — no timer to leak
      continue;
    }
    out.push(e);
  }
  return out;
}

function broadcast(envelope: Envelope, exceptSession?: string): void {
  for (const [sessionId, send] of subscribers) {
    if (sessionId === exceptSession) continue;
    try {
      send(envelope);
    } catch {
      // A dead stream must not stop the others being told. The route handler's
      // own cancel handler is what removes it.
    }
  }
}

// Presence is broadcast as a WHOLE SET rather than as deltas. The set is at most a
// few dozen entries, and a client that missed a delta (reconnect, dropped frame)
// would otherwise show a colleague editing a cell they left ten minutes ago — a
// stale "someone is here" indicator is worse than none, because it is the thing
// people are meant to trust before typing.
function broadcastPresence(): void {
  const entries = livePresence().map(({ lastSeen: _lastSeen, ...rest }) => rest);
  broadcast({ type: "presence", entries });
}

export function subscribe(sessionId: string, send: Subscriber): () => void {
  subscribers.set(sessionId, send);
  // Hand the newcomer the current state immediately — otherwise a tab that just
  // opened shows nobody editing until the next change or heartbeat.
  //
  // Guarded like broadcast() is: a stream can already be closed by the time we
  // write to it (the browser navigated away during setup), and subscribing must
  // never throw into the route handler's start(). Found by the test below —
  // broadcast() had this tolerance and these two initial frames did not.
  try {
    send({ type: "hello", sessionId });
    send({ type: "presence", entries: livePresence().map(({ lastSeen: _l, ...rest }) => rest) });
  } catch {
    // The unsubscribe returned below is still valid, and cancel() will call it.
  }
  return () => {
    subscribers.delete(sessionId);
    // A disconnect releases every cell that session was holding. This is the
    // "disconnects" half of spec 3's clearing rule, and it is immediate rather
    // than waiting out the TTL — a closed tab should not hold a cell for 30s.
    let released = false;
    for (const [key, e] of presence) {
      if (e.sessionId === sessionId) {
        presence.delete(key);
        released = true;
      }
    }
    if (released) broadcastPresence();
  };
}

// A cell has been entered, or is still being edited (heartbeat). Both are the same
// operation: record and refresh.
export function enterCell(entry: Omit<PresenceEntry, "lastSeen">): void {
  const key = presenceKey(entry.sessionId, entry.cellKey);
  const existing = presence.get(key);
  presence.set(key, { ...entry, lastSeen: Date.now() });
  // A heartbeat on a cell already held changes nothing anyone can see, so it must
  // not wake every other browser. Only a genuinely new claim broadcasts.
  if (!existing) broadcastPresence();
}

// Left the cell, saved, or cancelled — all three are "no longer editing this".
export function leaveCell(sessionId: string, cellKey: string): void {
  if (presence.delete(presenceKey(sessionId, cellKey))) broadcastPresence();
}

// Every cell this session was holding, released at once. Used when a tab is hidden
// or unloaded, where per-cell messages would be unreliable.
export function leaveAll(sessionId: string): void {
  let released = false;
  for (const [key, e] of presence) {
    if (e.sessionId === sessionId) {
      presence.delete(key);
      released = true;
    }
  }
  if (released) broadcastPresence();
}

// Announce saved changes to every connected browser, INCLUDING the author's own
// other tabs. Not excluded from the author's session either: their second monitor
// showing the same month needs the update as much as anybody's.
export function publishChanges(events: ChangeEvent[]): void {
  if (events.length === 0) return;
  // Logged because "the broadcast reached nobody" is invisible from the outside — the
  // save succeeds, the audit row is written, and the loop over an empty subscriber map
  // does nothing at all. A count of 0 here while browsers are demonstrably connected is
  // the signature of the bundling split described at the top of this file, and is worth
  // being able to read straight out of the PM2 log rather than re-deducing.
  console.log(`[realtime] publishing ${events.length} change event(s) to ${subscribers.size} connected session(s)`);
  broadcast({ type: "changes", events });
}

// Announce that the Role Permissions matrix changed — no payload, since every
// browser needs to re-run its OWN role's check server-side (router.refresh(),
// see RealtimeProvider.tsx) rather than trust a client-computed diff. Same
// broadcast-to-everyone shape as publishChanges: every connected session,
// including the ELT admin's own other tabs, needs to see the new state.
export function publishPermissionsChanged(): void {
  console.log(`[realtime] publishing permissions:updated to ${subscribers.size} connected session(s)`);
  broadcast({ type: "permissions" });
}

export function connectedSessionCount(): number {
  return subscribers.size;
}

export function currentPresence(): PresenceEntry[] {
  return livePresence();
}

// A single loud warning if this ever runs somewhere the in-memory assumption is
// false. PM2 sets NODE_APP_INSTANCE on every worker in cluster mode, so a value
// other than "0"/undefined means there is more than one process and presence is
// silently partitioned.
if (process.env.NODE_APP_INSTANCE && process.env.NODE_APP_INSTANCE !== "0") {
  console.error(
    "[realtime-hub] Running as PM2 instance " +
      process.env.NODE_APP_INSTANCE +
      " — presence and change broadcast are PER-PROCESS and will only reach the users on this worker. " +
      "Move the hub behind Redis pub/sub before running more than one instance.",
  );
}
