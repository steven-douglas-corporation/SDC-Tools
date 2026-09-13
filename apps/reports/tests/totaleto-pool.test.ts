import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { totalEtoConfig, TOTALETO_TIMEOUT } from "../src/lib/totaleto-connection";

// ── The global-pool bug, guarded at the source ──────────────────────────────
//
// Found 2026-09-03 chasing "[parts-etc-breakout] batched parts lines failed:
// Error: aborted", which made the Monthly ETC grid's Left to Purchase read $0 on
// every job. Both faults are in node_modules/mssql/lib/global-connection.js:
//
//   connect(config) begins `if (!globalConnection)`, so the config is used ONLY on
//   the first call in the process and every later caller's is silently discarded.
//
//   pool.close() on that pool sets globalConnection = null and closes it for EVERY
//   concurrent user, so any request in flight fails with `Error: aborted`.
//
// Nothing about either fault is visible at a call site — `sql.connect(myConfig)`
// followed by `pool.close()` in a finally reads as careful resource handling and is
// the documented-looking thing to write. That is why this is a source guard rather
// than only a fix: the next person to add a Total ETO query will reach for exactly
// the pattern that broke, and a unit test on our own module cannot catch it.

const SRC = join(process.cwd(), "src");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Source with comments stripped — a rule quoted in a comment is not a violation of it. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const short = (f: string) => f.replace(process.cwd(), "").split("\\").join("/");

test("nothing opens mssql's global pool", () => {
  // `sql.connect(...)` IS the global pool, whatever config is passed. A dedicated
  // `new sql.ConnectionPool(config)` is the only safe way to hold one, and for Total
  // ETO the only supported route is withTotalEto / totalEtoPool.
  const offenders = tsFiles(SRC)
    .filter((f) => /\bsql\s*\.\s*connect\s*\(/.test(code(f)))
    .map(short);
  assert.deepEqual(
    offenders,
    [],
    `these use mssql's ONE global pool — its config is discarded and closing it aborts ` +
      `every concurrent query. Use withTotalEto (Total ETO) or new sql.ConnectionPool:\n  ${offenders.join("\n  ")}`,
  );
});

test("no Total ETO caller closes a pool it did not create", () => {
  // The shared pools are process-lifetime by design (see totaleto-connection.ts). A
  // close anywhere in a Total ETO path is the abort bug coming back.
  const offenders: string[] = [];
  for (const file of tsFiles(SRC)) {
    const src = code(file);
    if (!/totalEtoPool|withTotalEto/.test(src)) continue;
    // closeTotalEtoPools is the deliberate teardown and owns the cache itself.
    if (short(file).endsWith("/lib/totaleto-connection.ts")) continue;
    if (/\bpool\s*\.\s*close\s*\(/.test(src)) offenders.push(short(file));
  }
  assert.deepEqual(offenders, [], `these close a pool they share with every other query:\n  ${offenders.join("\n  ")}`);
});

test("the Fabric warehouse cannot be handed a Total ETO connection", () => {
  // The sharpest consequence of the global pool: fabric-warehouse.ts targets a
  // different server, database and auth scheme, so whichever system connected first
  // in the process would have served the other one's queries.
  const src = code(join(SRC, "lib", "fabric-warehouse.ts"));
  assert.ok(/new\s+sql\.ConnectionPool\s*\(/.test(src), "must hold its own pool");
  assert.ok(!/\bsql\s*\.\s*connect\s*\(/.test(src), "must never reach for the global pool");
});

// ── The config that makes a long-lived pool safe ───────────────────────────

test("an idle pool holds no connections open", () => {
  // `min: 0` is what makes "never closed" cost nothing: the pools now live for the
  // life of the process, and anything above zero would pin connections on the SQL box
  // permanently rather than for the length of a query.
  const { pool } = totalEtoConfig(TOTALETO_TIMEOUT.sync);
  assert.equal(pool?.min, 0, "a long-lived pool must not hold connections while idle");
  assert.ok((pool?.idleTimeoutMillis ?? 0) > 0, "idle connections must be reaped");
});

test("the connection count is bounded per pool", () => {
  const { pool } = totalEtoConfig(TOTALETO_TIMEOUT.sync);
  assert.ok(pool?.max != null && pool.max > 0 && pool.max <= 10, `max should be a small ceiling, got ${pool?.max}`);
});

test("each distinct timeout is honoured, which the global pool silently discarded", () => {
  // The whole point of keying the cache by timeout. Under the old code the second
  // caller's requestTimeout never reached the driver, so the 300s the 49-job parts
  // query asked for was whatever the first query of the process happened to set.
  assert.equal(totalEtoConfig(300_000).requestTimeout, 300_000);
  assert.equal(totalEtoConfig(TOTALETO_TIMEOUT.bom).requestTimeout, TOTALETO_TIMEOUT.bom);
  assert.notEqual(TOTALETO_TIMEOUT.bom, TOTALETO_TIMEOUT.sync, "the timeouts differ, so the pools must differ too");
});

test("credentials are still read at call time, not frozen at module load", () => {
  // Pre-existing behaviour worth keeping now that pools are cached: a pool is built
  // from a config read when it is first opened, so a .env fix plus a restart is enough.
  const before = process.env.TOTALETO_DB_USER;
  try {
    process.env.TOTALETO_DB_USER = "guard-test-user";
    assert.equal(totalEtoConfig().user, "guard-test-user");
  } finally {
    if (before === undefined) delete process.env.TOTALETO_DB_USER;
    else process.env.TOTALETO_DB_USER = before;
  }
});
