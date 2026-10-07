// ── Reports deploys: build beside the running app, then switch (2026-10-07) ───
//
// WHY
//
// A Reports deploy used to stop the app first and then migrate, generate and
// build, so everyone was off it for ~60 s on every change. Almost all of that
// time is `next build`, which only needs to finish before the server RESTARTS,
// not before it STOPS. The one thing in the way is that the build writes to the
// directory the running server reads from, so a build under a live app corrupts
// it.
//
// THE FIX is two build directories, `.next-a` and `.next-b`. The running app
// serves one (named in `.active-dist`); the build goes into the other; the switch
// is then stop → free the port → flip the pointer → start, a few seconds. The
// directory that was serving is left intact, so a build that fails never touches
// the live app and a new build that won't come up is rolled back by pointing at
// the old directory again.
//
// WHAT STILL STOPS THE APP FIRST ("full" deploys): a change to package.json /
// package-lock.json (an install rewrites node_modules, whose native binaries the
// running app holds open) or to the Prisma schema / migrations (`prisma generate`
// fails with EPERM while the app holds the query engine, and a migration should
// not run under code that predates it). Those keep the old stop-first order.
//
// Pure decisions and the activate/rollback sequence live here, with every side
// effect passed in, so tests/deploy-lib.test.ts covers them without PM2 or a
// build. deploy.mjs is the thin CLI that supplies the real ones.

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

export const DIST_A = ".next-a";
export const DIST_B = ".next-b";
/** What the app served before this existed, and what `next build` writes by default. */
export const LEGACY_DIST = ".next";

export const ACTIVE_FILE = ".active-dist";
export const BUILT_FILE = ".built-dist";

// The pointer files are read back as directory names that are then rm -rf'd and
// handed to the server, so only these three values are ever accepted from disk.
// A pointer file with anything else in it (a typo, a stray edit, "../..") is
// treated as absent rather than trusted.
const ALLOWED = new Set([DIST_A, DIST_B, LEGACY_DIST]);

export function isAllowedDist(name) {
  return typeof name === "string" && ALLOWED.has(name);
}

/** The directory the next build goes into: whichever of A/B is NOT being served. */
export function nextTargetDist(active) {
  return active === DIST_A ? DIST_B : DIST_A;
}

/**
 * "fast" (build beside the running app, short switch) or "full" (stop first).
 * `changedFiles` are repo-relative paths with forward slashes, as git prints them.
 * Anything in apps/reports that is not one of the four cases below only changes
 * code the next build compiles, which is exactly what the fast path is for.
 */
export function reportsDeployMode(changedFiles) {
  const needsStop = (f) =>
    f === "apps/reports/package.json" ||
    f === "apps/reports/package-lock.json" ||
    f === "apps/reports/prisma/schema.prisma" ||
    f.startsWith("apps/reports/prisma/migrations/");
  return changedFiles.some(needsStop) ? "full" : "fast";
}

function readPointerFile(appDir, file) {
  try {
    const value = readFileSync(path.join(appDir, file), "utf8").trim();
    return isAllowedDist(value) ? value : null;
  } catch {
    return null;
  }
}

const hasBuild = (appDir, dist) => existsSync(path.join(appDir, dist, "BUILD_ID"));

/**
 * The directory that should be served right now: the pointer's, if that build is
 * really on disk; otherwise the legacy `.next` if it has a build; otherwise null
 * (nothing built yet — start.mjs builds one).
 */
export function activeDist(appDir) {
  const pointed = readPointerFile(appDir, ACTIVE_FILE);
  if (pointed && hasBuild(appDir, pointed)) return pointed;
  if (hasBuild(appDir, LEGACY_DIST)) return LEGACY_DIST;
  return null;
}

/** The directory the last `build` finished into, or null if none is waiting. */
export function builtDist(appDir) {
  const built = readPointerFile(appDir, BUILT_FILE);
  return built && hasBuild(appDir, built) ? built : null;
}

export function writeActive(appDir, dist) {
  if (!isAllowedDist(dist)) throw new Error(`refusing to point at ${JSON.stringify(dist)}`);
  writeFileSync(path.join(appDir, ACTIVE_FILE), `${dist}\n`);
}

export function writeBuilt(appDir, dist) {
  if (!isAllowedDist(dist)) throw new Error(`refusing to record ${JSON.stringify(dist)}`);
  writeFileSync(path.join(appDir, BUILT_FILE), `${dist}\n`);
}

export function clearBuilt(appDir) {
  rmSync(path.join(appDir, BUILT_FILE), { force: true });
}

/** Remove a build directory. Only ever one of the three known names. */
export function removeDist(appDir, dist) {
  if (!isAllowedDist(dist)) throw new Error(`refusing to delete ${JSON.stringify(dist)}`);
  rmSync(path.join(appDir, dist), { recursive: true, force: true });
}

/**
 * Stop the app, free its port, point at `dist`, start it, and wait for it to
 * answer — in that order, which is the one free-port.mjs documents: a stopped
 * process is not auto-restarted when free-port kills it, so there is exactly one
 * boot (a second boot kills the first mid-refresh and leaves the refresh lock
 * held by a dead process).
 *
 * `deps`: { stop(), freePort(), start(), waitHealthy(): Promise<boolean>, log(msg) }
 */
async function switchTo(appDir, dist, deps) {
  try {
    deps.stop();
  } catch (e) {
    deps.log(`  pm2 stop warning: ${e instanceof Error ? e.message : e} — continuing.`);
  }
  deps.freePort();
  writeActive(appDir, dist);
  deps.start();
  return deps.waitHealthy();
}

/**
 * Make the finished build live. If the app does not come up on it and an earlier
 * build is still on disk, point back at that one and say so loudly.
 * Returns { ok, active, rolledBack }.
 */
export async function activateBuild(appDir, deps) {
  const built = builtDist(appDir);
  if (!built) throw new Error("nothing to activate: no finished build (run `build` first)");
  const previous = activeDist(appDir);

  deps.log(`Switching Reports from ${previous ?? "(nothing)"} to ${built}…`);
  if (await switchTo(appDir, built, deps)) {
    // The first switch off the legacy `.next` keeps it as the way back; the
    // switch after that no longer needs it.
    if (previous !== LEGACY_DIST && existsSync(path.join(appDir, LEGACY_DIST))) {
      try {
        removeDist(appDir, LEGACY_DIST);
      } catch (e) {
        deps.log(`  could not remove the old .next (harmless): ${e instanceof Error ? e.message : e}`);
      }
    }
    clearBuilt(appDir);
    deps.log(`Reports is serving ${built}.`);
    return { ok: true, active: built, rolledBack: false };
  }

  deps.log(`  Reports did NOT come up on ${built}.`);
  if (previous && previous !== built && hasBuild(appDir, previous)) {
    deps.log(`  Rolling back to ${previous}…`);
    const back = await switchTo(appDir, previous, deps);
    deps.log(
      back
        ? `  Rolled back: Reports is serving ${previous} again. The new build is ${built} — look at \`pm2 logs sdc-reports --err\`.`
        : `  ROLLBACK ALSO FAILED — Reports is down. MANUAL ATTENTION REQUIRED (pm2 logs sdc-reports --err).`,
    );
    return { ok: false, active: back ? previous : null, rolledBack: back };
  }
  deps.log("  There is no earlier build to roll back to — Reports is down. MANUAL ATTENTION REQUIRED.");
  return { ok: false, active: null, rolledBack: false };
}

/** Bring the app up on whatever is already active (no new build, no pointer change). */
export async function restartActive(appDir, deps) {
  const active = activeDist(appDir);
  if (!active) throw new Error("no build on disk to start");
  deps.log(`Restarting Reports on ${active}…`);
  return switchTo(appDir, active, deps);
}
