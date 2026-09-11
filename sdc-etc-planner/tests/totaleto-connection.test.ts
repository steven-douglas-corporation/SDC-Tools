import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { classifyTotalEto, describeTotalEtoFailure, isTransientTotalEto, TOTALETO_TIMEOUT, totalEtoConfig } from "../src/lib/totaleto-connection";
import { TOTALETO_SOURCES } from "../src/lib/auto-sync";

// ── One Total ETO connection, one diagnosis (2026-09-01) ────────────────────
//
// Four refresh sources failed at once — Parts cost, Parts cost actual, Jobs from
// TotalETO, Cash Flow snapshot — and establishing that they shared a cause took
// an investigation, because the identical connection config existed in FOUR
// files. It is one module now; these tests keep it that way and pin the
// classification that turns a driver message into something actionable.

const LIB = join(process.cwd(), "src", "lib");

test("a rejected login is distinguished from an unreachable server", () => {
  // The operational difference: a rejected login needs a person to change a
  // credential and retrying cannot help. Everything else is worth retrying.
  // Reporting them the same way is what made a two-hour credential outage look
  // like a flaky feed.
  assert.equal(classifyTotalEto(Object.assign(new Error("Login failed for user 'x'."), { code: "ELOGIN" })), "login_rejected");
  // The real message from 2026-09-01, which carries no 'Login failed for user' text.
  assert.equal(
    classifyTotalEto(
      Object.assign(new Error("Login failed. The login is from an untrusted domain and cannot be used with Integrated authentication."), {
        code: "ELOGIN",
      }),
    ),
    "login_rejected",
  );
  // The former single "unreachable" and "timeout" buckets split on 2026-09-09 —
  // same operational meaning (all transient), finer diagnosis.
  assert.equal(classifyTotalEto(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), "server_unavailable");
  assert.equal(classifyTotalEto(Object.assign(new Error("getaddrinfo ENOTFOUND host"), { code: "ENOTFOUND" })), "dns");
  assert.equal(classifyTotalEto(Object.assign(new Error("Timeout: Request failed to complete in 30000ms"), { code: "ETIMEOUT" })), "query_timeout");
  for (const kind of ["server_unavailable", "dns", "query_timeout"] as const) {
    assert.ok(isTransientTotalEto(kind), `${kind} must stay retryable`);
  }
  assert.ok(!isTransientTotalEto("login_rejected"), "a rejected login must never be retried");
});

test("the two timeouts are told apart, because the remedies differ", () => {
  // Opening a connection and running a statement both fail with ETIMEOUT, and the
  // answers are unrelated: the first is a firewall or an overloaded box, the second
  // is a slow statement. tedious's own two sentences are the evidence.
  assert.equal(
    classifyTotalEto(Object.assign(new Error("Failed to connect to SERVER-APP1.stevendouglas.local:1433 in 15000ms"), { code: "ETIMEOUT" })),
    "connect_timeout",
  );
  assert.equal(
    classifyTotalEto(Object.assign(new Error("Timeout: Request failed to complete in 30000ms"), { code: "ETIMEOUT" })),
    "query_timeout",
  );
  // No sentence to go on: whether we had authenticated is then the only evidence.
  const bare = Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
  assert.equal(classifyTotalEto(bare, { authenticated: false }), "connect_timeout");
  assert.equal(classifyTotalEto(bare, { authenticated: true }), "query_timeout");
});

// ── The five-day Parts cost outage (2026-09-09) ─────────────────────────────
//
// Every manual refresh reported "1 source failed: Parts cost (TotalETO)" while
// every hourly refresh of the same source succeeded — 59 of 80 manual passes,
// with green interval passes either side. The recorded error was
//
//   Validation failed for parameter 'start'. r.type.validate is not a function
//
// in 11-28ms, which is faster than any network round trip: the query never left
// the process. The cause was three bundled copies of mssql sharing one globalThis
// pool cache, so a `sql.DateTime` from one copy was bound against a pool built by
// another, and mssql's identity-switch on TYPES fell through to `default`.
//
// It was reported to managers as a Total ETO failure with "the hourly schedule
// will retry the rest" appended, which is the part that cost five days.
test("a parameter-binding fault is called an app bug, not a Total ETO failure", () => {
  const real = Object.assign(new Error("Validation failed for parameter 'start'. r.type.validate is not a function"), { code: "EPARAM" });
  assert.equal(classifyTotalEto(real), "param_binding");
  // Also when only the message survives (a wrapped or re-thrown error).
  assert.equal(classifyTotalEto(new Error("Validation failed for parameter 'start'. parameter.type.validate is not a function")), "param_binding");

  assert.ok(!isTransientTotalEto("param_binding"), "retrying a binding fault forever is how this hid for five days");
  const msg = describeTotalEtoFailure(real);
  assert.match(msg, /THIS APPLICATION/, "must not be blamed on Total ETO");
  assert.match(msg, /Retrying cannot help/, "must not promise the hourly schedule will fix it");
  assert.ok(!/password|\.env/i.test(msg), "must not send anyone to the credentials");
});

test("a pool is never shared across mssql module instances", () => {
  // The fix for the above, in the one file that can enforce it. Two rules:
  // the cache entry records its owner, and the lookup filters on it. Asserted
  // against the source because the failure needs two module instances to
  // reproduce, which a unit test in one process cannot arrange.
  const s = readFileSync(join(LIB, "totaleto-connection.ts"), "utf8");
  assert.match(s, /owner: typeof sql/, "a cached pool must record which mssql instance built it");
  assert.match(s, /entries\.find\(\(e\) => e\.owner === sql\)/, "and the lookup must filter on it");
});

test("nothing but the shared module opens its own Total ETO pool", () => {
  // A pool per query is the other half of the same problem: it costs a fresh NTLM
  // login per statement (four per Cash Flow capture, three per drill click), and a
  // locally-built pool is a pool no shared diagnosis or retry knows about.
  const offenders: string[] = [];
  for (const file of readdirSync(LIB).filter((f) => f.endsWith(".ts"))) {
    if (file === "totaleto-connection.ts") continue;
    const s = readFileSync(join(LIB, file), "utf8");
    // Scoped to the files that talk to TOTAL ETO. lib/fabric-warehouse.ts builds a
    // pool of its own quite correctly — a different server, a different database and
    // an Azure AD token instead of NTLM — and sharing anything with it is the bug
    // its own header describes, not the fix.
    const totalEto = s.includes('from "@/lib/totaleto-connection"');
    if (totalEto && s.includes("new sql.ConnectionPool")) offenders.push(`${file} builds its own pool instead of using withTotalEto`);
    if (/sql\.connect\(/.test(s)) offenders.push(`${file} uses mssql's global connection, which any caller can close underneath it`);
  }
  assert.deepEqual(offenders, [], offenders.join("\n  "));
});

test("mssql is external to the bundle, so the process holds one instance", () => {
  // The root-cause half of the fix. Without this, a Next build carries one copy of
  // mssql per bundle layer and the identity switch in getTediousType stops working
  // across them.
  const cfg = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
  // `[^\]]` rather than the `s` flag: tsconfig targets ES2017 here, where dotAll
  // is not available — and the character class is the more precise rule anyway,
  // since it also asserts both names are inside the array literal.
  assert.match(cfg, /serverExternalPackages:[^\]]*"mssql"/);
  assert.match(cfg, /serverExternalPackages:[^\]]*"tedious"/);
});

test("a bug in OUR query is NOT excused as an infrastructure blip", () => {
  // The dangerous failure mode of a classifier like this: a real defect wearing
  // "probably the network" and never getting looked at.
  assert.equal(classifyTotalEto(new Error("Invalid column name 'Foo'.")), "other");
  assert.equal(classifyTotalEto(new Error("Conversion failed when converting date")), "other");
  // As mssql actually raises it: the server ran the statement and objected.
  assert.equal(
    classifyTotalEto(Object.assign(new Error("Invalid column name 'Foo'."), { code: "EREQUEST", number: 207 })),
    "sql_error",
  );
  assert.match(
    describeTotalEtoFailure(Object.assign(new Error("Invalid column name 'Foo'."), { code: "EREQUEST" })),
    /Retrying cannot help/,
  );
  // And with NO driver code, Total ETO is not named at all (2026-09-09): an
  // unrecognised error inside a step that happens to own a Total ETO source used
  // to print "Total ETO query failed against SERVER-APP1", which sends whoever
  // reads it to check a server that may be perfectly healthy.
  const bare = describeTotalEtoFailure(new Error("Cannot read properties of undefined"));
  assert.match(bare, /no sign that Total ETO itself was involved/);
  assert.ok(!/SERVER-APP1/.test(bare), "must not blame a server it has no evidence against");
});

test("a failed write to OUR database is not reported as a Total ETO failure", () => {
  // Total ETO answers, and then syncPartsCost's own upsert loop fails. The step
  // owns a Total ETO source, so this module describes its errors — which is how a
  // MySQL problem came to read as a SQL Server one.
  const prismaError = Object.assign(new Error("Unique constraint failed on the fields: (`jobId`,`section`,`month`)"), {
    name: "PrismaClientKnownRequestError",
    code: "P2002",
  });
  assert.equal(classifyTotalEto(prismaError), "app_write");
  const msg = describeTotalEtoFailure(prismaError);
  assert.match(msg, /this app's own database/);
  assert.ok(!isTransientTotalEto("app_write"), "a constraint violation does not fix itself on the hour");
});

test("the login-rejected message says who must do what", () => {
  const msg = describeTotalEtoFailure(Object.assign(new Error("Login failed."), { code: "ELOGIN" }));
  assert.match(msg, /TOTALETO_DB_USER/, "must name the setting to change");
  assert.match(msg, /Retrying will not help/, "must say the hourly schedule cannot fix this");
  assert.match(msg, /SERVER-APP1/, "must name the server");
});

test("a retryable failure says so, and does not send anyone to .env", () => {
  const msg = describeTotalEtoFailure(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
  assert.match(msg, /Worth retrying/);
  assert.ok(!/TOTALETO_DB_PASSWORD/.test(msg), "a network blip is not a credentials problem");
});

test("there is exactly ONE Total ETO connection config in the app", () => {
  // The four copies (sync-totaleto, cash-flow-totaleto, cash-flow-drill, job-bom)
  // are what made "one shared failure or four separate ones?" unanswerable from
  // the source. A fifth copy would bring that back.
  const offenders: string[] = [];
  for (const file of readdirSync(LIB).filter((f) => f.endsWith(".ts"))) {
    if (file === "totaleto-connection.ts") continue;
    const s = readFileSync(join(LIB, file), "utf8");
    if (s.includes("SERVER-APP1")) offenders.push(`${file} hardcodes the Total ETO server`);
    if (/domain:\s*"stevendouglas"/.test(s)) offenders.push(`${file} builds its own NTLM config`);
  }
  assert.deepEqual(offenders, [], offenders.join("\n  "));
});

test("per-caller query timeouts survived the consolidation", () => {
  // These differences are real — a BOM walk legitimately needs longer than a job
  // list — so flattening them to one value would have been a regression dressed
  // as cleanup.
  assert.ok(TOTALETO_TIMEOUT.bom > TOTALETO_TIMEOUT.cashFlow);
  assert.ok(TOTALETO_TIMEOUT.cashFlow > TOTALETO_TIMEOUT.sync);
  assert.equal(totalEtoConfig(TOTALETO_TIMEOUT.bom).requestTimeout, TOTALETO_TIMEOUT.bom);
});

test("the config still authenticates over NTLM against the right database", () => {
  const c = totalEtoConfig();
  assert.equal(c.database, "SDC");
  assert.equal(c.domain, "stevendouglas", "NTLM, not a SQL login — this is why a domain password change breaks it");
  assert.equal(c.port, 1433);
});

test("the four Total ETO refresh sources are named in one place", () => {
  // The lane checks the login once for exactly this set; if a fifth Total ETO
  // source is added and not listed, it would get a raw driver message again.
  assert.deepEqual(
    [...TOTALETO_SOURCES].sort(),
    ["cash_flow_snapshot", "parts_cost", "parts_cost_actual", "totaleto_jobs"],
  );
});

test("a rejected login short-circuits the lane; a blip does not", () => {
  // Only login_rejected skips the four queries. A transient preflight failure
  // must not cost a pass that would otherwise have succeeded.
  const s = readFileSync(join(LIB, "auto-sync.ts"), "utf8");
  assert.match(s, /login\.kind === "login_rejected"/, "only a rejected login blocks the lane");
  assert.equal((s.match(/if \(blocked\) throw new Error\(blocked\);/g) ?? []).length, 4, "all four sources honour it");
});
