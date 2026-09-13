import { test } from "node:test";
import assert from "node:assert/strict";
import {
  publishEtcCell,
  publishPartsCell,
  forgetEtcCell,
  forgetPartsCell,
  readEtcLiveTotals,
  readEtcLiveFooterTotals,
  subscribeEtcLiveTotals,
  flushEtcLiveTotals,
} from "../src/lib/etc-live-totals";
import {
  INTERACTION_BUDGET_MS,
  DEFAULT_BUDGET_MS,
  LONG_TASK_MS,
  MAX_RECORDS,
  budgetFor,
  isOverBudget,
  labelAttributesFor,
  safeControlLabel,
  pushRecord,
  formatRecord,
  type InteractionRecord,
} from "../src/lib/interaction-metrics";

// ── Why the app felt frozen (§38) ───────────────────────────────────────────
//
// Measured on the production build, July 2026, 49 jobs:
//
//   BEFORE   /etc      first paint 60ms, then ONE long task of 4,347ms
//            /quoted   1,194 inputs — the same DOM to within 15 elements — worst 159ms
//   AFTER    /etc      worst long task 237ms, total blocking 187ms
//
// The cause was not the cell count. Every New ETC cell publishes itself to the live
// store on mount, the store notified every listener synchronously on each publish, and
// one of those listeners repaints the grid's rollup cells by reading and writing the
// DOM. ~880 cells therefore cost ~880 forced style recalculations inside one commit,
// while the page sat there looking ready and ignoring clicks.
//
// These tests pin the two properties that fix it and that a later change could quietly
// undo: a burst of publishes is ONE notification, and a publish is visible to a reader
// immediately even though the notification is deferred.

const cell = (o: Partial<Parameters<typeof publishEtcCell>[1]> = {}) => ({
  jobId: 1,
  billingGroup: "Engineering" as const,
  sectionCode: "10-211",
  prior: 100,
  worked: 40,
  hoursLeft: 60,
  effective: 50,
  diff: 10,
  decided: true,
  ...o,
});

// ── One notification per burst (§38.4, §38.10) ──────────────────────────────

test("880 cells mounting notify the painter ONCE, not 880 times", () => {
  // The actual shape of the bug: this is what a month's grid does on mount.
  let notifications = 0;
  const stop = subscribeEtcLiveTotals(() => notifications++);
  for (let i = 0; i < 880; i++) {
    publishEtcCell(`c${i}`, cell({ jobId: (i % 49) + 1, effective: i }));
  }
  assert.equal(notifications, 0, "nothing should have been notified synchronously");
  flushEtcLiveTotals();
  assert.equal(notifications, 1, "a burst of publishes is one repaint, not one per cell");
  stop();
  for (let i = 0; i < 880; i++) forgetEtcCell(`c${i}`);
  flushEtcLiveTotals();
});

test("a reader between the publish and the notification sees the new figures", () => {
  // The half that must stay synchronous. `snapshot()` is cached on a version counter, so
  // if the counter waited for the notification too, anything reading in between — React
  // rendering for another reason, the painter's own first pass — would serve stale
  // totals. Deferring the notification is safe; deferring the data is not.
  publishEtcCell("sync", cell({ effective: 123, sectionCode: "10-312" }));
  assert.equal(readEtcLiveFooterTotals().sections.get("10-312")!.newEtc, 123);
  publishEtcCell("sync", cell({ effective: 456, sectionCode: "10-312" }));
  assert.equal(readEtcLiveFooterTotals().sections.get("10-312")!.newEtc, 456, "read before flush must be current");
  forgetEtcCell("sync");
  flushEtcLiveTotals();
});

test("mixed publishes and unmounts in one burst are still one notification", () => {
  // A month switch: every cell of the old month forgets itself and every cell of the new
  // one publishes, in one commit. That was ~1,760 repaints.
  let notifications = 0;
  const stop = subscribeEtcLiveTotals(() => notifications++);
  publishEtcCell("a", cell());
  publishEtcCell("b", cell({ jobId: 2 }));
  publishPartsCell(3, { prior: 100, spent: 10, left: 90, newEtc: 80, diff: 10, decided: true });
  forgetEtcCell("a");
  forgetPartsCell(3);
  assert.equal(notifications, 0);
  flushEtcLiveTotals();
  assert.equal(notifications, 1);
  stop();
  forgetEtcCell("b");
  flushEtcLiveTotals();
});

test("a no-op republish still schedules nothing", () => {
  // The existing guard (identical values do not notify) has to keep working, or typing a
  // character and deleting it again would repaint for nothing.
  publishEtcCell("same", cell({ effective: 7 }));
  flushEtcLiveTotals();
  let notifications = 0;
  const stop = subscribeEtcLiveTotals(() => notifications++);
  publishEtcCell("same", cell({ effective: 7 }));
  flushEtcLiveTotals();
  assert.equal(notifications, 0, "an unchanged cell must not cost a repaint");
  stop();
  forgetEtcCell("same");
  flushEtcLiveTotals();
});

test("a listener that unsubscribes during the flush does not break the others", () => {
  // A month switch unmounts subscribers while the deferred notification is being
  // delivered. Iterating the live set would throw or skip; a copy cannot.
  const seen: string[] = [];
  let stopSecond = () => {};
  const stopFirst = subscribeEtcLiveTotals(() => {
    seen.push("first");
    stopSecond();
  });
  stopSecond = subscribeEtcLiveTotals(() => seen.push("second"));
  publishEtcCell("z", cell({ effective: 99 }));
  flushEtcLiveTotals();
  assert.deepEqual(seen, ["first", "second"], "both listeners run even though one unsubscribed mid-flush");
  stopFirst();
  forgetEtcCell("z");
  flushEtcLiveTotals();
});

test("the figures themselves are unchanged by the coalescing", () => {
  // The whole point: this is a scheduling change, not an arithmetic one.
  publishEtcCell("p1", cell({ jobId: 5, effective: 30, diff: 5, hoursLeft: 35 }));
  publishEtcCell("p2", cell({ jobId: 5, sectionCode: "10-312", effective: 20, diff: -2, hoursLeft: 18 }));
  publishPartsCell(5, { prior: 1000, spent: 100, left: 900, newEtc: 850, diff: 50, decided: true });
  flushEtcLiveTotals();
  const job = readEtcLiveTotals().get(5)!;
  assert.equal(job.engineering.newEtc, 50);
  assert.equal(job.engineering.diff, 3);
  assert.equal(job.parts!.newEtc, 850);
  forgetEtcCell("p1");
  forgetEtcCell("p2");
  forgetPartsCell(5);
  flushEtcLiveTotals();
});

// ── The budgets (§38.13) ────────────────────────────────────────────────────

test("every §38.13 target is the number the requirement states", () => {
  assert.equal(budgetFor("pointerover"), 100, "pointer hover feedback: 50–100ms");
  assert.equal(budgetFor("pointerdown"), 100, "button pressed state: within 100ms");
  assert.equal(budgetFor("click"), 100, "tab active state / filter checkbox: within 100ms");
  assert.equal(budgetFor("click", true), 150, "dropdown opening: within 150ms");
  assert.equal(budgetFor("keydown"), 100);
  assert.equal(LONG_TASK_MS, 50, "the browser's own long-task threshold");
});

test("an unbudgeted event is judged generously, not against a made-up number", () => {
  assert.equal(budgetFor("dragover"), DEFAULT_BUDGET_MS);
  assert.equal(isOverBudget("dragover", 199), false);
  assert.equal(isOverBudget("dragover", 201), true);
});

test("the budget boundary is exclusive — a click exactly on target passes", () => {
  assert.equal(isOverBudget("click", INTERACTION_BUDGET_MS.click), false);
  assert.equal(isOverBudget("click", INTERACTION_BUDGET_MS.click + 1), true);
  // The measured 4,347ms hydration block, and the 237ms it became: both still reported,
  // because both are over 50ms. What changed is the size, and the log says so.
  assert.equal(isOverBudget("longtask", 4347), true);
});

// ── The log must not carry data (§38.14) ────────────────────────────────────

test("a control label is structural — never a value, a title or a placeholder", () => {
  // The grids on this app hold quoted hours, parts costs and people's names. `value`,
  // `title` and `placeholder` all carry them, so none may be read.
  const attrs = labelAttributesFor();
  for (const forbidden of ["value", "title", "placeholder", "data-value", "textContent"]) {
    assert.ok(!attrs.includes(forbidden), `${forbidden} must never be part of a log label`);
  }
});

test("the label names the control and stops there", () => {
  const el = (attrs: Record<string, string>, tagName = "INPUT") => ({
    tagName,
    getAttribute: (n: string) => attrs[n] ?? null,
  });
  assert.equal(safeControlLabel(el({ name: "newEtcOverride__50479", value: "1432857" })), "input[name=newEtcOverride__50479]");
  // Even when the only attribute present is one carrying data, it is not used.
  assert.equal(safeControlLabel(el({ value: "1432857", title: "Belcan_GE NASA ERA Phase 2" })), "input");
  assert.equal(safeControlLabel(el({ "aria-label": "Show the Parts spent detail" }, "BUTTON")), "button[aria-label=Show the Parts spent detail]");
  assert.equal(safeControlLabel(null), "unknown");
});

test("a label cannot grow unbounded", () => {
  const long = "x".repeat(500);
  assert.ok(safeControlLabel({ tagName: "INPUT", getAttribute: () => long }).length <= 60);
});

// ── The log cannot leak memory (§38.14, §38.15) ─────────────────────────────

test("the record buffer is bounded, so a tab left open all day cannot grow it", () => {
  // This app is left open all day, which is why an unbounded diagnostic log would be a
  // memory leak introduced by the thing measuring memory leaks.
  const buffer: InteractionRecord[] = [];
  const record = (i: number): InteractionRecord => ({
    page: "/etc",
    control: `input[name=c${i}]`,
    action: "click",
    durationMs: 100 + i,
    processingMs: 1,
    budgetMs: 100,
    overBudget: true,
    activeRequests: 0,
  });
  for (let i = 0; i < MAX_RECORDS * 10; i++) pushRecord(buffer, record(i));
  assert.equal(buffer.length, MAX_RECORDS);
  // …and it keeps the NEWEST, which is what somebody reporting "it just went slow" needs.
  assert.equal(buffer[buffer.length - 1].control, `input[name=c${MAX_RECORDS * 10 - 1}]`);
});

test("a log line carries page, control, action, duration and requests in flight", () => {
  // §38.14's required fields, in one readable sentence.
  const line = formatRecord({
    page: "/etc",
    control: "button[aria-label=Refresh Data]",
    action: "click",
    durationMs: 480,
    processingMs: 12,
    budgetMs: 100,
    overBudget: true,
    activeRequests: 3,
    status: "timeout",
  });
  assert.match(line, /\/etc/);
  assert.match(line, /click on button\[aria-label=Refresh Data\]/);
  assert.match(line, /480ms \(budget 100ms\)/);
  assert.match(line, /12ms in handlers/);
  assert.match(line, /3 requests in flight/);
  assert.match(line, /TIMEOUT/);
});

test("a clean line omits what it has nothing to say about", () => {
  const line = formatRecord({
    page: "/quoted",
    control: "main-thread",
    action: "longtask",
    durationMs: 237,
    processingMs: 0,
    budgetMs: 50,
    overBudget: true,
    activeRequests: 0,
  });
  assert.ok(!line.includes("in flight"), line);
  assert.ok(!line.includes("in handlers"), line);
  assert.match(line, /longtask on main-thread · 237ms/);
});
