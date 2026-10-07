import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ACTIVE_FILE,
  BUILT_FILE,
  DIST_A,
  DIST_B,
  LEGACY_DIST,
  activateBuild,
  activeDist,
  builtDist,
  isAllowedDist,
  nextTargetDist,
  removeDist,
  reportsDeployMode,
  restartActive,
  writeActive,
  writeBuilt,
} from "../scripts/deploy-lib.mjs";

function appDir() {
  return mkdtempSync(path.join(tmpdir(), "deploy-lib-"));
}
function fakeBuild(dir: string, dist: string) {
  mkdirSync(path.join(dir, dist), { recursive: true });
  writeFileSync(path.join(dir, dist, "BUILD_ID"), "x");
}

// ── which deploys can run beside the live app ───────────────────────────────

test("reportsDeployMode: a source-only change is fast", () => {
  assert.equal(reportsDeployMode(["apps/reports/src/lib/foo.ts", "apps/reports/src/components/Bar.tsx", "apps/reports/tests/foo.test.ts"]), "fast");
  assert.equal(reportsDeployMode(["apps/reports/prisma/seed-dev.ts", "apps/reports/next.config.ts", "apps/reports/scripts/start.mjs"]), "fast");
});

test("reportsDeployMode: dependencies, schema or migrations need the stop-first deploy", () => {
  assert.equal(reportsDeployMode(["apps/reports/src/a.ts", "apps/reports/package.json"]), "full");
  assert.equal(reportsDeployMode(["apps/reports/package-lock.json"]), "full");
  assert.equal(reportsDeployMode(["apps/reports/prisma/schema.prisma"]), "full");
  assert.equal(reportsDeployMode(["apps/reports/prisma/migrations/20261006120000_add_x/migration.sql"]), "full");
});

test("reportsDeployMode: another app's package.json does not force a full deploy", () => {
  assert.equal(reportsDeployMode(["apps/assemblies/package.json", "package.json", "apps/reports/src/a.ts"]), "fast");
});

// ── the two build directories ───────────────────────────────────────────────

test("nextTargetDist alternates A and B, and starts on A from the legacy .next or from nothing", () => {
  assert.equal(nextTargetDist(DIST_A), DIST_B);
  assert.equal(nextTargetDist(DIST_B), DIST_A);
  assert.equal(nextTargetDist(LEGACY_DIST), DIST_A);
  assert.equal(nextTargetDist(null), DIST_A);
});

test("only the three known directory names are ever accepted", () => {
  for (const ok of [DIST_A, DIST_B, LEGACY_DIST]) assert.equal(isAllowedDist(ok), true);
  for (const bad of ["../..", ".next-c", "", "node_modules", ".next/..", null, undefined, 3]) assert.equal(isAllowedDist(bad), false);
});

test("activeDist: follows the pointer when that build exists", () => {
  const dir = appDir();
  try {
    fakeBuild(dir, DIST_B);
    writeActive(dir, DIST_B);
    assert.equal(activeDist(dir), DIST_B);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activeDist: a pointer to a build that is gone falls back to the legacy .next, then to nothing", () => {
  const dir = appDir();
  try {
    writeActive(dir, DIST_A); // no .next-a on disk
    assert.equal(activeDist(dir), null);
    fakeBuild(dir, LEGACY_DIST);
    assert.equal(activeDist(dir), LEGACY_DIST);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activeDist: no pointer file means the legacy .next if it has a build", () => {
  const dir = appDir();
  try {
    assert.equal(activeDist(dir), null);
    fakeBuild(dir, LEGACY_DIST);
    assert.equal(activeDist(dir), LEGACY_DIST);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pointer file holding anything but a known name is ignored, not trusted", () => {
  const dir = appDir();
  try {
    fakeBuild(dir, LEGACY_DIST);
    writeFileSync(path.join(dir, ACTIVE_FILE), "../../Windows\n");
    assert.equal(activeDist(dir), LEGACY_DIST);
    writeFileSync(path.join(dir, BUILT_FILE), "../../Windows\n");
    assert.equal(builtDist(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeActive / writeBuilt / removeDist refuse a name outside the allowlist", () => {
  const dir = appDir();
  try {
    assert.throws(() => writeActive(dir, "../x"));
    assert.throws(() => writeBuilt(dir, "node_modules"));
    assert.throws(() => removeDist(dir, "src"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the switch, and the way back ────────────────────────────────────────────

function fakeDeps(opts: { healthy: boolean[]; stopThrows?: boolean }) {
  const calls: string[] = [];
  const queue = [...opts.healthy];
  const dir = { current: "" };
  return {
    calls,
    deps: {
      log: (m: string) => calls.push(`log:${m.trim()}`),
      stop: () => {
        calls.push("stop");
        if (opts.stopThrows) throw new Error("not registered");
      },
      freePort: () => calls.push("freePort"),
      start: () => calls.push(`start@${readFileSync(path.join(dir.current, ACTIVE_FILE), "utf8").trim()}`),
      waitHealthy: async () => {
        calls.push("health");
        return queue.shift() ?? false;
      },
    },
    bind: (d: string) => {
      dir.current = d;
    },
  };
}

const order = (calls: string[]) => calls.filter((c) => !c.startsWith("log:"));

test("activateBuild: stop, free the port, point at the new build, start, then verify — in that order", async () => {
  const dir = appDir();
  try {
    fakeBuild(dir, DIST_A);
    fakeBuild(dir, DIST_B);
    writeActive(dir, DIST_A);
    writeBuilt(dir, DIST_B);
    const f = fakeDeps({ healthy: [true] });
    f.bind(dir);
    const out = await activateBuild(dir, f.deps);
    assert.deepEqual(order(f.calls), ["stop", "freePort", `start@${DIST_B}`, "health"]);
    assert.deepEqual(out, { ok: true, active: DIST_B, rolledBack: false });
    assert.equal(activeDist(dir), DIST_B);
    assert.equal(builtDist(dir), null, "the finished-build marker is consumed");
    assert.equal(existsSync(path.join(dir, DIST_A, "BUILD_ID")), true, "the previous build is kept as the way back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activateBuild: a new build that does not come up is rolled back to the previous one", async () => {
  const dir = appDir();
  try {
    fakeBuild(dir, DIST_A);
    fakeBuild(dir, DIST_B);
    writeActive(dir, DIST_A);
    writeBuilt(dir, DIST_B);
    const f = fakeDeps({ healthy: [false, true] });
    f.bind(dir);
    const out = await activateBuild(dir, f.deps);
    assert.deepEqual(order(f.calls), [
      "stop", "freePort", `start@${DIST_B}`, "health",
      "stop", "freePort", `start@${DIST_A}`, "health",
    ]);
    assert.deepEqual(out, { ok: false, active: DIST_A, rolledBack: true });
    assert.equal(activeDist(dir), DIST_A);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activateBuild: when the rollback fails too it reports the app as down, not as rolled back", async () => {
  const dir = appDir();
  try {
    fakeBuild(dir, DIST_A);
    fakeBuild(dir, DIST_B);
    writeActive(dir, DIST_A);
    writeBuilt(dir, DIST_B);
    const f = fakeDeps({ healthy: [false, false] });
    f.bind(dir);
    const out = await activateBuild(dir, f.deps);
    assert.deepEqual(out, { ok: false, active: null, rolledBack: false });
    assert.ok(f.calls.some((c) => c.includes("MANUAL ATTENTION")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activateBuild: no earlier build means nothing to roll back to", async () => {
  const dir = appDir();
  try {
    fakeBuild(dir, DIST_A);
    writeBuilt(dir, DIST_A);
    const f = fakeDeps({ healthy: [false] });
    f.bind(dir);
    const out = await activateBuild(dir, f.deps);
    assert.deepEqual(out, { ok: false, active: null, rolledBack: false });
    assert.equal(order(f.calls).filter((c) => c === "stop").length, 1, "no second attempt without somewhere to go back to");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activateBuild: refuses when no build has finished, and does not touch the running app", async () => {
  const dir = appDir();
  try {
    fakeBuild(dir, DIST_A);
    writeActive(dir, DIST_A);
    const f = fakeDeps({ healthy: [true] });
    f.bind(dir);
    await assert.rejects(() => activateBuild(dir, f.deps), /nothing to activate/);
    assert.deepEqual(order(f.calls), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activateBuild: a marker pointing at a build with no BUILD_ID (a half-written build) is refused", async () => {
  const dir = appDir();
  try {
    fakeBuild(dir, DIST_A);
    writeActive(dir, DIST_A);
    mkdirSync(path.join(dir, DIST_B), { recursive: true }); // directory, but no BUILD_ID
    writeBuilt(dir, DIST_B);
    const f = fakeDeps({ healthy: [true] });
    f.bind(dir);
    await assert.rejects(() => activateBuild(dir, f.deps), /nothing to activate/);
    assert.deepEqual(order(f.calls), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activateBuild: a pm2 stop that errors (not registered yet) does not stop the switch", async () => {
  const dir = appDir();
  try {
    fakeBuild(dir, DIST_B);
    writeBuilt(dir, DIST_B);
    const f = fakeDeps({ healthy: [true], stopThrows: true });
    f.bind(dir);
    const out = await activateBuild(dir, f.deps);
    assert.equal(out.ok, true);
    assert.equal(activeDist(dir), DIST_B);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activateBuild: the first switch off the legacy .next keeps it; the next one removes it", async () => {
  const dir = appDir();
  try {
    fakeBuild(dir, LEGACY_DIST);
    fakeBuild(dir, DIST_A);
    writeBuilt(dir, DIST_A);
    const first = fakeDeps({ healthy: [true] });
    first.bind(dir);
    await activateBuild(dir, first.deps);
    assert.equal(existsSync(path.join(dir, LEGACY_DIST)), true, "kept as the way back after the first switch");

    fakeBuild(dir, DIST_B);
    writeBuilt(dir, DIST_B);
    const second = fakeDeps({ healthy: [true] });
    second.bind(dir);
    await activateBuild(dir, second.deps);
    assert.equal(existsSync(path.join(dir, LEGACY_DIST)), false, "no longer needed once two switches have worked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restartActive: restarts on the serving build without changing which one it is", async () => {
  const dir = appDir();
  try {
    fakeBuild(dir, DIST_B);
    writeActive(dir, DIST_B);
    const f = fakeDeps({ healthy: [true] });
    f.bind(dir);
    assert.equal(await restartActive(dir, f.deps), true);
    assert.deepEqual(order(f.calls), ["stop", "freePort", `start@${DIST_B}`, "health"]);
    assert.equal(activeDist(dir), DIST_B);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restartActive: with no build on disk it says so instead of starting nothing", async () => {
  const dir = appDir();
  try {
    const f = fakeDeps({ healthy: [true] });
    f.bind(dir);
    await assert.rejects(() => restartActive(dir, f.deps), /no build on disk/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
