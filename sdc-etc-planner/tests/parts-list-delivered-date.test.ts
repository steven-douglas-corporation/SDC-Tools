import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Parts List "Delivered Date" — sourcing guard (2026-09-10) ───────────────
//
// The column shows when a part ACTUALLY arrived. The whole value of it is that
// it is not a promise: the request that asked for it said, in as many words,
// "do not derive it from Expected Date or Required Date".
//
// The authoritative field, established by inspecting the Total ETO schema
// rather than by guessing at a name:
//
//   tblReceiverLog.[Date]   the receiving clerk's goods-in date, per receipt
//                           line. Total ETO's own vwReceiverLogSummed rolls it
//                           up as MaxOfDate and vwPurchaseOrderDetailsDetailed
//                           surfaces it as LastReceivedDate — which is exactly
//                           what job-bom.ts's BOM_SQL already selects.
//
//   NOT tblReceiverLog.DateCreated — that is when the receipt was keyed in, and
//   it disagrees with the real receipt date on 262 of 33,348 rows (backdated
//   receiving). NOT tblProjects.PDelivery / tblSalesOrder.SalesDelivery, which
//   are the JOB's delivery, not a part's. NOT tblInventoryDetails.ReceivedDate,
//   which is when stock came into the warehouse, not when it reached this job.
//
// For a part issued from inventory rather than bought there is no receiver log
// line at all, so the fallback is the pull's own FulfilledDate — the moment the
// stock left the shelf for this job.
//
// ── The invariant this guard actually protects ─────────────────────────────
//
// Delivered Date and `status === "received"` must be able to be checked against
// each other. They can only be if they read the same facts, and they do:
//
//   receivedQtyFor(r, ctx) = r.ReceivedQty          (SUM tblReceiverLog.QtyReceived)
//                          + pull.fulfilledQty      (fulfilled inventory pulls)
//   receivedDate           = iso(r.LastReceivedDate) (MAX tblReceiverLog.[Date])
//                          ?? iso(pull.fulfilledDate)
//
// Same two sources, same order, one assignment apart in job-bom-rules.ts.
// Audited against job 1116: 636/636 received-from-PO rows and 24/24
// received-from-stock rows carry a date. The rows that read RECEIVED with no
// date are zero-quantity requirements — `0 >= 0` is true and nothing was ever
// delivered — which a blank date states honestly rather than papering over.
//
// A source-shape guard, in the convention this repo already uses for rules that
// live across several files (see procurement-uncovered-consistency.test.ts):
// there is no React test renderer here, and the failure being guarded against
// is somebody repointing the column at a date that is merely nearby.

const SRC = join(import.meta.dirname, "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/** Drop comments, so a field merely NAMED in prose is never read as a use. */
function strip(raw: string): string {
  return raw
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("the BOM query reads the receiver log's own date, not the row's creation stamp", () => {
  const sql = strip(read("lib/job-bom.ts"));
  assert.match(sql, /FROM tblReceiverLog rl3/, "BOM_SQL must still source LastReceivedDate from tblReceiverLog");
  assert.match(sql, /rl3\.\[Date\][\s\S]{0,400}AS LastReceivedDate/, "LastReceivedDate must select tblReceiverLog.[Date]");
  assert.doesNotMatch(sql, /DateCreated/, "DateCreated is the data-entry stamp, not the receipt date");
});

test("receivedDate reads the same two facts that decide RECEIVED status", () => {
  const rules = strip(read("lib/job-bom-rules.ts"));

  // The date: receiver log first, inventory fulfilment as the fallback.
  assert.match(
    rules,
    /receivedDate:\s*iso\(r\.LastReceivedDate\)\s*\?\?\s*iso\(pull\?\.fulfilledDate\s*\?\?\s*null\)/,
    "receivedDate must be LastReceivedDate ?? the inventory pull's fulfilment date",
  );

  // The quantity that decides the status: the same two, in the same order.
  assert.match(
    rules,
    /export function receivedQtyFor[\s\S]{0,300}r\.ReceivedQty[\s\S]{0,120}pull\?\.fulfilledQty/,
    "receivedQtyFor must stay PO receipts + fulfilled pulls — the quantity side of the same two facts",
  );
  assert.match(
    rules,
    /export function statusFor[\s\S]{0,300}receivedQtyFor\(r, ctx\) >= qty\) return "received"/,
    "RECEIVED must still be decided by receivedQtyFor, so the date and the status cannot diverge",
  );
});

test("the Delivered Date column is wired to receivedDate and to nothing else", () => {
  const panel = strip(read("components/procurement/PoDetailPanel.tsx"));

  // "Received Date" since 2026-09-13; the KEY stays "delivered" so saved column sets survive.
  assert.match(panel, /\{ key: "delivered", label: "Received Date"/, "the column must be declared in ALL_COLS");

  // Sort accessor — the one place a wrong field would silently reorder the table.
  assert.match(
    panel,
    /delivered:\s*\{\s*type:\s*"date",\s*value:\s*\(p\)\s*=>\s*p\.receivedDate\s*\}/,
    "the sort accessor must read p.receivedDate",
  );

  // The cell body, between `case "delivered"` and the next case.
  const cellBody = panel.match(/case "delivered":\s*\{([\s\S]*?)\n {6}case /);
  assert.ok(cellBody, "PartRowCells must render a 'delivered' case");
  const body = cellBody[1];
  assert.match(body, /fmtDate\(p\.receivedDate\)/, "the cell must print p.receivedDate through the shared fmtDate");
  for (const forbidden of ["expectedDate", "requiredDate", "purchasedDate", "invoicedDate"]) {
    assert.doesNotMatch(
      body,
      new RegExp(forbidden),
      `Delivered Date must not fall back to ${forbidden} — a promised or billed date is not a delivery`,
    );
  }
});

test("the column reaches the Columns menu, the List view and the PO drawer as one definition", () => {
  const panel = strip(read("components/procurement/PoDetailPanel.tsx"));
  const job = strip(read("components/JobProcurement.tsx"));

  // ALL_COLS is the single source of column order for the header, the body, the
  // sticky footer AND the Columns menu, so appearing in it is what puts the
  // column in every one of those at once. What has to be checked is that the
  // two places holding a SEPARATE per-key list did not get missed.
  assert.match(panel, /PO_PANEL_COL_KEYS: ColKey\[\] = \[[^\]]*"delivered"/, "the PO drawer's scoped column list must include it");
  assert.match(panel, /PO_PANEL_COL_WIDTH[\s\S]{0,400}delivered:\s*\d+/, "the PO drawer pins every column's width; a missing one collapses it");
  assert.match(job, /DEFAULT_COL_WIDTH: Record<ColKey, number> = \{[\s\S]*?delivered:\s*\d+/, "the List view needs a default width");

  // Default-VISIBLE: DEFAULT_HIDDEN_COLS lists what is hidden, so absence is the
  // assertion. A stored hiddenPartCols behaves the same way — a key that did not
  // exist when it was written cannot be in it — so this needs no migration.
  const hidden = job.match(/DEFAULT_HIDDEN_COLS: ColKey\[\] = \[([^\]]*)\]/);
  assert.ok(hidden, "DEFAULT_HIDDEN_COLS must still exist");
  assert.doesNotMatch(hidden[1], /"delivered"/, "Delivered Date ships visible, beside Required and Expected Date");
});

test("the From/To range can filter on Delivered, reading the same field the column shows", () => {
  const job = strip(read("components/JobProcurement.tsx"));

  // One named union, not the five inline copies it replaced — a sixth date mode
  // added to four of five sites is a filter that accepts a value one of its own
  // call sites cannot express.
  assert.match(
    job,
    /type PartsDateFilter = "purchase" \| "invoice" \| "req" \| "exp" \| "delivered";/,
    "the date-filter modes must stay one named type",
  );
  assert.doesNotMatch(
    job,
    /"purchase" \| "invoice" \| "req" \| "exp"(?! \| "delivered")/,
    "no site may keep its own inline copy of the union",
  );

  // The mode reads receivedDate — the Delivered Date column's own field — so
  // "delivered in August" and the column that answers it cannot disagree.
  assert.match(
    job,
    /dateType === "delivered" \? p\.receivedDate/,
    "the delivered range must filter on p.receivedDate",
  );
  assert.match(job, /\{ value: "delivered", label: "Received" \}/, "the segmented control must offer it");

  // Selecting it has to light up Clear, or a range nobody can see is stuck on.
  assert.match(job, /dateType !== "purchase"/, "filtersActive must still treat a non-default date mode as an active filter");
});

test("Delivered Date sits with the other date columns, in the requested order", () => {
  const panel = strip(read("components/procurement/PoDetailPanel.tsx"));
  const allCols = panel.match(/export const ALL_COLS[\s\S]*?\n\];/);
  assert.ok(allCols, "ALL_COLS must still be a single literal array");
  const order = [...allCols[0].matchAll(/key: "(\w+)"/g)].map((m) => m[1]);
  const dates = order.filter((k) => ["purchased", "req", "exp", "delivered"].includes(k));
  assert.deepEqual(
    dates,
    ["purchased", "req", "exp", "delivered"],
    "the request asked for Purchased | Required Date | Expected Date | Delivered Date",
  );
});

// ── Dates carry a two-digit year (2026-09-13, by request) ───────────────────
//
// "Jan 23" is ambiguous on a table that routinely spans a year boundary. Every
// procurement date cell goes through fmtDate, so the three requested columns
// (Required, Expected, Received) and their neighbours all read the same way.
test("fmtDate prints month, day and a two-digit year", async () => {
  const { fmtDate } = await import("../src/lib/po-detail");
  // Noon local, so the day cannot roll over a timezone boundary in the test.
  assert.equal(fmtDate("2026-01-23T12:00:00"), "Jan 23 '26");
  assert.equal(fmtDate("2025-12-31T12:00:00"), "Dec 31 '25");
  assert.equal(fmtDate("2030-07-04T12:00:00"), "Jul 4 '30");
  assert.equal(fmtDate(null), "—");
  assert.equal(fmtDate("not a date"), "—");
});
