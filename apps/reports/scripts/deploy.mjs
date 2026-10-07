// Reports deploy steps. See deploy-lib.mjs for why there are two build
// directories and what a "fast" versus a "full" deploy means.
//
//   node scripts/deploy.mjs build      build into the directory that is NOT being served
//                                      (safe while the app is running)
//   node scripts/deploy.mjs activate   stop → free the port → switch → start → verify,
//                                      rolling back if the app does not come up
//   node scripts/deploy.mjs restart    stop → free the port → start, on the build already
//                                      active (what a failed full deploy falls back to)
//   node scripts/deploy.mjs            build, then activate — `npm run deploy`
//
// Exit code is non-zero when the step failed, including a rollback (the app is up
// on the old build, but the deploy did not take, and that must not look like success).

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activateBuild,
  activeDist,
  clearBuilt,
  nextTargetDist,
  removeDist,
  restartActive,
  writeBuilt,
} from "./deploy-lib.mjs";
import { existsSync } from "node:fs";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PM2_NAME = "sdc-reports";
// Deliberately NOT process.env.PORT: the updater runs this with its OWN environment, which can
// carry another app's PORT, and free-port.mjs kills whatever is listening on the number it is
// given. 4006 is the port ecosystem.config.js gives sdc-reports; REPORTS_PORT exists only for a
// test box that runs it elsewhere.
const PORT = Number(process.env.REPORTS_PORT) || 4006;
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`;
// A cold boot is normally a few seconds; a self-heal boot (start.mjs reinstalling
// node_modules) can spend a minute or two before it listens.
const HEALTH_TIMEOUT_MS = 150_000;
const WIN = process.platform === "win32";

const log = (msg) => console.log(`[deploy] ${msg}`);

/**
 * Every argument below is a hardcoded literal or a value from the allowlist in
 * deploy-lib.mjs. shell:true is needed on Windows because npm and pm2 are .cmd
 * shims (see start.mjs); never pass anything user- or env-derived through here.
 */
function run(cmd, args, env) {
  execFileSync(cmd, args, { cwd: APP_DIR, stdio: "inherit", shell: WIN, env: { ...process.env, ...env } });
}

/**
 * True once the server answers HTTP at all. Any status counts: a 503 from
 * /api/health means the database is unreachable, which is not something a rollback
 * to the previous build would fix, whereas no answer means the new build did not boot.
 */
async function waitHealthy() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5_000) });
      log(`health check: HTTP ${res.status}`);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  return false;
}

const deps = {
  log,
  stop: () => run("pm2", ["stop", PM2_NAME]),
  freePort: () => run("node", ["scripts/free-port.mjs", String(PORT)]),
  start: () => run("pm2", ["start", PM2_NAME]),
  waitHealthy,
};

function build() {
  const active = activeDist(APP_DIR);
  const target = nextTargetDist(active);
  log(`Building into ${target} (serving ${active ?? "nothing"}).`);
  // Clear first: a stale marker must never let `activate` switch to a half-written
  // build, and a leftover directory from an earlier build should not leak into this one.
  clearBuilt(APP_DIR);
  removeDist(APP_DIR, target);
  run("npm", ["run", "build"], { NEXT_DIST_DIR: target });
  if (!existsSync(path.join(APP_DIR, target, "BUILD_ID"))) {
    throw new Error(`build finished but ${target}/BUILD_ID is missing`);
  }
  writeBuilt(APP_DIR, target);
  log(`Build ready in ${target}.`);
}

const step = process.argv[2] ?? "all";
try {
  if (step === "build" || step === "all") build();
  if (step === "activate" || step === "all") {
    const result = await activateBuild(APP_DIR, deps);
    if (!result.ok) process.exit(1);
  }
  if (step === "restart") {
    if (!(await restartActive(APP_DIR, deps))) {
      log("Reports did not come up. MANUAL ATTENTION REQUIRED (pm2 logs sdc-reports --err).");
      process.exit(1);
    }
  }
  if (!["build", "activate", "restart", "all"].includes(step)) {
    console.error(`deploy: unknown step ${JSON.stringify(step)} (expected build, activate, restart)`);
    process.exit(2);
  }
} catch (e) {
  console.error(`[deploy] FAILED: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
