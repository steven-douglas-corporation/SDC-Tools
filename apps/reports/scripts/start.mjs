// ── PM2 entry point: preflight, self-heal, then serve (§72) ───────────────────
//
// WHY THIS FILE EXISTS (measured 2026-08-26)
//
// PM2 used to launch this app with `script: 'node_modules/next/dist/bin/next'`.
// That made PM2's entry point a file inside the one directory npm deletes and
// recreates on every install — so an install that dies partway takes the app
// down permanently, and PM2 cannot do anything about it because the thing it is
// told to run no longer exists.
//
// That is exactly what happened. An `npm install` run by hand inside this folder
// on 2026-08-25 at 20:03 was interrupted. Everything made of JavaScript was
// gone; the only survivors were five native binaries Windows could not unlink
// because the running app held them open (.prisma query engine, @next/swc,
// keytar.node, the msal DLLs) plus a stub `next/dist/` with no package.json and
// no bin/. From then until 08:15 the next morning PM2 restarted the app every
// three seconds — 139 times, ~12 hours — each attempt logging the same line:
//
//     Error: Cannot find module '…\sdc-etc-planner\node_modules\next\dist\bin\next'
//     code: 'MODULE_NOT_FOUND'
//
// Nobody was told. `pm2 list` showed a blank status and 0b memory rather than
// anything that reads as broken, and the tile in the shell just looked down.
//
// WHAT THIS DOES ABOUT IT
//
// PM2 now runs THIS file, which is tracked in git and therefore always present.
// It checks the two things that must be true before `next start` can work — deps
// installed, production build on disk — and repairs whichever is missing rather
// than dying. A wiped node_modules is now a slow boot (~90s for npm ci) instead
// of an outage, and it heals on the restart PM2 was already going to attempt.
//
// The repair is bounded, not a loop: if a repair runs and the tree is STILL
// broken, this exits non-zero. Paired with min_uptime + max_restarts in
// ecosystem.config.js, PM2 gives up after ~10 tries and marks the app `errored`,
// which is a state a human can actually see — that is the point. Never make this
// retry forever; a silent infinite retry is the failure mode this file replaces.
//
// Once preflight passes, Next's own bin is loaded IN-PROCESS via import() rather
// than spawned. PM2 keeps supervising exactly one node process, so its signal
// handling and max_memory_restart still apply to the real server — the same
// reason the old config invoked the Next CLI directly instead of through an npm
// shim. This file adds a preflight, not a process.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEXT_BIN = path.join(APP_DIR, "node_modules", "next", "dist", "bin", "next");
const NEXT_PKG = path.join(APP_DIR, "node_modules", "next", "package.json");
const PRISMA_CLIENT = path.join(APP_DIR, "node_modules", ".prisma", "client", "index.js");
const BUILD_ID = path.join(APP_DIR, ".next", "BUILD_ID");
const PORT = process.env.PORT || "4006";
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function log(msg) {
  console.log(`[start] ${msg}`);
}

/** Run a command in the app dir, inheriting stdio so PM2's log captures it. */
function run(cmd, args) {
  log(`running: ${cmd} ${args.join(" ")}`);
  // shell:true is REQUIRED on Windows and is not optional styling. npm and npx
  // are .cmd shims, and since the CVE-2024-27980 fix Node refuses to spawn a
  // .cmd without a shell — it throws `spawnSync npm.cmd EINVAL` instead. Caught
  // on 2026-08-26 by running this file against a deliberately broken tree: the
  // whole repair path failed on its first command, which would have made this
  // launcher no better than the config it replaced. Test the repair branch, not
  // just the happy path, if you touch this.
  //
  // Safe against injection because every argument below is a hardcoded literal;
  // do not start passing anything user- or env-derived through here.
  execFileSync(cmd, args, { cwd: APP_DIR, stdio: "inherit", shell: process.platform === "win32" });
}

// Check BOTH the bin and package.json. The interrupted install left a `next/dist`
// directory behind with neither — a bare existsSync on the folder would have
// called that tree healthy and gone straight back to crash-looping.
const depsOk = () => existsSync(NEXT_BIN) && existsSync(NEXT_PKG);

let repaired = false;

if (!depsOk()) {
  log("node_modules is missing or incomplete (no next bin) — reinstalling.");
  log("This is the recovery path for an interrupted npm install; expect ~1-2 min.");
  try {
    // `npm ci` over `npm install`: it rebuilds the tree from the lockfile rather
    // than reconciling whatever partial state was left behind, which is what we
    // are recovering from. Falls back to `npm install` because ci refuses to run
    // at all when package.json and the lockfile disagree, and a stale lockfile
    // must not be the reason production stays down.
    run(NPM, ["ci"]);
  } catch {
    log("npm ci failed — falling back to npm install. (Common cause: package.json and the lockfile disagree, which makes ci refuse to run at all.)");
    run(NPM, ["install"]);
  }
  repaired = true;
}

if (!depsOk()) {
  // Deliberately fatal. See the header: exiting lets PM2 exhaust max_restarts and
  // land in `errored`, which is visible. Retrying here would hide it again.
  console.error(
    "[start] FATAL: dependencies are still missing after a repair attempt. " +
      "Fix by hand from an Administrator shell:\n" +
      `  cd /d "${APP_DIR}"\n` +
      "  rmdir /s /q node_modules && npm install && npx prisma generate && npm run build\n" +
      "If rmdir reports a file in use, stop the app and close the Electron shell first.",
  );
  process.exit(1);
}

// Prisma's generated client lives in node_modules/.prisma, so a reinstall wipes
// it too. It is not restored by npm — it has to be generated, or every database
// query throws at runtime and the app boots into a half-working state.
if (repaired || !existsSync(PRISMA_CLIENT)) {
  try {
    run("npx", ["prisma", "generate"]);
  } catch {
    log("WARNING: prisma generate failed — DB routes will fail until this is fixed.");
  }
}

// A reinstall does not touch .next, so this normally passes untouched. It matters
// on a first boot in a fresh clone, and after anyone clears the build directory.
if (!existsSync(BUILD_ID)) {
  log("No production build found (.next/BUILD_ID missing) — building.");
  run(NPM, ["run", "build"]);
}

log(`preflight ok — starting next on port ${PORT}`);

// Hand off to Next's own CLI in this same process. Its bin reads process.argv, so
// stage the argv it would have seen had PM2 launched it directly.
process.argv = [process.argv[0], NEXT_BIN, "start", "-p", PORT];
await import(pathToFileURL(NEXT_BIN).href);
