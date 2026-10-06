import type { PartsCostLine } from "@/lib/sync-totaleto";
import type { BomNode } from "@/lib/job-bom-rules";
import { isSdcBillingLine } from "@/lib/parts-actual-sdc";

// ── Window-scoped invoiced attribution for the Parts List tab ──────────────
//
// sync-totaleto.ts has no `server-only` guard and is imported into
// JobProcurement.tsx (a client component) only as TYPES today — a real value
// import risks pulling `mssql` toward the client bundle. This file has zero
// DB/React dependencies, so it's safe to import for real, and — unlike
// everything else touching this feature — testable with real fixtures rather
// than source-inspection regexes.
//
// The bug this exists to fix: getJobPartsCost's own invoicedAmount is a
// LIFETIME sum per PO line (every invoice event that line has ever had,
// collapsed to one row). getJobPartsInvoicedInMonth is the already-correct,
// already-tested fix for a DIFFERENT feature (the Monthly ETC Parts Spent
// drill) — it returns one row per real invoice event within an arbitrary
// window. This module takes THAT function's own output and reshapes it for
// Parts List's row grain (one row per BOM part, not per invoice event).

// Normalizes a part number for join/dedupe — trim, collapse whitespace,
// upper. Relocated here from JobProcurement.tsx (was a private helper there)
// so both files share one definition instead of two that could drift.
export function normPn(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

/**
 * Every normalized part number a BOM tree carries as a requirement — the
 * `bomPartNumbers` argument `attributeInvoicedWindow` takes.
 *
 * Includes each node's `self` (2026-09-14). A "Both Assembly and Contents"
 * assembly is itself one of the things to buy (job-bom-rules.ts: BomNode.self),
 * and flattenBomParts gives it a Parts List row. JobProcurement.tsx built this set
 * from `node.parts` alone, so an invoice against such an assembly's own number
 * resolved to a part number "not in the BOM" and fell into the unattached total
 * in a windowed Invoiced view — its row sat at $0 while the footer carried the
 * money as unattributable. Shared here so the set and the flattener walk the same
 * tree the same way.
 */
export function collectBomPartNumbers(roots: readonly BomNode[]): Set<string> {
  const set = new Set<string>();
  const add = (pn: string) => {
    const key = normPn(pn);
    if (key) set.add(key);
  };
  const walk = (node: BomNode) => {
    if (node.self) add(node.self.pn);
    for (const p of node.parts) add(p.pn);
    for (const c of node.children) walk(c);
  };
  for (const section of roots) walk(section);
  return set;
}

/**
 * The key a purchase line is grouped under when no BOM part claims it — part number,
 * else its description. THE one definition: flattenBomParts groups its non-BOM rows
 * with it, and attributeInvoicedWindow buckets the window's non-BOM money with it, so
 * a window line always finds the row that represents it.
 */
export function leftoverKey(partNumber: string | null | undefined, description: string | null | undefined): string {
  return normPn(partNumber) || `\u0000blank:${normPn(description) || "(none)"}`;
}

export type WindowAttribution = {
  /** normalized part number -> summed invoiced amount within the window. */
  byPartNumber: Map<string, number>;
  /** The invoice events behind byPartNumber, per part number — what the row's expanded
   *  PO lines show, so they list exactly the invoices the row's Invoiced $ adds up. */
  linesByPartNumber: Map<string, PartsCostLine[]>;
  /** Invoiced money in the window that doesn't resolve to any part number —
   *  non-PO AP lines (freight/tariffs/reimbursements, which have no
   *  PurchaseDetailID at all) and PO lines whose part isn't in the
   *  currently-shown BOM. Never silently dropped — surfaced as a total so a
   *  reconciliation footer can show it rather than the grand total quietly
   *  falling short of the reference. */
  unattachedAmount: number;
  unattachedCount: number;
  /**
   * The same money as `unattached*`, bucketed by leftoverKey — so the Parts List's
   * "Not on the BOM" rows can show what was invoiced against THEM in the window.
   * Without it a windowed view priced every non-BOM row at $0 and dropped it, and the
   * table total fell short of the job's Money Spent Month by exactly the freight,
   * fees, card charges and off-BOM parts (job 1160, Sept 2026: $38,488 vs $41,637).
   */
  nonBomByKey: Map<string, { amount: number; lines: PartsCostLine[] }>;
};

/**
 * Groups getJobPartsInvoicedInMonth's own line-level output by PART NUMBER —
 * deliberately NOT by PurchaseDetailID (one PO line). A part can have
 * multiple distinct PO lines (reorders), and Parts List's existing join
 * (lineIndex in JobProcurement.tsx) already collapses to just the newest one
 * for DISPLAY purposes — but the window's invoiced TOTAL must still capture
 * invoice activity against an OLDER PO line for that same part, or this fix
 * would silently reintroduce "collapse across history" one level up (PO
 * lines instead of invoice events) instead of removing it.
 *
 * `bomPartNumbers` is the set of normalized part numbers actually present in
 * the job's CURRENT BOM tree (job-bom.ts) — a resolved part number that isn't
 * in it is just as unattachable as no part number at all: there's no row in
 * Parts List for it either way. Found live, not theorized: verifying this fix
 * against job 1142/July 2026 (reference total $113,101.89, from
 * getPartsCostBookedByJob) showed a $2,957.11 shortfall — nine real AP lines
 * (several "Shipping" line items, a corrosion inhibitor, cable-tie mounts...)
 * whose part numbers don't correspond to any part in the job's current BOM.
 * Without this parameter those dollars would sit in `byPartNumber` under a
 * key no row ever looks up, silently missing from BOTH a part row and the
 * reconciliation footer — reproducing exactly the "total doesn't match"
 * failure this whole fix exists to close, just relocated.
 *
 * A part number with zero matching lines in the window is simply ABSENT from
 * `byPartNumber` (not present with a $0 value) — mirrors
 * getJobPartsInvoicedInMonth's own `meaningful = lines.filter(l =>
 * l.invoicedAmount !== 0)` rule, so a row with no real invoice activity in
 * the window drops out of an Invoiced+range view rather than showing a false
 * "$0 invoiced this month".
 */
export function attributeInvoicedWindow(lines: PartsCostLine[], bomPartNumbers: ReadonlySet<string>): WindowAttribution {
  const byPartNumber = new Map<string, number>();
  const linesByPartNumber = new Map<string, PartsCostLine[]>();
  let unattachedAmount = 0;
  let unattachedCount = 0;
  const nonBomByKey = new Map<string, { amount: number; lines: PartsCostLine[] }>();

  for (const line of lines) {
    // SDC billing is judged on THE INVOICE LINE, not on a row's one displayed supplier: a
    // part bought from both SDC and an outside supplier (job 1150's 1150-F-008) has to keep
    // the outside invoice and drop the SDC one. Dropped from every bucket, the unattached
    // total included — it is excluded on purpose, not "unmatched".
    if (isSdcBillingLine(line)) continue;
    const key = normPn(line.partNumber);
    if (!key || !bomPartNumbers.has(key)) {
      unattachedAmount += line.invoicedAmount;
      unattachedCount++;
      const lk = leftoverKey(line.partNumber, line.description);
      const bucket = nonBomByKey.get(lk);
      if (bucket) {
        bucket.amount += line.invoicedAmount;
        bucket.lines.push(line);
      } else {
        nonBomByKey.set(lk, { amount: line.invoicedAmount, lines: [line] });
      }
      continue;
    }
    byPartNumber.set(key, (byPartNumber.get(key) ?? 0) + line.invoicedAmount);
    const bucketLines = linesByPartNumber.get(key);
    if (bucketLines) bucketLines.push(line);
    else linesByPartNumber.set(key, [line]);
  }

  // A part number's events could still net to exactly zero within the window
  // (e.g. an invoice and a same-amount credit memo both landing in it) —
  // drop it from the map entirely, same zero-invoice rule as above, rather
  // than leave a spurious 0 entry a caller would have to re-filter.
  for (const [key, amount] of byPartNumber) {
    if (amount === 0) {
      byPartNumber.delete(key);
      linesByPartNumber.delete(key);
    }
  }

  return { byPartNumber, linesByPartNumber, unattachedAmount, unattachedCount, nonBomByKey };
}
