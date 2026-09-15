import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── The draft save cannot unlock a month; the freeze, validation and the grid
//    share one job universe; the fee rows are built inside the freeze (2026-09-14) ──
//
// saveAllNewEtcDrafts, submitEtcEntriesInTx and submitMonthlyReport all read the
// module-level Prisma client and the session, so they cannot be run here. What CAN be
// pinned is the shape of the code — the same way tests/parts-list-invoiced-window-
// action.test.ts pins a thin reuse rather than re-testing a query. The rules
// themselves (assertMonthNotLocked, isMonthLocked, the Parts rule) are behavioural
// tests in tests/etc.test.ts.

const SRC = join(import.meta.dirname, "..", "src");
function code(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/\/\/[^\n"'`]*$/gm, "");
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} must exist in the source`);
  const nextExport = source.indexOf("\nexport ", start + 1);
  return nextExport === -1 ? source.slice(start) : source.slice(start, nextExport);
}

const ACTIONS = () => code("lib", "etc-actions.ts");
const REPORT = () => code("lib", "monthly-report.ts");
const REPORT_ACTIONS = () => code("lib", "monthly-report-actions.ts");

// ── Finding 2: the lock guard on the draft save ─────────────────────────────

test("saveAllNewEtcDrafts refuses a locked month before preparing any write", () => {
  const body = functionBody(ACTIONS(), "saveAllNewEtcDrafts");
  const guard = body.indexOf("assertMonthNotLocked(month, entries)");
  assert.ok(guard >= 0, "the month's entries must be checked with assertMonthNotLocked");
  const firstWrite = body.indexOf("writes.push(");
  assert.ok(firstWrite >= 0);
  assert.ok(guard < firstWrite, "the lock check must come before the first write is prepared");
  // The month read it guards includes needsReview — that is what isMonthLocked reads.
  const read = body.slice(0, guard);
  assert.match(read, /needsReview: true/);
});

test("the create path cannot race past the top check: the lock is re-checked inside the write transaction", () => {
  const body = functionBody(ACTIONS(), "saveAllNewEtcDrafts");
  // An interactive transaction over thunks, not `prisma.$transaction(writes)` over
  // pre-built promises — the re-check has to see the same rows the writes touch.
  assert.match(body, /prisma\.\$transaction\(async \(tx\) => \{/);
  assert.match(body, /assertMonthNotLocked\(month, await tx\.etcEntry\.findMany\(\{ where: \{ month \}, select: \{ needsReview: true \} \}\)\)/);
  assert.match(body, /for \(const write of writes\) await write\(tx\);/);
  // No write is built against the shared client any more.
  assert.doesNotMatch(body, /prisma\.etcEntry\.(update|upsert)\(/);
  // The create upsert in particular goes through the transaction client.
  assert.match(body, /tx\.etcEntry\.upsert\(/);
});

// ── Finding 6: one job universe for the grid, validation, the freeze and Refresh ──

test("the freeze prunes and freezes by getEtcMonthJobIds, not by a job filter of its own", () => {
  const body = functionBody(REPORT(), "submitEtcEntriesInTx");
  assert.match(body, /getEtcMonthJobIds\(month, tx\)/, "evaluated inside the transaction");
  assert.doesNotMatch(body, /etcEligibleJobFilter|etcActiveJobFilter/);
  assert.doesNotMatch(REPORT(), /import \{[^}]*etcEligibleJobFilter[^}]*\} from "@\/lib\/job-filters"/);
});

test("Refresh Data prunes by the same universe", () => {
  const src = ACTIONS();
  const start = src.indexOf("async function pruneStaleEntries");
  assert.ok(start >= 0);
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(body, /getEtcMonthJobIds\(month\)/);
  assert.doesNotMatch(body, /etcActiveJobFilter/);
});

test("validation scopes to the same `where` the freeze and the grid use", () => {
  const body = functionBody(REPORT(), "validateMonthlyReport");
  assert.match(body, /getEtcMonthJobWhere\(month\)/);
  assert.match(body, /entriesInSubmissionScope\(entries, eligibleJobIds\)/);
});

// ── Finding 9: the fee rows are computed inside the freeze transaction ───────

test("submitMonthlyReport computes the Standard Sheet rows inside the transaction, after the entries are frozen", () => {
  const body = functionBody(REPORT_ACTIONS(), "submitMonthlyReport");
  const tx = body.indexOf("prisma.$transaction(");
  const freeze = body.indexOf("submitEtcEntriesInTx(tx, month, userId)");
  const rows = body.indexOf("loadStandardSheetRows(month, tx)");
  assert.ok(tx >= 0 && freeze >= 0 && rows >= 0);
  assert.ok(tx < freeze && freeze < rows, "freeze first, then the fee rows, both inside the transaction");
  // And not read ahead of it any more.
  assert.equal(body.indexOf("loadStandardSheetRows(month)"), -1);
});

test("loadStandardSheetRows reads the month through the client it is given", () => {
  const body = functionBody(REPORT(), "loadStandardSheetRows");
  assert.match(body, /getEtcMonthJobWhere\(month, db\)/);
  assert.match(body, /getExecutionEtcByJob\([\s\S]*?\{ db \}\)/);
  assert.match(body, /db\.standardSheetSetting\.findUnique/);
});

test("the fingerprint covers the two Parts halves and the per-job contingency", () => {
  const body = functionBody(REPORT(), "monthDataFingerprint");
  assert.match(body, /leftToInvoice/);
  assert.match(body, /leftToPurchase/);
  assert.match(body, /FROM ExecutionRate/);
  assert.match(body, /contingencyAmount/);
});

// ── Finding 3(a): history rows are stamped, and the stamp does not claim ownership ──

test("sync-etc-history stamps every history row it writes and ignores its own stamp when deciding ownership", () => {
  const src = code("lib", "sync-etc-history.ts");
  assert.match(src, /needsReview: false,\s*submittedAt: historyConfirmedAt\(period\.month\)/);
  assert.match(src, /isHistoryConfirmedAt\(r\.month, r\.submittedAt\)/);
  // The naive `submittedAt: { not: null }` ownership clause is gone.
  assert.doesNotMatch(src, /OR: \[\{ submittedAt: \{ not: null \} \}/);
});

// ── Finding 7: a locked month's Parts cell never re-derives from the live halves ──

test("PartsCostNewEtcCell adopts the server seed on mount and never subscribes on a frozen month", () => {
  const src = code("components", "PartsCostNewEtcCell.tsx");
  assert.match(src, /if \(!derived \|\| frozen\) return;/);
  assert.match(src, /const applied = useRef<string \| null>\(null\);/);
  const page = code("app", "(app)", "etc", "page.tsx");
  assert.match(page, /frozen=\{locked\}/);
  // And the page seeds the cell from the one Parts rule, never from the live sum first.
  assert.match(page, /const partsCostState = partsCostCellState\(partsCostEntry, partsLive/);
  assert.match(page, /const partsCostSeed = newEtcSeedText\(partsCostState\);/);
  assert.doesNotMatch(page, /isHistoricalMonth \|\| .*submittedAt != null/);
});
