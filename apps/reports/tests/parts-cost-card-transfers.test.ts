import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  matchTransfers,
  netTransfersByJob,
  summarizeTransfersForJobs,
  describeTransfers,
  type PullRow,
  type Transfer,
} from "../src/lib/parts-transfer-netting";
import { computePartsProjection, computeYetToInvoice } from "../src/lib/parts-projection";
import { leftToInvoiceForLines } from "../src/lib/left-to-invoice";
import { actualTotal, purchasedTotal } from "../src/lib/parts-budget-projection";
import type { PartsCostLine } from "../src/lib/sync-totaleto";

// ── Transfers on the Job Details Parts Cost card (2026-10-13) ────────────────
//
// The card is built from a job's PO lines, which are invoices, so a job whose parts were
// moved to another job (booked as inventory pulls — Total ETO cannot re-code an invoice)
// kept the cost on the card while the Projects grid already netted it. The card now adds the
// transfer to Invoiced AND Purchased, by the same amount, and to nothing else.

const T = (from: number, to: number, costOut: number, costIn = costOut, day = "2026-08-24", itemId = 1): Transfer => ({
  fromJob: String(from), toJob: String(to), itemId, qty: 1, costOut, costIn, day, negPullIds: [1], posPullIds: [2],
});

test("job 1155 card: everything that left is one 'out' entry to 1160", () => {
  const s = summarizeTransfersForJobs([T(1155, 1160, 20246.44, 20208.42), T(1155, 1160, 216.64)], ["1155"]);
  assert.equal(s.entries.length, 1);
  assert.deepEqual(
    { d: s.entries[0].direction, o: s.entries[0].otherJob, a: s.entries[0].amount, n: s.entries[0].transfers },
    { d: "out", o: "1160", a: -20463.08, n: 2 },
  );
  assert.equal(s.net, -20463.08);
});

test("job 1160 card: the same transfer is an 'in' entry from 1155, at 1160's own booked cost", () => {
  const s = summarizeTransfersForJobs([T(1155, 1160, 20246.44, 20208.42), T(1155, 1160, 216.64)], ["1160"]);
  assert.equal(s.entries[0].direction, "in");
  assert.equal(s.entries[0].otherJob, "1155");
  assert.equal(s.net, 20425.06);
});

test("a single job's card equals what the Projects grid nets for that job", () => {
  const rows: PullRow[] = [
    { id: 1, jobId: 1155, itemId: 5, qty: -3, cost: -86.4, day: "2026-08-24", poLinked: false },
    { id: 2, jobId: 1160, itemId: 5, qty: 1, cost: 28.8, day: "2026-08-24", poLinked: false },
    { id: 3, jobId: 1160, itemId: 5, qty: 2, cost: 57.6, day: "2026-08-24", poLinked: false },
    { id: 4, jobId: 1107, itemId: 9, qty: -1, cost: -264.91, day: "2026-10-08", poLinked: false },
    { id: 5, jobId: 1165, itemId: 9, qty: 1, cost: 264.91, day: "2026-10-08", poLinked: false },
  ];
  const { transfers } = matchTransfers(rows);
  const grid = netTransfersByJob(transfers);
  for (const job of ["1155", "1160", "1107", "1165"]) {
    assert.equal(summarizeTransfersForJobs(transfers, [job]).net, grid.get(job), `job ${job}`);
  }
});

test("a transfer between two jobs INSIDE the selection never left it, so it is not shown or counted", () => {
  const s = summarizeTransfersForJobs([T(1155, 1160, 100), T(1155, 1170, 40)], ["1155", "1160"]);
  assert.equal(s.entries.length, 1, "only the transfer that crosses the selection's edge");
  assert.equal(s.entries[0].otherJob, "1170");
  assert.equal(s.net, -40);
});

test("jobs the selection does not contain, and an empty selection, contribute nothing", () => {
  assert.deepEqual(summarizeTransfersForJobs([T(1155, 1160, 100)], ["1999"]), { net: 0, entries: [] });
  assert.deepEqual(summarizeTransfersForJobs([T(1155, 1160, 100)], []), { net: 0, entries: [] });
  assert.deepEqual(summarizeTransfersForJobs([], ["1155"]), { net: 0, entries: [] });
});

test("entries are one per direction and counterpart, largest first, with the latest day", () => {
  const s = summarizeTransfersForJobs(
    [T(1155, 1160, 10, 10, "2026-08-24"), T(1170, 1160, 500, 500, "2026-09-02"), T(1155, 1160, 5, 5, "2026-09-10")],
    ["1160"],
  );
  assert.deepEqual(s.entries.map((e) => [e.otherJob, e.amount, e.transfers, e.lastDay]), [
    ["1170", 500, 1, "2026-09-02"],
    ["1155", 15, 2, "2026-09-10"],
  ]);
});

test("describeTransfers names the other job, the direction and the dollars, and caps long lists", () => {
  assert.equal(
    describeTransfers([{ direction: "out", otherJob: "1160", amount: -20463.08, transfers: 2, lastDay: "2026-08-24" }]),
    "moved to job 1160 (−$20,463)",
  );
  assert.equal(
    describeTransfers([{ direction: "in", otherJob: "1155", amount: 20425.06, transfers: 2, lastDay: "2026-08-24" }]),
    "moved in from job 1155 (+$20,425)",
  );
  const many = ["1", "2", "3", "4", "5"].map((o) => ({ direction: "in" as const, otherJob: o, amount: 1, transfers: 1, lastDay: "2026-08-24" }));
  assert.match(describeTransfers(many), /, \+2 more$/);
  assert.equal(describeTransfers([]), "no transfers");
});

// ── The arithmetic the card does with it, using the app's own functions ──────

const line = (o: Partial<PartsCostLine> & Pick<PartsCostLine, "totalPrice" | "actualAmount">): PartsCostLine => ({
  lineId: `pod:${Math.random()}`, itemId: 1, purchaseDate: "2026-05-01", invoicedDate: "2026-06-01", supplier: "Acme",
  manufacturer: null, category: null, poNumber: "1", partNumber: "A", description: "x", quantity: 1, unitPrice: o.totalPrice,
  invoicedAmount: o.actualAmount, ...o,
});

test("netting Invoiced AND Purchased leaves Left to invoice and the open balance exactly where they were", () => {
  // 1155-shaped: everything received, a small open PO balance.
  const lines = [line({ totalPrice: 29641.69, actualAmount: 29641.69 }), line({ totalPrice: 2559.19, actualAmount: 0 })];
  const net = -20463.08;
  const before = { inv: actualTotal(lines), pur: purchasedTotal(lines), left: leftToInvoiceForLines(lines), open: computeYetToInvoice(lines).allRows };
  const after = { inv: before.inv + net, pur: before.pur + net, left: leftToInvoiceForLines(lines), open: computeYetToInvoice(lines).allRows };
  assert.equal(after.left, before.left);
  assert.equal(after.open, before.open);
  assert.ok(Math.abs(after.pur - after.inv - (before.pur - before.inv)) < 1e-9, "Purchased - Invoiced is unchanged");
  assert.equal(Math.round(after.inv), 9179);
  assert.equal(Math.round(after.pur), 11738);
});

test("job 1160: the projection moves by exactly the transfer — the ETC and open balance are not touched", () => {
  const lines = [line({ totalPrice: 179082.82, actualAmount: 179082.82 }), line({ totalPrice: 60585.31, actualAmount: 0 })];
  const open = computeYetToInvoice(lines).allRows;
  const base = computePartsProjection({ invoiced: actualTotal(lines), priorEtc: 70064.75, partsSpentThisMonth: 818.75, openBalance: open });
  const moved = computePartsProjection({ invoiced: actualTotal(lines) + 20425.06, priorEtc: 70064.75, partsSpentThisMonth: 818.75, openBalance: open });
  assert.ok(Math.abs(moved.totalProjection - base.totalProjection - 20425.06) < 1e-6);
  assert.equal(moved.adjustedEtc, base.adjustedEtc, "the manager's ETC is never rewritten by a transfer");
  assert.equal(moved.additionalExposure, base.additionalExposure);
});

// ── Structural guards: what must NOT change, and where it is wired ───────────

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const noComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

test("the card adds the transfer to Invoiced and Purchased only — never to the lines, Left to invoice or the ETC", () => {
  const src = noComments(read("src", "lib", "parts-cost-financials.ts"));
  assert.match(src, /const invoiced = actualTotal\(lines\) \+ transfers\.net;/);
  assert.match(src, /purchased: purchasedTotal\(lines\) \+ transfers\.net,/);
  assert.match(src, /const leftToInvoice = projection \? projection\.committedNotPosted : leftToInvoiceForLines\(lines\);/);
  assert.match(src, /const yet = computeYetToInvoice\(lines\);/);
  assert.equal((src.match(/transfers\.net/g) ?? []).length, 3, "added to invoiced and purchased, and reported once");
  assert.doesNotMatch(src, /lines\.push|lines\.concat|\.\.\.transfers/, "the raw PO lines are never touched");
});

test("a failed transfers read is flagged on the card, not absorbed as 'no transfers'", () => {
  const src = noComments(read("src", "lib", "parts-cost-financials.ts"));
  assert.match(src, /const transfersUnavailable = transferSummary == null;/);
  assert.match(src, /transfersUnavailable,/);
});

test("getPartsCostForJobs / getJobPartsCost and the money-spent queries are untouched — every other reader keeps real purchase lines only", () => {
  const src = noComments(read("src", "lib", "sync-totaleto.ts"));
  for (const name of ["getPartsCostForJobs", "getJobPartsCost", "getJobPartsInvoicedInMonth", "getPartsCostBookedByJob"]) {
    const start = src.indexOf(`export async function ${name}`);
    assert.ok(start >= 0, name);
    const next = src.indexOf("\nexport ", start + 1);
    const body = src.slice(start, next === -1 ? undefined : next);
    assert.doesNotMatch(body, /transfer|loadTransfers|netting/i, `${name} must not know about transfers`);
  }
});

test("only the Parts Cost card's own server module reads transfers for display", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(f) && /getTransfersForJobs/.test(readFileSync(full, "utf8"))) offenders.push(full.slice(ROOT.length + 1).replace(/\\/g, "/"));
    }
  };
  walk(join(ROOT, "src"));
  assert.deepEqual(offenders.sort(), ["src/lib/parts-cost-financials.ts", "src/lib/sync-totaleto.ts"]);
});

test("the drill adds transfer ROWS from the same entries, so its footer sums to the card", () => {
  const src = noComments(read("src", "components", "PartsCostDrill.tsx"));
  assert.match(src, /\.\.\.transferRows\(financials\.transfers\)/);
  assert.match(src, /const invoiceBasis = financials\.invoiced - financials\.transfersNet;/, "the months-vs-lifetime note compares invoices with invoices");
  assert.match(src, /isTransfer \? "—"/, "a transfer row has no quantity or unit price");
});

test("the Parts List only DESCRIBES the transfer — its rows, totals and reconciliation are untouched", () => {
  const src = noComments(read("src", "components", "JobProcurement.tsx"));
  assert.match(src, /unexplained: jobTotal - \(matchedTotal - estimated\),/, "the equation is the same");
  assert.match(src, /transfersNet: transfers\?\.net \?\? 0,/);
  assert.doesNotMatch(src, /total \+= .*transfer/i, "no transfer is ever summed into a row total");
});
