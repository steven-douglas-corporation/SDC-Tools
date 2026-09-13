"use client";

import { useEffect, useState, useTransition } from "react";
import { BuildReadinessDrawer } from "@/components/build-readiness/BuildReadinessDrawer";
import { DrillLines, DrillEmpty, DRILL_NUM, DRILL_TOTAL_LABEL } from "@/components/ui/Drill";
import { usd, usdExact } from "@/components/ui/format";
import { formatMonthLabel } from "@/lib/cash-flow-view";
import { loadArDrill, loadApDrill, loadPoDrill } from "@/lib/cash-flow-drill-actions";
import type { ArDrillRow, ApDrillRow, PoDrillRow } from "@/lib/cash-flow-drill";

// Record-level drill-through for one project/month's AR, AP, or PO —
// CURRENT only (see cash-flow-drill.ts's own header: a stored snapshot keeps
// only the aggregated total, not line-item detail). Fetched on open, same
// on-demand-I/O reasoning as every other drill in this app.

type Category = "AR" | "AP" | "PO";

export function CashFlowDrillDrawer({
  projectId,
  jobName,
  forecastMonth,
  category,
  onClose,
}: {
  projectId: string;
  jobName: string | null;
  forecastMonth: string;
  category: Category;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<ArDrillRow[] | ApDrillRow[] | PoDrillRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    startTransition(() => {
      setRows(null);
      setError(null);
      (async () => {
        try {
          const result =
            category === "AR" ? await loadArDrill(projectId, forecastMonth) : category === "AP" ? await loadApDrill(projectId, forecastMonth) : await loadPoDrill(projectId, forecastMonth);
          if (!cancelled) setRows(result);
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load this detail.");
        }
      })();
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, forecastMonth, category]);

  const title = `${category} — ${jobName ?? projectId}`;
  const subtitle = `Project ${projectId} · ${formatMonthLabel(forecastMonth)}`;

  return (
    <BuildReadinessDrawer title={title} subtitle={subtitle} breadcrumb={[title]} onBreadcrumbClick={() => {}} onClose={onClose}>
      {error ? (
        <DrillEmpty>Couldn&apos;t load this detail: {error}</DrillEmpty>
      ) : rows === null ? (
        <DrillEmpty>Loading…</DrillEmpty>
      ) : category === "AR" ? (
        <ArDrillTable rows={rows as ArDrillRow[]} />
      ) : category === "AP" ? (
        <ApDrillTable rows={rows as ApDrillRow[]} />
      ) : (
        <PoDrillTable rows={rows as PoDrillRow[]} />
      )}
    </BuildReadinessDrawer>
  );
}

function ArDrillTable({ rows }: { rows: ArDrillRow[] }) {
  if (rows.length === 0) return <DrillEmpty>No AR terms in this month.</DrillEmpty>;
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <DrillLines
      head={
        <>
          <th>Invoice #</th>
          <th>Description</th>
          <th>Invoice Date</th>
          <th>Due Date</th>
          <th>Status</th>
          <th className="text-right">Amount</th>
        </>
      }
      foot={
        <tr>
          <td className={DRILL_TOTAL_LABEL} colSpan={5}>
            Total
          </td>
          <td className={`${DRILL_NUM} text-sm font-semibold`} title={usdExact(total)}>
            {usd(total)}
          </td>
        </tr>
      }
    >
      {rows.map((r, i) => (
        <tr key={i}>
          <td className="font-mono text-sdc-muted">{r.invoiceNumber ?? "—"}</td>
          <td className="text-sdc-gray-700" title={r.description ?? undefined}>
            <span className="line-clamp-1">{r.description ?? "—"}</span>
          </td>
          <td className="font-mono tabular-nums text-sdc-muted">{r.invoiceDate ?? "—"}</td>
          <td className="font-mono tabular-nums text-sdc-muted">{r.dueDate ?? "—"}</td>
          <td className="text-sdc-muted">{r.status}</td>
          <td className={DRILL_NUM} title={usdExact(r.amount)}>
            {usd(r.amount)}
          </td>
        </tr>
      ))}
    </DrillLines>
  );
}

function ApDrillTable({ rows }: { rows: ApDrillRow[] }) {
  if (rows.length === 0) return <DrillEmpty>No AP due in this month.</DrillEmpty>;
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <DrillLines
      head={
        <>
          <th>Invoice #</th>
          <th>Invoice Date</th>
          <th>Due Date</th>
          <th className="text-right">Amount</th>
        </>
      }
      foot={
        <tr>
          <td className={DRILL_TOTAL_LABEL} colSpan={3}>
            Total
          </td>
          <td className={`${DRILL_NUM} text-sm font-semibold`} title={usdExact(total)}>
            {usd(total)}
          </td>
        </tr>
      }
    >
      {rows.map((r, i) => (
        <tr key={i}>
          <td className="font-mono text-sdc-muted">{r.invoiceNumber ?? "—"}</td>
          <td className="font-mono tabular-nums text-sdc-muted">{r.invoiceDate ?? "—"}</td>
          <td className="font-mono tabular-nums text-sdc-muted">{r.dueDate ?? "—"}</td>
          <td className={DRILL_NUM} title={usdExact(r.amount)}>
            {usd(r.amount)}
          </td>
        </tr>
      ))}
    </DrillLines>
  );
}

function PoDrillTable({ rows }: { rows: PoDrillRow[] }) {
  if (rows.length === 0) return <DrillEmpty>No open PO commitments expected in this month.</DrillEmpty>;
  const total = rows.reduce((s, r) => s + r.remainingAmount, 0);
  return (
    <DrillLines
      head={
        <>
          <th>PO #</th>
          <th>Expected Date</th>
          <th className="text-right">Ordered</th>
          <th className="text-right">Invoiced</th>
          <th className="text-right">Remaining</th>
        </>
      }
      foot={
        <tr>
          <td className={DRILL_TOTAL_LABEL} colSpan={4}>
            Total remaining
          </td>
          <td className={`${DRILL_NUM} text-sm font-semibold`} title={usdExact(total)}>
            {usd(total)}
          </td>
        </tr>
      }
    >
      {rows.map((r, i) => (
        <tr key={i}>
          <td className="font-mono text-sdc-muted">{r.poNumber ?? "—"}</td>
          <td className="font-mono tabular-nums text-sdc-muted">{r.expectedDate ?? "—"}</td>
          <td className={DRILL_NUM}>{usd(r.orderedAmount)}</td>
          <td className={DRILL_NUM}>{usd(r.invoicedAmount)}</td>
          <td className={DRILL_NUM} title={usdExact(r.remainingAmount)}>
            {usd(r.remainingAmount)}
          </td>
        </tr>
      ))}
    </DrillLines>
  );
}
