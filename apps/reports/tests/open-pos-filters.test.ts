import test from "node:test";
import assert from "node:assert/strict";
import type { PartsCostLine } from "../src/lib/sync-totaleto";
import { buildOpenPos, type OpenPoJob } from "../src/lib/open-pos-rules";
import { advCounts, advMatch, NO_ADV_FILTERS, type AdvContext, type AdvFilters } from "../src/lib/open-pos-filters";

// Open POs' Advanced filters: any tick within a group, every group with ticks.

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
  partNumber: "P-1",
  description: null,
  quantity: 1,
  unitPrice: o.total,
  totalPrice: o.total,
  invoicedAmount: o.posted ?? 0,
  actualAmount: o.posted ?? 0,
  ...o,
});

const r = buildOpenPos(
  new Map([
    [
      "1101",
      [
        line({ po: "LATE", total: 100, requiredDate: "2026-10-01" }), // late, not invoiced, Acme
        line({ po: "SOON", total: 100, requiredDate: "2026-12-01", supplier: "Globex" }), // coming, not invoiced
        line({ po: "PAID", total: 100, posted: 100, requiredDate: "2026-12-01" }), // coming, invoiced not received
      ],
    ],
    ["1102", [line({ po: "HALF", total: 100, quantity: 4, unitPrice: 25, receivedQty: 2, requiredDate: "2026-12-01", supplier: "Globex" })]],
  ]),
  JOBS,
  TODAY,
);
const ctx: AdvContext = {
  today: TODAY,
  requiredByLine: new Map(),
  jobStatus: new Map(r.jobs.map((j) => [j.jobId, j.jobStatus])),
};
const pick = (f: Partial<Record<keyof AdvFilters, string[]>>): AdvFilters => ({
  ...NO_ADV_FILTERS,
  ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, new Set(v)])),
});
const shown = (f: AdvFilters) => r.rows.filter((x) => advMatch(x, f, ctx)).map((x) => x.poNumber).sort();

test("nothing ticked lists every open PO", () => {
  assert.deepEqual(shown(NO_ADV_FILTERS), ["HALF", "LATE", "PAID", "SOON"]);
});

test("within a group any tick matches; across groups every group must", () => {
  assert.deepEqual(shown(pick({ timing: ["late"] })), ["LATE"]);
  assert.deepEqual(shown(pick({ timing: ["late"], received: ["partly"] })), []);
  assert.deepEqual(shown(pick({ received: ["none", "partly"] })), ["HALF", "LATE", "PAID", "SOON"]);
  assert.deepEqual(shown(pick({ timing: ["coming"], jobStatus: ["Active"] })), ["PAID", "SOON"]);
  assert.deepEqual(shown(pick({ jobStatus: ["HeadStart"] })), ["HALF"]);
});

test("received and invoiced are separate questions that combine: e.g. paid for, nothing here", () => {
  assert.deepEqual(shown(pick({ received: ["none"], invoiced: ["fully"] })), ["PAID"]);
  assert.deepEqual(shown(pick({ received: ["none"], invoiced: ["none"] })), ["LATE", "SOON"]);
  assert.deepEqual(shown(pick({ received: ["partly"] })), ["HALF"]);
});

test("each PO has exactly one received answer and one invoiced answer", () => {
  const more = buildOpenPos(
    new Map([
      [
        "1101",
        [
          line({ po: "ALL", total: 100, receivedQty: 1, posted: 40 }), // all here, partly invoiced
          line({ po: "OVER", total: 100, receivedQty: 1, posted: 130 }), // all here, over-invoiced
        ],
      ],
    ]),
    JOBS,
    TODAY,
  );
  for (const x of [...r.rows, ...more.rows]) {
    const rec = ["all", "partly", "none"].filter((o) => advMatch(x, pick({ received: [o] }), ctx));
    const inv = ["none", "partly", "fully", "over"].filter((o) => advMatch(x, pick({ invoiced: [o] }), ctx));
    assert.equal(rec.length, 1, `${x.poNumber} received: ${rec}`);
    assert.equal(inv.length, 1, `${x.poNumber} invoiced: ${inv}`);
  }
  const ans = (po: string) => more.rows.find((x) => x.poNumber === po)!;
  assert.ok(advMatch(ans("ALL"), pick({ received: ["all"], invoiced: ["partly"] }), ctx));
  assert.ok(advMatch(ans("OVER"), pick({ invoiced: ["over"] }), ctx));
});

test("vs required uses the next line to arrive and its BOM date", () => {
  const withBom: AdvContext = { ...ctx, requiredByLine: new Map(r.rows.flatMap((x) => x.items.map((l) => [l.lineId, x.poNumber === "SOON" ? "2026-11-20" : "2026-12-31"] as [string, string]))) };
  const f = pick({ required: ["after"] });
  assert.deepEqual(r.rows.filter((x) => advMatch(x, f, withBom)).map((x) => x.poNumber), ["SOON"]);
  // With no required dates loaded, everything still to arrive is "not on the BOM".
  assert.equal(r.rows.filter((x) => advMatch(x, pick({ required: ["noBom"] }), ctx)).length, 4);
});

test("a count is what ticking that box would leave, on top of the other groups", () => {
  const f = pick({ jobStatus: ["HeadStart"] });
  const c = advCounts(r.rows, f, ctx, { received: [], timing: ["late", "coming"], invoiced: [], required: [], jobStatus: ["Active", "HeadStart"] });
  // Timing counts are within HeadStart jobs; job-status counts ignore their own ticks.
  assert.deepEqual(c.timing, { late: 0, coming: 1 });
  assert.deepEqual(c.jobStatus, { Active: 3, HeadStart: 1 });
});

test("every loaded job comes back, not only those with open POs (a closed PO on Here can be on one)", () => {
  const withClosed = buildOpenPos(new Map([["1101", [line({ po: "DONE", total: 100, posted: 100, receivedQty: 1 })]]]), JOBS, TODAY);
  assert.equal(withClosed.rows.length, 0);
  assert.deepEqual(withClosed.here.map((x) => x.poNumber), ["DONE"]);
  assert.deepEqual(withClosed.allJobs.map((j) => j.jobId), ["1101", "1102"]);
});
