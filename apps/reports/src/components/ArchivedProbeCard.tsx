"use client";

import { useState, useTransition } from "react";
import { archivedProbeAction, type ArchivedProbeResult } from "@/lib/archived-probe-actions";
import { BUTTON_SECONDARY } from "@/components/ui/classnames";

const money = (n: number) =>
  (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Temporary, read-only: one job's Parts List lines with archived PO lines left out,
// to compare against Job Details > Procurement. Remove once the answer is in.
export function ArchivedProbeCard() {
  const [pending, startTransition] = useTransition();
  const [jobId, setJobId] = useState("1155");
  const [r, setR] = useState<ArchivedProbeResult | null>(null);

  function run() {
    startTransition(async () => setR(await archivedProbeAction(jobId)));
  }

  return (
    <>
      <div className="mt-3 flex items-center gap-2">
        <input
          value={jobId}
          onChange={(e) => setJobId(e.target.value)}
          inputMode="numeric"
          aria-label="Job number"
          className="w-24 rounded-md border border-sdc-border px-2 py-1 text-sm"
        />
        <button type="button" onClick={run} disabled={pending} className={BUTTON_SECONDARY}>
          {pending ? "Querying…" : "Show lines"}
        </button>
      </div>

      {r && !r.ok && <p className="mt-3 text-sm text-sdc-gray-600">{r.reason}</p>}

      {r && r.ok && (
        <div className="mt-3">
          <p className="mb-2 text-sm text-sdc-gray-600">
            Job {r.jobId}: <strong className="text-sdc-navy">{r.lines.length}</strong> lines · Total{" "}
            <strong className="text-sdc-navy">{money(r.purchased)}</strong> · Invoiced{" "}
            <strong className="text-sdc-navy">{money(r.paid)}</strong> · Left to invoice{" "}
            <strong className="text-sdc-navy">{money(r.leftToPay)}</strong>
          </p>
          <p className="mb-2 text-sm text-sdc-gray-600">
            Left out as archived: <strong className="text-sdc-navy">{r.archived.count}</strong> PO lines · Total{" "}
            <strong className="text-sdc-navy">{money(r.archived.purchased)}</strong> · Invoiced{" "}
            <strong className="text-sdc-navy">{money(r.archived.paid)}</strong>
          </p>
          <div className="max-h-96 overflow-auto border border-sdc-border">
            <table className="w-full text-left text-note">
              <thead className="sticky top-0 bg-sdc-gray-50 text-label uppercase tracking-wider text-sdc-gray-600">
                <tr>
                  <th className="px-2 py-1">PO</th>
                  <th className="px-2 py-1">Supplier</th>
                  <th className="px-2 py-1">Part No</th>
                  <th className="px-2 py-1">Description</th>
                  <th className="px-2 py-1 text-right">Qty</th>
                  <th className="px-2 py-1 text-right">Total $</th>
                  <th className="px-2 py-1 text-right">Invoiced $</th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.lineId} className="border-t border-sdc-border-soft">
                    <td className="px-2 py-1">{l.poNumber ?? "–"}</td>
                    <td className="px-2 py-1">{l.supplier ?? "–"}</td>
                    <td className="px-2 py-1">{l.partNumber ?? "–"}</td>
                    <td className="px-2 py-1">{l.description ?? "–"}</td>
                    <td className="px-2 py-1 text-right">{l.quantity}</td>
                    <td className="px-2 py-1 text-right">{money(l.totalPrice)}</td>
                    <td className="px-2 py-1 text-right">{money(l.invoicedAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
