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
  assert.equal(transfers[0].negPullId, out1.id, "the lower id goes first");
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
