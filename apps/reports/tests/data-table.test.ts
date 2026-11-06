import test from "node:test";
import assert from "node:assert/strict";
import { pageOf, searchRows, sortRows, type TableColumnLogic } from "../src/lib/data-table";

type Row = { id: number; name: string; po: string; amount: number | null };
const rows: Row[] = [
  { id: 1, name: "Acme Fasteners", po: "PO 10", amount: 50 },
  { id: 2, name: "Globex Motion", po: "PO 9", amount: null },
  { id: 3, name: "acme electric", po: "PO 100", amount: 7 },
  { id: 4, name: "—", po: "PO 2", amount: 50 },
];
const cols: TableColumnLogic<Row>[] = [
  { id: "name", value: (r) => r.name },
  { id: "po", value: (r) => r.po },
  { id: "amount", value: (r) => r.amount, searchable: false },
];
const ids = (rs: Row[]) => rs.map((r) => r.id);

test("search: every word must appear in some searchable column, ignoring case", () => {
  assert.deepEqual(ids(searchRows(rows, cols, "acme")), [1, 3]);
  assert.deepEqual(ids(searchRows(rows, cols, "ACME po 10")), [1, 3]); // "po 10" also matches "PO 100"
  assert.deepEqual(ids(searchRows(rows, cols, "  ")), [1, 2, 3, 4]);
  // Columns marked searchable: false are not searched.
  assert.deepEqual(ids(searchRows(rows, cols, "50")), []);
});

test("sort: numbers as numbers, text naturally, blanks last both ways, stable", () => {
  assert.deepEqual(ids(sortRows(rows, cols, { id: "po", dir: "asc" })), [4, 2, 1, 3]);
  assert.deepEqual(ids(sortRows(rows, cols, { id: "amount", dir: "asc" })), [3, 1, 4, 2]);
  assert.deepEqual(ids(sortRows(rows, cols, { id: "amount", dir: "desc" })), [1, 4, 3, 2]);
  assert.deepEqual(ids(sortRows(rows, cols, { id: "name", dir: "desc" })), [2, 1, 3, 4]);
  assert.deepEqual(ids(sortRows(rows, cols, null)), [1, 2, 3, 4]);
});

test("pages: clamped, and from/to count from 1", () => {
  const many = Array.from({ length: 120 }, (_, i) => i);
  assert.deepEqual(pageOf(many, 0, 50), { rows: many.slice(0, 50), page: 0, pages: 3, from: 1, to: 50 });
  const last = pageOf(many, 9, 50);
  assert.equal(last.page, 2);
  assert.equal(last.from, 101);
  assert.equal(last.to, 120);
  assert.deepEqual(pageOf([], 0, 50), { rows: [], page: 0, pages: 1, from: 0, to: 0 });
});
