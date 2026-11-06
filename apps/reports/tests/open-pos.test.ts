import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PartsCostLine } from "../src/lib/sync-totaleto";
import { lineLeftToInvoice } from "../src/lib/left-to-invoice";
import { buildOpenPos, poStatus, type OpenPoJob } from "../src/lib/open-pos-rules";

// Open POs: a PO is open when its signed Left to Invoice is not $0.00, the Parts List's own
// filter applied per PO. Receipts only decide the Status column.

const TODAY = "2026-11-06";
const JOBS: OpenPoJob[] = [
  { jobId: "1101", jobName: "Alpha", status: "Active" },
  { jobId: "1102", jobName: "Bravo", status: "HeadStart" },
];

let n = 0;
const line = (o: Partial<PartsCostLine> & { po: string; total: number; posted?: number }): PartsCostLine => ({
  lineId: `pod:${++n}`,
  itemId: null,
  purchaseDate: "2026-09-01",
  invoicedDate: null,
  requiredDate: null,
  receivedQty: 0,
  supplier: "Acme",
  manufacturer: null,
  category: null,
  poNumber: o.po,
  partNumber: null,
  description: null,
  quantity: 1,
  unitPrice: o.total,
  totalPrice: o.total,
  invoicedAmount: o.posted ?? 0,
  actualAmount: o.posted ?? 0,
  ...o,
});

test("fully invoiced POs are not open; partly invoiced and over-invoiced ones are", () => {
  const lines = new Map([
    [
      "1101",
      [
        line({ po: "A", total: 100, posted: 100, receivedQty: 1 }),
        line({ po: "B", total: 100, posted: 40, receivedQty: 1 }),
        line({ po: "C", total: 100, posted: 130, receivedQty: 1 }),
        line({ po: "D", total: 100, posted: 99.996, receivedQty: 1 }), // sub-cent residue: not open
      ],
    ],
  ]);
  const r = buildOpenPos(lines, JOBS, TODAY);
  assert.deepEqual(r.rows.map((x) => x.poNumber).sort(), ["B", "C"]);
  assert.equal(r.rows.find((x) => x.poNumber === "B")!.leftToInvoice, 60);
  assert.equal(r.rows.find((x) => x.poNumber === "C")!.status, "over-invoiced");
  assert.equal(r.rows.find((x) => x.poNumber === "C")!.leftToInvoice, -30);
});

test("the balance is the shared per-line Left to Invoice, summed", () => {
  const ls = [line({ po: "E", total: 250, posted: 75 }), line({ po: "E", total: -20, posted: 0, quantity: -1 })];
  const r = buildOpenPos(new Map([["1101", ls]]), JOBS, TODAY);
  const expected = Math.round(ls.reduce((s, l) => s + lineLeftToInvoice(l), 0) * 100) / 100;
  assert.equal(r.rows[0].leftToInvoice, expected);
});

test("extra-cost lines are not purchase orders", () => {
  const ec: PartsCostLine = { ...line({ po: "AP-9", total: 500, posted: 0 }), lineId: "ec:1:x:500", receivedQty: null };
  const r = buildOpenPos(new Map([["1101", [ec]]]), JOBS, TODAY);
  assert.equal(r.rows.length, 0);
});

test("status: past due beats awaiting delivery, which beats awaiting invoice", () => {
  const lines = new Map([
    [
      "1101",
      [
        line({ po: "LATE", total: 100, requiredDate: "2026-10-01", receivedQty: 0 }),
        line({ po: "SOON", total: 100, requiredDate: "2026-12-01", receivedQty: 0 }),
        line({ po: "HERE", total: 100, requiredDate: "2026-10-01", receivedQty: 1 }),
        line({ po: "HALF", total: 100, requiredDate: "2026-10-01", quantity: 4, unitPrice: 25, receivedQty: 2 }),
      ],
    ],
  ]);
  const r = buildOpenPos(lines, JOBS, TODAY);
  const s = Object.fromEntries(r.rows.map((x) => [x.poNumber, x.status]));
  assert.deepEqual(s, { LATE: "past-due", SOON: "awaiting-delivery", HERE: "awaiting-invoice", HALF: "past-due" });
  // Past due sorts first.
  assert.equal(r.rows[0].status, "past-due");
  assert.equal(r.totals.pastDuePos, 2);
});

test("a line due today is not past due", () => {
  const r = buildOpenPos(new Map([["1101", [line({ po: "T", total: 10, requiredDate: TODAY })]]]), JOBS, TODAY);
  assert.equal(r.rows[0].status, "awaiting-delivery");
});

test("no receipt data reads as Open, never as past due", () => {
  const r = buildOpenPos(new Map([["1101", [line({ po: "U", total: 10, requiredDate: "2026-01-01", receivedQty: undefined })]]]), JOBS, TODAY);
  assert.equal(r.rows[0].status, "open");
  assert.equal(r.rows[0].receiptsKnown, false);
  assert.equal(poStatus({ leftToInvoice: 5, receiptsKnown: false, linesPastDue: 3, linesReceived: 0, linesReceivable: 1 }), "open");
});

test("a PO split across jobs is one row, and each job counts only its own lines", () => {
  const lines = new Map([
    ["1101", [line({ po: "SPLIT", total: 300, posted: 100 })]],
    ["1102", [line({ po: "SPLIT", total: 200, posted: 0 })]],
  ]);
  const r = buildOpenPos(lines, JOBS, TODAY);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.rows[0].jobIds, ["1101", "1102"]);
  assert.equal(r.rows[0].leftToInvoice, 400);
  const byJob = Object.fromEntries(r.jobs.map((j) => [j.jobId, j.openValue]));
  assert.deepEqual(byJob, { "1101": 200, "1102": 200 });
  // The headline equals the project table's column total.
  assert.equal(r.totals.openValue, 400);
});

test("still to arrive is the unreceived quantity at PO price", () => {
  const r = buildOpenPos(new Map([["1101", [line({ po: "Q", total: 100, quantity: 10, unitPrice: 10, receivedQty: 3 })]]]), JOBS, TODAY);
  assert.equal(r.jobs[0].awaitingDeliveryValue, 70);
});

test("jobs not in the loaded set are ignored", () => {
  const r = buildOpenPos(new Map([["9999", [line({ po: "X", total: 10 })]]]), JOBS, TODAY);
  assert.equal(r.rows.length, 0);
});

test("the page builds on the shared parts pipeline, not a fresh PO query", () => {
  const src = readFileSync(join(process.cwd(), "src", "lib", "open-pos.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.match(src, /getPartsCostForJobs\(/);
  assert.doesNotMatch(src, /tblPurchaseOrder/);
});
