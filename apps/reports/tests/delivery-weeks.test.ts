import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deliveryWeeks, formatWeeks } from "../src/lib/delivery-weeks";
import { CELL_SPECS } from "../src/lib/cell-rules";

const read = (...p: string[]) => readFileSync(join(process.cwd(), "src", ...p), "utf8");

test("weeks to delivery is the day gap divided by seven, to one decimal", () => {
  assert.equal(deliveryWeeks("2025-03-13", "2025-06-05"), 12);
  assert.equal(deliveryWeeks("2025-03-13", "2025-03-13"), 0);
  assert.equal(deliveryWeeks("2025-03-13", "2025-03-29"), 2.3); // 16 days
  assert.equal(deliveryWeeks("2024-12-30", "2025-01-06"), 1); // year boundary
  assert.equal(deliveryWeeks("2024-02-26", "2024-03-04"), 1); // leap day
});

test("a DST change does not shift the count", () => {
  // 2025-03-01 to 2025-05-10 spans the US spring-forward on 2025-03-09: still exactly 10 weeks.
  assert.equal(deliveryWeeks("2025-03-01", "2025-05-10"), 10);
});

test("delivery before start is shown as negative, not hidden", () => {
  assert.equal(deliveryWeeks("2025-06-05", "2025-03-13"), -12);
});

test("a missing or invalid date gives no figure", () => {
  assert.equal(deliveryWeeks(null, "2025-03-13"), null);
  assert.equal(deliveryWeeks("2025-03-13", ""), null);
  assert.equal(deliveryWeeks("2025-03-13", undefined), null);
  assert.equal(deliveryWeeks("nope", "2025-03-13"), null);
});

test("weeks display without a trailing .0", () => {
  assert.equal(formatWeeks(12), "12");
  assert.equal(formatWeeks(2.3), "2.3");
  assert.equal(formatWeeks(-12), "-12");
  assert.equal(formatWeeks(null), "");
});

test("Quoted Delivery is an editable date; Weeks to Delivery is calculated and never saved", () => {
  assert.equal(CELL_SPECS["projects.quotedDeliveryDate"].editable, true);
  assert.equal(CELL_SPECS["projects.quotedDeliveryDate"].kind, "date");
  assert.equal(CELL_SPECS["projects.deliveryWeeks"].editable, false);
  const actions = read("lib", "quoted-actions.ts");
  assert.match(actions, /DATE_FIELDS = \["startDate", "completeDate", "quotedDeliveryDate"\]/);
  assert.doesNotMatch(actions, /deliveryWeeks|quotedDeliveryWeeks/, "only the date is stored");
});

test("the grid, the new-row form and the export carry both columns after Start Date", () => {
  const view = read("lib", "projects-view.ts");
  assert.ok(view.indexOf('"startDate"') < view.indexOf('"quotedDelivery"'));
  assert.ok(view.indexOf('"quotedDelivery"') < view.indexOf('"deliveryWeeks"'));
  assert.ok(view.indexOf('"deliveryWeeks"') < view.indexOf('"completeDate"'));
  const page = read("app", "(app)", "quoted", "page.tsx");
  assert.match(page, /jobField__\$\{job\.id\}__quotedDeliveryDate/);
  assert.match(page, /deliveryWeeks\(dateInputValue\(job\.startDate\), dateInputValue\(job\.quotedDeliveryDate\)\)/);
  assert.match(page, /<ProjectsDeliveryWeeks \/>/);
  assert.match(read("components", "NewProjectRows.tsx"), /newRow__\$\{tempId\}__quotedDeliveryDate/);
  const exp = read("lib", "export", "projects-export.ts");
  assert.ok(exp.indexOf('header: "Start Date"') < exp.indexOf('header: "Quoted Delivery"'));
  assert.ok(exp.indexOf('header: "Quoted Delivery"') < exp.indexOf('header: "Weeks to Delivery"'));
  assert.ok(exp.indexOf('header: "Weeks to Delivery"') < exp.indexOf('header: "Complete Date"'));
});
