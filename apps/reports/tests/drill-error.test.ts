import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── A drill must never print React's redaction (2026-09-01) ─────────────────
//
// Reported on Monthly ETC: expanding a job under "Parts spent" rendered
// "An error occurred in the Server Components render. The specific message is
// omitted in production builds..." into the table. That is what the client
// receives whenever an unhandled error escapes a Server Action — the client half
// was already catching it and showing `error.message`, so the app degraded
// correctly and then displayed a sentence about React internals.
//
// The real error was ELOGIN from the Total ETO SQL Server. `withDrillErrors`
// catches it, logs the real one, and throws a sentence naming the system.
//
// drill-error.ts is `server-only`, which throws under this test runner, so these
// assert on the source. The behaviour worth pinning is structural anyway: that
// every action reaching an external system goes through the helper.

const LIB = join(process.cwd(), "src", "lib");
const src = (f: string) => readFileSync(join(LIB, f), "utf8");

test("withDrillErrors logs the real error server-side and never returns it", () => {
  const s = src("drill-error.ts");
  assert.ok(s.includes("console.error"), "the real error must reach the log");
  assert.ok(/stack/.test(s), "the log needs the stack to be debuggable");
  // The thrown message must carry the request id and NOT the original text.
  const thrown = s.slice(s.indexOf("throw new Error("));
  assert.ok(thrown.includes("ref ${requestId}"), "the user-facing message must carry a correlation id");
  assert.ok(!/error\.message/.test(thrown), "the upstream's own message must not reach the browser");
});

test("an unreachable upstream is named; anything else stays generic", () => {
  const s = src("drill-error.ts");
  // The narrow list is the point: guessing "it's just the network" about a real
  // defect would hide the defect.
  for (const code of ["ELOGIN", "ETIMEOUT", "ECONNREFUSED", "ESOCKET"]) {
    assert.ok(s.includes(code), `${code} should classify as "upstream unreachable"`);
  }
  assert.ok(s.includes("is not responding"), "the unreachable message should say the system is not responding");
  assert.ok(s.includes("Couldn't load this detail"), "anything unrecognised keeps the generic message");
  assert.ok(s.includes("figures already on the page are unaffected"), "tell the user the page's own numbers still stand");
});

test("every Total ETO / Power BI drill action goes through the helper", () => {
  // The defect was one unwrapped action. These are the files holding drill actions
  // that leave the application database; each must route through withDrillErrors.
  for (const file of ["hours-detail-actions.ts", "tm-drill-actions.ts"]) {
    const s = src(file);
    assert.ok(s.includes("withDrillErrors"), `${file} must use the shared drill error helper`);
  }
});

test("there is only ONE drill error implementation", () => {
  // tm-drill-actions.ts used to own a private `withDrillLogging`. It was extracted
  // so the ETC drill could reuse it; a second copy would drift.
  const tm = src("tm-drill-actions.ts");
  assert.ok(!/function withDrillLogging/.test(tm), "the private copy is gone — one helper, in drill-error.ts");
});

test("the Total ETO job-lines action is the one that needed wrapping", () => {
  const s = src("hours-detail-actions.ts");
  const fn = s.slice(s.indexOf("export async function loadJobPartsLines"));
  assert.ok(fn.includes("withDrillErrors"), "loadJobPartsLines reaches Total ETO and must not leak a raw ConnectionError");
  assert.ok(fn.includes('upstream: "totaleto"'), "so the message can name Total ETO");
});
