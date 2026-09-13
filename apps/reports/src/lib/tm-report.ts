// ── T&M dollar cards: MIGRATED OFF POWER BI (2026-09-02) ───────────────────
//
// The company has moved to this app reading Total ETO and Paylocity directly, and
// the "Job Hours Report - Management Level" model stopped refreshing on 2026-07-31.
// These cards were the last thing still querying it, so the page was serving a
// five-week-old world and returning $0 for any range past July without saying why.
//
// The measures, the drill and the date defaults now live in lib/tm-parts-source.ts
// against Total ETO. What stays here is the vocabulary the UI and the tests already
// speak: the filter shape, the card definitions and the row types. `buildTmFilters`
// and `buildTmPartsDrillDax` are kept because tests/tm-report.test.ts pins the DAX
// they produce — that is now a record of what the Power BI page did, useful while
// anyone is still reconciling against the old report, and dead weight once nobody
// is. Nothing in the running app calls them.
//
// This file no longer imports runDax, which also removes @azure/msal-node and keytar
// from anything that value-imports it — see the bundling note further down.


// ── T&M tab data layer — Parts/dollar cards + shared filter helper ─────────
//
// Native recreation of the Power BI "T&M" page (Job Hours Report - Management
// Level.Report, page c54109ba5857acc45cc9) for its three DOLLAR cards (Part
// Invoiced Amount, SDC Manufactured Parts Sales Price, Expense Reports).
// Every value below is fetched LIVE from that exact semantic model via the
// same measures the Power BI page itself uses — never recomputed locally —
// so a number here can never drift from Power BI's own answer for the same
// job/status/date-range selection.
//
// ── The four Hours cards moved out (2026-08-19) ─────────────────────────────
//
// Engineering/Shop/PM/Manufacturing Hours used to be a fourth "8 measures"
// group here too, queried live against Power BI's 'Hours Actual' table. By
// explicit request they now read the app's own local Paylocity ingest
// instead — the SAME data and mappings Monthly ETC's own hours already use —
// so this file no longer touches Power BI for hours at all. See
// src/lib/tm-hours.ts for that pipeline, and TmMetrics below for how a page
// assembles both halves into one object.
//
// Field → measure mapping (verbatim DAX, from Measure Tables.tmdl):
//
//   Job Display                          → Measure Tables[Job Display]
//   Part Invoiced Amount                 → Measure Tables[Part Invoiced Amount]
//   SDC Manufactured Parts Sales Price   → Measure Tables[SDC Manufactured Parts Sales Price]
//   Expense Reports                      → Measure Tables[Expense Reports]
//   (date-picker defaults only)          → Measure Tables[Estimated to Complete As Of Date],
//                                           Measure Tables[Hours Refreshed Thru]
//
// Filter columns: 'Job'[Job Id] (the plain job number — NOT the composite
// 'Job'[Job] display key — confirmed by tracing how sync-actuals.ts populates
// the app's own local Job.jobId field from Hours Estimated[Job Id]/Cost
// Estimated[Job Id], the same string src/components/JobSelect.tsx already
// works in), 'Job'[Job Status], and 'Date'[Date] (a plain Between range — the
// Power BI slicer's own additional 'Date'[Is ETC to Date] filter carries no
// selected values in the saved page state, so it isn't an active restriction
// there either).

export type TmFilters = {
  jobIds?: string[];
  jobStatuses?: string[];
  startDate: string; // yyyy-mm-dd
  endDate: string; // yyyy-mm-dd
};

// The three Power BI-backed dollar fields, plus the job-context display —
// fetchTmMetrics' own return shape.
export type TmPartsMetrics = {
  jobDisplay: string;
  partInvoicedAmount: number;
  sdcManufacturedPartsSalesPrice: number;
  expenseReports: number;
};

// The full 7-KPI shape the T&M UI renders — assembled by the page from
// TmPartsMetrics (Power BI) + TmHoursTotals (local Paylocity, tm-hours.ts).
// Kept here since it's the "whole T&M metrics" concept every UI component
// already imports as a type; nothing in this file computes the four hours
// fields any more.
export type TmMetrics = TmPartsMetrics & {
  engineeringHours: number;
  shopHours: number;
  pmHours: number;
  manufacturingHours: number;
  // Every hour in range that is neither Engineering, Shop, PM nor Manufacturing
  // — Power BI's own `Other Hours` measure by another name. Added 2026-09-01;
  // before it, these hours were computed nowhere and shown nowhere. See
  // tm-hours-classify.ts's audit note.
  otherHours: number;
};

export type TmDateDefaults = {
  asOfDate: string | null;
  hoursRefreshedThru: string | null;
};

/** DAX string-literal escaping: a literal `"` inside the value must become `""`. */
function daxString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function daxDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return `DATE(${y},${m},${d})`;
}

/**
 * Builds the CALCULATETABLE filter arguments for the metrics query. Pure and
 * network-free so it's directly unit-testable (tests/tm-report.test.ts) —
 * empty job/status selections produce no filter argument at all, matching
 * "All Jobs Selected" rather than an accidental empty-set IN{} that would
 * zero everything out.
 */
// ── Which DATE a parts card's range applies to ──────────────────────────────
//
// "invoicedDate" is the model's own active relationship: 'Part Purchase'[Invoiced
// Date] -> 'Date'[Date]. Filtering 'Date'[Date] therefore filters parts BY
// INVOICED DATE, and that is right for Part Invoiced Amount — an invoiced amount
// belongs to the period it was invoiced in.
//
// "purchaseDate" detaches that relationship (ALL('Date')) and filters
// 'Part Purchase'[Purchase Date] directly. Needed because the model has no
// active relationship on Purchase Date at all — it points at an auto-generated
// LocalDateTable, not the shared Date table — so there is no way to reach it
// through 'Date'[Date].
//
// Why any card needs it: see SDC Manufactured Parts Sales Price below.
export type TmDateBasis = "invoicedDate" | "purchaseDate";

export function buildTmFilters(filters: TmFilters, basis: TmDateBasis = "invoicedDate"): string[] {
  const args: string[] = [];
  if (filters.jobIds && filters.jobIds.length > 0) {
    args.push(`'Job'[Job Id] IN {${filters.jobIds.map(daxString).join(",")}}`);
  }
  if (filters.jobStatuses && filters.jobStatuses.length > 0) {
    args.push(`'Job'[Job Status] IN {${filters.jobStatuses.map(daxString).join(",")}}`);
  }
  if (basis === "purchaseDate") {
    // ALL('Date') FIRST: it removes whatever the Invoiced-Date relationship would
    // have imposed, so the explicit Purchase Date bounds below are the only date
    // restriction. The job filters above are on 'Job' and are untouched by it.
    args.push(`ALL('Date')`);
    args.push(
      `'Part Purchase'[Purchase Date] >= ${daxDate(filters.startDate)} && 'Part Purchase'[Purchase Date] <= ${daxDate(filters.endDate)}`,
    );
  } else {
    args.push(`'Date'[Date] >= ${daxDate(filters.startDate)} && 'Date'[Date] <= ${daxDate(filters.endDate)}`);
  }
  return args;
}


// ── Drill-through row-level detail (Parts cards only) ───────────────────────
//
// One DAX query per card, reusing buildTmFilters() — the exact filter
// context fetchTmMetrics already applies for the same card — plus, for two
// of the three, the one extra filter condition lifted verbatim from that
// card's own measure (see the DAX quoted below). Same filtered source rows
// in, same filtered source rows out: summing a card's own reconciling column
// across every row this returns must equal the KPI value fetchTmMetrics
// returned for the same selection. Never add a filter or exclusion here that
// isn't in the measure itself.

export type TmPartsDrillKey = "partInvoicedAmount" | "sdcManufacturedPartsSalesPrice" | "expenseReports";

export type TmPartsDrillRow = {
  jobId: string;
  jobName: string;
  partNumber: string;
  description: string;
  supplier: string;
  poNumber: string;
  purchaseDate: string | null;
  invoicedDate: string | null;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  invoicedAmount: number;
};

// measure 'Part Invoiced Amount'               = sum('Part Purchase'[Invoiced Amount])
// measure 'SDC Manufactured Parts Sales Price' = CALCULATE(SUM('Part Purchase'[Total Price]), REMOVEFILTERS(...), 'Part Purchase'[Manufacturer] = "SDC", 'Part Purchase'[Supplier] = "Steven Douglas Corp.")
// measure 'Expense Reports'                    = CALCULATE(SUM('Part Purchase'[Total Price]), SEARCH("expense reports", 'Part Purchase'[Supplier], 1, 0) > 0)
//
// "Expense Reports" is NOT the model's separate 'Travel Expenses' table (real
// employee expense reports, with no Job/Date-range relationship to this page's
// filters at all) — despite the name, the measure is a text-matched subset of
// 'Part Purchase' rows whose AP vendor name contains "expense reports". Using
// 'Travel Expenses' here would show the wrong data and wouldn't reconcile.
// ── ONE spec per card, for BOTH the KPI and the drill (2026-09-01) ──────────
//
// The KPI used to call the Power BI MEASURE while the drill hand-replicated
// that measure's filter here. Two definitions of one card, and the only thing
// keeping them equal was that somebody had transcribed the DAX correctly —
// exactly the drift the reconciliation requirement exists to prevent. (The
// hours path had the same defect in a different shape; see tm-hours.ts.)
//
// Now `amountColumn` + `rowFilter` + `basis` generate the KPI's SUM and the
// drill's row projection from the same three values, so "summary total = sum of
// visible detail records" is true BY CONSTRUCTION rather than by agreement.
// Verified numerically against the measures they replace, all-jobs
// 2026-05-31..2026-07-31: Part Invoiced 4,618,166.917330997 both ways, Expense
// Reports 6,451.06 both ways.
export const PARTS_CARDS: Record<
  TmPartsDrillKey,
  { amountColumn: "Invoiced Amount" | "Total Price"; rowFilter: string | null; basis: TmDateBasis }
> = {
  // measure: sum('Part Purchase'[Invoiced Amount]) — an invoiced amount belongs
  // to the period it was invoiced in, so the model's own Invoiced-Date
  // relationship is the right basis and this card is unchanged.
  partInvoicedAmount: { amountColumn: "Invoiced Amount", rowFilter: null, basis: "invoicedDate" },

  // ── This card read $0 for every recent range, structurally ────────────────
  //
  // measure: CALCULATE(SUM('Part Purchase'[Total Price]), REMOVEFILTERS(...),
  //          [Manufacturer] = "SDC", [Supplier] = "Steven Douglas Corp.")
  //
  // These are SDC's OWN manufactured parts — internal, so SDC never invoices
  // itself. Measured 2026-09-01: 1,026 of 2,257 such rows have NO Invoiced Date
  // at all, and the newest one that does is 2025-10-07. Filtered through the
  // Invoiced-Date relationship, any range after October 2025 returns blank —
  // not "no activity", but a guaranteed zero regardless of activity. The card
  // was dead by construction.
  //
  // Purchase Date is the right basis and the more reliable field: 0 of those
  // 2,257 rows are missing it (against 170 of all 31,312 Part Purchase rows,
  // versus 3,605 missing Invoiced Date). It is also the event the metric names
  // — when SDC manufactured/sold the part — rather than when an outside vendor
  // billed us, which for an internal part never happens.
  //
  // On 2026-05-31..2026-07-31 this reports 218 rows / $39,102.73 where the
  // measure reported blank. It is a DELIBERATE divergence from Power BI's own
  // measure, the only one on this page, and the reason is that the measure is
  // wrong for this column rather than that the app wants a different number.
  sdcManufacturedPartsSalesPrice: {
    amountColumn: "Total Price",
    rowFilter: `'Part Purchase'[Manufacturer] = "SDC" && 'Part Purchase'[Supplier] = "Steven Douglas Corp."`,
    basis: "purchaseDate",
  },

  // measure: CALCULATE(SUM('Part Purchase'[Total Price]),
  //          SEARCH("expense reports", 'Part Purchase'[Supplier], 1, 0) > 0)
  //
  // NOT the model's separate 'Travel Expenses' table (real employee expense
  // reports, with no Job/Date-range relationship to this page's filters at
  // all) — despite the name, this is a text-matched subset of 'Part Purchase'
  // rows whose AP vendor name contains "expense reports".
  //
  // Left on the Invoiced-Date basis: measured both ways on the reported range
  // and they are identical ($6,451.06, 9 rows), so there is no evidence for
  // changing it and faithfulness to the measure wins the tie.
  expenseReports: {
    amountColumn: "Total Price",
    rowFilter: `SEARCH("expense reports", 'Part Purchase'[Supplier], 1, 0) > 0`,
    basis: "invoicedDate",
  },
};

/** The filter arguments for one card — the single source both the KPI and the drill build on. */
function partsCardFilters(filters: TmFilters, key: TmPartsDrillKey): string[] {
  const card = PARTS_CARDS[key];
  const args = buildTmFilters(filters, card.basis);
  return card.rowFilter ? [...args, card.rowFilter] : args;
}

// 'Part Purchase' is already row-grain (one PO/AP line per row), so this is a
// straight SELECTCOLUMNS projection rather than an aggregation — every column
// aliased, so every key below comes back as its plain alias text (confirmed
// by job-hours-source.ts's own buildColumnResolver, the existing precedent
// for an aliased SELECTCOLUMNS query in this codebase). Exported so
// tests/tm-report.test.ts can assert its shape without a live Power BI
// connection.
export function buildTmPartsDrillDax(filters: TmFilters, key: TmPartsDrillKey): string {
  // Same partsCardFilters() the KPI uses — that shared call is what makes
  // "summary total = sum of visible detail records" structural.
  const args = partsCardFilters(filters, key).join(",\n    ");
  return `
EVALUATE
CALCULATETABLE(
  SELECTCOLUMNS(
    'Part Purchase',
    "Job Id", 'Part Purchase'[Job ID],
    "Job Name", RELATED('Job'[Job Name]),
    "Part Number", 'Part Purchase'[Part Number],
    "Description", 'Part Purchase'[Description],
    "Supplier", 'Part Purchase'[Supplier],
    "PO Number", 'Part Purchase'[PO Number],
    "Purchase Date", 'Part Purchase'[Purchase Date],
    "Invoiced Date", 'Part Purchase'[Invoiced Date],
    "Quantity", 'Part Purchase'[Quantity],
    "Unit Price", 'Part Purchase'[Purchase Price],
    "Total Price", 'Part Purchase'[Total Price],
    "Invoiced Amount", 'Part Purchase'[Invoiced Amount]
  ),
    ${args}
)`;
}

// The reconciliation check (KPI Total / Detail Total / Difference) lives in
// tm-drill-reconcile.ts, not here. That split was originally forced: this file
// imported runDax at module scope, so anything value-imported from it dragged
// @azure/msal-node, keytar and `fs` into whatever bundle took it — Turbopack once
// tried to put keytar's native binary into a browser chunk and broke the build.
//
// That constraint is GONE as of the 2026-09-02 migration; this file is now types and
// pure helpers. The split stays anyway, because it is the right shape on its own
// merits and because lib/tm-parts-source.ts (which the server path uses) is
// `server-only` and inherits the same rule. Client code should still `import type`
// from here.

// Prefills the two date pickers on first load only — not part of the
// displayed metrics, and never used to filter them.
