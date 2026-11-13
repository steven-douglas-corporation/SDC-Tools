import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PartsCostLine } from "../src/lib/sync-totaleto";
import { lineLeftToInvoice } from "../src/lib/left-to-invoice";
import { buildOpenPos, isChargeLine, lineCounts, nextUpcoming, poDates, stackLines, timelineSlot, vsRequired, mondayOf, moneyOf, poStatus, weekRange, type OpenPoJob } from "../src/lib/open-pos-rules";

// Open POs: a PO is open when its signed Left to Invoice is not $0.00 (the Parts List's own
// filter applied per PO) OR a part line has not fully arrived.

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

test("a PO invoiced in full but not yet delivered is open, and adds nothing to the open value", () => {
  const lines = new Map([
    [
      "1101",
      [
        line({ po: "PREPAID", total: 100, posted: 100, receivedQty: 0, requiredDate: "2026-12-01" }),
        line({ po: "OWED", total: 50, posted: 0, receivedQty: 1 }),
      ],
    ],
  ]);
  const r = buildOpenPos(lines, JOBS, TODAY);
  const prepaid = r.rows.find((x) => x.poNumber === "PREPAID")!;
  assert.ok(prepaid, "listed although nothing is left to invoice");
  assert.equal(prepaid.leftToInvoice, 0);
  assert.equal(prepaid.status, "awaiting-delivery");
  assert.equal(prepaid.money.invoicedNotReceived, 100);
  assert.equal(r.totals.openPos, 2);
  // The money is the rest of the app's: only OWED's $50 is left to invoice.
  assert.equal(r.totals.openValue, 50);
});

test("charge lines never keep a PO open on delivery; a part line does", () => {
  const lines = new Map([
    [
      "1101",
      [
        // Parts here, everything billed, the freight line never 'received': closed.
        line({ po: "FRT", total: 100, posted: 100, receivedQty: 1, partNumber: "ABC-1" }),
        line({ po: "FRT", total: 40, posted: 40, receivedQty: 0, partNumber: "Shipping" }),
        // A credit has nothing to receive: closed.
        line({ po: "CR", total: -20, posted: -20, quantity: -1, receivedQty: 0 }),
        // A part line still to come keeps a fully billed PO open.
        line({ po: "PART", total: 100, posted: 100, receivedQty: 1, partNumber: "ABC-1" }),
        line({ po: "PART", total: 30, posted: 30, receivedQty: 0, partNumber: "ABC-2" }),
      ],
    ],
  ]);
  const r = buildOpenPos(lines, JOBS, TODAY);
  assert.deepEqual(r.rows.map((x) => x.poNumber), ["PART"]);
});

test("invoiced, not received is the posted money beyond what arrived, capped at what is still to come", () => {
  // 10 × $10, 4 here ($40). $80 posted: $40 of it is for parts not here yet.
  assert.equal(moneyOf([line({ po: "I", total: 100, quantity: 10, unitPrice: 10, receivedQty: 4, posted: 80 })], TODAY).invoicedNotReceived, 40);
  // $150 posted (over-invoiced): capped at the $60 still to arrive.
  assert.equal(moneyOf([line({ po: "I", total: 100, quantity: 10, unitPrice: 10, receivedQty: 4, posted: 150 })], TODAY).invoicedNotReceived, 60);
  // Posted less than received: nothing paid ahead.
  assert.equal(moneyOf([line({ po: "I", total: 100, quantity: 10, unitPrice: 10, receivedQty: 4, posted: 25 })], TODAY).invoicedNotReceived, 0);
  // A billed freight charge is not a part paid ahead.
  assert.equal(moneyOf([line({ po: "I", total: 40, posted: 40, receivedQty: 0, partNumber: "FEE" })], TODAY).invoicedNotReceived, 0);
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

test("a re-promised date decides late, like the Scheduler's ETA; the original is kept for the ↻ mark", () => {
  const lines = new Map([
    [
      "1101",
      [
        // Originally due Oct 1, vendor re-promised Nov 20: not late today.
        line({ po: "MOVED", total: 100, requiredDate: "2026-10-01", expectedDate: "2026-11-20", receivedQty: 0 }),
        // Re-promised, and the new date has passed too: late.
        line({ po: "SLIPPED", total: 100, requiredDate: "2026-09-01", expectedDate: "2026-10-15", receivedQty: 0 }),
        // A feed with no expected date falls back to the required date.
        line({ po: "PLAIN", total: 100, requiredDate: "2026-10-01", receivedQty: 0 }),
      ],
    ],
  ]);
  const r = buildOpenPos(lines, JOBS, TODAY);
  const by = Object.fromEntries(r.rows.map((x) => [x.poNumber, x]));
  assert.equal(by.MOVED.status, "awaiting-delivery");
  assert.equal(by.MOVED.nextDue, "2026-11-20");
  assert.equal(by.MOVED.originalDue, "2026-10-01");
  assert.equal(by.MOVED.revised, true);
  assert.equal(by.SLIPPED.status, "past-due");
  assert.equal(by.PLAIN.status, "past-due");
  assert.equal(by.PLAIN.revised, false);
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

test("the tile measures, by value at PO price", () => {
  const ls = [
    // 10 × $10: 4 received, the rest late (expected Oct 1). $25 posted against it.
    line({ po: "M", total: 100, quantity: 10, unitPrice: 10, receivedQty: 4, requiredDate: "2026-10-01", posted: 25 }),
    // 5 × $20, nothing received, expected in 2 weeks.
    line({ po: "M", total: 100, quantity: 5, unitPrice: 20, receivedQty: 0, requiredDate: "2026-11-20" }),
    // 2 × $50, nothing received, expected in 6 weeks: outside the 4-week window.
    line({ po: "M", total: 100, quantity: 2, unitPrice: 50, receivedQty: 0, requiredDate: "2026-12-18" }),
  ];
  const m = moneyOf(ls, TODAY);
  assert.deepEqual(m, { ordered: 300, received: 40, notReceived: 260, late: 60, next4Weeks: 100, receivedNotInvoiced: 15, invoicedNotReceived: 0, leftToInvoice: 275 });
  const r = buildOpenPos(new Map([["1101", ls]]), JOBS, TODAY);
  assert.equal(r.rows[0].partiallyReceived, true);
  assert.equal(r.rows[0].lateSince, "2026-10-01");
  assert.equal(r.rows[0].daysLate, 36);
});

test("job shares add up to the PO, and the chart adds up to Not yet received", () => {
  const lines = new Map([
    ["1101", [line({ po: "S", total: 300, quantity: 3, unitPrice: 100, receivedQty: 1, requiredDate: "2026-10-01" })]],
    ["1102", [line({ po: "S", total: 200, quantity: 2, unitPrice: 100, receivedQty: 0, requiredDate: "2026-11-10" }), line({ po: "T", total: 50, receivedQty: 0 })]],
  ]);
  const r = buildOpenPos(lines, JOBS, TODAY);
  const s = r.rows.find((x) => x.poNumber === "S")!;
  for (const k of Object.keys(s.money) as (keyof typeof s.money)[]) {
    assert.equal(Math.round(s.shares.reduce((a, x) => a + x.money[k], 0) * 100) / 100, s.money[k], k);
  }
  const chart = r.weeks.reduce((a, w) => a + w.notReceived, 0);
  const notReceived = r.rows.reduce((a, x) => a + x.money.notReceived, 0);
  assert.equal(chart, notReceived);
  assert.equal(r.weeks.find((w) => w.key === "late")!.notReceived, 200);
  // TODAY is Friday Nov 6; Nov 10 falls in the calendar week of Monday Nov 9.
  assert.equal(r.weeks.find((w) => w.key === "2026-11-09")!.notReceived, 200);
  assert.equal(r.weeks.find((w) => w.key === "no-date")!.notReceived, 50);
});

test("each PO carries its lines for the PO panel, and they add up to the PO", () => {
  const lines = new Map([
    ["1101", [line({ po: "P", total: 300, posted: 100, quantity: 3, unitPrice: 100, receivedQty: 1, requiredDate: "2026-10-01", expectedDate: "2026-11-20" })]],
    ["1102", [line({ po: "P", total: 50, quantity: 1, unitPrice: 50, receivedQty: 0 })]],
  ]);
  const r = buildOpenPos(lines, JOBS, TODAY).rows[0];
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map((i) => i.jobId), ["1101", "1102"]);
  assert.ok(r.items.every((i) => i.lineId.startsWith("pod:")));
  assert.equal(r.items.reduce((s, i) => s + i.leftToInvoice, 0), r.leftToInvoice);
  // The re-promised date is what the panel shows as expected; the original is kept for ↻.
  assert.equal(r.items[0].expected, "2026-11-20");
  assert.equal(r.items[0].original, "2026-10-01");
});

test("the chart's weeks are calendar weeks, Monday to Sunday, starting with this one", () => {
  assert.equal(mondayOf("2026-11-06"), "2026-11-02"); // Friday
  assert.equal(mondayOf("2026-11-09"), "2026-11-09"); // Monday
  assert.equal(mondayOf("2026-11-15"), "2026-11-09"); // Sunday
  const lines = new Map([
    [
      "1101",
      [
        line({ po: "THIS", total: 10, receivedQty: 0, requiredDate: "2026-11-08" }), // Sunday of this week
        line({ po: "NEXT", total: 20, receivedQty: 0, requiredDate: "2026-11-09" }), // Monday of next week
        line({ po: "PAST", total: 40, receivedQty: 0, requiredDate: "2026-11-03" }), // earlier this week: late
      ],
    ],
  ]);
  const r = buildOpenPos(lines, JOBS, TODAY);
  const w = Object.fromEntries(r.weeks.map((x) => [x.key, x.notReceived]));
  assert.equal(r.weeks[1].key, "2026-11-02");
  assert.equal(w["2026-11-02"], 10);
  assert.equal(w["2026-11-09"], 20);
  assert.equal(w.late, 40);
});

test("week labels are date ranges", () => {
  assert.equal(weekRange("2026-11-09"), "Nov 9–15");
  assert.equal(weekRange("2026-11-30"), "Nov 30–Dec 6");
  assert.equal(weekRange("2026-12-28"), "Dec 28–Jan 3");
});

test("line counts: a line is received once all of it has arrived; credits and unknown receipts don't count as received", () => {
  const lines = new Map([
    [
      "1101",
      [
        line({ po: "C", total: 100, quantity: 10, unitPrice: 10, receivedQty: 10 }), // all here
        line({ po: "C", total: 100, quantity: 10, unitPrice: 10, receivedQty: 4 }), // partly here
        line({ po: "C", total: -20, quantity: -2, unitPrice: 10, receivedQty: 0 }), // a credit: nothing to receive
      ],
    ],
    ["1102", [line({ po: "C", total: 50, quantity: 5, unitPrice: 10, receivedQty: undefined })]], // no receipt data
  ]);
  const r = buildOpenPos(lines, JOBS, TODAY).rows[0];
  assert.deepEqual(lineCounts(r.items), { lines: 3, received: 1, pieces: 25, piecesReceived: 14 });
  // A job's card counts only its own lines of a split PO.
  assert.deepEqual(lineCounts(r.items, "1101"), { lines: 2, received: 1, pieces: 20, piecesReceived: 14 });
  assert.deepEqual(lineCounts(r.items, "1102"), { lines: 1, received: 0, pieces: 5, piecesReceived: 0 });
  // Same rule as the PO's own counts.
  assert.equal(lineCounts(r.items).lines, r.linesReceivable);
  assert.equal(lineCounts(r.items).received, r.linesReceived);
});

test("received counts leave out shipping, fee and tariff charges, as Job Details does", () => {
  const items = buildOpenPos(
    new Map([
      [
        "1101",
        [
          line({ po: "D", total: 100, quantity: 10, unitPrice: 10, receivedQty: 10, partNumber: "ABC-1" }),
          line({ po: "D", total: 40, quantity: 1, unitPrice: 40, receivedQty: 0, partNumber: "Shipping" }),
          line({ po: "D", total: 15, quantity: 1, unitPrice: 15, receivedQty: 0, partNumber: " tariff " }),
          line({ po: "D", total: 5, quantity: 1, unitPrice: 5, receivedQty: 0, partNumber: "FEE" }),
          line({ po: "D", total: 10, quantity: 1, unitPrice: 10, receivedQty: 0, partNumber: "SHIPPING-BOX" }), // a part, not a charge
        ],
      ],
    ]),
    JOBS,
    TODAY,
  ).rows[0].items;
  assert.deepEqual(lineCounts(items), { lines: 2, received: 1, pieces: 11, piecesReceived: 10 });
  assert.equal(isChargeLine({ partNumber: "Shipping" }), true);
  assert.equal(isChargeLine({ partNumber: null }), false);
});

test("next delivery to come skips late and fully received lines", () => {
  const lines = new Map([
    [
      "1101",
      [
        line({ po: "N", total: 10, receivedQty: 0, requiredDate: "2026-10-01" }), // late
        line({ po: "N", total: 10, receivedQty: 0, requiredDate: "2026-11-20" }), // to come
        line({ po: "N", total: 10, receivedQty: 1, requiredDate: "2026-11-10" }), // already here
      ],
    ],
    ["1102", [line({ po: "N", total: 10, receivedQty: 0, requiredDate: "2026-11-12" })]],
  ]);
  const r = buildOpenPos(lines, JOBS, TODAY).rows[0];
  assert.equal(r.nextDue, "2026-10-01"); // the PO's earliest outstanding date is the late one
  assert.equal(nextUpcoming(r.items, TODAY), "2026-11-12");
  assert.equal(nextUpcoming(r.items, TODAY, "1101"), "2026-11-20");
  assert.equal(nextUpcoming(r.items, "2026-12-01"), null);
});

test("timeline dates come from the next line to arrive: expected and original from the same line", () => {
  const lines = new Map([
    [
      "1101",
      [
        line({ po: "D", total: 10, receivedQty: 0, requiredDate: "2026-10-01", expectedDate: "2026-11-20" }), // re-promised
        line({ po: "D", total: 10, receivedQty: 1, requiredDate: "2026-09-01" }), // here: ignored
      ],
    ],
    ["1102", [line({ po: "D", total: 10, receivedQty: 0, requiredDate: "2026-11-12" })]],
  ]);
  const r = buildOpenPos(lines, JOBS, TODAY).rows[0];
  // The next line is 1102's (Nov 12, never moved). The re-promised line's Oct 1 is NOT its original.
  assert.deepEqual(poDates(r.items), { outstanding: true, expected: "2026-11-12", original: "2026-11-12", revised: false, required: null });
  assert.deepEqual(poDates(r.items, "1101"), { outstanding: true, expected: "2026-11-20", original: "2026-10-01", revised: true, required: null });
  assert.deepEqual(poDates(r.items, "1102"), { outstanding: true, expected: "2026-11-12", original: "2026-11-12", revised: false, required: null });
  const done = buildOpenPos(new Map([["1101", [line({ po: "E", total: 10, posted: 5, receivedQty: 1, requiredDate: "2026-10-01" })]]]), JOBS, TODAY).rows[0];
  assert.equal(poDates(done.items).outstanding, false);
});

test("timeline: the BOM's required date is the same line's, and the line is green on or before it, red after", () => {
  const lines = new Map([
    [
      "1101",
      [
        line({ po: "F", total: 10, receivedQty: 0, requiredDate: "2026-11-20" }), // next to arrive
        line({ po: "F", total: 10, receivedQty: 0, requiredDate: "2026-12-05" }),
      ],
    ],
  ]);
  const items = buildOpenPos(lines, JOBS, TODAY).rows[0].items;
  const [next, later] = items[0].expected === "2026-11-20" ? [items[0], items[1]] : [items[1], items[0]];
  // Only the next line's required date counts, not the earliest one on the PO.
  const req = new Map([
    [next.lineId, "2026-11-25"],
    [later.lineId, "2026-11-01"],
  ]);
  assert.equal(poDates(items, undefined, req).required, "2026-11-25");
  assert.equal(poDates(items, undefined, new Map([[later.lineId, "2026-11-01"]])).required, null); // next line not on the BOM
  assert.deepEqual(vsRequired("2026-11-20", "2026-11-25"), { onTime: true, days: 5 });
  assert.deepEqual(vsRequired("2026-11-25", "2026-11-25"), { onTime: true, days: 0 });
  assert.deepEqual(vsRequired("2026-11-30", "2026-11-25"), { onTime: false, days: 5 });
  assert.equal(vsRequired(null, "2026-11-25"), null);
  assert.equal(vsRequired("2026-11-25", null), null);
});

test("timeline slots: Late before this Monday, the track for the weeks shown, Later after", () => {
  const monday = "2026-11-02";
  assert.deepEqual(timelineSlot("2026-11-01", monday, 12), { lane: "late", pct: 0 });
  assert.equal(timelineSlot("2026-11-02", monday, 12).lane, "track"); // earlier this week: still on the track
  assert.ok(Math.abs(timelineSlot("2026-11-02", monday, 12).pct - (0.5 / 84) * 100) < 1e-9);
  assert.equal(timelineSlot("2027-01-24", monday, 12).lane, "track"); // last day shown
  assert.deepEqual(timelineSlot("2027-01-25", monday, 12), { lane: "later", pct: 100 });
  assert.deepEqual(timelineSlot(null, monday, 12), { lane: "none", pct: 0 });
});

test("dots too close together stack onto new lines; far apart ones share the first", () => {
  assert.deepEqual(stackLines([10, 10.5, 11, 30], 1.6), [0, 1, 2, 0]);
  assert.deepEqual(stackLines([50, 10, 12], 1.6), [0, 0, 0]);
  // A re-promised PO's line (0% to 40%) keeps other dots off it, so none looks connected.
  assert.deepEqual(stackLines([{ from: 0, to: 40 }, 20, 60], 1.6), [0, 1, 0]);
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
