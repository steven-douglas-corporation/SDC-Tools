import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lineLeftToInvoice, rawLeftToInvoice, rewindLines } from "../src/lib/left-to-invoice";
import { flattenBomParts } from "../src/lib/po-detail";
import type { BomNode, BomPart, JobBom } from "../src/lib/job-bom";
import type { PartsCostLine } from "../src/lib/sync-totaleto";

// ── Parts List "Rewind to" (2026-10-08) ─────────────────────────────────────────
//
// Pick a month and the list reads as it stood at that month's end — the position Monthly
// ETC reports for that month. It is done by rewinding the purchase LINES (rewindLines)
// before any row is built, so there is no second formula to drift:
//
//     sum of the rewound lines' Left to Invoice === rawLeftToInvoice(lines, { asOf, asOfPosting: true })
//
// which is what Monthly ETC calls (before its aggregate floor).

const SEPT = "2026-09-30";

let seq = 0;
const line = (o: Partial<PartsCostLine>): PartsCostLine => ({
  lineId: `pod:${++seq}`,
  itemId: null,
  purchaseDate: null,
  invoicedDate: null,
  supplier: "ACME",
  manufacturer: null,
  category: null,
  poNumber: "100",
  partNumber: null,
  description: null,
  quantity: 1,
  unitPrice: 0,
  totalPrice: 0,
  invoicedAmount: 0,
  actualAmount: 0,
  ...o,
});

const LINES: PartsCostLine[] = [
  // Bought in July, billed in full on Oct 7: open on 09/30.
  line({ purchaseDate: "2026-07-10", invoicedDate: "2026-10-07", totalPrice: 8064.9, invoicedAmount: 8064.9, actualAmount: 8064.9, postings: [{ day: "2026-10-07", amount: 8064.9 }] }),
  // Billed across both months: only September's $3,000 had posted.
  line({
    purchaseDate: "2026-07-10", invoicedDate: "2026-10-07", totalPrice: 5000, invoicedAmount: 5000, actualAmount: 5000,
    postings: [{ day: "2026-09-10", amount: 3000 }, { day: "2026-10-07", amount: 2000 }],
  }),
  // Bought and settled inside the month: unchanged.
  line({ purchaseDate: "2026-09-02", invoicedDate: "2026-09-20", totalPrice: 400, invoicedAmount: 400, actualAmount: 400, postings: [{ day: "2026-09-20", amount: 400 }] }),
  // Bought in October: did not exist yet.
  line({ purchaseDate: "2026-10-03", totalPrice: 900 }),
  // No purchase date: still counted, as in Monthly ETC.
  line({ purchaseDate: null, totalPrice: 75 }),
  // No per-document split: dated by its latest invoice, which is after the cutoff.
  line({ purchaseDate: "2026-08-01", invoicedDate: "2026-10-02", totalPrice: 250, invoicedAmount: 250, actualAmount: 250 }),
  // Over-invoiced credit: negative left to invoice, kept.
  line({ purchaseDate: "2026-06-01", invoicedDate: "2026-06-15", totalPrice: 100, invoicedAmount: 130, actualAmount: 130, postings: [{ day: "2026-06-15", amount: 130 }] }),
];

const sumLeft = (ls: readonly PartsCostLine[]) => ls.reduce((s, l) => s + lineLeftToInvoice(l), 0);
const cents = (n: number) => Math.round(n * 100) / 100;

test("rewound lines add up to exactly Monthly ETC's month-end figure (before its floor)", () => {
  const rewound = rewindLines(LINES, SEPT);
  assert.equal(cents(sumLeft(rewound)), cents(rawLeftToInvoice(LINES, { asOf: SEPT, asOfPosting: true })));
  // 8,064.90 + 2,000 + 0 + 75 + 250 - 30 (the October line is out)
  assert.equal(cents(sumLeft(rewound)), 10359.9);
});

test("a purchase after the cutoff is out; an undated one stays", () => {
  const rewound = rewindLines(LINES, SEPT);
  assert.equal(rewound.length, LINES.length - 1);
  assert.ok(!rewound.some((l) => l.purchaseDate === "2026-10-03"));
  assert.ok(rewound.some((l) => l.purchaseDate === null));
});

test("an invoice posted after the cutoff is un-posted, per document", () => {
  const [late, straddle, settled] = rewindLines(LINES, SEPT);
  assert.equal(late.actualAmount, 0);
  assert.equal(late.invoicedAmount, 0, "billed amount follows, so Invoiced $ and % Inv agree");
  assert.equal(late.invoicedDate, null);
  assert.equal(straddle.actualAmount, 3000, "only September's slice had posted");
  assert.equal(straddle.invoicedDate, "2026-09-10", "the newest invoice still standing, not the October one");
  assert.deepEqual(straddle.postings, [{ day: "2026-09-10", amount: 3000 }]);
  assert.equal(settled, LINES[2], "a line the cutoff does not change is the same object");
});

test("rewinding does not mutate the lines it was given", () => {
  const before = JSON.stringify(LINES);
  rewindLines(LINES, SEPT);
  assert.equal(JSON.stringify(LINES), before);
});

test("a cutoff after everything changes nothing; one before everything leaves only undated lines", () => {
  assert.equal(rewindLines(LINES, "2099-12-31").length, LINES.length);
  assert.equal(cents(sumLeft(rewindLines(LINES, "2099-12-31"))), cents(sumLeft(LINES)));
  assert.deepEqual(rewindLines(LINES, "2000-01-31").map((l) => l.purchaseDate), [null]);
});

// ── Through the row builder ─────────────────────────────────────────────────────

const part = (o: Partial<BomPart> & { id: number; pn: string }): BomPart => ({
  desc: "", manufacturer: "", qty: 1, poQty: 1, receivedQty: 0, unitPrice: 0, costBasis: "none", source: "po", release: "contentsOnly",
  isAssembly: false, pullQty: 0, requiredDate: null, expectedDate: null, originalDate: null, revisedDate: null, poDate: null,
  receivedDate: null, status: "ordered", hold: false, supplier: null, poId: null, packetId: null, packetLabel: null, ...o,
});
const bomOf = (parts: BomPart[]): JobBom => {
  const root: BomNode = {
    key: "s1", id: 1, depth: 0, label: "Section 1", pn: "", desc: "Test", isAssembly: false, release: "contentsOnly", self: null,
    packetId: null, packetLabel: null, children: [], parts,
    stats: { total: 0, received: 0, noPO: 0, ordered: 0, stock: 0, pct: 0 }, totalCost: 0, totalPartQty: 0, nestedAssemblies: 0,
  };
  return { jobId: "1161", roots: [root], grandTotalCost: 0, grandTotalPartQty: 0, rowCount: parts.length, vendors: [] };
};

test("the Parts List footer at a month end equals the rewound lines — no second formula", () => {
  const bom = bomOf([part({ id: 1, pn: "A" }), part({ id: 2, pn: "B" })]);
  const lines = [
    // A: one PO billed Oct 7 against a Jul 10 PO.
    line({ itemId: 1, partNumber: "A", purchaseDate: "2026-07-10", invoicedDate: "2026-10-07", totalPrice: 8064.9, invoicedAmount: 8064.9, actualAmount: 8064.9, postings: [{ day: "2026-10-07", amount: 8064.9 }] }),
    // B: a second PO placed in October.
    line({ itemId: 2, partNumber: "B", purchaseDate: "2026-09-05", invoicedDate: "2026-09-25", totalPrice: 500, invoicedAmount: 500, actualAmount: 500, postings: [{ day: "2026-09-25", amount: 500 }], poNumber: "101" }),
    line({ itemId: 2, partNumber: "B", purchaseDate: "2026-10-03", totalPrice: 700, poNumber: "102" }),
  ];
  const today = flattenBomParts(bom, lines);
  const rewound = flattenBomParts(bom, rewindLines(lines, SEPT));
  const byPn = (rows: typeof today, pn: string) => rows.find((r) => r.pn === pn)!;

  assert.equal(cents(byPn(today, "A").leftToSpend ?? NaN), 0, "today A is settled");
  assert.equal(cents(byPn(rewound, "A").leftToSpend ?? NaN), 8064.9, "on 09/30 it was all still open");
  assert.equal(byPn(rewound, "A").invoicedAmount, 0);
  assert.equal(byPn(rewound, "A").poBreakdown[0].leftToInvoice, 8064.9, "the PO's own line agrees with the row");

  assert.equal(byPn(rewound, "B").totalPrice, 500, "the October PO is not part of September");
  assert.equal(byPn(rewound, "B").poBreakdown.length, 1);
  assert.equal(byPn(rewound, "B").leftToSpend, 0);

  const footer = rewound.reduce((s, r) => s + (r.leftToSpend ?? 0), 0);
  assert.equal(cents(footer), cents(rawLeftToInvoice(lines, { asOf: SEPT, asOfPosting: true })));
});

// ── Wiring guards ───────────────────────────────────────────────────────────────

test("the single-job feed attaches postings, or Rewind to would date every line by its latest invoice", () => {
  const feed = readFileSync(join(process.cwd(), "src", "lib", "sync-totaleto.ts"), "utf8");
  assert.match(feed, /await attachPostings\(pool, String\(numericJob\), new Map\(\[\[String\(numericJob\), lines\]\]\)\);/);
});

// ── A row with no purchase lines owes nothing (2026-10-08) ───────────────────────
//
// Job 1161 rewound to 09/30: the Parts List footer read $11,266 against Monthly ETC's
// $11,243. The $23 was part 4W64K312 — Qty 2 x $11.44 from the BOM, Purch Qty "-" — a
// part bought and received in October, so the rewind left it as a BOM estimate and the
// estimate was read as still owed. Nothing bought means nothing to invoice, which is the
// rule in-house, stock and SDC rows already followed; it now covers every such row.

test("a BOM part with no purchase lines owes $0 but keeps its estimate in Total $", () => {
  const bom = bomOf([part({ id: 9, pn: "NEVER-BOUGHT", qty: 2, unitPrice: 11.44 })]);
  const [row] = flattenBomParts(bom, []);
  assert.equal(row.matchReason, "no-purchase");
  assert.equal(cents(row.totalPrice), 22.88, "the BOM estimate is still shown");
  assert.equal(row.invoicedAmount, 0);
  assert.equal(row.leftToSpend, 0, "…but it is not owed");
});

test("a part whose only PO falls after the cutoff owes $0 at the cutoff, and the footer still equals ETC's", () => {
  const bom = bomOf([part({ id: 1, pn: "A", qty: 2, unitPrice: 11.44 }), part({ id: 2, pn: "B" })]);
  const lines = [
    line({ itemId: 1, partNumber: "A", purchaseDate: "2026-10-05", totalPrice: 22.88, poNumber: "200" }),
    line({ itemId: 2, partNumber: "B", purchaseDate: "2026-09-05", totalPrice: 500, poNumber: "101" }),
  ];
  const today = flattenBomParts(bom, lines);
  const rewound = flattenBomParts(bom, rewindLines(lines, SEPT));
  const a = (rows: typeof today) => rows.find((r) => r.pn === "A")!;

  assert.equal(cents(a(today).leftToSpend ?? NaN), 22.88, "today the October PO is open");
  assert.equal(a(rewound).matchReason, "no-purchase", "rewound, it is just a BOM part");
  assert.equal(a(rewound).leftToSpend, 0);
  const footer = rewound.reduce((s, r) => s + (r.leftToSpend ?? 0), 0);
  assert.equal(cents(footer), cents(rawLeftToInvoice(lines, { asOf: SEPT, asOfPosting: true })));
  assert.equal(cents(footer), 500);
});

test("the list is built from the rewound lines, and the reconciliation reads the same set", () => {
  const src = readFileSync(join(process.cwd(), "src", "components", "JobProcurement.tsx"), "utf8");
  assert.match(src, /flattenBomParts\(bom, lines, activeAttribution\)/);
  assert.match(src, /for \(const l of lines \?\? \[\]\) \{\s*jobTotal \+= l\.totalPrice;/);
  assert.match(src, /const rewindCutoff = windowRequested \? null : monthEndCutoff\(rewind\);/, "ignored while an Invoiced range is requested");
});

test("both footers leave not-bought-yet BOM estimates out of Total $, so Total − Invoiced = Left to Invoice", () => {
  const src = readFileSync(join(process.cwd(), "src", "components", "JobProcurement.tsx"), "utf8");
  // The on-screen footer sums the estimate separately (for its tooltip); the export's total row skips it.
  assert.match(src, /if \(p\.matchReason === "no-purchase"\) a\.estimate \+= p\.totalPrice;\s*else a\.total \+= p\.totalPrice;/);
  assert.match(src, /if \(p\.matchReason !== "no-purchase"\) a\.total \+= p\.totalPrice;/);
  assert.ok(!/^\s*a\.total \+= p\.totalPrice;/m.test(src), "no footer may add every row's Total $ again");
});

test("with the estimate out of the footer sum, Total − Invoiced equals the Left to Invoice sum", () => {
  const bom = bomOf([part({ id: 1, pn: "A" }), part({ id: 2, pn: "UNBOUGHT", qty: 2, unitPrice: 11.44 })]);
  const rows = flattenBomParts(bom, [
    line({ itemId: 1, partNumber: "A", purchaseDate: "2026-09-05", totalPrice: 500, invoicedAmount: 200, actualAmount: 200, invoicedDate: "2026-09-20", postings: [{ day: "2026-09-20", amount: 200 }] }),
  ]);
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
  const total = sum((r) => (r.matchReason === "no-purchase" ? 0 : r.totalPrice));
  assert.equal(cents(total - sum((r) => r.invoicedAmount)), cents(sum((r) => r.leftToSpend ?? 0)));
});
