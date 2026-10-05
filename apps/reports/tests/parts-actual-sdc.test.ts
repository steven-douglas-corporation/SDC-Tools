import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitActualBySdc } from "../src/lib/parts-actual-sdc";

// ── The Projects export's "excl. SDC" Parts Cost columns (2026-10-02) ────────────────
//
// Steven Douglas Corp. never invoices itself, so the export offers the lifetime
// GL-posted actual with SDC's own billing removed. Calculated live at export time; the
// grid and Job.costActualHistorical are untouched. The pure split is tested with
// fixtures; the SQL and the export wiring are pinned by source shape, the convention
// the other Total ETO tests use because the query itself needs a live connection.

const line = (jobId: string, vendor: string | null, amount: number) => ({ jobId, vendor, amount });

test("actual is everything; sdc is only the Steven Douglas Corp. share", () => {
  const m = splitActualBySdc([
    line("1101", "KEYENCE CORP OF AMERICA", 1700),
    line("1101", "Steven Douglas Corp.", 300),
    line("1101", "McMASTER-CARR SUPPLY CO.", 100),
  ]);
  assert.deepEqual(m.get("1101"), { actual: 2100, sdc: 300 });
});

test("a job with no SDC billing has sdc 0 and actual unchanged", () => {
  const m = splitActualBySdc([line("1142", "Pemco Incorporated", 500), line("1142", "REXEL", 250)]);
  assert.deepEqual(m.get("1142"), { actual: 750, sdc: 0 });
});

test("every SDC spelling isSdcVendor accepts is counted, including the AP-approval suffix", () => {
  const m = splitActualBySdc([
    line("1106", "Steven Douglas Corp.", 10),
    line("1106", "STEVEN DOUGLAS CORPORATION", 20),
    line("1106", "Steven Douglas Corp. [Concord] (Approved)", 209625),
    line("1106", "SDC", 5),
  ]);
  assert.equal(m.get("1106")!.sdc, 10 + 20 + 209625 + 5);
  assert.equal(m.get("1106")!.actual, m.get("1106")!.sdc);
});

test("SDC Credit Card and Expense Reports are NOT SDC-as-supplier: they stay in actual, out of sdc", () => {
  // A payment method and an expense channel (lib/vendor-normalize.ts). Removing them would
  // quietly delete genuine outside spend from the comparison.
  const m = splitActualBySdc([
    line("1150", "SDC Credit Card", 3944.13),
    line("1150", "Steven Douglas Corp. Expense Reports", 2429.16),
    line("1150", "Steven Douglas Corp.", 30387.5),
  ]);
  assert.equal(m.get("1150")!.sdc, 30387.5);
  assert.ok(Math.abs(m.get("1150")!.actual - (3944.13 + 2429.16 + 30387.5)) < 1e-9);
});

test("credits net off, and an SDC credit reduces the SDC share", () => {
  const m = splitActualBySdc([
    line("1148", "BlackHawk Supply", -31765.2),
    line("1148", "ACME", 70000),
    line("1148", "Steven Douglas Corp.", -50),
    line("1148", "Steven Douglas Corp.", 200),
  ]);
  assert.ok(Math.abs(m.get("1148")!.actual - (70000 - 31765.2 + 150)) < 1e-9);
  assert.equal(m.get("1148")!.sdc, 150);
});

test("a vendor-less document is not SDC, and stays in actual", () => {
  const m = splitActualBySdc([line("1200", null, 75), line("1200", "", 25)]);
  assert.deepEqual(m.get("1200"), { actual: 100, sdc: 0 });
});

test("a non-finite amount is skipped, never turned into a confident figure", () => {
  const m = splitActualBySdc([line("1300", "ACME", Number.NaN), line("1301", "ACME", 10)]);
  assert.equal(m.has("1300"), false);
  assert.deepEqual(m.get("1301"), { actual: 10, sdc: 0 });
});

test("jobs are kept apart", () => {
  const m = splitActualBySdc([line("1", "Steven Douglas Corp.", 5), line("2", "ACME", 7), line("1", "ACME", 3)]);
  assert.deepEqual(m.get("1"), { actual: 8, sdc: 5 });
  assert.deepEqual(m.get("2"), { actual: 7, sdc: 0 });
});

// ── Source shape ─────────────────────────────────────────────────────────────

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const stripComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

test("the SDC split query shares the GL-posted predicate and the AP amount with getPartsActualByJob", () => {
  const src = stripComments(read("src", "lib", "sync-totaleto.ts"));
  const fn = src.slice(src.indexOf("export async function getPartsActualSdcSplitByJob"));
  const body = fn.slice(0, fn.indexOf("feed: \"parts_actual.sdc_split_by_job\""));
  assert.match(body, /THEN \$\{AP_LINE_AMOUNT\} ELSE 0 END\) AS Amount/, "the one canonical AP line amount, summed (inside the optional date cut)");
  assert.match(body, /\$\{glPostedAp\("SFC"\)\}/, "the shared GL-posted predicate, not a copy");
  assert.match(body, /GROUP BY APDD\.ProjectID, SFC\.CName/, "grouped by vendor so the SDC share can be decided in TypeScript");
  assert.match(body, /splitActualBySdc\(/, "the SDC decision is the pure, tested function (isSdcVendor), not a SQL pattern");
  assert.doesNotMatch(body, /LIKE/i, "no second hand-written SDC pattern in SQL");
  // Short and non-retrying: a person is waiting on an export click.
  assert.match(fn, /requestTimeout: 40_000, attempts: 1/);
});

test("the Projects grid and the sync do not call the SDC split", () => {
  // The whole point of the export-only version: nothing on screen changes.
  for (const rel of [
    ["src", "app", "(app)", "quoted", "page.tsx"],
    ["src", "lib", "export", "projects-query.ts"],
  ]) {
    let text = "";
    try { text = read(...rel); } catch { continue; }
    assert.doesNotMatch(text, /getPartsActualSdcSplitByJob|splitActualBySdc/, `${rel.join("/")} must not use the SDC split`);
  }
  const sync = stripComments(read("src", "lib", "sync-totaleto.ts"));
  const syncFn = sync.slice(sync.indexOf("export async function syncPartsCostActual"), sync.indexOf("export async function syncFromTotalEto"));
  assert.doesNotMatch(syncFn, /getPartsActualSdcSplitByJob|splitActualBySdc/, "syncPartsCostActual must keep writing the SDC-inclusive actual");
});

test("the export adds the four excl. SDC columns after Parts Cost Remaining, and the section columns shift with them", () => {
  const src = read("src", "lib", "export", "projects-export.ts");
  const order = [
    // Template literals since 2026-10-05: each gains ", through <date>" only when a date is set.
    "header: `Parts Cost Actual (GL-posted${through})`",
    'header: `Parts Cost Remaining${asOf ?',
    "header: `SDC Billed (GL-posted, ${asOf ?",
    "header: `Parts Cost Actual (GL-posted, excl. SDC${through})`",
    "header: `Parts Cost Remaining (excl. SDC${through})`",
    'header: "Excl. SDC basis"',
    "...sectionColumns",
  ].map((s) => src.indexOf(s));
  assert.ok(order.every((n) => n > 0), "every new header is present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in reading order");
  // Fixed columns are indexes 0-17 now; the per-section running index starts at 18, or
  // every section total would land one block too early.
  assert.match(src, /let i = 18;/);
  assert.match(src, /addTotal\(14, sdcBilled\);[\s\S]*addTotal\(15, costActualExcl\);[\s\S]*addTotal\(16, costRemainingExcl\);/);
  // The unqualified existing headers must survive, byte for byte.
  assert.match(src, /\{ header: `Parts Cost Actual \(GL-posted\$\{through\}\)`, type: "currency" \}/);
});

test("the export degrades to blank columns when Total ETO does not answer, rather than failing", () => {
  const src = read("src", "lib", "export", "projects-export.ts");
  // A LIVE export degrades; one with a date throws instead (tests/export-as-of.test.ts).
  assert.match(src, /let sdcSplit: Map<string, PartsActualSdcSplit> \| null = null;\s*try \{\s*sdcSplit = await getPartsActualSdcSplitByJob\(asOf\);\s*\} catch/);
  assert.match(src, /Unavailable - Total ETO did not respond/);
  assert.match(src, /if \(sdcSplit !== null\) costRemainingExcl =/, "no remaining figure is invented when the SDC read failed");
});

test("a manual historical figure is carried through and labelled, never altered", () => {
  const src = read("src", "lib", "export", "projects-export.ts");
  assert.match(src, /costActualExcl = costActual;/);
  assert.match(src, /Manual historical figure - SDC not separable/);
});
