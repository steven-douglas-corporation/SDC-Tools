"use client";

import { useRef, useState, useTransition } from "react";
import { importSupervisorsAction } from "@/lib/employee-actions";
import type { SupervisorImportResult } from "@/lib/import-employee-supervisors";
import { BUTTON_SECONDARY } from "@/components/ui/classnames";

// Uploads a Paylocity employee export (.xlsx) and sets each employee's
// supervisor from its "Supervisor [Id]" column (matched by Emp Id ==
// paylocityId). Shows a report of what changed / what couldn't be matched.
export function ImportSupervisorsButton() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SupervisorImportResult | null>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.set("file", file);
    startTransition(async () => {
      setResult(await importSupervisorsAction(fd));
      if (inputRef.current) inputRef.current.value = ""; // allow re-upload of same file
    });
  }

  return (
    <>
      <input ref={inputRef} type="file" accept=".xlsx,.xls" onChange={onFile} className="hidden" aria-hidden />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={pending}
        title="Set reporting lines from a Paylocity employee export (matched by Emp Id). Re-run whenever the org changes."
        className={BUTTON_SECONDARY}
      >
        {pending ? "Importing…" : "Import supervisors (Paylocity)"}
      </button>

      {result && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setResult(null)}>
          <div className="max-h-[calc(var(--app-vh)_*_0.8)] w-full max-w-lg overflow-auto rounded-xl border border-sdc-border bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            {!result.ok ? (
              <>
                <p className="mb-2 font-heading text-lg font-bold text-sdc-navy">Import failed</p>
                <p className="text-sm text-sdc-gray-600">{result.reason}</p>
              </>
            ) : (
              <>
                <p className="mb-1 font-heading text-lg font-bold text-sdc-navy">Supervisors imported</p>
                <p className="mb-4 text-sm text-sdc-gray-600">
                  <strong className="text-sdc-navy">{result.updated.length}</strong> set/changed ·{" "}
                  <strong className="text-sdc-navy">{result.unchanged}</strong> unchanged
                  {result.clearedCount > 0 && <> · <strong className="text-sdc-navy">{result.clearedCount}</strong> cleared</>}
                </p>

                {result.updated.length > 0 && (
                  <div className="mb-4">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sdc-gray-400">Reporting line set</p>
                    <ul className="space-y-0.5 text-sm">
                      {result.updated.map((u) => (
                        <li key={u.name} className="text-sdc-navy">{u.name} → <span className="font-medium">{u.supervisor}</span></li>
                      ))}
                    </ul>
                  </div>
                )}

                {result.supervisorNotInEtc.length > 0 && (
                  <div className="mb-4">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[#8A6D00]">
                      Supervisor not in ETC ({result.supervisorNotInEtc.length})
                    </p>
                    <p className="text-sm text-sdc-gray-700">
                      {result.supervisorNotInEtc.map((s) => `${s.name} (sup #${s.supervisorEmpId})`).join(", ")}
                    </p>
                  </div>
                )}

                {result.notInEtc > 0 && (
                  <p className="mb-2 text-note text-sdc-muted">
                    {result.notInEtc} export rows had no matching active ETC employee (terminated / not tracked) — skipped.
                  </p>
                )}
              </>
            )}

            <div className="mt-2 flex justify-end">
              <button type="button" onClick={() => setResult(null)} className={BUTTON_SECONDARY}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
