"use client";

import { useMemo, useState } from "react";
import { SectionTitle } from "@/components/ui/Typography";
import { card, TOOLBAR_BTN_COMPACT, TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_NEUTRAL } from "@/components/ui/classnames";
import { usd, usdExact } from "@/components/ui/format";
import { fmtDate } from "@/lib/po-detail";
import { OPEN_PO_STATUS_LABEL, type OpenPoStatus, type OpenPosResult } from "@/lib/open-pos-rules";
import { OpenPosGrid } from "@/components/open-pos/OpenPosGrid";

// Three layers, top to bottom: the totals, one row per job (how each project stands on
// open commitments), then every open PO. Clicking a job narrows the PO list to it;
// the status buttons narrow it by what each PO is waiting on. All client-side: the
// server already sent every open PO.

const STATUS_ORDER: OpenPoStatus[] = ["past-due", "awaiting-delivery", "awaiting-invoice", "over-invoiced", "open"];

function Kpi({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className={card("p-4")} title={title}>
      <div className="text-note text-sdc-gray-400">{label}</div>
      <div className="mt-1 font-heading text-xl font-bold text-sdc-navy">{value}</div>
    </div>
  );
}

export function OpenPosClient({ data }: { data: OpenPosResult }) {
  const [job, setJob] = useState<string | null>(null);
  const [status, setStatus] = useState<OpenPoStatus | null>(null);

  const counts = useMemo(() => {
    const c = new Map<OpenPoStatus, number>();
    for (const r of data.rows) if (!job || r.jobIds.includes(job)) c.set(r.status, (c.get(r.status) ?? 0) + 1);
    return c;
  }, [data.rows, job]);

  const rows = useMemo(
    () => data.rows.filter((r) => (!job || r.jobIds.includes(job)) && (!status || r.status === status)),
    [data.rows, job, status],
  );

  const { totals } = data;

  if (data.rows.length === 0) {
    return <div className={card()}>No open purchase orders on Active or HeadStart projects as of {fmtDate(data.asOf)}.</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Open POs" value={totals.openPos.toLocaleString()} />
        <Kpi label="Left to invoice on open POs" value={usd(totals.openValue)} title={usdExact(totals.openValue)} />
        <Kpi label="Past due POs" value={totals.pastDuePos.toLocaleString()} title="Open POs with a line not fully received after its required date" />
        <Kpi
          label="Still to arrive (at PO price)"
          value={usd(totals.awaitingDeliveryValue)}
          title={`${usdExact(totals.awaitingDeliveryValue)}: quantity not yet received × unit price, on open POs`}
        />
      </div>

      <section className="flex flex-col gap-2">
        <SectionTitle>By project</SectionTitle>
        <div className="overflow-x-auto rounded-xl border border-sdc-border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-sdc-navy text-left text-white">
              <tr>
                <th className="px-3 py-2 font-semibold">Job</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 text-right font-semibold">Open POs</th>
                <th className="px-3 py-2 text-right font-semibold">Past due</th>
                <th className="px-3 py-2 text-right font-semibold">Left to invoice</th>
                <th className="px-3 py-2 text-right font-semibold">Still to arrive</th>
                <th className="px-3 py-2 font-semibold">Oldest open PO</th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((j) => {
                const active = job === j.jobId;
                return (
                  <tr
                    key={j.jobId}
                    onClick={() => setJob(active ? null : j.jobId)}
                    className={`cursor-pointer border-t border-sdc-border ${active ? "bg-sdc-blue-light" : "hover:bg-sdc-blue-light/40"}`}
                    title={active ? "Show every project's POs" : "Show only this project's POs"}
                  >
                    <td className="px-3 py-1.5">
                      <a
                        href={`/job-hours?jobs=${encodeURIComponent(j.jobId)}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-sdc-blue hover:underline"
                      >
                        {j.jobId}
                      </a>{" "}
                      <span className="text-sdc-navy">{j.jobName}</span>
                    </td>
                    <td className="px-3 py-1.5 text-sdc-gray-600">{j.jobStatus}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{j.openPos}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${j.pastDuePos > 0 ? "font-semibold text-red-700" : "text-sdc-gray-400"}`}>{j.pastDuePos}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums" title={usdExact(j.openValue)}>{usd(j.openValue)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums" title={usdExact(j.awaitingDeliveryValue)}>{usd(j.awaitingDeliveryValue)}</td>
                    <td className="px-3 py-1.5 text-sdc-gray-600">{fmtDate(j.oldestOpen)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SectionTitle className="mr-2">Purchase orders{job ? ` on job ${job}` : ""}</SectionTitle>
          <button type="button" onClick={() => setStatus(null)} className={`${TOOLBAR_BTN_COMPACT} ${status === null ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL}`}>
            All
          </button>
          {STATUS_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(status === s ? null : s)}
              className={`${TOOLBAR_BTN_COMPACT} ${status === s ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL}`}
            >
              {OPEN_PO_STATUS_LABEL[s]} ({counts.get(s)})
            </button>
          ))}
          {job && (
            <button type="button" onClick={() => setJob(null)} className={`${TOOLBAR_BTN_COMPACT} ${TOOLBAR_BTN_NEUTRAL}`}>
              Clear job
            </button>
          )}
        </div>
        <p className="text-note text-sdc-gray-400">
          Amounts are the whole PO. A PO split across jobs lists every job it charges; the project table above counts only each job&apos;s own lines.
        </p>
        <OpenPosGrid rows={rows} />
      </section>
    </div>
  );
}
