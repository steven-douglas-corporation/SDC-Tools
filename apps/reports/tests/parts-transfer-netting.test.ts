import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  matchTransfers,
  netTransfersByJob,
  applyNetting,
  TRANSFER_NETTING_FROM,
  type PullRow,
} from "../src/lib/parts-transfer-netting";

// ── Job-to-job transfers booked as inventory pulls (2026-10-13) ──────────────
//
// 1155's parts were moved to 1160 in Total ETO. Total ETO cannot re-code an invoice, so
// the move is a negative pull on 1155 and a positive pull on 1160; the app only read the
// invoices and kept the cost on 1155. These pin the rule that nets it, and the cases it
// must NOT touch (the real database has -$4.9M of ordinary negative pulls).

let seq = 1;
const pull = (o: Partial<PullRow> & Pick<PullRow, "jobId" | "itemId" | "qty" | "cost" | "day">): PullRow => ({
  id: seq++,
  poLinked: false,
  ...o,
});
/** One transfer = two halves. */
const move = (from: number, to: number, itemId: number, qty: number, cost: number, day: string, costIn = cost) => [
  pull({ jobId: from, itemId, qty: -qty, cost: -cost, day }),
  pull({ jobId: to, itemId, qty, cost: costIn, day }),
];

test("the cutoff is 2026-08-01", () => {
  assert.equal(TRANSFER_NETTING_FROM, "2026-08-01");
});

test("1155 -> 1160: the leaving job loses the cost and the arriving job gains it", () => {
  const rows = [...move(1155, 1160, 2707, 1, 1694, "2026-08-24"), ...move(1155, 1160, 812, 3, 120.5, "2026-08-24", 118.75)];
  const { transfers } = matchTransfers(rows);
  assert.equal(transfers.length, 2);
  const net = netTransfersByJob(transfers);
  assert.equal(net.get("1155"), -1814.5, "each leaving pull's own cost comes off the from-job");
  assert.equal(net.get("1160"), 1812.75, "each arriving pull's OWN booked cost goes onto the to-job");
});

test("transfers before the cutoff are never applied", () => {
  const rows = [...move(1116, 1083, 500, 2, 3271.83, "2026-02-02"), ...move(1155, 1160, 600, 1, 50, "2026-07-31")];
  assert.equal(matchTransfers(rows).transfers.length, 0);
  assert.equal(matchTransfers(rows, { from: "2026-07-31" }).transfers.length, 1, "the cutoff is inclusive and a parameter");
});

test("a transfer dated exactly on the cutoff is applied", () => {
  assert.equal(matchTransfers(move(1155, 1160, 1, 1, 10, "2026-08-01")).transfers.length, 1);
});

test("the arriving half booked a few days BEFORE the cutoff still pairs", () => {
  const rows = [
    pull({ jobId: 1160, itemId: 9, qty: 2, cost: 40, day: "2026-07-30" }),
    pull({ jobId: 1155, itemId: 9, qty: -2, cost: -40, day: "2026-08-02" }),
  ];
  assert.equal(matchTransfers(rows).transfers.length, 1);
});

test("the stock bin (99999) is never a side of a transfer", () => {
  assert.equal(matchTransfers(move(99999, 1129, 5, 1, 300, "2026-08-03")).transfers.length, 0);
  assert.equal(matchTransfers(move(1129, 99999, 5, 1, 300, "2026-08-03")).transfers.length, 0);
});

test("an arriving pull that draws on a PO line is not a transfer (its invoice is already counted)", () => {
  const rows = [
    pull({ jobId: 1155, itemId: 7, qty: -1, cost: -80, day: "2026-08-10" }),
    pull({ jobId: 1160, itemId: 7, qty: 1, cost: 80, day: "2026-08-10", poLinked: true }),
  ];
  assert.equal(matchTransfers(rows).transfers.length, 0);
});

test("ordinary stock issues and returns are never netted", () => {
  const rows = [
    pull({ jobId: 1160, itemId: 1, qty: 4, cost: 120, day: "2026-08-12" }), // issued to a job from stock
    pull({ jobId: 1147, itemId: 2, qty: -3, cost: -900, day: "2026-08-12" }), // returned to stock
  ];
  const { transfers, unmatched } = matchTransfers(rows);
  assert.equal(transfers.length, 0);
  assert.equal(unmatched.length, 2, "left for review, not applied");
  assert.equal(netTransfersByJob(transfers).size, 0);
});

test("a different quantity, a different item, or the same job is not a match", () => {
  const rows = [
    pull({ jobId: 1155, itemId: 1, qty: -2, cost: -50, day: "2026-08-10" }),
    pull({ jobId: 1160, itemId: 1, qty: 3, cost: 50, day: "2026-08-10" }), // quantity differs
    pull({ jobId: 1155, itemId: 2, qty: -1, cost: -50, day: "2026-08-10" }),
    pull({ jobId: 1160, itemId: 3, qty: 1, cost: 50, day: "2026-08-10" }), // item differs
    pull({ jobId: 1155, itemId: 4, qty: -1, cost: -50, day: "2026-08-10" }),
    pull({ jobId: 1155, itemId: 4, qty: 1, cost: 50, day: "2026-08-10" }), // same job, in and out
  ];
  assert.equal(matchTransfers(rows).transfers.length, 0);
});

test("the two halves must fall within 14 days of each other", () => {
  assert.equal(matchTransfers([
    pull({ jobId: 1155, itemId: 1, qty: -1, cost: -50, day: "2026-08-20" }),
    pull({ jobId: 1160, itemId: 1, qty: 1, cost: 50, day: "2026-09-03" }),
  ]).transfers.length, 1, "exactly 14 days");
  assert.equal(matchTransfers([
    pull({ jobId: 1155, itemId: 1, qty: -1, cost: -50, day: "2026-08-20" }),
    pull({ jobId: 1160, itemId: 1, qty: 1, cost: 50, day: "2026-09-04" }),
  ]).transfers.length, 0, "15 days");
});

test("costs that disagree are not the same movement (1159 -> 1161: -$21.32 against $0)", () => {
  assert.equal(matchTransfers(move(1159, 1161, 3, 1, 21.32, "2026-10-06", 0)).transfers.length, 0);
  assert.equal(matchTransfers(move(1144, 1133, 3, 1, 41.79, "2026-08-06", 84.28)).transfers.length, 0, "more than double the cost is not the same part");
  assert.equal(matchTransfers(move(1144, 1133, 3, 1, 41.79, "2026-08-06", 42.3)).transfers.length, 1, "a few cents of costing drift is");
  assert.equal(matchTransfers(move(1155, 1160, 2726, 1, 225, "2026-08-24", 168)).transfers.length, 1, "each side is costed on its own: $225 out, $168 in is the real item 2726");
});

test("each arriving pull is used once, nearest date first, lowest id on a tie", () => {
  const out1 = pull({ jobId: 1155, itemId: 1, qty: -1, cost: -10, day: "2026-08-10" });
  const out2 = pull({ jobId: 1155, itemId: 1, qty: -1, cost: -10, day: "2026-08-10" });
  const in1 = pull({ jobId: 1160, itemId: 1, qty: 1, cost: 10, day: "2026-08-10" });
  const { transfers } = matchTransfers([out1, out2, in1]);
  assert.equal(transfers.length, 1, "one arrival can balance only one departure");
  assert.equal(transfers[0].negPullIds[0], out1.id, "the lower id goes first");
  const far = pull({ jobId: 1162, itemId: 8, qty: 1, cost: 10, day: "2026-08-16" });
  const near = pull({ jobId: 1161, itemId: 8, qty: 1, cost: 10, day: "2026-08-11" });
  const o = pull({ jobId: 1155, itemId: 8, qty: -1, cost: -10, day: "2026-08-10" });
  assert.equal(matchTransfers([far, near, o]).transfers[0].toJob, "1161", "the nearest arrival wins");
});

test("matching does not depend on the order rows arrive in", () => {
  const rows = [...move(1155, 1160, 1, 1, 10, "2026-08-24"), ...move(1155, 1160, 2, 5, 99.5, "2026-08-24"), ...move(1107, 1165, 3, 1, 264.91, "2026-10-08")];
  const a = netTransfersByJob(matchTransfers(rows).transfers);
  const b = netTransfersByJob(matchTransfers([...rows].reverse()).transfers);
  assert.deepEqual([...a].sort(), [...b].sort());
});

test("asOf keeps only transfers whose both halves are done by that day", () => {
  const rows = [...move(1155, 1160, 1, 1, 100, "2026-08-24"), ...move(1107, 1165, 2, 1, 264.91, "2026-10-08")];
  assert.equal(matchTransfers(rows, { asOf: "2026-09-30" }).transfers.length, 1);
  assert.equal(matchTransfers(rows, { asOf: "2026-08-23" }).transfers.length, 0);
  assert.equal(matchTransfers(rows, { asOf: null }).transfers.length, 2);
});

test("a transfer between two jobs nets to ~zero company-wide", () => {
  const net = netTransfersByJob(matchTransfers(move(1155, 1160, 1, 1, 100, "2026-08-24")).transfers);
  assert.equal([...net.values()].reduce((a, b) => a + b, 0), 0);
});

test("applyNetting adds onto an existing actual and rounds to cents", () => {
  const actual = new Map([["1155", 29641.69], ["1160", 178674.1]]);
  applyNetting(actual, new Map([["1155", -20246.44], ["1160", 20208.42]]));
  assert.equal(actual.get("1155"), 9395.25);
  assert.equal(actual.get("1160"), 198882.52);
});

test("applyNetting never creates a job — absence means 'no Total ETO data' (manual actuals)", () => {
  const actual = new Map([["1160", 100]]);
  applyNetting(actual, new Map([["4242", 50], ["1160", 5]]));
  assert.equal(actual.has("4242"), false);
  assert.equal(actual.get("1160"), 105);
});

// ── Transfers booked in pieces (1155 -> 1160, 2026-08-24) ────────────────────

const out = (jobId: number, itemId: number, qty: number, cost: number, day: string, o: Partial<PullRow> = {}) =>
  pull({ jobId, itemId, qty: -qty, cost: -cost, day, ...o });
const into = (jobId: number, itemId: number, qty: number, cost: number, day: string, o: Partial<PullRow> = {}) =>
  pull({ jobId, itemId, qty, cost, day, ...o });

test("one leaving pull that arrived in pieces is matched (item 2744: 8 out, 1 + 7 in)", () => {
  const rows = [out(1155, 2744, 8, 101.6, "2026-08-24"), into(1160, 2744, 1, 12.7, "2026-08-24"), into(1160, 2744, 7, 88.9, "2026-08-24")];
  const { transfers, unmatched } = matchTransfers(rows);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].qty, 8);
  assert.equal(transfers[0].posPullIds.length, 2);
  assert.equal(unmatched.length, 0);
  const net = netTransfersByJob(transfers);
  assert.equal(net.get("1155"), -101.6);
  assert.equal(net.get("1160"), 101.6);
});

test("the four real split items from 1155 -> 1160 all match", () => {
  const rows = [
    out(1155, 2655, 3, 86.4, "2026-08-24"), into(1160, 2655, 1, 28.8, "2026-08-24"), into(1160, 2655, 2, 57.6, "2026-08-24"),
    out(1155, 2764, 20, 20, "2026-08-24"), into(1160, 2764, 18, 18, "2026-08-24"), into(1160, 2764, 2, 2, "2026-08-24"),
    out(1155, 2775, 3, 8.64, "2026-08-24"), into(1160, 2775, 2, 5.76, "2026-08-24"), into(1160, 2775, 1, 2.88, "2026-08-24"),
  ];
  const { transfers, unmatched } = matchTransfers(rows);
  assert.equal(transfers.length, 3);
  assert.equal(unmatched.length, 0);
  assert.equal(netTransfersByJob(transfers).get("1155"), -115.04);
});

test("several leaving pulls that arrived as one are matched too", () => {
  const rows = [out(1155, 5, 1, 10, "2026-08-24"), out(1155, 5, 2, 20, "2026-08-24"), into(1160, 5, 3, 30, "2026-08-24")];
  const { transfers } = matchTransfers(rows);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].negPullIds.length, 2);
});

test("pieces that do not add up exactly are NOT matched (item 2738: 2 out, only 1 in)", () => {
  const rows = [out(1155, 2738, 2, 138.8, "2026-08-24"), into(1160, 2738, 1, 69.4, "2026-08-24")];
  const { transfers, unmatched } = matchTransfers(rows);
  assert.equal(transfers.length, 0);
  assert.equal(unmatched.length, 2, "left for review");
});

test("pieces split across two different arriving jobs are ambiguous and not applied", () => {
  const rows = [
    out(1155, 7, 4, 40, "2026-08-24"),
    into(1160, 7, 1, 10, "2026-08-24"), into(1160, 7, 3, 30, "2026-08-24"),
    into(1162, 7, 2, 20, "2026-08-24"), into(1162, 7, 2, 20, "2026-08-24"),
  ];
  assert.equal(matchTransfers(rows).transfers.length, 0);
});

test("a piece that is PO-linked, on the stock bin, outside the window, or another item is never used", () => {
  const base = out(1155, 9, 4, 40, "2026-08-24");
  assert.equal(matchTransfers([base, into(1160, 9, 1, 10, "2026-08-24", { poLinked: true }), into(1160, 9, 3, 30, "2026-08-24")]).transfers.length, 0);
  assert.equal(matchTransfers([base, into(99999, 9, 1, 10, "2026-08-24"), into(99999, 9, 3, 30, "2026-08-24")]).transfers.length, 0);
  assert.equal(matchTransfers([base, into(1160, 9, 1, 10, "2026-08-24"), into(1160, 9, 3, 30, "2026-09-20")]).transfers.length, 0);
  assert.equal(matchTransfers([base, into(1160, 9, 1, 10, "2026-08-24"), into(1160, 10, 3, 30, "2026-08-24")]).transfers.length, 0);
});

test("pieces whose cost is unrelated to the leaving cost are rejected", () => {
  const rows = [out(1155, 11, 4, 400, "2026-08-24"), into(1160, 11, 1, 1, "2026-08-24"), into(1160, 11, 3, 2, "2026-08-24")];
  assert.equal(matchTransfers(rows).transfers.length, 0);
});

test("a one-to-one match always wins over a split that could reuse the same pulls", () => {
  const rows = [out(1155, 12, 3, 30, "2026-08-24"), into(1160, 12, 3, 30, "2026-08-24"), into(1160, 12, 1, 10, "2026-08-24"), into(1160, 12, 2, 20, "2026-08-24")];
  const { transfers, unmatched } = matchTransfers(rows);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].posPullIds.length, 1, "the exact pull was taken, not the two pieces");
  assert.equal(unmatched.length, 2, "the two pieces are left, not double counted");
});

test("no pull is ever used twice, and results do not depend on row order", () => {
  const rows = [
    out(1155, 2744, 8, 101.6, "2026-08-24"), into(1160, 2744, 1, 12.7, "2026-08-24"), into(1160, 2744, 7, 88.9, "2026-08-24"),
    out(1155, 2764, 20, 20, "2026-08-24"), into(1160, 2764, 18, 18, "2026-08-24"), into(1160, 2764, 2, 2, "2026-08-24"),
    out(1155, 13, 1, 5, "2026-08-24"), into(1160, 13, 1, 5, "2026-08-24"),
  ];
  const a = matchTransfers(rows);
  const ids = a.transfers.flatMap((t) => [...t.negPullIds, ...t.posPullIds]);
  assert.equal(new Set(ids).size, ids.length);
  const b = matchTransfers([...rows].reverse());
  assert.deepEqual([...netTransfersByJob(a.transfers)].sort(), [...netTransfersByJob(b.transfers)].sort());
});

test("a split transfer respects asOf once its LAST piece is booked", () => {
  const rows = [out(1155, 14, 8, 80, "2026-08-24"), into(1160, 14, 1, 10, "2026-08-24"), into(1160, 14, 7, 70, "2026-09-02")];
  assert.equal(matchTransfers(rows, { asOf: "2026-08-31" }).transfers.length, 0);
  assert.equal(matchTransfers(rows, { asOf: "2026-09-02" }).transfers.length, 1);
});

// ── Wiring: structural guards, like the sibling parts tests (no Total ETO in CI) ──

const SRC = readFileSync(join(import.meta.dirname, "..", "src", "lib", "sync-totaleto.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
const span = (name: string) => {
  const start = SRC.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = SRC.indexOf("\nexport ", start + 1);
  return next === -1 ? SRC.slice(start) : SRC.slice(start, next);
};

test("getPartsActualByJob applies the netting and does not swallow a failure", () => {
  const fn = span("getPartsActualByJob");
  assert.match(fn, /applyNetting\(map, await getTransferNettingByJob\(\)\)/);
  assert.doesNotMatch(fn, /catch/, "falling back to AP-only would silently put a transferred job's old cost back");
});

test("the Projects export split takes the same netting, as of the same day, and leaves the SDC share alone", () => {
  const fn = span("getPartsActualSdcSplitByJob");
  assert.match(fn, /getTransferNettingByJob\(asOf\)/);
  assert.match(fn, /cur\.actual = /);
  assert.doesNotMatch(fn, /cur\.sdc/);
});

test("the pull read is read-only, fulfilled-only, off the stock bin, and bounded by the lookback", () => {
  const fn = span("getTransferNettingByJob");
  assert.match(fn, /FROM tblInventoryPullDetails/);
  assert.match(fn, /FulfilledStatus = 1/);
  assert.match(fn, /ProjectID <> @bin/);
  assert.match(fn, /FulfilledDate >= @since/);
  assert.doesNotMatch(fn, /\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
});
