"use client";

import { useMemo, useState } from "react";
import { DRILL_NUM, DRILL_TOTAL_LABEL, DrillEmpty, DrillLines } from "@/components/ui/Drill";
import { SortableTh } from "@/components/ui/SortableHeader";
import { useColumnSort } from "@/components/useColumnSort";
import { sortRows, type SortColumns } from "@/lib/table-sort";
import { usd, usdExact } from "@/components/ui/format";
import type { TmPartsDrillRow } from "@/lib/tm-report";

// The drill-through TABLE behind the T&M tab's three Parts-based cards (Part
// Invoiced Amount, SDC Manufactured Parts Sales Price, Expense Reports) —
// rendered inside the shared right-side drawer (BuildReadinessDrawer, see
// TmReportClient.tsx) that owns the title/subtitle/close chrome, so this is
// just the search box + table, on the same DrillLines/SortableTh primitives
// HoursDetailPanel already uses for Monthly ETC's own drills. All three read
// the same 'Part Purchase' row shape from tm-report.ts's fetchTmPartsDrill —
// they differ only in which extra measure-condition filtered the rows, and
// which column is the one that reconciles to the KPI (`amountKey`): Invoiced
// Amount for Part Invoiced Amount, Total Price for the other two. Every real
// Part Purchase field is still shown regardless — this never hides a column
// to make one card's story simpler.

type SortKey =
  | "purchaseDate"
  | "invoicedDate"
  | "jobId"
  | "jobName"
  | "partNumber"
  | "description"
  | "supplier"
  | "poNumber"
  | "quantity"
  | "unitPrice"
  | "totalPrice"
  | "invoicedAmount";

const COLUMNS: SortColumns<TmPartsDrillRow, SortKey> = {
  purchaseDate: { type: "date", value: (r) => r.purchaseDate },
  invoicedDate: { type: "date", value: (r) => r.invoicedDate },
  jobId: { type: "id", value: (r) => r.jobId || null },
  jobName: { type: "text", value: (r) => r.jobName || null },
  partNumber: { type: "text", value: (r) => r.partNumber || null },
  description: { type: "text", value: (r) => r.description || null },
  supplier: { type: "text", value: (r) => r.supplier || null },
  poNumber: { type: "text", value: (r) => r.poNumber || null },
  quantity: { type: "number", value: (r) => r.quantity },
  unitPrice: { type: "currency", value: (r) => r.unitPrice },
  totalPrice: { type: "currency", value: (r) => r.totalPrice },
  invoicedAmount: { type: "currency", value: (r) => r.invoicedAmount },
};

export function TmPartsDrillPanel({
  rows,
  error,
  amountKey,
  amountLabel,
}: {
  /** null while the drill is loading. */
  rows: TmPartsDrillRow[] | null;
  error: string | null;
  /** Which column this card's KPI actually sums — drives the default sort and the total row. */
  amountKey: "totalPrice" | "invoicedAmount";
  amountLabel: string;
}) {
  const sort = useColumnSort<SortKey>({ key: amountKey, direction: "desc" });
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.jobId.toLowerCase().includes(q) ||
        r.jobName.toLowerCase().includes(q) ||
        r.partNumber.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.supplier.toLowerCase().includes(q) ||
        r.poNumber.toLowerCase().includes(q),
    );
  }, [rows, query]);

  const sorted = useMemo(() => sortRows(filtered, sort.sort, COLUMNS), [filtered, sort.sort]);
  const total = filtered.reduce((sum, r) => sum + r[amountKey], 0);
  const filtering = query.trim().length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-sdc-border-soft px-4 py-2.5">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search part, description, supplier, PO#, or job…"
          className="h-7 w-full max-w-xs rounded-md border border-sdc-border-soft px-2 text-note outline-none motion-interactive focus:border-sdc-blue"
        />
      </div>
      <div className="styled-scrollbar min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <DrillEmpty>Couldn&apos;t load this detail: {error}</DrillEmpty>
        ) : rows === null ? (
          <DrillEmpty>Loading…</DrillEmpty>
        ) : sorted.length === 0 ? (
          <DrillEmpty>No parts match.</DrillEmpty>
        ) : (
          <div className="overflow-x-auto">
            <DrillLines
              head={
                <>
                  <SortableTh label="Purchase Date" sortKey="purchaseDate" type="date" sort={sort.sort} onSort={sort.onSort} className="w-28" />
                  <SortableTh label="Invoiced Date" sortKey="invoicedDate" type="date" sort={sort.sort} onSort={sort.onSort} className="w-28" />
                  <SortableTh label="Job ID" sortKey="jobId" type="id" sort={sort.sort} onSort={sort.onSort} className="w-20" />
                  <SortableTh label="Job / Machine" sortKey="jobName" type="text" sort={sort.sort} onSort={sort.onSort} className="w-44" />
                  <SortableTh label="Part No" sortKey="partNumber" type="text" sort={sort.sort} onSort={sort.onSort} className="w-32" />
                  <SortableTh label="Description" sortKey="description" type="text" sort={sort.sort} onSort={sort.onSort} />
                  <SortableTh label="Supplier" sortKey="supplier" type="text" sort={sort.sort} onSort={sort.onSort} className="w-40" />
                  <SortableTh label="PO #" sortKey="poNumber" type="text" sort={sort.sort} onSort={sort.onSort} className="w-24" />
                  <SortableTh label="Qty" sortKey="quantity" type="number" sort={sort.sort} onSort={sort.onSort} className="w-16" />
                  <SortableTh label="Unit $" sortKey="unitPrice" type="currency" sort={sort.sort} onSort={sort.onSort} className="w-24" />
                  <SortableTh label="Job Cost" sortKey="totalPrice" type="currency" sort={sort.sort} onSort={sort.onSort} className="w-24" title="Part Purchase[Total Price]" />
                  <SortableTh label="Invoiced $" sortKey="invoicedAmount" type="currency" sort={sort.sort} onSort={sort.onSort} className="w-24" title="Part Purchase[Invoiced Amount]" />
                </>
              }
              foot={
                <tr>
                  <td className={DRILL_TOTAL_LABEL} colSpan={11}>
                    {filtering ? `Shown (${amountLabel})` : `Total (${amountLabel})`}
                  </td>
                  <td className={`${DRILL_NUM} text-sm font-semibold`} title={usdExact(total)}>
                    {usd(total)}
                  </td>
                </tr>
              }
            >
              {sorted.map((r, i) => (
                <tr key={`${r.jobId}-${r.poNumber}-${r.partNumber}-${i}`}>
                  <td className="font-mono tabular-nums text-sdc-muted">{r.purchaseDate ?? "—"}</td>
                  <td className="font-mono tabular-nums text-sdc-muted">{r.invoicedDate ?? "—"}</td>
                  <td className="font-mono text-sdc-muted">{r.jobId || "—"}</td>
                  <td className="text-sdc-gray-700" title={r.jobName}>
                    <span className="line-clamp-1">{r.jobName || "—"}</span>
                  </td>
                  <td className="font-mono text-sdc-gray-700">{r.partNumber || "—"}</td>
                  <td className="text-sdc-gray-700" title={r.description}>
                    <span className="line-clamp-1">{r.description || "—"}</span>
                  </td>
                  <td className="text-sdc-muted">{r.supplier || "—"}</td>
                  <td className="font-mono text-sdc-muted">{r.poNumber || "—"}</td>
                  <td className={DRILL_NUM}>{r.quantity.toLocaleString()}</td>
                  <td className={DRILL_NUM} title={usdExact(r.unitPrice)}>
                    {usd(r.unitPrice)}
                  </td>
                  <td className={`${DRILL_NUM} ${amountKey === "totalPrice" ? "font-semibold text-sdc-navy" : ""}`} title={usdExact(r.totalPrice)}>
                    {usd(r.totalPrice)}
                  </td>
                  <td className={`${DRILL_NUM} ${amountKey === "invoicedAmount" ? "font-semibold text-sdc-navy" : ""}`} title={usdExact(r.invoicedAmount)}>
                    {usd(r.invoicedAmount)}
                  </td>
                </tr>
              ))}
            </DrillLines>
          </div>
        )}
      </div>
    </div>
  );
}
