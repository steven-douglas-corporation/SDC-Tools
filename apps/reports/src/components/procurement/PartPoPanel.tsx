"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usd, usd2 } from "@/components/ui/format";
import { useColumnSort } from "@/components/useColumnSort";
import { SortableTh } from "@/components/ui/SortableHeader";
import { sortRows, type SortColumns } from "@/lib/table-sort";
import { num, fmtDate, type FlatPart, type PartPoGroup } from "@/lib/po-detail";
import { Stat, SupplierAvatar } from "@/components/procurement/PoDetailPanel";

// ─────────────────────────────────────────────────────────────────────────────
// Part detail — the right-side panel behind a Parts List part number.
//
// The Parts List is one row per part, and that row's money is the SUM of every
// PO the part was ever bought on. That is the correct grain for a buy-list, and
// it is also lossy in a way the table could not admit: a part bought three times
// at three prices showed one PO number, one date and — until 2026-09-10 — an em
// dash where the unit price should be, because no single price was true.
//
// This panel is where that information goes instead of being averaged away.
// Every PO keeps its own quantity, price, extended total, invoiced amount, what
// is left to invoice, its dates and its supplier. Job 1116's 2090-CTFB-MADD-CFF05
// was bought at $166.66, $220.00 and $169.16 from two different suppliers; the
// row's blended $185-ish is a fact about the job, and these three are the facts
// about the purchasing, and both need somewhere to live.
//
// ── Why the footer here matters ──────────────────────────────────────────────
//
// It restates the row's own Total $ and Invoiced $, and the PO rows above it sum
// to exactly that — `flattenBomParts` builds `poBreakdown` from the same lines
// and the same share divisor as the row's totals, so this is an identity rather
// than a second calculation that happens to agree. If they ever disagree on
// screen, the bug is real and this footer is where it shows up first.
// ─────────────────────────────────────────────────────────────────────────────

type PoSortKey = "po" | "supplier" | "qty" | "unit" | "total" | "invoiced" | "left" | "purchased" | "expected" | "delivered";

const PO_COLUMNS: SortColumns<PartPoGroup, PoSortKey> = {
  po: { type: "id", value: (g) => g.poNumber },
  supplier: { type: "text", value: (g) => g.supplier },
  qty: { type: "number", value: (g) => g.qty },
  unit: { type: "currency", value: (g) => g.unitPrice },
  total: { type: "currency", value: (g) => g.totalPrice },
  invoiced: { type: "currency", value: (g) => g.invoicedAmount },
  left: { type: "currency", value: (g) => g.leftToInvoice },
  purchased: { type: "date", value: (g) => g.purchaseDate },
  expected: { type: "date", value: (g) => g.expectedDate },
  delivered: { type: "date", value: (g) => g.deliveredDate },
};

export function PartPoPanel({
  part,
  onClose,
  onOpenPo,
  windowActive,
}: {
  part: FlatPart;
  onClose: () => void;
  onOpenPo: (supplier: string | null, poNumber: string | null) => void;
  /** True when an Invoiced+range window is active on the table behind this. */
  windowActive: boolean;
}) {
  // Mount closed, then flip to open on the next frame so the slide-in plays —
  // same as PoPanel. Setting it synchronously in an effect would land in the
  // same commit as the mount, so the transition has nothing to animate from.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setOpen(true));
    return () => window.cancelAnimationFrame(id);
  }, []);
  const requestClose = useCallback(() => {
    setOpen(false);
    window.setTimeout(onClose, 200);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  const sort = useColumnSort<PoSortKey>();
  const rows = sortRows(part.poBreakdown, sort.sort, PO_COLUMNS);

  // Summed from the SAME rows the table draws, not from the FlatPart's own
  // fields — so the footer proves the rows add up rather than asserting it.
  // `part.totalPrice` is shown beside it for exactly that comparison.
  const tot = useMemo(
    () =>
      part.poBreakdown.reduce(
        (a, g) => ({ qty: a.qty + g.qty, total: a.total + g.totalPrice, invoiced: a.invoiced + g.invoicedAmount, left: a.left + g.leftToInvoice }),
        { qty: 0, total: 0, invoiced: 0, left: 0 },
      ),
    [part.poBreakdown],
  );
  // Sub-cent tolerance: these are floating-point sums of the same terms, so an
  // exact === would flag rounding as a discrepancy.
  const reconciles = Math.abs(tot.total - part.totalPrice) < 0.005;

  const th = (key: PoSortKey, label: string, align?: "right") => (
    <SortableTh
      label={label}
      sortKey={key}
      type={PO_COLUMNS[key].type}
      align={align ?? "left"}
      sort={sort.sort}
      onSort={sort.onSort}
      className="border-r border-white/15 px-2 py-1.5 font-bold"
    />
  );

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`Part ${part.pn}`}>
      <div onClick={requestClose} className={`absolute inset-0 bg-sdc-navy/40 motion-interactive ${open ? "opacity-100" : "opacity-0"}`} />
      <aside
        className={`absolute right-0 top-0 flex h-full w-[860px] max-w-[calc(var(--app-vw)_*_0.92)] flex-col bg-white shadow-xl motion-interactive ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        {/* Header */}
        <div className="flex flex-col gap-3 border-b border-sdc-border-soft p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate font-mono text-base font-bold text-sdc-navy" title={part.pn}>{part.pn}</div>
              <div className="truncate text-xs text-sdc-gray-600" title={part.desc}>{part.desc || "No description"}</div>
            </div>
            <button type="button" onClick={requestClose} aria-label="Close" className="rounded p-1 text-sdc-gray-400 hover:bg-sdc-gray-100 hover:text-sdc-navy">
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4 L12 12 M12 4 L4 12" strokeLinecap="round" /></svg>
            </button>
          </div>

          {/* Part-level facts. Required Date sits HERE rather than in the table
              below because it is not a property of a purchase: it is
              eps.RequiredDate, per BOM edge, so the part needs it once and no
              individual PO has its own. Putting it in a per-PO column would have
              meant repeating one value down every row as if it varied. */}
          <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
            <Stat label="BOM Qty" value={num(part.qty)} />
            <Stat label="Purchased Qty" value={part.poBreakdown.length ? num(part.purchasedQty) : "—"} />
            <Stat label="Avg Unit $" value={part.effectiveUnitPrice === null ? "—" : usd2(part.effectiveUnitPrice)} />
            <Stat label="Required" value={fmtDate(part.requiredDate)} />
            <Stat label="Received" value={fmtDate(part.receivedDate)} />
            <Stat label="POs" value={num(part.poBreakdown.length)} />
          </div>

          {windowActive && (
            <p className="rounded-md bg-sdc-yellow-bg px-2.5 py-1.5 text-note text-sdc-yellow-text">
              An Invoiced date range is active on the table behind this panel. The window scopes invoiced money by part
              number, not per purchase line, so there is no windowed figure to break down here — everything below is
              lifetime.
            </p>
          )}
        </div>

        {/* PO table */}
        <div className="min-h-0 flex-1 overflow-auto styled-scrollbar">
          {rows.length === 0 ? (
            <p className="p-4 text-note text-sdc-muted">
              Nothing has been purchased against this part yet, so it has no PO history. The Total $ on its row is the
              BOM&rsquo;s own cost estimate rather than spend.
            </p>
          ) : (
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-[1]">
                <tr className="bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
                  {th("po", "PO #")}
                  {th("supplier", "Supplier")}
                  {th("qty", "Qty", "right")}
                  {th("unit", "Unit $", "right")}
                  {th("total", "Total $", "right")}
                  {th("invoiced", "Invoiced", "right")}
                  {th("left", "Left to Invoice", "right")}
                  {th("purchased", "Purchased")}
                  {th("expected", "Expected")}
                  {th("delivered", "Received")}
                </tr>
              </thead>
              <tbody>
                {rows.map((g) => (
                  // Keyed on the purchase lines' own Total ETO ids, not the PO
                  // number: two suppliers can raise the same number, and an
                  // extra-cost row has no number at all.
                  <tr key={g.lineIds.join("|")} className="border-b border-sdc-border-soft hover:bg-sdc-blue-light/40">
                    <td className="px-2 py-1.5">
                      <span className="flex items-baseline gap-1">
                        {g.poNumber ? (
                          <button
                            type="button"
                            onClick={() => onOpenPo(g.supplier, g.poNumber)}
                            className="font-mono text-note font-medium text-sdc-blue hover:underline"
                          >
                            {g.poNumber}
                          </button>
                        ) : (
                          <span className="font-mono text-note text-sdc-muted">no PO</span>
                        )}
                        {/* One PO can carry the same part on more than one line —
                            33 of job 1116's 1045 part/PO pairs do. This row sums
                            them, and says so rather than looking like one line. */}
                        {g.lineCount > 1 && (
                          <span
                            title={`${g.lineCount} lines for this part on this PO, summed here`}
                            className="shrink-0 rounded bg-sdc-blue/10 px-1 text-micro font-semibold tabular-nums text-sdc-blue-dark"
                          >
                            {g.lineCount} lines
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="max-w-[150px] truncate px-2 py-1.5 text-note text-sdc-navy" title={g.supplier ?? ""}>
                      <span className="flex items-center gap-1.5">
                        <SupplierAvatar supplier={g.supplier ?? "—"} size={18} />
                        <span className="truncate">{g.supplier || "—"}</span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-note tabular-nums text-sdc-navy">{num(g.qty)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-note tabular-nums text-sdc-navy">
                      {g.unitPrice === null ? <span title="This PO's quantity nets to zero, so it has no unit price">—</span> : usd2(g.unitPrice)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-note font-semibold tabular-nums text-sdc-navy">{usd(g.totalPrice)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-note tabular-nums text-sdc-navy">{usd(g.invoicedAmount)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-note tabular-nums text-sdc-navy">{usd(g.leftToInvoice)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-label text-sdc-navy">{fmtDate(g.purchaseDate)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-label text-sdc-navy">{fmtDate(g.expectedDate)}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-label text-sdc-navy">{fmtDate(g.deliveredDate)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0">
                <tr className="bg-sdc-navy text-white">
                  <td className="px-2 py-1.5 text-micro font-bold uppercase tracking-wider" colSpan={2}>
                    Total — {rows.length} PO{rows.length === 1 ? "" : "s"}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-note font-bold tabular-nums">{num(tot.qty)}</td>
                  <td />
                  <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-note font-bold tabular-nums">{usd(tot.total)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-note font-bold tabular-nums">{usd(tot.invoiced)}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-note font-bold tabular-nums">{usd(tot.left)}</td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          )}
        </div>

        {/* Reconciliation line — the claim this panel makes about itself, stated
            where it can be checked instead of only in a test. */}
        {rows.length > 0 && (
          <div className="border-t border-sdc-border-soft px-4 py-2.5 text-note text-sdc-gray-600">
            {reconciles ? (
              <>
                These {rows.length} PO{rows.length === 1 ? "" : "s"} sum to <span className="font-semibold text-sdc-navy">{usd(tot.total)}</span>, which is
                the Total $ on this part&rsquo;s Parts List row — {usd2(part.effectiveUnitPrice ?? 0)} average × {num(part.purchasedQty)} units purchased.
              </>
            ) : (
              // Never expected. Said out loud rather than swallowed, because a
              // silent disagreement here is money the table cannot account for.
              <span className="font-semibold text-sdc-red-text">
                These POs sum to {usd(tot.total)} but the Parts List row shows {usd(part.totalPrice)} — a{" "}
                {usd(tot.total - part.totalPrice)} difference. Please report this.
              </span>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
