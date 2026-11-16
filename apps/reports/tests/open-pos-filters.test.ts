import test from "node:test";
import assert from "node:assert/strict";
import type { PartsCostLine } from "../src/lib/sync-totaleto";
import { buildOpenPos, type OpenPoJob } from "../src/lib/open-pos-rules";
import { advActive, advCounts, advMatch, DEFAULT_ADV_FILTERS, NO_ADV_FILTERS, type AdvContext, type AdvFilters } from "../src/lib/open-pos-filters";

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
  assert.deepEqual(shown(pick({ delivery: ["late"] })), ["LATE"]);
  assert.deepEqual(shown(pick({ delivery: ["late", "partial"] })), ["HALF", "LATE"]);
  assert.deepEqual(shown(pick({ delivery: ["coming"], supplier: ["Globex"] })), ["HALF", "SOON"]);
  assert.deepEqual(shown(pick({ delivery: ["coming"], invoicing: ["invoicedNotReceived"] })), ["PAID"]);
  assert.deepEqual(shown(pick({ jobStatus: ["HeadStart"] })), ["HALF"]);
});

test("nothing received yet leaves out partly received POs", () => {
  assert.deepEqual(shown(pick({ delivery: ["none"] })), ["LATE", "PAID", "SOON"]);
});

test("vs required uses the next line to arrive and its BOM date", () => {
  const withBom: AdvContext = { ...ctx, requiredByLine: new Map(r.rows.flatMap((x) => x.items.map((l) => [l.lineId, x.poNumber === "SOON" ? "2026-11-20" : "2026-12-31"] as [string, string]))) };
  const f = pick({ required: ["after"] });
  assert.deepEqual(r.rows.filter((x) => advMatch(x, f, withBom)).map((x) => x.poNumber), ["SOON"]);
  // With no required dates loaded, everything still to arrive is "not on the BOM".
  assert.equal(r.rows.filter((x) => advMatch(x, pick({ required: ["noBom"] }), ctx)).length, 4);
});

test("a count is what ticking that box would leave, on top of the other groups", () => {
  const f = pick({ supplier: ["Globex"] });
  const c = advCounts(r.rows, f, ctx, { status: [], delivery: ["late", "coming"], invoicing: [], required: [], supplier: ["Acme", "Globex"], jobStatus: [] });
  // Delivery counts are within Globex; supplier counts ignore the supplier ticks themselves.
  assert.deepEqual(c.delivery, { late: 0, coming: 2 });
  assert.deepEqual(c.supplier, { Acme: 2, Globex: 2 });
});

test("PO status: Advanced starts at open POs; Closed brings in fully received and invoiced ones", () => {
  const withClosed = buildOpenPos(
    new Map([["1101", [line({ po: "OPEN", total: 100, requiredDate: "2026-12-01" }), line({ po: "DONE", total: 100, posted: 100, receivedQty: 1 })]]]),
    JOBS,
    TODAY,
  );
  const all = [...withClosed.rows, ...withClosed.here.filter((x) => !x.open)];
  const pos = (f: AdvFilters) => all.filter((x) => advMatch(x, f, ctx)).map((x) => x.poNumber).sort();
  assert.deepEqual(pos(DEFAULT_ADV_FILTERS), ["OPEN"]);
  assert.deepEqual(pos({ ...DEFAULT_ADV_FILTERS, status: new Set(["open", "closed"]) }), ["DONE", "OPEN"]);
  assert.deepEqual(pos({ ...DEFAULT_ADV_FILTERS, status: new Set(["closed"]) }), ["DONE"]);
  // Where Advanced starts is not "filtered"; anything else is.
  assert.equal(advActive(DEFAULT_ADV_FILTERS), false);
  assert.equal(advActive({ ...DEFAULT_ADV_FILTERS, status: new Set(["open", "closed"]) }), true);
  // Every loaded job comes back, not only those with open POs.
  assert.deepEqual(withClosed.allJobs.map((j) => j.jobId), ["1101", "1102"]);
});
