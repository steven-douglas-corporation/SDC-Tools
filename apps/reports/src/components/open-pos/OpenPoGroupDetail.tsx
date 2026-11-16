"use client";

import { Fragment } from "react";
import { BuildReadinessDrawer, type DrawerBadge } from "@/components/build-readiness/BuildReadinessDrawer";
import { Stat } from "@/components/procurement/PoDetailPanel";
import { usd, usdExact } from "@/components/ui/format";
import { fmtDate } from "@/lib/po-detail";
import { isChargeLine, lineState, stateCounts, vsRequired, type DeliveryState, type OpenPoLine, type OpenPoMoney, type OpenPoRow, type StateCounts } from "@/lib/open-pos-rules";

// ── A whole card, opened: one project (or supplier) and every PO on it, line by line ─────
//
// Opened by clicking anywhere on an Open POs card. The card lists POs; this lists their
// lines, each marked Here, Coming or Outstanding (open-pos-rules.ts lineState), with when it
// is expected and when the BOM needs it. A PO's heading opens the PO panel, as a card row does.
// On a project card only that job's lines are shown (a PO split across jobs shows its share).

export const STATE_LABEL: Record<DeliveryState, string> = { here: "Here", coming: "Coming", outstanding: "Outstanding" };
export const STATE_TIP: Record<DeliveryState, string> = {
  here: "All of it has arrived",
  coming: "Not all here yet, expected today or later (or no date yet)",
  outstanding: "Not all here, and its expected date has passed",
};
export const STATE_CLS: Record<DeliveryState, string> = {
  here: "bg-sdc-green-bg text-sdc-green-text",
  coming: "bg-sdc-blue-light text-sdc-blue-dark",
  outstanding: "bg-sdc-red-bg text-sdc-red-text",
};

export type GroupDetailPo = { row: OpenPoRow; money: OpenPoMoney };

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

export function OpenPoGroupDetail({
  title,
  subtitle,
  badge,
  pos,
  jobId,
  today,
  requiredByLine,
  bySupplier,
  onOpenPo,
  onClose,
}: {
  title: string;
  subtitle: string;
  badge?: DrawerBadge;
  pos: GroupDetailPo[];
  /** A project card: only this job's lines. */
  jobId?: string;
  today: string;
  /** BOM required date by line id, for lines still to arrive. */
  requiredByLine: ReadonlyMap<string, string>;
  /** Headings per supplier, as on the card. */
  bySupplier?: boolean;
  onOpenPo: (row: OpenPoRow) => void;
  onClose: () => void;
}) {
  const mine = (row: OpenPoRow) => row.items.filter((l) => jobId == null || l.jobId === jobId);
  const counts = pos.reduce<StateCounts>(
    (c, p) => {
      const s = stateCounts(p.row.items, today, jobId);
      return { here: c.here + s.here, coming: c.coming + s.coming, outstanding: c.outstanding + s.outstanding };
    },
    { here: 0, coming: 0, outstanding: 0 },
  );
  const sum = (k: keyof OpenPoMoney) => pos.reduce((s, p) => s + p.money[k], 0);
  const late = sum("late");
  const notReceived = sum("notReceived");

  // POs by their next line to arrive, soonest (most overdue) first; all-here POs last.
  const next = (p: GroupDetailPo) => {
    let d: string | null = null;
    for (const l of mine(p.row)) {
      const s = lineState(l, today);
      if ((s === "coming" || s === "outstanding") && l.expected && (!d || l.expected < d)) d = l.expected;
    }
    return d ?? (stateCounts(p.row.items, today, jobId).coming > 0 ? "9998" : "9999");
  };
  const ordered = [...pos].sort((a, b) => next(a).localeCompare(next(b)) || a.row.poNumber.localeCompare(b.row.poNumber, undefined, { numeric: true }));
  const sections: { key: string | null; pos: GroupDetailPo[] }[] = [];
  if (bySupplier) {
    const at = new Map<string, number>();
    for (const p of ordered) {
      const k = p.row.suppliers.join(", ") || "No supplier";
      if (!at.has(k)) at.set(k, sections.push({ key: k, pos: [] }) - 1);
      sections[at.get(k)!].pos.push(p);
    }
  } else sections.push({ key: null, pos: ordered });

  return (
    <BuildReadinessDrawer title={title} subtitle={subtitle} badge={badge} breadcrumb={[title]} onBreadcrumbClick={() => {}} onClose={onClose}>
      <div className="flex flex-col gap-4 p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Ordered" value={usd(sum("ordered"))} />
          <Stat label="Here" value={usd(sum("received"))} />
          <Stat label="Coming" value={usd(notReceived - late)} />
          <Stat label="Outstanding" value={usd(late)} tone={late > 0 ? "danger" : undefined} />
          <Stat label="Invoiced, not received" value={usd(sum("invoicedNotReceived"))} />
          <Stat label="Left to invoice" value={usd(sum("leftToInvoice"))} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-note">
          <span className="font-semibold text-sdc-gray-600">Part lines:</span>
          {(["here", "coming", "outstanding"] as const).map((s) => (
            <span key={s} title={STATE_TIP[s]} className={`rounded-full px-2 py-0.5 font-semibold ${STATE_CLS[s]}`}>
              {counts[s]} {STATE_LABEL[s].toLowerCase()}
            </span>
          ))}
        </div>

        {sections.map((sec) => (
          <Fragment key={sec.key ?? "all"}>
            {sec.key != null && (
              <h3 className="-mb-2 text-xs font-bold uppercase tracking-wide text-sdc-gray-600">
                {sec.key} <span className="font-normal normal-case text-sdc-gray-400">· {sec.pos.length} {sec.pos.length === 1 ? "PO" : "POs"}</span>
              </h3>
            )}
            {sec.pos.map((p) => (
              <PoSection key={p.row.poNumber} p={p} lines={mine(p.row)} today={today} requiredByLine={requiredByLine} showSupplier={!bySupplier} onOpenPo={onOpenPo} />
            ))}
          </Fragment>
        ))}
      </div>
    </BuildReadinessDrawer>
  );
}

function PoSection({
  p,
  lines,
  today,
  requiredByLine,
  showSupplier,
  onOpenPo,
}: {
  p: GroupDetailPo;
  lines: OpenPoLine[];
  today: string;
  requiredByLine: ReadonlyMap<string, string>;
  showSupplier: boolean;
  onOpenPo: (row: OpenPoRow) => void;
}) {
  const { row } = p;
  const rank = (l: OpenPoLine) => {
    const s = lineState(l, today);
    return s === "outstanding" ? 0 : s === "coming" ? 1 : s === "here" ? 2 : 3;
  };
  const sorted = [...lines].sort((a, b) => rank(a) - rank(b) || (a.expected ?? "9").localeCompare(b.expected ?? "9"));
  return (
    <section className="overflow-hidden rounded-lg border border-sdc-border">
      <button
        type="button"
        onClick={() => onOpenPo(row)}
        title="Open this PO's own panel"
        className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 bg-sdc-gray-100 px-3 py-1.5 text-left hover:bg-sdc-blue-light/40"
      >
        <span className="font-mono text-note font-semibold text-sdc-blue underline decoration-dotted underline-offset-2">PO {row.poNumber}</span>
        {showSupplier && <span className="text-label text-sdc-gray-600">{row.suppliers.join(", ") || "No supplier"}</span>}
        <span className="text-label text-sdc-gray-400">ordered {fmtDate(row.purchaseDate)}</span>
        {!row.open && <span className="rounded bg-sdc-green-bg px-1.5 text-micro font-bold text-sdc-green-text">CLOSED</span>}
        <span className="ml-auto text-label tabular-nums text-sdc-gray-600" title={`${usdExact(p.money.received)} of ${usdExact(p.money.ordered)} here, at PO price`}>
          {usd(p.money.received)} of {usd(p.money.ordered)} here ›
        </span>
      </button>
      <table className="w-full text-sm">
        <thead className="text-left text-micro font-bold uppercase tracking-wider text-sdc-gray-400">
          <tr>
            <th className="px-3 py-1">Part</th>
            <th className="px-2 py-1 text-right" title="Received so far of the quantity ordered">
              Received
            </th>
            <th className="px-2 py-1" title="When it is expected. ↻ means the vendor re-promised a new date">
              Expected
            </th>
            <th className="px-2 py-1" title="When the job's BOM needs the part: green if it arrives on or before that day, red if after">
              Needed
            </th>
            <th className="px-3 py-1" title="Here, coming, or outstanding (past its expected date)">
              State
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((l) => {
            const s = lineState(l, today);
            const required = s && s !== "here" ? (requiredByLine.get(l.lineId) ?? null) : null;
            const v = vsRequired(l.expected, required);
            const repromised = s !== "here" && !!l.original && !!l.expected && l.original !== l.expected;
            return (
              <tr key={l.lineId} className="border-t border-sdc-border-soft/60 align-top">
                <td className="px-3 py-1">
                  <div className="font-mono text-note font-semibold text-sdc-navy">{l.partNumber ?? "–"}</div>
                  <div className="text-label text-sdc-gray-600">{l.description}</div>
                </td>
                <td className="px-2 py-1 text-right font-mono text-label tabular-nums text-sdc-gray-600">
                  {l.quantity <= 0 ? "Credit" : isChargeLine(l) ? "Charge" : `${l.receivedQty == null ? "?" : Math.min(l.receivedQty, l.quantity)}/${l.quantity}`}
                </td>
                <td
                  className={`whitespace-nowrap px-2 py-1 font-mono text-label ${s === "outstanding" ? "font-semibold text-sdc-red-text" : "text-sdc-gray-600"}`}
                  title={repromised ? `Re-promised by the vendor. Originally due ${fmtDate(l.original)}` : undefined}
                >
                  {!s ? "–" : s === "here" ? "Here" : l.expected ? fmtDate(l.expected) : "No date"}
                  {repromised && <span className="text-sdc-blue"> ↻</span>}
                </td>
                <td
                  className={`whitespace-nowrap px-2 py-1 font-mono text-label ${v ? (v.onTime ? "text-green-700" : "font-semibold text-red-700") : "text-sdc-gray-400"}`}
                  title={
                    !required
                      ? s && s !== "here"
                        ? "Not on the job's BOM (or not loaded yet), so there is no required date"
                        : undefined
                      : !v
                        ? `Needed ${fmtDate(required)}`
                        : v.days === 0
                          ? `Needed ${fmtDate(required)}: arrives the day it's needed`
                          : `Needed ${fmtDate(required)}: arrives ${days(v.days)} ${v.onTime ? "before" : "after"} it's needed`
                  }
                >
                  {required ? fmtDate(required) : "–"}
                  {v && !v.onTime && v.days > 0 && <span> +{v.days}d</span>}
                </td>
                <td className="px-3 py-1">
                  {s ? (
                    <span title={STATE_TIP[s]} className={`rounded-full px-2 py-0.5 text-note font-semibold ${STATE_CLS[s]}`}>
                      {STATE_LABEL[s]}
                    </span>
                  ) : (
                    <span className="text-label text-sdc-gray-400" title="A credit, a shipping / fee / tariff charge, or no receiving data">
                      –
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
