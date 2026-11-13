"use client";

import { useEffect, useState } from "react";
import { BuildReadinessDrawer, type DrawerBadge } from "@/components/build-readiness/BuildReadinessDrawer";
import { Stat } from "@/components/procurement/PoDetailPanel";
import { TOOLBAR_BTN_COMPACT, TOOLBAR_BTN_NEUTRAL } from "@/components/ui/classnames";
import { usd, usdExact } from "@/components/ui/format";
import { fmtDate } from "@/lib/po-detail";
import { isChargeLine, type OpenPoLine, type OpenPoRow } from "@/lib/open-pos-rules";
import type { PoBomContext, PoBomUse } from "@/lib/open-po-bom";
import { loadPoBomContext } from "@/lib/open-pos-actions";

// One PO, opened from Open POs. Opens at once with what the page already has (the PO's lines,
// money and dates); where each part is used in the BOM is then asked of Total ETO for this one
// PO (open-po-bom.ts) and fills in when it arrives.

const pctOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function UsedIn({ uses, state }: { uses: PoBomUse[] | undefined; state: "loading" | "failed" | "done" }) {
  if (state === "loading") return <span className="text-sdc-gray-400">Looking up…</span>;
  if (state === "failed") return <span className="text-sdc-gray-400">–</span>;
  if (!uses?.length) return <span className="text-sdc-gray-400" title="This part is not on the job's BOM, so nothing is waiting on it there">Not in the BOM</span>;
  return (
    <span className="flex flex-col gap-0.5">
      {uses.map((u, i) => (
        <span
          key={i}
          className="leading-tight"
          title={`${u.section}. ${u.assemblyPn} ${u.assemblyDesc}. Needs ${u.qty}${u.neededBy ? ` by ${fmtDate(u.neededBy)}` : ""}${u.onHold ? ". On engineering hold" : ""}`}
        >
          <span className="font-mono text-sdc-navy">{u.assemblyPn}</span> <span className="text-sdc-gray-600">{u.assemblyDesc}</span>
          {u.neededBy && <span className="text-sdc-gray-400"> · needed {fmtDate(u.neededBy)}</span>}
          {u.onHold && <span className="ml-1 rounded bg-sdc-yellow-bg px-1 text-micro font-bold text-sdc-yellow-text">HOLD</span>}
        </span>
      ))}
    </span>
  );
}

export function OpenPoPanel({
  row,
  badge,
  jobName,
  schedulerVendorPosUrl,
  onClose,
}: {
  row: OpenPoRow;
  badge: DrawerBadge & { title?: string };
  jobName: (jobId: string) => string;
  schedulerVendorPosUrl?: string;
  onClose: () => void;
}) {
  const [bom, setBom] = useState<PoBomContext | null>(null);
  useEffect(() => {
    let live = true;
    loadPoBomContext(row.poNumber, row.jobIds)
      .then((r) => live && setBom(r))
      .catch(() => live && setBom({ ok: false, error: "Could not read the BOM. The PO's lines are still shown." }));
    return () => {
      live = false;
    };
  }, [row.poNumber, row.jobIds]);

  const state = bom == null ? "loading" : bom.ok ? "done" : "failed";
  const usesByLine = new Map<string, PoBomUse[]>();
  if (bom?.ok) for (const u of bom.uses) usesByLine.set(u.lineId, [...(usesByLine.get(u.lineId) ?? []), u]);

  const m = row.money;
  const p = pctOf(m.received, m.ordered);
  const multiJob = row.jobIds.length > 1;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const lines = [...row.items].sort((a, b) => outstanding(b) - outstanding(a) || (a.expected ?? "9").localeCompare(b.expected ?? "9"));

  return (
    <BuildReadinessDrawer
      title={`PO ${row.poNumber}`}
      subtitle={`${row.suppliers.join(", ") || "No supplier"} · ordered ${fmtDate(row.purchaseDate)} · ${row.items.length} ${row.items.length === 1 ? "line" : "lines"}`}
      badge={badge}
      breadcrumb={[`PO ${row.poNumber}`]}
      onBreadcrumbClick={() => {}}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4 p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Ordered" value={usd(m.ordered)} />
          <Stat label="Not yet received" value={usd(m.notReceived)} />
          <Stat label="Late" value={usd(m.late)} tone={m.late > 0 ? "danger" : undefined} />
          <Stat label="Invoiced, not received" value={usd(m.invoicedNotReceived)} />
          <Stat label="Received, not invoiced" value={usd(m.receivedNotInvoiced)} />
          <Stat label="Left to invoice" value={usd(m.leftToInvoice)} />
        </div>
        <div className="flex items-center gap-2" title={`${p}% of the PO's value has arrived: ${usdExact(m.received)} of ${usdExact(m.ordered)}, at PO price`}>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sdc-gray-100">
            <div className={`h-full rounded-full ${p >= 100 ? "bg-sdc-green" : m.late > 0 ? "bg-sdc-navy" : "bg-sdc-blue"}`} style={{ width: `${Math.min(100, p)}%` }} />
          </div>
          <span className="w-24 shrink-0 text-right text-note font-semibold tabular-nums text-sdc-gray-600">{p}% received</span>
        </div>

        <div className="overflow-x-auto rounded-lg border border-sdc-border">
          <table className="w-full text-sm">
            <thead className="bg-sdc-gray-100 text-left text-micro font-bold uppercase tracking-wider text-sdc-gray-400">
              <tr>
                <th className="px-3 py-1.5" title="Part number and description from the PO line">
                  Part
                </th>
                {multiJob && (
                  <th className="px-2 py-1.5" title="The job this line charges">
                    Job
                  </th>
                )}
                <th className="px-2 py-1.5 text-right" title="Received so far of the quantity ordered">
                  Received
                </th>
                <th className="px-2 py-1.5" title="When the line is expected. ↻ means the vendor re-promised a new date">
                  Expected
                </th>
                <th className="px-2 py-1.5 text-right" title="Value still to be invoiced on this line">
                  Left to invoice
                </th>
                <th className="px-3 py-1.5" title="Where the part is used in the job's BOM, and when it is needed there. Looked up when this panel opens">
                  Used in
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const late = outstanding(l) > 0 && !!l.expected && l.expected < today;
                const repromised = outstanding(l) > 0 && !!l.original && !!l.expected && l.original !== l.expected;
                return (
                  <tr key={l.lineId} className="border-t border-sdc-border-soft/60 align-top">
                    <td className="px-3 py-1.5">
                      <div className="font-mono text-note font-semibold text-sdc-navy">{l.partNumber ?? "–"}</div>
                      <div className="text-label text-sdc-gray-600">{l.description}</div>
                    </td>
                    {multiJob && (
                      <td className="px-2 py-1.5 text-note">
                        <a href={`/job-hours?jobs=${encodeURIComponent(l.jobId)}`} title={`Open ${l.jobId} in Job Details`} className="text-sdc-blue hover:underline">
                          {l.jobId}
                        </a>
                      </td>
                    )}
                    <td
                      className="px-2 py-1.5 text-right font-mono text-label tabular-nums text-sdc-gray-600"
                      title={
                        l.quantity <= 0
                          ? "A credit or return on the PO, nothing to receive"
                          : isChargeLine(l)
                            ? "A shipping, fee or tariff charge, not a part. Left out of the received counts, as on Job Details"
                            : l.receivedQty == null
                              ? "No receiving data for this line"
                              : `${Math.min(l.receivedQty, l.quantity)} of ${l.quantity} received`
                      }
                    >
                      {l.quantity <= 0 ? "Credit" : isChargeLine(l) ? "Charge" : `${l.receivedQty == null ? "?" : Math.min(l.receivedQty, l.quantity)}/${l.quantity}`}
                    </td>
                    <td
                      className={`whitespace-nowrap px-2 py-1.5 font-mono text-label ${late ? "font-semibold text-sdc-red-text" : "text-sdc-gray-600"}`}
                      title={
                        isChargeLine(l)
                          ? "A charge, not a part: nothing to deliver"
                          : repromised
                            ? `Re-promised by the vendor. Originally due ${fmtDate(l.original)}`
                            : outstanding(l) <= 0
                              ? "Everything on this line has arrived"
                              : undefined
                      }
                    >
                      {l.quantity <= 0 || isChargeLine(l) ? "–" : outstanding(l) <= 0 ? "Here" : l.expected ? fmtDate(l.expected) : "No date"}
                      {repromised && <span className="text-sdc-blue"> ↻</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-label tabular-nums text-sdc-navy" title={usdExact(l.leftToInvoice)}>
                      {l.leftToInvoice === 0 ? "–" : usd(l.leftToInvoice)}
                    </td>
                    <td className="px-3 py-1.5 text-label">
                      <UsedIn uses={usesByLine.get(l.lineId)} state={state} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {bom && !bom.ok && <p className="text-note text-sdc-gray-400">{bom.error}</p>}

        <div className="flex flex-wrap gap-2">
          {row.jobIds.map((j) => (
            <a key={j} href={`/job-hours?jobs=${encodeURIComponent(j)}`} title={`Open ${j} in Job Details, with its full Parts List`} className={`${TOOLBAR_BTN_COMPACT} ${TOOLBAR_BTN_NEUTRAL}`}>
              {j}
              {jobName(j) ? ` · ${jobName(j)}` : ""} in Job Details
            </a>
          ))}
          {schedulerVendorPosUrl && (
            <a
              href={schedulerVendorPosUrl}
              target="_blank"
              rel="noreferrer"
              title="Opens the Scheduler's Vendor POs page in a new tab, where buyers set ETAs, tracking and notes"
              className={`${TOOLBAR_BTN_COMPACT} ${TOOLBAR_BTN_NEUTRAL}`}
            >
              Chase in Scheduler ↗
            </a>
          )}
        </div>
      </div>
    </BuildReadinessDrawer>
  );
}

/** Quantity still to arrive on a line (0 when receipts are unknown, or it is a credit or a charge). */
function outstanding(l: OpenPoLine): number {
  if (l.receivedQty == null || l.quantity <= 0 || isChargeLine(l)) return 0;
  return Math.max(0, l.quantity - l.receivedQty);
}
