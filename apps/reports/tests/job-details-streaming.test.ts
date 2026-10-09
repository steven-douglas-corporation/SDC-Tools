import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-shape guards for the Job Details "snappy selection" change. The behaviour
// itself is React/Next streaming and needs a browser; what a refactor can silently
// undo is the STRUCTURE it depends on, and that is what these pin.

const SRC = join(import.meta.dirname, "..", "src");
const page = readFileSync(join(SRC, "app", "(app)", "job-hours", "page.tsx"), "utf8");
const select = readFileSync(join(SRC, "components", "JobSelect.tsx"), "utf8");
const dash = readFileSync(join(SRC, "components", "JobHoursDashboard.tsx"), "utf8");
const strip = (raw: string) => raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the page does not await the Total ETO reads before rendering", () => {
  const code = strip(page);
  // The whole point: hours must not wait on Parts Cost / BOM. Awaiting either promise
  // (alone or in an all()) at the top level of the view puts them back on the critical path.
  assert.doesNotMatch(code, /await\s+(?:financialsPromise|bomPromise)\b/);
  assert.match(code, /await Promise\.all\(\[hoursDetailPromise, schedulerPromise\]\)/);
  // They are awaited only inside the streamed Procurement body.
  assert.match(code, /async function ProcurementBody[\s\S]*await Promise\.all\(\[bomPromise, financialsPromise\]\)/);
});

test("both streamed boundaries are keyed by the selection", () => {
  // Without a key, a boundary already showing the previous job holds its content (and the
  // whole new page) until the new promise settles — the old wait, reintroduced silently.
  assert.match(strip(page), /<Suspense key=\{selectionKey\}/);
  assert.equal((strip(dash).match(/<Suspense key=\{data\.jobRefs/g) ?? []).length, 2);
});

test("neither Total ETO promise can reject", () => {
  const code = strip(page);
  // An unawaited rejected promise is an unhandled rejection that can take the process down.
  assert.match(code, /getPartsCostFinancials\(data\.jobRefs\.map\(\(r\) => r\.id\)\)\.then\(/);
  assert.match(code, /console\.error\("getPartsCostFinancials failed:"/);
  assert.match(code, /withTimeoutOrNull\(`TotalETO BOM/);
});

test("JobSelect answers the click through the transition, not by waiting on the URL", () => {
  const code = strip(select);
  assert.match(code, /const sw = useJobSwitch\(\)/);
  assert.match(code, /sw\.select\(next, commit\)/);
  // The picker reads the optimistic selection, so the ✓ and chip move on the click frame.
  assert.match(code, /const selected = sw\?\.selected \?\? serverSelected/);
});
