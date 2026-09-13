// ── Free a TCP port before starting the server (§71) ─────────────────────────
//
// PM2 on this Windows box does not reliably kill this app's server process. Measured
// 2026-08-06, three times in twenty minutes: `pm2 stop`, `pm2 restart` and even
// `pm2 delete` each reported success while the actual `next start` server kept running
// and kept the socket. The new instance then crash-loops on:
//
//     Error: listen EADDRINUSE: address already in use :::3010
//
// every ~4s, forever, while the OLD build carries on serving — so a deploy looks like it
// worked, the site looks up, and the new code is simply not live. That is the worst shape
// a deploy failure can take, because nothing announces it. (`↺ 364` on the PM2 entry was
// this loop, accumulated over many deploys.)
//
// So the documented deploy no longer trusts PM2 to have released the port: it frees it
// explicitly, then starts. Idempotent — if nothing is listening it says so and exits 0,
// which is the normal case on a healthy deploy.
//
// Deliberately dependency-free (no `kill-port` from npx): a deploy step that has to reach
// the network to free a local socket is a deploy step that fails when the network does.

// ── Why the deploy stops PM2 FIRST (2026-08-25) ──────────────────────────────
//
// The deploy was `next build && free-port && pm2 restart`, and that sequence booted the
// app TWICE on every deploy. free-port kills the listening process; PM2, which is still
// supervising it, sees its child die and autorestarts it — boot #1. Then `pm2 restart`
// runs and boots it again — boot #2, killing boot #1 a few seconds in.
//
// That is not cosmetic, because the app runs a full refresh on startup. Boot #1 took the
// refresh lock and was killed mid-pass, leaving the lock held by a dead process and its
// RefreshRun row saying "running" forever. Measured in the PM2 log on 2026-08-25:
//
//   09:09:03  boot #1 (PM2 autorestart after free-port killed the old process)
//   09:09:04  boot #1 takes the refresh lock and starts a pass
//   09:09:16  boot #2 (`pm2 restart`) — kills the pass 12s in, lock still held
//
// and the same pattern again at 08:52:28/08:52:40 and 09:20:28/09:20:45. Until the lock
// timeout expired, every user's Refresh Data button reported a refresh already in
// progress that nothing was actually running — the "stuck on Refreshing…" complaint,
// caused by the deploy rather than by the refresh.
//
// `pm2 stop` before free-port is what breaks the cycle: a stopped process is not
// autorestarted when it dies, so free-port's kill produces no boot at all and `pm2
// start` produces exactly one. free-port is still needed and still runs between them —
// PM2 on this box does not reliably kill the server, which is the whole reason this
// file exists.

import { execFileSync } from "node:child_process";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`free-port: expected a port number, got ${JSON.stringify(process.argv[2])}`);
  process.exit(1);
}

/** PIDs LISTENING on `port`, from netstat. Windows-only, which is this app's deploy target. */
function listenersOn() {
  let out = "";
  try {
    out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
  } catch (e) {
    console.error(`free-port: could not run netstat — ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes("LISTENING")) continue;
    // Columns: Proto  Local Address  Foreign Address  State  PID
    const cols = line.trim().split(/\s+/);
    const local = cols[1] ?? "";
    const pid = Number(cols[cols.length - 1]);
    // Match the port EXACTLY — endsWith(":3010") would also match :13010, and killing
    // an unrelated service because of a substring match is far worse than a failed deploy.
    const portPart = local.slice(local.lastIndexOf(":") + 1);
    if (Number(portPart) === port && Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

const pids = listenersOn();
if (pids.length === 0) {
  console.log(`free-port: nothing listening on ${port} — nothing to do.`);
  process.exit(0);
}

let failed = 0;
for (const pid of pids) {
  try {
    execFileSync("taskkill", ["/F", "/PID", String(pid)], { encoding: "utf8", stdio: "pipe" });
    console.log(`free-port: killed PID ${pid} which held ${port}.`);
  } catch (e) {
    failed++;
    const detail = e instanceof Error ? e.message.split("\n")[0] : String(e);
    console.error(`free-port: could NOT kill PID ${pid} — ${detail}`);
  }
}

if (failed > 0) {
  // Fail the deploy loudly. Continuing to `pm2 restart` here is what produces the silent
  // failure this script exists to prevent: the restart "succeeds", the old build keeps
  // serving, and nobody finds out until someone asks why their change is not live.
  console.error(
    `free-port: ${failed} process(es) on ${port} survived. ` +
      `Run this shell as the user that owns them (or as Administrator) and retry — ` +
      `do NOT treat the deploy as done.`,
  );
  process.exit(1);
}

// The socket can linger a moment in TIME_WAIT after the process dies; give the OS a beat
// so the very next `next start` does not race it and report the same EADDRINUSE.
await new Promise((r) => setTimeout(r, 1500));
console.log(`free-port: ${port} is free.`);
