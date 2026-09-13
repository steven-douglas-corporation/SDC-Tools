import type { ProjectRelease } from "@prisma/client";
import { card, INPUT, BUTTON_PRIMARY } from "@/components/ui/classnames";
import { usd } from "@/components/ui/format";
import { uploadProjectRelease, deleteProjectRelease } from "@/lib/project-release-actions";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";

// Displays the parsed SDC Project Release for a job (identity, order date,
// delivery, financial milestones, penalty/warranty, and the Project Budget) and
// lets a manager upload/replace it. The .pdf/.docx is parsed server-side in
// lib/project-release.ts.
type Milestone = { pct: number; label: string };
type BudgetLine = { label: string; value: number; isCost: boolean };
type Details = {
  jobNumber?: string | null;
  jobTitle?: string | null;
  buyer?: string | null;
  quote?: string | null;
  poNumber?: string | null;
  customerContact?: string | null;
  warrantyMonths?: number | null;
  commercialCost?: number | null;
  budget?: BudgetLine[];
};

function fmtDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

export function ProjectReleasePanel({
  jobId,
  jobName,
  release,
}: {
  jobId: number;
  jobName: string;
  release: ProjectRelease | null;
}) {
  const milestones = (Array.isArray(release?.milestones) ? release?.milestones : []) as unknown as Milestone[];
  const details = (release?.details ?? {}) as Details;
  const budget = Array.isArray(details.budget) ? details.budget : [];

  return (
    <div className={`${card("p-5")} mb-6`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-sdc-navy">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0">
            <path d="M4 1.5 H9 L13 5.5 V14.5 H4 Z" strokeLinejoin="round" />
            <path d="M9 1.5 V5.5 H13" strokeLinejoin="round" />
          </svg>
          Project Release
        </p>
        {release && (
          <form action={deleteProjectRelease.bind(null, jobId)}>
            <ConfirmSubmit
              message="Remove the Project Release for this job? The uploaded document and its parsed dates/budget will be cleared."
              className="text-xs text-sdc-gray-400 hover:text-sdc-red-text"
            >
              Remove
            </ConfirmSubmit>
          </form>
        )}
      </div>

      {!release ? (
        <div className="text-center">
          <p className="mb-1 text-sm text-sdc-muted">
            No Project Release loaded for <span className="font-semibold">{jobName}</span> yet.
          </p>
          <p className="mb-4 text-xs text-sdc-gray-400">
            Upload the SDC Project Release (.pdf or .docx). We&apos;ll pull the order date, delivery, financial
            milestones, warranty, and the project budget.
          </p>
          <form action={uploadProjectRelease.bind(null, jobId)} className="flex items-center justify-center gap-2">
            <input type="file" name="file" accept=".pdf,.docx" required className={INPUT} />
            <button className={BUTTON_PRIMARY} type="submit">Upload Project Release</button>
          </form>
        </div>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-sdc-border-soft p-3">
              <p className="text-note text-sdc-gray-400">RECEIPT OF PO</p>
              <p className="font-mono text-sm font-bold text-sdc-navy">{fmtDate(release.receiptOfPo)}</p>
            </div>
            <div className="rounded-lg border border-sdc-border-soft p-3">
              <p className="text-note text-sdc-gray-400">DELIVERY</p>
              <p className="font-mono text-sm font-bold text-sdc-navy">{release.deliveryDate || "—"}</p>
            </div>
            <div className="rounded-lg border border-sdc-border-soft p-3">
              <p className="text-note text-sdc-gray-400">WARRANTY</p>
              <p className="font-mono text-sm font-bold text-sdc-navy">
                {details.warrantyMonths != null ? `${details.warrantyMonths} mo` : release.penalty ? "Penalty" : "—"}
              </p>
            </div>
            <div className="rounded-lg border border-sdc-border-soft p-3">
              <p className="text-note text-sdc-gray-400">PO # / QUOTE</p>
              <p className="truncate font-mono text-xs font-bold text-sdc-navy" title={`${details.poNumber ?? ""} · ${details.quote ?? ""}`}>
                {details.poNumber || "—"}
              </p>
              <p className="truncate text-note text-sdc-gray-400">{details.quote || ""}</p>
            </div>
          </div>

          {milestones.length > 0 && (
            <div className="mb-4">
              <p className="mb-1 text-note text-sdc-gray-400">FINANCIAL MILESTONES</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {milestones.map((m, i) => (
                      <tr key={i} className="border-b border-sdc-border-soft/60">
                        <td className="w-16 py-1 pr-4 font-mono font-bold text-sdc-navy">{m.pct}%</td>
                        <td className="py-1 text-sdc-gray-600">{m.label}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {budget.length > 0 && (
            <div className="mb-4">
              <p className="mb-1 text-note text-sdc-gray-400">PROJECT BUDGET</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {budget.map((b, i) => (
                      <tr key={i} className="border-b border-sdc-border-soft/60">
                        <td className="py-1 pr-4 text-sdc-gray-600">{b.label}</td>
                        <td className="py-1 text-right font-mono font-bold text-sdc-navy">
                          {b.isCost
                            ? usd(b.value)
                            : `${b.value} hrs`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {release.budgetImage && (
            <div className="mb-4">
              <p className="mb-1 text-note text-sdc-gray-400">PROJECT BUDGET (image)</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={release.budgetImage} alt="Project budget" className="max-w-full rounded-lg border border-sdc-border-soft" />
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-sdc-gray-400">
              {release.fileName} · uploaded {fmtDate(release.uploadedAt)}
              {details.customerContact ? ` · contact: ${details.customerContact}` : ""}
            </p>
            <form action={uploadProjectRelease.bind(null, jobId)} className="flex items-center gap-2">
              <input type="file" name="file" accept=".pdf,.docx" required className={`${INPUT} text-xs`} />
              <button className={BUTTON_PRIMARY} type="submit">Replace</button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
