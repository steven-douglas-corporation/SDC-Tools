import { test } from "node:test";
import assert from "node:assert/strict";
import {
  monthKeyFromIso,
  buildArLines,
  buildApLines,
  buildPoLines,
  buildEtcLines,
  aggregateLines,
  hashLines,
  UNKNOWN_MONTH,
  type CashFlowLine,
} from "../src/lib/cash-flow-normalize";

test("monthKeyFromIso extracts yyyy-mm from a real date", () => {
  assert.equal(monthKeyFromIso("2026-08-19"), "2026-08");
});

test("monthKeyFromIso falls back to UNKNOWN for null or malformed input", () => {
  assert.equal(monthKeyFromIso(null), UNKNOWN_MONTH);
  assert.equal(monthKeyFromIso("not-a-date"), UNKNOWN_MONTH);
});

const CUSTOMERS = new Map([["1081", "First Solar"]]);

test("buildArLines: incoming/AR, customer denormalized from the lookup map", () => {
  const lines = buildArLines([{ projectId: "1081", dueDate: "2026-09-15", amount: 100, released: true, description: null }], CUSTOMERS);
  assert.deepEqual(lines, [{ projectId: "1081", customer: "First Solar", forecastMonth: "2026-09", flowType: "incoming", category: "AR", amount: 100 }]);
});

test("buildArLines drops zero-amount terms", () => {
  assert.deepEqual(buildArLines([{ projectId: "1081", dueDate: "2026-09-15", amount: 0, released: false, description: null }], CUSTOMERS), []);
});

test("buildArLines with no due date at all lands in UNKNOWN — never silently assigned to a month", () => {
  const lines = buildArLines([{ projectId: "1081", dueDate: null, amount: 50, released: false, description: null }], CUSTOMERS);
  assert.equal(lines[0].forecastMonth, UNKNOWN_MONTH);
});

test("buildApLines: outgoing/AP", () => {
  const lines = buildApLines([{ projectId: "1081", dueDate: "2026-10-01", amount: 200 }], CUSTOMERS);
  assert.deepEqual(lines, [{ projectId: "1081", customer: "First Solar", forecastMonth: "2026-10", flowType: "outgoing", category: "AP", amount: 200 }]);
});

test("buildPoLines: outgoing/PO, using remainingAmount (not the full ordered amount)", () => {
  const lines = buildPoLines([{ projectId: "1081", dueDate: "2026-11-05", remainingAmount: 75 }], CUSTOMERS);
  assert.deepEqual(lines, [{ projectId: "1081", customer: "First Solar", forecastMonth: "2026-11", flowType: "outgoing", category: "PO", amount: 75 }]);
});

test("buildEtcLines: outgoing/ETC, forecastMonth passed through untouched (never derived from a date)", () => {
  const lines = buildEtcLines([{ projectId: "1081", forecastMonth: "2026-09", amount: 40000 }], CUSTOMERS);
  assert.deepEqual(lines, [{ projectId: "1081", customer: "First Solar", forecastMonth: "2026-09", flowType: "outgoing", category: "ETC", amount: 40000 }]);
});

test("a project with no entry in the customer map gets a null customer, not a crash", () => {
  const lines = buildArLines([{ projectId: "9999", dueDate: "2026-09-01", amount: 10, released: false, description: null }], CUSTOMERS);
  assert.equal(lines[0].customer, null);
});

test("aggregateLines collapses multiple rows for the same project/month/type/category into one", () => {
  const lines: CashFlowLine[] = [
    { projectId: "1081", customer: "First Solar", forecastMonth: "2026-09", flowType: "incoming", category: "AR", amount: 100 },
    { projectId: "1081", customer: "First Solar", forecastMonth: "2026-09", flowType: "incoming", category: "AR", amount: 50 },
  ];
  const result = aggregateLines(lines);
  assert.equal(result.length, 1);
  assert.equal(result[0].amount, 150);
});

test("aggregateLines keeps distinct categories/months separate", () => {
  const lines: CashFlowLine[] = [
    { projectId: "1081", customer: null, forecastMonth: "2026-09", flowType: "incoming", category: "AR", amount: 100 },
    { projectId: "1081", customer: null, forecastMonth: "2026-10", flowType: "incoming", category: "AR", amount: 100 },
    { projectId: "1081", customer: null, forecastMonth: "2026-09", flowType: "outgoing", category: "AP", amount: 100 },
  ];
  assert.equal(aggregateLines(lines).length, 3);
});

test("aggregateLines output is deterministically sorted regardless of input order", () => {
  const a: CashFlowLine = { projectId: "1082", customer: null, forecastMonth: "2026-09", flowType: "incoming", category: "AR", amount: 1 };
  const b: CashFlowLine = { projectId: "1081", customer: null, forecastMonth: "2026-08", flowType: "outgoing", category: "AP", amount: 2 };
  const orderA = aggregateLines([a, b]);
  const orderB = aggregateLines([b, a]);
  assert.deepEqual(orderA, orderB);
  assert.equal(orderA[0].projectId, "1081"); // 1081 sorts before 1082
});

test("hashLines is stable for the same aggregated content, regardless of pre-aggregation order", () => {
  const a: CashFlowLine = { projectId: "1081", customer: "First Solar", forecastMonth: "2026-09", flowType: "incoming", category: "AR", amount: 100 };
  const b: CashFlowLine = { projectId: "1081", customer: "First Solar", forecastMonth: "2026-09", flowType: "incoming", category: "AR", amount: 50 };
  const h1 = hashLines(aggregateLines([a, b]));
  const h2 = hashLines(aggregateLines([b, a]));
  assert.equal(h1, h2);
});

test("hashLines changes when an amount changes — this IS the 'did the forecast move' signal", () => {
  const before: CashFlowLine[] = [{ projectId: "1081", customer: null, forecastMonth: "2026-09", flowType: "incoming", category: "AR", amount: 100 }];
  const after: CashFlowLine[] = [{ projectId: "1081", customer: null, forecastMonth: "2026-09", flowType: "incoming", category: "AR", amount: 101 }];
  assert.notEqual(hashLines(before), hashLines(after));
});

test("hashLines is identical for truly identical content — this IS the dedup signal", () => {
  const lines: CashFlowLine[] = [{ projectId: "1081", customer: null, forecastMonth: "2026-09", flowType: "incoming", category: "AR", amount: 100 }];
  assert.equal(hashLines(lines), hashLines([...lines]));
});
