// ── The GL-posted test for an AP document, spelled once (2026-09-14) ─────────
//
// Copied EXACTLY from src/lib/sync-totaleto.ts (SAGE_FIRST_VENDORS, AP_DOC_FLAGGED,
// glPostedAp, sageFirstJoin), so that Cash Flow's AP and PO queries apply the same
// rule Parts Actual does. Until this file existed cash-flow-totaleto.ts and
// cash-flow-drill.ts each carried `ISNULL(APBD.APDocDoNotExport, 0) = 0` by hand —
// the PRE-2026-09-04 rule, which excludes every flagged document. Accounting's
// correction (docs/PARTS-COST-VARIANCE-2026-09.md §2.1) established that a flagged
// document from a Sage-first vendor IS paid and IS on the ledger; sync-totaleto.ts
// was changed that day and these two files were not, so a cash forecast dropped
// $112k of card charges that the job's actual spend counted.
//
// No `import "server-only"` and no mssql import: these are string constants, so a
// plain node:test file can pin the two spellings against each other.
//
// sync-totaleto.ts still defines its own copy. It is owned by another change in
// flight, and tests/parts-actual-gl-posted.test.ts asserts the flag appears exactly
// once in THAT file; when that file next moves it should import these instead, and
// the parity test in tests/gl-posted-sql.test.ts is what will catch any drift until
// it does.

/**
 * Vendors whose flagged (APDocDoNotExport = 1) documents are Sage-first purchases —
 * already paid, already on the job ledger — and therefore count as posted. Matched
 * EXACTLY, never by pattern (`LIKE '%credit card%'` would catch a real outside
 * supplier, CompanyID 1071). See sync-totaleto.ts's own header on this list.
 */
export const SAGE_FIRST_VENDORS = "'SDC Credit Card', 'Steven Douglas Corp. Expense Reports'";

/** The raw flag, against the joined tblAPBatchDocument alias `APBD`. */
export const AP_DOC_FLAGGED = "ISNULL(APBD.APDocDoNotExport, 0) = 1";

/**
 * True when the AP document posts to the general ledger — not flagged, or flagged
 * but billed by a Sage-first vendor. `companyAlias` is an ALREADY-JOINED tblCompany
 * alias (see `sageFirstJoin`): a correlated subquery here is illegal inside
 * `SUM(CASE WHEN …)`, a joined column is legal everywhere.
 */
export const glPostedAp = (companyAlias: string): string =>
  `(NOT ${AP_DOC_FLAGGED} OR ${companyAlias}.CName IN (${SAGE_FIRST_VENDORS}))`;

/** The tblCompany join `glPostedAp` reads its vendor name through. */
export const sageFirstJoin = (alias: string): string =>
  `LEFT JOIN tblCompany ${alias} WITH(NOLOCK) ON ${alias}.CompanyID = APBD.CompanyID`;

// ── A PO line's ordered value, in the job's currency ─────────────────────────
//
// The same `POD.PurchasePrice * POH.PurchaseCurrRate` term sync-totaleto.ts's
// LINE_TOTAL_PRICE multiplies by (and its `UnitPrice` column). Cash Flow's PO
// forecast and drill computed `PurchaseQty * PurchasePrice` with NO rate while
// subtracting an invoiced amount that DID carry `APDocCurrRate`, so a foreign-
// currency PO's remaining commitment was ordered-in-CAD minus invoiced-in-USD.
// No ISNULL, deliberately: LINE_TOTAL_PRICE has none either, and a null rate
// nulling the line is the same behaviour the Parts List already has for it.
export const PO_LINE_ORDERED_AMOUNT = "(POD.PurchaseQty * POD.PurchasePrice * POH.PurchaseCurrRate)";
