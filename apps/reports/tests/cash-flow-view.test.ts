import { test } from "node:test";
import assert from "node:assert/strict";
import { distinctMonths, currentMonthKey, computeKpis, buildProjectRows, compareLines, biggestMoversForMonth, shiftMonth, formatMonthLabel } from "../src/lib/cash-flow-view";
import { UNKNOWN_MONTH, type CashFlowLine } from "../src/lib/cash-flow-normalize";
import type { ProjectEstimate } from "../src/lib/cash-flow";

function line(overrides: Partial<CashFlowLine>): CashFlowLine {
  return { projectId: "1081", customer: "First Solar", forecastMonth: "2026-09", flowType: "incoming", category: "AR", amount: 100, ...overrides };
}

test("distinctMonths excludes UNKNOWN and sorts", () => {
  const lines = [line({ forecastMonth: "2026-10" }), line({ forecastMonth: UNKNOWN_MONTH }), line({ forecastMonth: "2026-08" })];
  assert.deepEqual(distinctMonths(lines), ["2026-08", "2026-10"]);
});

test("currentMonthKey formats as yyyy-mm", () => {
  assert.equal(currentMonthKey(new Date("2026-08-19T12:00:00Z")), "2026-08");
});

test("computeKpis: current-month incoming/outgoing/net", () => {
  const today = new Date("2026-08-19T00:00:00Z");
  const lines = [
    line({ forecastMonth: "2026-08", flowType: "incoming", category: "AR", amount: 500 }),
    line({ forecastMonth: "2026-08", flowType: "outgoing", category: "AP", amount: 200 }),
    line({ forecastMonth: "2026-09", flowType: "incoming", category: "AR", amount: 999 }), // not this month — excluded from current-month KPIs
  ];
  const kpis = computeKpis(lines, today);
  assert.equal(kpis.incomingCurrentMonth, 500);
  assert.equal(kpis.outgoingCurrentMonth, 200);
  assert.equal(kpis.netCurrentMonth, 300);
});

test("computeKpis: next-30-days is current month + next calendar month (documented month-level approximation)", () => {
  const today = new Date("2026-08-19T00:00:00Z");
  const lines = [
    line({ forecastMonth: "2026-08", flowType: "incoming", amount: 100 }),
    line({ forecastMonth: "2026-09", flowType: "incoming", amount: 50 }),
    line({ forecastMonth: "2026-10", flowType: "incoming", amount: 999 }), // outside the window
  ];
  assert.equal(computeKpis(lines, today).next30Incoming, 150);
});

test("computeKpis: next-30-days correctly rolls over a December -> January year boundary", () => {
  const today = new Date("2026-12-10T00:00:00Z");
  const lines = [line({ forecastMonth: "2026-12", flowType: "outgoing", category: "AP", amount: 10 }), line({ forecastMonth: "2027-01", flowType: "outgoing", category: "AP", amount: 20 })];
  assert.equal(computeKpis(lines, today).next30Outgoing, 30);
});

test("computeKpis: unknown-due-date AR/AP/PO are surfaced separately, never folded into a month", () => {
  const lines = [
    line({ forecastMonth: UNKNOWN_MONTH, category: "AR", flowType: "incoming", amount: 10 }),
    line({ forecastMonth: UNKNOWN_MONTH, category: "AP", flowType: "outgoing", amount: 20 }),
    line({ forecastMonth: UNKNOWN_MONTH, category: "PO", flowType: "outgoing", amount: 30 }),
  ];
  const kpis = computeKpis(lines, new Date("2026-08-19T00:00:00Z"));
  assert.equal(kpis.arUnknown, 10);
  assert.equal(kpis.apUnknown, 20);
  assert.equal(kpis.poUnknown, 30);
  // and they must NOT also land in the current-month totals
  assert.equal(kpis.incomingCurrentMonth, 0);
  assert.equal(kpis.outgoingCurrentMonth, 0);
});

const ESTIMATE: ProjectEstimate = {
  projectId: "1081",
  customer: "First Solar",
  jobName: "Light Soak Chambers",
  salesPrice: 1000000,
  materialEstimate: 300000,
  laborEstimate: 200000,
  totalEstimate: 500000,
  projectProfit: 500000,
  remainingCost: 150000,
};

test("buildProjectRows: a project with an estimate but no lines still appears, all-zero", () => {
  const rows = buildProjectRows([ESTIMATE], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalIncoming, 0);
  assert.equal(rows[0].byMonth.size, 0);
});

test("buildProjectRows: AR/AP/PO/ETC roll up into the right month bucket and category subtotal", () => {
  const lines = [
    line({ forecastMonth: "2026-09", category: "AR", flowType: "incoming", amount: 100 }),
    line({ forecastMonth: "2026-09", category: "AP", flowType: "outgoing", amount: 40 }),
    line({ forecastMonth: "2026-09", category: "PO", flowType: "outgoing", amount: 20 }),
    line({ forecastMonth: "2026-09", category: "ETC", flowType: "outgoing", amount: 10 }),
  ];
  const rows = buildProjectRows([ESTIMATE], lines);
  const sep = rows[0].byMonth.get("2026-09")!;
  assert.equal(sep.ar, 100);
  assert.equal(sep.ap, 40);
  assert.equal(sep.po, 20);
  assert.equal(sep.etc, 10);
  assert.equal(sep.incoming, 100);
  assert.equal(sep.outgoing, 70);
});

test("buildProjectRows: a line for a project with no estimate row still creates a row, not silently dropped", () => {
  const rows = buildProjectRows([], [line({ projectId: "9999", customer: "Ghost Co" })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projectId, "9999");
  assert.equal(rows[0].jobName, null);
});

test("compareLines: the task's own worked example — September Incoming, current vs Jul 31", () => {
  const current = [line({ forecastMonth: "2026-09", flowType: "incoming", amount: 1_420_000 })];
  const previous = [line({ forecastMonth: "2026-09", flowType: "incoming", amount: 1_750_000 })];
  const rows = compareLines(current, previous);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].current, 1_420_000);
  assert.equal(rows[0].previous, 1_750_000);
  assert.equal(rows[0].changeAmount, -330_000);
});

test("compareLines: a month/flowType present in only one side still gets a row (zero on the other side)", () => {
  const rows = compareLines([line({ forecastMonth: "2026-11" })], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].previous, 0);
  assert.equal(rows[0].current, 100);
});

test("compareLines: changePercent is null (not Infinity/0) when the previous value was exactly zero", () => {
  const rows = compareLines([line({ amount: 50 })], [line({ amount: 0 })]);
  assert.equal(rows[0].changePercent, null);
});

test("shiftMonth moves forward/backward across year boundaries", () => {
  assert.equal(shiftMonth("2026-11", 2), "2027-01");
  assert.equal(shiftMonth("2026-02", -3), "2025-11");
  assert.equal(shiftMonth("2026-08", 0), "2026-08");
});

test("formatMonthLabel renders a real month as 'Mon yyyy' and UNKNOWN as 'Unknown'", () => {
  assert.equal(formatMonthLabel("2026-08"), "Aug 2026");
  assert.equal(formatMonthLabel(UNKNOWN_MONTH), "Unknown");
});

test("biggestMoversForMonth: identifies which project drove the change for one month/category", () => {
  const current = [
    line({ projectId: "1081", customer: "A", forecastMonth: "2026-09", category: "AR", amount: 100 }),
    line({ projectId: "1082", customer: "B", forecastMonth: "2026-09", category: "AR", amount: 50 }),
  ];
  const previous = [
    line({ projectId: "1081", customer: "A", forecastMonth: "2026-09", category: "AR", amount: 100 }), // unchanged
    line({ projectId: "1082", customer: "B", forecastMonth: "2026-09", category: "AR", amount: 500 }), // dropped by 450
  ];
  const movers = biggestMoversForMonth(current, previous, "2026-09", "AR");
  assert.equal(movers.length, 1); // 1081 is unchanged and correctly excluded
  assert.equal(movers[0].projectId, "1082");
  assert.equal(movers[0].changeAmount, -450);
});
