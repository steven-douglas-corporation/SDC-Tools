"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { MATCH_REASON_LABEL, MATCH_REASON_TEXT } from "@/lib/parts-match-reason";
import type { BomPart, PoLineGroup } from "@/lib/job-bom";
import { usd, usd2 } from "@/components/ui/format";
import { useColumnSort } from "@/components/useColumnSort";
import { SortableTh } from "@/components/ui/SortableHeader";
import { sortRows, type SortColumns } from "@/lib/table-sort";
import { useStableNow } from "@/lib/use-stable-now";
import {
  DAY,
  STATUS_PILL,
  STATUS_ROW_BG,
  COST_BASIS_NOTE,
  isEstimatedCost,
  num,
  fmtDate,
  type PartPoGroup,
  daysBetween,
  parentLineFor,
  poCellState,
  type FlatPart,
  type PoGroup,
  type DrillablePart,
  type PartStatus,
} from "@/lib/po-detail";

// ─────────────────────────────────────────────────────────────────────────────
// PO detail drawer — the right-side sliding panel shown from the Job Hour
// Details → Procurement Parts List (its "PO #" links / risk cards) AND from
// Build Readiness's Upcoming Unlocks table (src/lib/build-readiness-po-
// actions.ts fetches the same FlatPart/PoGroup shape for a job it doesn't
// otherwise have loaded, then hands it to this same component). Extracted out
// of JobProcurement.tsx (2026-08-17) so both places render the literal same
// drawer rather than two components that could visually drift apart.
// ─────────────────────────────────────────────────────────────────────────────

// ── Release-status badge ─────────────────────────────────────────────────────
// An assembly can appear in the parts list as one line to buy, with nothing
// beneath it — that is its BOM release status talking, not missing data. Without
// this badge a row like 1116-DB-000 (LEFT PICK CONVEYOR, one $1,430 purchase)
// looks identical to a loose part, and anyone comparing against the tree would
// reasonably assume its subcomponents had been dropped by mistake.
export function ReleaseBadge({ p }: { p: Pick<BomPart, "isAssembly" | "release"> }) {
  if (!p.isAssembly) return null;
  const both = p.release === "bothAssemblyAndContents";
  return (
    <span
      className="rounded bg-sdc-gray-100 px-1 text-micro font-bold tracking-wide text-sdc-gray-600"
      title={
        both
          ? "Released as “Both Assembly and Contents” — this assembly is purchased AND its contents are procured separately"
          : "Released as “Assembly Only” — purchased whole, so its subcomponents are not separate requirements"
      }
    >
      {both ? "ASSY+" : "ASSY"}
    </span>
  );
}

function StatusPill({ st }: { st: PartStatus }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-micro font-bold tracking-wide ${STATUS_PILL[st.key]}`} title={st.sub || st.label}>
      {st.label}
      {st.sub ? <span className="font-medium opacity-70">{st.sub}</span> : null}
    </span>
  );
}

// Lead time chip — weeks between purchase and expected delivery. ≤4w ok (green),
// ≤8w warn (amber), >8w long (blue). Day count in the tooltip.
function LeadChip({ ordered, expected }: { ordered: string | null; expected: string | null }) {
  const days = daysBetween(ordered, expected);
  if (days == null || days < 0) return <span className="text-label text-sdc-gray-400">—</span>;
  const wks = Math.round((days / 7) * 2) / 2;
  const cls = wks <= 4 ? "bg-sdc-green-bg text-sdc-green-text" : wks <= 8 ? "bg-sdc-yellow-bg text-sdc-yellow-text" : "bg-sdc-blue-light text-sdc-blue-dark";
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-label font-semibold tabular-nums ${cls}`} title={`${days} day lead time (ordered → expected delivery)`}>
      {wks}w
    </span>
  );
}

// Due countdown chip — green "RCVD" when received, else weeks ahead (+Nw) /
// due-soon (+Nw amber) / late (-Nw red) vs. the expected date.
function DueChip({ expected, received, now }: { expected: string | null; received: boolean; now: number }) {
  if (received) return <span className="inline-flex items-center rounded bg-sdc-green-bg px-1.5 py-0.5 text-micro font-bold text-sdc-green-text" title="Already received">RCVD</span>;
  if (!expected) return <span className="text-label text-sdc-gray-400">—</span>;
  const t = new Date(expected).getTime();
  if (Number.isNaN(t)) return <span className="text-label text-sdc-gray-400">—</span>;
  const rawDays = (t - now) / DAY;
  const daysRounded = Math.round(rawDays);
  const wks = Math.round((rawDays / 7) * 2) / 2;
  const base = "inline-flex items-center rounded px-1.5 py-0.5 text-label font-semibold tabular-nums";
  if (rawDays > 7) return <span className={`${base} bg-sdc-green-bg text-sdc-green-text`} title={`Due in ${daysRounded} days`}>+{wks}w</span>;
  if (rawDays >= 0) return <span className={`${base} bg-sdc-yellow-bg text-sdc-yellow-text`} title={`Due in ${daysRounded} days`}>+{wks}w</span>;
  const overWks = Math.round((Math.abs(rawDays) / 7) * 2) / 2;
  return <span className={`${base} bg-sdc-red-bg text-sdc-red-text`} title={`${Math.abs(daysRounded)} days overdue`}>-{overWks}w</span>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared visual atoms (supplier chip/avatar)
// ─────────────────────────────────────────────────────────────────────────────

const AVATAR_PALETTE = [
  "#3182CE", "#429C5D", "#805AD5", "#DD6B20", "#D44A4A",
  "#2B8A8A", "#C05621", "#6B46C1", "#2F855A", "#C53030",
  "#2C7A7B", "#744210", "#553C9A", "#276749", "#9B2C2C",
  "#2A69AC", "#B7791F", "#4A5568", "#285E61", "#702459",
];

function avatarColor(name: string): string {
  const hash = name.split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function supplierInitials(supplier: string): string {
  return supplier
    .split(/[\s.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

// Square colored-initial avatar (same palette as SupplierChip), sized for the
// vendor card header / drawer header.
export function SupplierAvatar({ supplier, size = 30 }: { supplier: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded font-bold text-white"
      style={{ width: size, height: size, background: avatarColor(supplier), fontSize: Math.round(size * 0.38) }}
    >
      {supplierInitials(supplier)}
    </span>
  );
}

function SupplierChip({ supplier }: { supplier: string | null }) {
  if (!supplier) return <span className="text-note text-sdc-gray-400">—</span>;
  const initials = supplierInitials(supplier);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span
        aria-hidden
        className="inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded text-micro font-bold text-white"
        style={{ background: avatarColor(supplier) }}
      >
        {initials}
      </span>
      <span className="truncate text-note font-medium text-sdc-navy" title={supplier}>
        {supplier}
      </span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Column model — shared by the main Parts List table (JobProcurement.tsx) and
// this drawer's own scoped-down table (PO_PANEL_COL_KEYS below).
// ─────────────────────────────────────────────────────────────────────────────

export type ColKey =
  | "qty"
  | "pn"
  | "desc"
  | "parent"
  | "category"
  | "mfr"
  | "supplier"
  | "po"
  | "subs"
  | "purchased"
  | "invoiceddate"
  | "req"
  | "exp"
  | "delivered"
  | "lead"
  | "due"
  | "unit"
  | "purchqty"
  | "total"
  | "invoiced"
  | "pctinv"
  | "leftspend"
  | "match"
  | "status";

export const ALL_COLS: { key: ColKey; label: string; align?: "right"; title?: string }[] = [
  { key: "qty", label: "Qty", align: "right" },
  { key: "pn", label: "Part No" },
  { key: "desc", label: "Desc" },
  { key: "parent", label: "Parent Assembly" },
  { key: "category", label: "Category" },
  { key: "mfr", label: "Mfr" },
  { key: "supplier", label: "Supplier" },
  { key: "po", label: "PO #" },
  // ── "# Subs", replacing the "+N" badge inside the PO cell (2026-09-10) ────
  //
  // The badge said the same thing, but said it inside another column's cell:
  // it could not be sorted, could not be filtered, could not be hidden, and
  // read as decoration on the PO number rather than as a fact about the row.
  // Worse, it put a count where a reader expects part of the PO identifier.
  // Its own column is sortable like everything else — "show me the parts bought
  // the most times" is now a click.
  { key: "subs", label: "# Subs", align: "right", title: "Additional purchase lines rolled into this row beyond the PO shown. 0 means this row is a single purchase. Click the part number to see them all." },
  { key: "purchased", label: "Purchased" },
  { key: "invoiceddate", label: "Invoiced" },
  { key: "req", label: "Required Date", title: "eps.RequiredDate — when the part is needed" },
  { key: "exp", label: "Expected Date", title: "Current due date (DateRequired || PurchaseDateRequired)" },
  // ── "Delivered Date" — when the part ACTUALLY arrived (2026-09-10) ────────
  //
  // Not derived from Expected or Required: it is `BomPart.receivedDate`, which
  // job-bom-rules.ts fills from `MAX(tblReceiverLog.[Date])` for this item on this
  // job — the receiving clerk's own goods-in date — falling back to the inventory
  // pull's FulfilledDate for a part issued from stock rather than bought.
  //
  // Deliberately the SAME two facts that decide `status === "received"`
  // (receivedQtyFor = PO receipts + fulfilled pulls), so the date and the status can
  // never tell different stories. Audited on job 1116: 636/636 received-from-PO rows
  // and 24/24 received-from-stock rows carry a date. The exceptions are honest — a
  // zero-quantity requirement reads RECEIVED because `0 >= 0` and nothing was ever
  // delivered, and a process-built part is counted by neither.
  //
  // NOT tblReceiverLog.DateCreated: that is when the receipt was keyed in, and it
  // differs from the real receipt date on 262 rows (backdated receiving).
  // Labelled "Received Date" since 2026-09-13 (by request) - the same word the
  // RECEIVED status and receivedQty already use; the key stays `delivered` so a
  // stored column set keeps working.
  { key: "delivered", label: "Received Date", title: "When the part was actually received — MAX(tblReceiverLog.Date), or the inventory pull's fulfilment date for a part issued from stock. Blank until something is received." },
  { key: "lead", label: "Lead" },
  { key: "due", label: "Due" },
  { key: "unit", label: "Unit $", align: "right" },
  // ── "Purch Qty", so the money row actually self-adds (2026-09-10) ─────────
  //
  // Unit x Qty never made Total and could not: `qty` is the BOM REQUIREMENT
  // (eps.ItemQty), which is a different quantity from the one that was bought.
  // Job 1116's 2198-C1004-ERS is required once and was bought five times across
  // three POs — so Total / qty is $5,115.74 for a part whose every PO is about
  // $1,050, which is not a unit price by any reading.
  //
  // Qty keeps its meaning (readiness, RECEIVED and the coverage bars all compare
  // it against receivedQty) and the purchased quantity gets its own column, so
  // Unit $ x Purch Qty === Total $ is an identity on every row that has one.
  { key: "purchqty", label: "Purch Qty", align: "right", title: "Units actually bought, across every PO. Unit $ x Purch Qty = Total $. Differs from Qty, which is what the BOM requires." },
  { key: "total", label: "Total $", align: "right" },
  { key: "invoiced", label: "Invoiced $", align: "right" },
  // ── "Left to Invoice", immediately after Invoiced $ (2026-09-02) ──────────
  //
  // Same column, same arithmetic (`totalPrice - invoicedAmount`, see po-detail.ts's
  // enrich) — renamed and moved, not added. It was called "Left to Spend" and sat
  // after % Inv, which is why it read as a procurement figure ("how much of this
  // budget is still unspent") rather than the billing figure it actually is: what
  // remains to invoice on work already costed. The two are the same number and
  // opposite questions, and the name was answering the wrong one.
  //
  // Ordered here rather than at the end because ALL_COLS is the single source of
  // column order for the header, the body, the sticky footer AND the Columns menu —
  // so this one move puts it beside Invoiced $ everywhere, with no second list to
  // keep in step.
  { key: "leftspend", label: "Left to Invoice", align: "right", title: "Total $ − Invoiced $. Negative when a part has been over-invoiced." },
  { key: "pctinv", label: "% Inv", align: "right" },
  // ── Why every row can say what it is (2026-09-02) ────────────────────────
  //
  // The table now carries purchase lines that have no BOM row — freight, tariffs,
  // outside processes, fees, reimbursements, credits, and parts bought against a
  // superseded revision — because reporting them as a footer summary meant $88,643
  // on job 1101 that nobody could click into. This column is what keeps that
  // honest: a row that is not a BOM part says so, and says which kind.
  { key: "match", label: "Match", title: "Whether this row is a BOM part, and if not, what the charge is" },
  { key: "status", label: "Status" },
];

// One accessor per ColKey, covering every column the visibility menu can show
// — `SortColumns<FlatPart, ColKey>` (a `Record`, not a `Partial`) means TypeScript
// itself catches a column added to ALL_COLS with no matching sort entry.
//
// A function of `now`, not a bare module-level constant — only the "due"
// column needs it (a countdown against the current time), but that one
// dependency means the whole map has to be built per-render rather than once
// at module scope. Called through a `useMemo` at each call site.
export function partsListSortColumns(now: number): SortColumns<FlatPart, ColKey> {
  return {
    qty: { type: "number", value: (p) => p.qty },
    pn: { type: "id", value: (p) => p.pn },
    desc: { type: "text", value: (p) => p.desc || null },
    parent: { type: "text", value: (p) => parentLineFor(p) },
    category: { type: "text", value: (p) => p.category },
    // Sorts on exactly what the cell displays (In-house (SDC), not the raw
    // manufacturer code) — same convention as every "status"-typed column.
    mfr: { type: "text", value: (p) => (p.manufacturer === "SDC" ? "In-house (SDC)" : p.manufacturer || null) },
    supplier: { type: "text", value: (p) => p.supplier },
    // Null for STOCK/PROCESS/NO-PO rows alike (no PO number exists) — nulls
    // already sort last in both directions, which is the right place for
    // "there is no PO" regardless of why.
    po: { type: "id", value: (p) => p.poNumber },
    // The count the cell prints, so sorting matches what is on screen.
    subs: { type: "number", value: (p) => Math.max(0, p.lineCount - 1) },
    purchased: { type: "date", value: (p) => p.purchasedDate },
    invoiceddate: { type: "date", value: (p) => p.invoicedDate },
    req: { type: "date", value: (p) => p.requiredDate },
    exp: { type: "date", value: (p) => p.expectedDate },
    // Same value the cell prints, partial receipts included — a row with SOME
    // quantity in hand has genuinely had a delivery, and sorting it in with the
    // rest is what makes "what landed in August" answerable. Nulls (nothing
    // received) sort last in both directions, which is where "—" belongs.
    delivered: { type: "date", value: (p) => p.receivedDate },
    // LeadChip's own underlying number (days from purchased to expected),
    // with the same "negative reads as no data" rule it renders with: a
    // negative lead time is display "—", so it sorts where "—" sorts.
    lead: {
      type: "number",
      value: (p) => {
        const d = daysBetween(p.purchasedDate, p.expectedDate);
        return d != null && d >= 0 ? d : null;
      },
    },
    // DueChip's own underlying number (days from now to expected) — null once
    // received, matching its "RCVD" display rather than a stale countdown.
    due: {
      type: "number",
      value: (p) => (p.st.key === "received" || !p.expectedDate ? null : (new Date(p.expectedDate).getTime() - now) / DAY),
    },
    // The blended figure the cell shows, falling back to the BOM estimate for a
    // row with no purchases at all — again, exactly what is rendered.
    unit: { type: "currency", value: (p) => p.effectiveUnitPrice ?? (p.purchasedQty === 0 ? p.unitPrice : null) },
    purchqty: { type: "number", value: (p) => (p.poBreakdown.length ? p.purchasedQty : null) },
    total: { type: "currency", value: (p) => p.totalPrice },
    invoiced: { type: "currency", value: (p) => p.invoicedAmount },
    pctinv: { type: "number", value: (p) => p.pctInvoiced },
    leftspend: { type: "currency", value: (p) => p.leftToSpend },
  match: { type: "text", value: (p) => MATCH_REASON_LABEL[p.matchReason] },
    status: { type: "status", value: (p) => p.st.label },
  };
}

export function PartRowCells({
  p,
  cols,
  now,
  onOpenPo,
  onOpenPart,
  expand,
}: {
  p: FlatPart;
  cols: { key: ColKey; label: string; align?: "right"; title?: string }[];
  now: number;
  onOpenPo: (supplier: string | null, poNumber: string | null) => void;
  /** Opens the part's PO-history panel. Optional so a caller with no panel of
   *  its own (the PO drawer's table) renders the part number as plain text. */
  onOpenPart?: (p: FlatPart) => void;
  /**
   * The row's expand/collapse control (2026-09-13) — a chevron before the part
   * number that folds the part's POs out INLINE under the row, one sub-row per PO
   * (PartPoSubRowCells). Only the Parts List passes this; the PO drawer's table
   * has one PO by definition and renders no chevron. The chevron is omitted when
   * the part has no purchases: there is nothing to unfold.
   */
  expand?: { open: boolean; onToggle: () => void };
}) {
  const parentLine = parentLineFor(p);
  const cell = (key: ColKey) => {
    switch (key) {
      case "qty":
        return <span className="text-note font-bold tabular-nums text-sdc-navy">{num(p.qty)}</span>;
      case "pn":
        // -- The part number opens the part's PO history (2026-09-10) --------
        //
        // It used to be decoration: blue and underlined, but the click it
        // implied was the ROW's, which clears every filter and scroll-flashes
        // the row you already clicked. Now it is a real button to a real
        // destination, and stopPropagation keeps the row's own handler out of
        // it -- the same shape the PO # button below already had.
        return (
          <span className="flex items-center gap-1 truncate">
            {/* The drop-down (2026-09-13, by request): the same POs the side panel
                lists, unfolded under the row so a reader can compare a part's
                purchases against its neighbours without leaving the table. The
                panel stays the full view; this is the glance. */}
            {expand && p.poBreakdown.length > 0 ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); expand.onToggle(); }}
                aria-expanded={expand.open}
                aria-label={`${expand.open ? "Collapse" : "Expand"} the ${p.poBreakdown.length} PO${p.poBreakdown.length === 1 ? "" : "s"} for ${p.pn}`}
                title={expand.open ? "Collapse POs" : `Show ${p.poBreakdown.length} PO${p.poBreakdown.length === 1 ? "" : "s"} under this row`}
                className="shrink-0 rounded px-0.5 text-sdc-gray-400 hover:bg-sdc-blue/10 hover:text-sdc-blue-dark"
              >
                <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" className={`motion-interactive ${expand.open ? "rotate-90" : ""}`} aria-hidden>
                  <path d="M4 2.5 L8 6 L4 9.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : expand ? (
              // Keeps part numbers aligned down the column when some rows have a
              // chevron and some do not.
              <span className="w-[14px] shrink-0" aria-hidden />
            ) : null}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenPart?.(p); }}
              title={p.lineCount > 1 ? `${p.pn} \u2014 see all ${p.lineCount} purchases` : `${p.pn} \u2014 see purchase detail`}
              className="min-w-0 truncate text-left font-mono text-note font-bold text-sdc-blue hover:underline"
            >
              {p.pn}
            </button>
            <ReleaseBadge p={p} />
          </span>
        );
      case "desc":
        return <span className="block truncate text-note font-semibold text-sdc-navy" title={p.desc}>{p.desc || "—"}</span>;
      case "parent":
        return (
          <span className={`block truncate font-mono text-label font-medium ${p.parentPN ? "text-sdc-navy" : "italic text-sdc-muted"}`} title={parentLine}>
            {parentLine}
          </span>
        );
      case "category":
        return <span className="block truncate text-note font-medium text-sdc-navy" title={p.category ?? ""}>{p.category || "—"}</span>;
      case "mfr":
        return <span className="block truncate text-note font-medium text-sdc-navy" title={p.manufacturer}>{p.manufacturer === "SDC" ? "In-house (SDC)" : p.manufacturer || "—"}</span>;
      case "supplier":
        return <SupplierChip supplier={p.supplier} />;
      case "po": {
        // poCellState, not an inline poNumber check — the red NO PO state is
        // isUncoveredPart's, the same rule the card and the filter count with.
        // See po-detail.ts for what the old inline chain got wrong.
        const cell = poCellState(p);
        switch (cell.kind) {
          case "po":
            return (
              <span className="flex min-w-0 items-baseline gap-1">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onOpenPo(p.supplier, p.poNumber); }}
                  title={p.lineCount > 1 ? `View ${cell.po} — the newest of ${p.lineCount} purchases on this row` : "View PO"}
                  className="min-w-0 truncate text-left font-mono text-note font-medium text-sdc-blue hover:underline"
                >
                  {cell.po}
                </button>
                {/* The "+5" badge that lived here until 2026-09-10 moved out to
                    its own "# Subs" column. It answered the right question — this
                    row sums several purchases — from the wrong place: inside the
                    PO cell it read as part of the PO number, and could not be
                    sorted or hidden. */}
              </span>
            );
          case "stock":
            return <span className="text-label font-semibold text-sdc-green-text" title={`Pulled from inventory (${num(p.pullQty)} issued) — no purchase order needed`}>STOCK</span>;
          case "process":
            return <span className="text-label font-semibold text-sdc-blue-dark" title="Built in-house on an ETO process schedule — no purchase order needed">IN-HOUSE</span>;
          case "received":
            return <span className="text-label font-semibold text-sdc-gray-400" title="Already satisfied — no purchase order to raise">N/A</span>;
          case "hold":
            return <span className="text-label font-semibold text-sdc-yellow-text" title="On hold in ETO — not an actionable purchasing gap while paused">ON HOLD</span>;
          case "none":
            return (
              <span
                className="text-label font-semibold text-sdc-red-text"
                title={cell.stalePo ? `PO ${cell.stalePo} exists but covers no quantity — this is still an open buy` : "No purchase order, no inventory pull and no process schedule"}
              >
                NO PO
              </span>
            );
        }
      }
      case "subs": {
        const subs = Math.max(0, p.lineCount - 1);
        return (
          <span
            className={`whitespace-nowrap font-mono text-note tabular-nums ${subs > 0 ? "font-semibold text-sdc-blue-dark" : "text-sdc-gray-400"}`}
            title={subs > 0 ? `${p.lineCount} purchase lines across ${p.poBreakdown.length} PO${p.poBreakdown.length > 1 ? "s" : ""} \u2014 the PO column shows the newest. Click the part number for all of them.` : "A single purchase"}
          >
            {subs > 0 ? subs : "\u2014"}
          </span>
        );
      }
      case "purchased":
        // The newest of the group, flagged as such rather than presented as the date
        // the whole row was bought — job 1101's six card invoices span Aug 2025 to
        // Jul 2026 and the row showed only "Jul 30".
        return (
          <span
            className="whitespace-nowrap font-mono text-label font-medium text-sdc-navy"
            title={p.lineCount > 1 ? `Newest of ${p.lineCount} purchases on this row` : undefined}
          >
            {fmtDate(p.purchasedDate)}
            {p.lineCount > 1 && <span className="ml-0.5 text-sdc-gray-400" aria-hidden>*</span>}
          </span>
        );
      case "invoiceddate":
        return <span className="whitespace-nowrap font-mono text-label font-medium text-sdc-navy">{fmtDate(p.invoicedDate)}</span>;
      case "req":
        return <span className="whitespace-nowrap font-mono text-label font-medium text-sdc-navy">{fmtDate(p.requiredDate)}</span>;
      case "exp":
        return <span className="whitespace-nowrap font-mono text-label font-medium text-sdc-navy">{fmtDate(p.expectedDate)}</span>;
      case "delivered": {
        // A part can be part-delivered: job 1116's LEM150D 04 S had 5 of 95 in
        // hand, so it is still ON ORDER and yet something really did arrive on
        // 2026-08-10. Printing the date bare would read as "this line is done";
        // hiding it would lose a real receipt. The `*` is the same marker the
        // Purchased and Unit $ cells already use for "true, but not the whole
        // story", and the title says which part of the order landed.
        const partial = p.receivedQty > 0 && p.receivedQty < p.qty;
        return (
          <span
            className="whitespace-nowrap font-mono text-label font-medium text-sdc-navy"
            title={partial ? `Partial delivery — ${num(p.receivedQty)} of ${num(p.qty)} received as of this date` : undefined}
          >
            {fmtDate(p.receivedDate)}
            {p.receivedDate && partial && <span className="ml-0.5 text-sdc-gray-400" aria-hidden>*</span>}
          </span>
        );
      }
      case "lead":
        return <LeadChip ordered={p.purchasedDate} expected={p.expectedDate} />;
      case "due":
        return <DueChip expected={p.expectedDate} received={p.st.key === "received"} now={now} />;
      case "purchqty":
        return (
          <span
            className="whitespace-nowrap font-mono text-note font-medium tabular-nums text-sdc-navy"
            title={p.poBreakdown.length ? `Bought across ${p.poBreakdown.length} PO${p.poBreakdown.length > 1 ? "s" : ""}. The BOM requires ${num(p.qty)}.` : "Nothing purchased against this part yet"}
          >
            {p.poBreakdown.length ? num(p.purchasedQty) : "\u2014"}
          </span>
        );
      case "unit": {
        // ── A grouped row has no single unit price ──────────────────────────
        //
        // It used to print the newest line's, beside a Total $ covering the whole
        // group — so `Qty 6 x $210.36` visibly failed to make `$9,840` and the row
        // looked wrong even though every figure in it was right. An em dash is the
        // honest answer: the row has a total, not a price. Same convention the
        // windowed-invoiced columns already use for "no coherent single value".
        // A blend across every PO, not the newest line's price -- and no longer
        // an em dash. `effectiveUnitPrice x purchasedQty === totalPrice` holds by
        // construction (po-detail.ts derives it from those two fields), so the
        // row self-adds for the first time.
        const blended = p.lineCount > 1;
        if (p.effectiveUnitPrice !== null) {
          return (
            <span
              className="whitespace-nowrap font-mono text-note font-medium tabular-nums text-sdc-navy"
              title={
                blended
                  ? `Average across ${p.poBreakdown.length} PO${p.poBreakdown.length > 1 ? "s" : ""} (${p.lineCount} purchase lines) \u2014 ${usd(p.totalPrice)} over ${num(p.purchasedQty)} units. Click the part number for each PO's own price.`
                  : COST_BASIS_NOTE[p.costBasis]
              }
            >
              {usd2(p.effectiveUnitPrice)}
              {blended ? <span className="ml-0.5 text-sdc-gray-400" aria-hidden>~</span> : null}
            </span>
          );
        }
        // Nothing bought (or a purchased quantity that nets to zero): the total
        // beside this is the BOM's own estimate, and the existing asterisk is
        // what already says so.
        return (
          <span className="whitespace-nowrap font-mono text-note font-medium tabular-nums text-sdc-navy" title={COST_BASIS_NOTE[p.costBasis]}>
            {p.unitPrice > 0 ? usd2(p.unitPrice) : "\u2014"}
            {p.unitPrice > 0 && isEstimatedCost(p.costBasis) ? (
              <span className="ml-0.5 text-sdc-gray-400" aria-hidden>*</span>
            ) : null}
          </span>
        );
      }
      case "total":
        return <span className="whitespace-nowrap font-mono text-note font-semibold tabular-nums text-sdc-navy">{p.totalPrice > 0 ? usd(p.totalPrice) : "—"}</span>;
      case "invoiced":
        return <span className="whitespace-nowrap font-mono text-note font-medium tabular-nums text-sdc-navy">{usd(p.invoicedAmount)}</span>;
      case "pctinv":
        return (
          <span className="whitespace-nowrap font-mono text-note font-medium tabular-nums text-sdc-gray-600" title={p.pctInvoiced === null ? "Not meaningful for a windowed Invoiced $ figure" : undefined}>
            {p.pctInvoiced === null ? "—" : `${p.pctInvoiced}%`}
          </span>
        );
      case "match":
        return (
          <span
            className={`inline-block rounded px-1.5 py-0.5 text-micro font-semibold ${
              p.matchReason === "matched"
                ? "text-sdc-muted"
                : p.matchReason.startsWith("join-")
                  ? "bg-sdc-yellow-bg text-sdc-yellow-text"
                  : "bg-sdc-gray-100 text-sdc-gray-600"
            }`}
            title={MATCH_REASON_TEXT[p.matchReason]}
          >
            {MATCH_REASON_LABEL[p.matchReason]}
          </span>
        );
      case "leftspend":
        return (
          <span className="whitespace-nowrap font-mono text-note font-medium tabular-nums text-sdc-navy" title={p.leftToSpend === null ? "Not meaningful for a windowed Invoiced $ figure" : undefined}>
            {p.leftToSpend === null ? "—" : usd(p.leftToSpend)}
          </span>
        );
      case "status":
        return <StatusPill st={p.st} />;
    }
  };
  return (
    <>
      {cols.map((c) => (
        <td
          key={c.key}
          className={`overflow-hidden border-b border-r border-sdc-border-soft px-2 py-1 align-middle ${c.align === "right" ? "text-right" : ""}`}
        >
          {cell(c.key)}
        </td>
      ))}
    </>
  );
}

// ── One PO, unfolded under its part's row (2026-09-13) ──────────────────────
//
// The inline form of PartPoPanel's table: the same PartPoGroup, the same fields,
// laid under the parent row's OWN columns so each figure sits beneath the header
// that names it — the PO number under PO #, its quantity under Purch Qty, its
// price under Unit $, its total under Total $. Every cell reads the group's own
// field (never the parent's), so a part bought at three prices shows three prices.
//
// Part-level columns (Qty, Desc, Required Date, Status…) are left blank on
// purpose: repeating the parent's value down every sub-row would present one fact
// as if it varied per PO. The one exception is the part-number cell, which names
// the sub-row for what it is.
//
// Sub-rows are NOT part of the footer's arithmetic — PartsTableView sums `parts`,
// and these rows are a view of money the parent row already counts. Counting them
// would double every expanded part.
export function PartPoSubRowCells({
  p,
  g,
  cols,
  onOpenPo,
}: {
  p: FlatPart;
  g: PartPoGroup;
  cols: { key: ColKey; label: string; align?: "right"; title?: string }[];
  onOpenPo: (supplier: string | null, poNumber: string | null) => void;
}) {
  const money = "font-mono text-note tabular-nums text-sdc-gray-700";
  const date = "whitespace-nowrap font-mono text-label text-sdc-gray-700";
  const plural = p.poBreakdown.length === 1 ? "" : "s";
  const cell = (key: ColKey): ReactNode => {
    switch (key) {
      case "pn":
        return (
          <span className="block truncate pl-5 font-mono text-note text-sdc-muted" title={`${p.pn} — one of its ${p.poBreakdown.length} PO${plural}`}>
            {"\u21B3 PO"}
            {g.lineCount > 1 ? ` \u00B7 ${g.lineCount} lines` : ""}
          </span>
        );
      case "supplier":
        return (
          <span className="flex items-center gap-1.5 truncate text-note text-sdc-gray-700" title={g.supplier ?? ""}>
            <SupplierAvatar supplier={g.supplier ?? "\u2014"} size={14} />
            <span className="truncate">{g.supplier || "\u2014"}</span>
          </span>
        );
      case "po":
        return g.poNumber ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpenPo(g.supplier, g.poNumber); }}
            title={`Open PO ${g.poNumber}`}
            className="truncate font-mono text-note font-medium text-sdc-blue hover:underline"
          >
            {g.poNumber}
          </button>
        ) : (
          <span className="font-mono text-note text-sdc-muted">no PO</span>
        );
      case "subs":
        // Lines for THIS part on THIS PO — what the parent row's count adds up.
        return (
          <span className={`${money} ${g.lineCount > 1 ? "" : "text-sdc-gray-400"}`} title={g.lineCount > 1 ? `${g.lineCount} lines for this part on this PO, summed here` : "One line"}>
            {g.lineCount > 1 ? g.lineCount : "\u2014"}
          </span>
        );
      case "purchased":
        return <span className={date}>{fmtDate(g.purchaseDate)}</span>;
      case "invoiceddate":
        return <span className={date}>{fmtDate(g.invoicedDate)}</span>;
      case "exp":
        return <span className={date}>{fmtDate(g.expectedDate)}</span>;
      case "delivered":
        return <span className={date}>{fmtDate(g.deliveredDate)}</span>;
      case "unit":
        return (
          <span className={money} title={g.unitPrice === null ? "This PO's quantity nets to zero, so it has no unit price" : `${usd(g.totalPrice)} over ${num(g.qty)} units on this PO`}>
            {g.unitPrice === null ? "\u2014" : usd2(g.unitPrice)}
          </span>
        );
      case "purchqty":
        return <span className={money}>{num(g.qty)}</span>;
      case "total":
        return <span className={`${money} font-semibold`}>{usd(g.totalPrice)}</span>;
      case "invoiced":
        return <span className={money}>{usd(g.invoicedAmount)}</span>;
      case "leftspend":
        return <span className={money}>{usd(g.leftToInvoice)}</span>;
      case "pctinv":
        return <span className={money}>{g.totalPrice > 0 ? `${Math.round((g.invoicedAmount / g.totalPrice) * 100)}%` : g.invoicedAmount > 0 ? "100%" : ""}</span>;
      default:
        return null;
    }
  };
  return (
    <>
      {cols.map((c) => (
        <td
          key={c.key}
          className={`overflow-hidden whitespace-nowrap border-b border-r border-sdc-border-soft px-2 py-0 align-middle ${c.align === "right" ? "text-right" : ""}`}
        >
          {cell(c.key)}
        </td>
      ))}
    </>
  );
}

// ── PO detail — right-side sliding panel ─────────────────────────────────────

// The drawer's parts table always shows THIS JOB's own BOM parts for the PO
// (`po.parts`, a FlatPart[]) through the exact same column system the main
// Parts List table uses — `ColKey`, `ALL_COLS`, `partsListSortColumns`,
// `PartRowCells` — rather than a bespoke row shape. Those raw vendor lines
// can't carry Mfr/Required Date/Invoiced $/Status — fields only a BOM
// `FlatPart` has — so this keeps the Parts-List-identical shape and drops any
// individual non-BOM vendor line rows. Supplier-wide awareness of the real PO
// (including any non-BOM lines) isn't lost, though — the authoritative
// "PO Lines (Supplier Status)" bar below still reads
// `authoritative.received/itemCount/pct`.
const PO_PANEL_COL_KEYS: ColKey[] = ["qty", "pn", "desc", "mfr", "purchased", "invoiceddate", "req", "exp", "delivered", "unit", "total", "invoiced", "status"];

// Pinned column widths — an auto-layout table with no width hints sizes every
// column to its OWN widest cell with no ceiling, and "Desc" is free text
// across up to several dozen rows. `table-fixed` + this colgroup force every
// column to actually respect a width, which is what makes PartRowCells'
// existing truncate+title behavior finally apply.
const PO_PANEL_COL_WIDTH: Partial<Record<ColKey, number>> = {
  qty: 44,
  pn: 110,
  desc: 200,
  mfr: 90,
  // Widened 2026-09-13 for the two-digit year ("Jan 23 '26").
  purchased: 78,
  invoiceddate: 76,
  req: 84,
  exp: 84,
  delivered: 84,
  unit: 64,
  total: 68,
  invoiced: 72,
  status: 96,
};

export function PoPanel({
  supplier,
  po,
  authoritative,
  onClose,
  onPartClick,
  onOpenPo,
}: {
  supplier: string;
  po: PoGroup;
  authoritative?: PoLineGroup;
  onClose: () => void;
  onPartClick: (p: DrillablePart) => void;
  onOpenPo: (supplier: string | null, poNumber: string | null) => void;
}) {
  const nowMs = useStableNow();
  const cols = useMemo(() => ALL_COLS.filter((c) => PO_PANEL_COL_KEYS.includes(c.key)), []);
  const sortColumns = useMemo(() => partsListSortColumns(nowMs), [nowMs]);
  const lineSort = useColumnSort<ColKey>();
  const sortedParts = sortRows(po.parts, lineSort.sort, sortColumns);
  // Sum of the pinned widths above — the table's own width, so `table-fixed`
  // has a real number to divide among the `<colgroup>` below rather than
  // shrinking every column proportionally to fit whatever the drawer
  // happens to be (which is what `table-fixed` does to a 100%-wide table
  // with no explicit width of its own).
  const tableWidth = cols.reduce((sum, c) => sum + (PO_PANEL_COL_WIDTH[c.key] ?? 80), 0);

  // Mount closed, then flip to open on the next frame so the slide-in plays.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setOpen(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  // Animate out, then unmount via the parent after the transition.
  const requestClose = useCallback(() => {
    setOpen(false);
    window.setTimeout(onClose, 200);
  }, [onClose]);

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  // Required/Expected/Purchased/Invoiced — the header-level rollup.
  // Required/Purchased are the EARLIEST among the PO's parts (when the first
  // thing was needed/bought); Expected stays the LATEST — "when is this PO
  // fully in" is the useful reading of a single expected date across several
  // parts, not the soonest one.
  const stats = useMemo(() => {
    let purchased: string | null = null;
    let required: string | null = null;
    let expected: string | null = null;
    let value = 0;
    let invoicedTotal = 0;
    for (const p of po.parts) {
      if (p.purchasedDate && (!purchased || p.purchasedDate.slice(0, 10) < purchased.slice(0, 10))) purchased = p.purchasedDate;
      if (p.requiredDate && (!required || p.requiredDate.slice(0, 10) < required.slice(0, 10))) required = p.requiredDate;
      if (p.expectedDate && (!expected || p.expectedDate.slice(0, 10) > expected.slice(0, 10))) expected = p.expectedDate;
      value += (p.unitPrice || 0) * (p.qty || 0);
      invoicedTotal += p.invoicedAmount || 0;
    }
    const pct = po.total ? Math.round((po.received / po.total) * 100) : 0;
    return { purchased, required, expected, value, invoicedTotal, pct };
  }, [po]);

  const badge = po.pastDue
    ? { label: "PAST DUE", cls: "bg-sdc-red-bg text-sdc-red-text" }
    : stats.pct >= 90
      ? { label: "RECEIVED", cls: "bg-sdc-green-bg text-sdc-green-text" }
      : stats.pct >= 60
        ? { label: "PARTIAL", cls: "bg-sdc-yellow-bg text-sdc-yellow-text" }
        : { label: "PENDING", cls: "bg-sdc-blue-light text-sdc-blue-dark" };

  const handlePart = (p: FlatPart) => {
    onPartClick(p);
    requestClose();
  };

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`PO ${po.poNumber ?? "without number"}`}>
      {/* Backdrop */}
      <div
        onClick={requestClose}
        className={`absolute inset-0 bg-sdc-navy/40 motion-interactive ${open ? "opacity-100" : "opacity-0"}`}
      />
      {/* Panel — 800px comfortably fits every column but the widest "Desc"
          values without scrolling on a normal desktop width, leaving the
          table's own horizontal scroll as the fallback for a genuinely long
          value or a narrower viewport. Still capped by
          `max-w-[calc(var(--app-vw)_*_0.92)]` for small screens. */}
      <aside
        className={`absolute right-0 top-0 flex h-full w-[800px] max-w-[calc(var(--app-vw)_*_0.92)] flex-col bg-white shadow-xl motion-interactive ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        {/* Header */}
        <div className="flex flex-col gap-3 border-b border-sdc-border-soft p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <SupplierAvatar supplier={supplier} size={38} />
              <div className="min-w-0">
                <div className="truncate text-base font-bold text-sdc-navy" title={supplier}>{supplier}</div>
                <div className="font-mono text-xs text-sdc-gray-600">{po.poNumber ? `PO #${po.poNumber}` : "Parts without PO"}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-micro font-bold tracking-wide ${badge.cls}`}>{badge.label}</span>
              <button type="button" onClick={requestClose} aria-label="Close" className="rounded p-1 text-sdc-gray-400 hover:bg-sdc-gray-100 hover:text-sdc-navy">
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4 L12 12 M12 4 L4 12" strokeLinecap="round" /></svg>
              </button>
            </div>
          </div>

          {/* Summary stats — Parts/Required/Expected/Purchased/Invoiced/PO
              Value. This row wraps (`flex-wrap`). */}
          <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
            <Stat label="Parts" value={num(po.total)} />
            <Stat label="Required" value={fmtDate(stats.required)} />
            <Stat label="Expected" value={fmtDate(stats.expected)} tone={po.pastDue ? "danger" : undefined} />
            <Stat label="Purchased" value={fmtDate(stats.purchased)} />
            <Stat label="Invoiced" value={stats.invoicedTotal > 0 ? usd(stats.invoicedTotal) : "—"} />
            <Stat label="PO Value" value={stats.value > 0 ? usd(stats.value) : "—"} />
          </div>

          {/* Progress bars — authoritative PO-line status (when matched) plus the
              BOM assembly-readiness bar. */}
          <div className="flex flex-col gap-2">
            {authoritative && (
              <PanelBar
                label="PO Lines (Supplier Status)"
                received={authoritative.received}
                total={authoritative.itemCount}
                pct={authoritative.pct}
              />
            )}
            <PanelBar label="Parts (Assembly Readiness)" received={po.received} total={po.total} pct={stats.pct} />
          </div>
        </div>

        {/* Parts table — same columns, sort keys and row cells (`PartRowCells`)
            as the main Parts List table, just scoped to this PO's own parts
            and status-tinted the same way (`STATUS_ROW_BG`).

            `table-fixed` + the `<colgroup>`/`tableWidth` above — see
            PO_PANEL_COL_WIDTH's own comment for why a plain `w-full`
            auto-layout table would let "Desc" balloon and drag the whole
            table too wide. This wrapper still scrolls both ways
            (`overflow-y-auto` also computes `overflow-x` to `auto` per every
            browser's shared, if unspecified, behavior — `styled-scrollbar`
            already themes both scrollbars). */}
        <div className="flex-1 overflow-auto styled-scrollbar">
          <table className="table-fixed border-collapse text-left" style={{ width: tableWidth, minWidth: "100%" }}>
            <colgroup>
              {cols.map((c) => (
                <col key={c.key} style={{ width: PO_PANEL_COL_WIDTH[c.key] }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-[1]">
              <tr className="bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
                {cols.map((c) => (
                  <SortableTh
                    key={c.key}
                    label={c.label}
                    sortKey={c.key}
                    type={sortColumns[c.key].type}
                    sort={lineSort.sort}
                    onSort={lineSort.onSort}
                    title={c.title}
                    className="px-2 py-2"
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedParts.map((p, i) => (
                <tr
                  key={`${p.id}-${i}`}
                  onClick={() => handlePart(p)}
                  title="Copy part # · locate row"
                  className={`cursor-pointer border-b border-sdc-border-soft/60 ${STATUS_ROW_BG[p.st.key]}`}
                >
                  <PartRowCells p={p} cols={cols} now={nowMs} onOpenPo={onOpenPo} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </aside>
    </div>
  );
}

function PanelBar({ label, received, total, pct }: { label: string; received: number; total: number; pct: number }) {
  const color = pct >= 90 ? "bg-sdc-green" : pct >= 60 ? "bg-sdc-yellow" : "bg-sdc-blue";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-label">
        <span className="font-semibold uppercase tracking-wide text-sdc-gray-400">{label}</span>
        <span className="text-sdc-gray-600 tabular-nums">
          {received}/{total} · <span className="font-semibold text-sdc-navy">{pct}%</span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-sdc-gray-100">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="flex flex-col">
      <span className="text-micro font-bold uppercase tracking-wider text-sdc-gray-400">{label}</span>
      <span className={`font-mono text-xs font-semibold tabular-nums ${tone === "danger" ? "text-sdc-red-text" : "text-sdc-navy"}`}>{value}</span>
    </div>
  );
}
