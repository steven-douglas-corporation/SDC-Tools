import { test } from "node:test";
import assert from "node:assert/strict";
import { tmDrawerReducer, tmDrawerOpenKey, tmDrawerRowState, type TmDrawerState } from "../src/lib/tm-drawer-state";

// The whole point of this module: `key` and its data can never disagree,
// because a single dispatch replaces both together. These tests pin down the
// specific bug this exists to make structurally impossible — a `resolved`/
// `failed` for a card that isn't (or is no longer) open must never touch
// state, however it got issued (a race, a bug elsewhere, anything).

type Row = { hours: number };
const CLOSED: TmDrawerState<Row> = { status: "closed" };

test("opening from closed goes straight to loading, never to a stale success", () => {
  const next = tmDrawerReducer(CLOSED, { type: "open", key: "engineeringHours" });
  assert.deepEqual(next, { status: "loading", key: "engineeringHours" });
});

test("opening the same key that's already open closes it (toggle)", () => {
  const open: TmDrawerState<Row> = { status: "success", key: "engineeringHours", rows: [{ hours: 5 }] };
  const next = tmDrawerReducer(open, { type: "open", key: "engineeringHours" });
  assert.deepEqual(next, { status: "closed" });
});

test("opening a DIFFERENT key while one is loaded goes to loading for the new key, dropping the old rows immediately", () => {
  const open: TmDrawerState<Row> = { status: "success", key: "engineeringHours", rows: [{ hours: 5 }] };
  const next = tmDrawerReducer(open, { type: "open", key: "partInvoicedAmount" });
  assert.deepEqual(next, { status: "loading", key: "partInvoicedAmount" });
  // Never a state where `key` names one card and `rows` belongs to another —
  // this IS the fix for the Hours<->Parts crash: there is no intermediate
  // state to render with mismatched key/data, because they change atomically.
});

test("a resolved response for a key that's no longer open is dropped, not applied", () => {
  const switched: TmDrawerState<Row> = { status: "loading", key: "shopHours" };
  const next = tmDrawerReducer(switched, { type: "resolved", key: "engineeringHours", rows: [{ hours: 1 }] });
  assert.deepEqual(next, switched, "a late response for the card the user left must not overwrite the one they're now viewing");
});

test("a resolved response while the drawer is closed is dropped", () => {
  const next = tmDrawerReducer(CLOSED, { type: "resolved", key: "engineeringHours", rows: [{ hours: 1 }] });
  assert.deepEqual(next, CLOSED, "closing must be safe even while a request for it is still in flight");
});

test("a failed response for a key that's no longer open is dropped", () => {
  const switched: TmDrawerState<Row> = { status: "loading", key: "shopHours" };
  const next = tmDrawerReducer(switched, { type: "failed", key: "engineeringHours", message: "boom" });
  assert.deepEqual(next, switched);
});

test("a failed response while closed is dropped", () => {
  const next = tmDrawerReducer(CLOSED, { type: "failed", key: "engineeringHours", message: "boom" });
  assert.deepEqual(next, CLOSED);
});

test("resolved with zero rows is its own explicit 'empty' status, not success with an empty array left to be inferred", () => {
  const loading: TmDrawerState<Row> = { status: "loading", key: "pmHours" };
  const next = tmDrawerReducer(loading, { type: "resolved", key: "pmHours", rows: [] });
  assert.deepEqual(next, { status: "empty", key: "pmHours" });
});

test("resolved with rows is success, carrying exactly those rows", () => {
  const loading: TmDrawerState<Row> = { status: "loading", key: "pmHours" };
  const rows = [{ hours: 3 }, { hours: 4 }];
  const next = tmDrawerReducer(loading, { type: "resolved", key: "pmHours", rows });
  assert.deepEqual(next, { status: "success", key: "pmHours", rows });
});

test("failed for the currently-open key sets an error carrying the message", () => {
  const loading: TmDrawerState<Row> = { status: "loading", key: "manufacturingHours" };
  const next = tmDrawerReducer(loading, { type: "failed", key: "manufacturingHours", message: "Couldn't load this detail." });
  assert.deepEqual(next, { status: "error", key: "manufacturingHours", message: "Couldn't load this detail." });
});

test("a 'loading' refresh (filter change or retry) for a key that isn't open is dropped", () => {
  const success: TmDrawerState<Row> = { status: "success", key: "shopHours", rows: [{ hours: 2 }] };
  const next = tmDrawerReducer(success, { type: "loading", key: "engineeringHours" });
  assert.deepEqual(next, success);
});

test("a 'loading' refresh for the currently-open key re-enters loading, discarding its old rows/error", () => {
  const errored: TmDrawerState<Row> = { status: "error", key: "shopHours", message: "boom" };
  const next = tmDrawerReducer(errored, { type: "loading", key: "shopHours" });
  assert.deepEqual(next, { status: "loading", key: "shopHours" });
});

test("close is idempotent and safe from any status, including already-closed", () => {
  for (const state of [
    CLOSED,
    { status: "loading", key: "shopHours" } as const,
    { status: "success", key: "shopHours", rows: [{ hours: 1 }] } as TmDrawerState<Row>,
    { status: "error", key: "shopHours", message: "x" } as const,
  ]) {
    assert.deepEqual(tmDrawerReducer(state, { type: "close" }), CLOSED);
  }
});

test("tmDrawerOpenKey is null only when closed", () => {
  assert.equal(tmDrawerOpenKey(CLOSED), null);
  assert.equal(tmDrawerOpenKey<Row>({ status: "loading", key: "pmHours" }), "pmHours");
  assert.equal(tmDrawerOpenKey<Row>({ status: "error", key: "pmHours", message: "x" }), "pmHours");
});

test("tmDrawerRowState collapses success/empty/closed to idle — only loading and error are distinct to a KPI row", () => {
  assert.equal(tmDrawerRowState(CLOSED), "idle");
  assert.equal(tmDrawerRowState<Row>({ status: "empty", key: "pmHours" }), "idle");
  assert.equal(tmDrawerRowState<Row>({ status: "success", key: "pmHours", rows: [] }), "idle");
  assert.equal(tmDrawerRowState<Row>({ status: "loading", key: "pmHours" }), "loading");
  assert.equal(tmDrawerRowState<Row>({ status: "error", key: "pmHours", message: "x" }), "error");
});
