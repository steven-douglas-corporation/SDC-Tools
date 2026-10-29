"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BUTTON_COMPACT, BUTTON_COMPACT_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, INPUT } from "@/components/ui/classnames";
import { useProjectsEditMode } from "@/components/ProjectsEditMode";
import {
  applyChangeQuote,
  deleteChangeQuote,
  listChangeQuoteJobs,
  loadChangeQuotes,
  reverseChangeQuote,
  saveChangeQuote,
  type ChangeQuotePanelData,
  type ChangeQuoteResult,
  type ChangeQuoteView,
  type JobOption,
} from "@/lib/change-quote-actions";
import { parseCents, reconcile, splitBySection, splitParts, totalHours } from "@/lib/change-quotes";

// ── Change Quotes panel (Projects tab) ──────────────────────────────────────
//
// One matrix per job, laid out like the budget tables the quote documents use:
// ORIGINAL (derived), one row per change quote, and TOTAL — which is exactly what
// the Projects grid holds, so nothing here can disagree with it. See
// lib/change-quotes.ts for the model and lib/change-quote-actions.ts for the writes.
//
// The panel keeps its own state and talks to its own server actions; it is not part
// of the grid's <form>, so opening it, editing in it, or saving from it can never
// mark a grid cell dirty or post one. The grid is refreshed by the actions that
// change totals (apply / reverse).

const usd = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 });
const hrs = (n: number) => (Math.round(n) === n ? String(n) : n.toFixed(2).replace(/\.?0+$/, ""));

type Draft = { key: string; id?: number; label: string; note: string; date: string; amount: string; parts: string; hours: Record<string, string> };

const fromQuote = (q: ChangeQuoteView): Draft => ({
  key: String(q.id),
  id: q.id,
  label: q.label,
  note: q.note ?? "",
  date: q.quoteDate ?? "",
  amount: q.amountCents === null ? "" : String(q.amountCents / 100),
  parts: q.partsCents === 0 ? "" : String(q.partsCents / 100),
  hours: Object.fromEntries(Object.entries(q.hours).map(([s, h]) => [s, String(h)])),
});

const draftHours = (d: Draft) => {
  const out: Record<string, number> = {};
  for (const [s, v] of Object.entries(d.hours)) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) out[s] = n;
  }
  return out;
};

const sameDraft = (a: Draft, b: Draft) => {
  const h = (d: Draft) => JSON.stringify(Object.entries(draftHours(d)).sort());
  return a.label.trim() === b.label.trim() && a.note.trim() === b.note.trim() && a.date === b.date && a.amount.trim() === b.amount.trim() && a.parts.trim() === b.parts.trim() && h(a) === h(b);
};

export function ChangeQuotesButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title="Track change quotes — original vs. change-quote hours and parts cost">
        Change Quotes
      </button>
      {open && <ChangeQuotesDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function ChangeQuotesDialog({ onClose }: { onClose: () => void }) {
  const { editing, mayEdit } = useProjectsEditMode();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [jobs, setJobs] = useState<JobOption[] | null>(null);
  const [filter, setFilter] = useState("");
  const [jobPk, setJobPk] = useState<number | null>(null);
  const [data, setData] = useState<ChangeQuotePanelData | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    listChangeQuoteJobs()
      .then((j) => live && setJobs(j))
      .catch(() => live && setNotice({ kind: "error", text: "Couldn't load the job list." }));
    return () => {
      live = false;
    };
  }, []);

  // Server quotes → drafts, keeping any unsaved NEW rows and any Draft the user is mid-edit on.
  const adopt = useCallback((next: ChangeQuotePanelData, keepEdits: boolean) => {
    setData(next);
    setDrafts((prev) => {
      const fresh = next.quotes.map(fromQuote);
      if (!keepEdits) return fresh;
      const byId = new Map(prev.filter((p) => p.id !== undefined).map((p) => [p.id!, p]));
      const merged = fresh.map((f) => {
        const mine = byId.get(f.id!);
        return mine && next.quotes.find((q) => q.id === f.id)?.status === "Draft" && !sameDraft(mine, f) ? mine : f;
      });
      return [...merged, ...prev.filter((p) => p.id === undefined)];
    });
  }, []);

  const select = useCallback(
    async (pk: number | null) => {
      setJobPk(pk);
      setNotice(null);
      setData(null);
      setDrafts([]);
      if (pk === null) return;
      setBusy("load");
      const r = await loadChangeQuotes(pk);
      setBusy(null);
      if (r.ok) adopt(r.data, false);
      else setNotice({ kind: "error", text: r.error });
    },
    [adopt],
  );

  async function act(key: string, call: () => Promise<ChangeQuoteResult>, after?: (r: Extract<ChangeQuoteResult, { ok: true }>) => void) {
    setBusy(key);
    setNotice(null);
    try {
      const r = await call();
      if (r.ok) {
        adopt(r.data, true);
        if (r.message) setNotice({ kind: "ok", text: r.message });
        after?.(r);
      } else {
        setNotice({ kind: "error", text: r.error });
      }
    } catch {
      setNotice({ kind: "error", text: "That didn't go through — check your connection and try again." });
    } finally {
      setBusy(null);
    }
  }

  const canEdit = editing && mayEdit;
  const quotes = useMemo(() => data?.quotes ?? [], [data]);
  const applied = useMemo(() => quotes.filter((q) => q.status === "Applied"), [quotes]);

  const split = useMemo(() => (data ? splitBySection(data.totals, applied) : null), [data, applied]);
  const partsSplit = useMemo(() => (data ? splitParts(data.partsTotalCents, applied) : null), [data, applied]);

  const sections = useMemo(() => {
    if (!data) return [];
    const used = new Set<string>(Object.keys(data.totals).filter((s) => data.totals[s] > 0));
    for (const q of quotes) for (const s of Object.keys(q.hours)) used.add(s);
    for (const d of drafts) for (const s of Object.keys(draftHours(d))) used.add(s);
    return showAll ? data.sections : data.sections.filter((s) => used.has(s.code));
  }, [data, quotes, drafts, showAll]);

  const shownJobs = (jobs ?? []).filter((j) => {
    const f = filter.trim().toLowerCase();
    return f === "" || j.jobId.toLowerCase().includes(f) || j.jobName.toLowerCase().includes(f);
  });

  function patchDraft(key: string, patch: Partial<Draft>) {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }
  function setHours(key: string, section: string, value: string) {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, hours: { ...d.hours, [section]: value } } : d)));
  }
  function addDraft() {
    if (!data) return;
    const n = drafts.length + 1;
    setDrafts((prev) => [...prev, { key: `new-${Date.now()}`, label: `CQ${n}`, note: "", date: "", amount: "", parts: "", hours: {} }]);
  }

  const gridCols = sections.length + 4;

  return (
    <div
      className="motion-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (!dialogRef.current?.contains(e.target as Node)) onClose();
      }}
    >
      <div ref={dialogRef} role="dialog" aria-label="Change quotes" className="flex max-h-[calc(var(--app-vh)_*_0.9)] w-full max-w-[min(calc(var(--app-vw)_*_0.96),1500px)] flex-col overflow-hidden rounded-xl border border-sdc-border bg-white shadow-lg">
        <div className="flex items-center justify-between gap-3 border-b border-sdc-border px-5 py-3">
          <div>
            <h2 className="font-heading text-base font-semibold text-sdc-navy">Change Quotes</h2>
            <p className="text-note text-sdc-muted">Original budget, each change quote, and the total the grid holds — hours by section and parts cost.</p>
          </div>
          <button type="button" className="text-2xl leading-none text-sdc-gray-400 hover:text-sdc-navy" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-sdc-border px-5 py-3">
          <label className="text-sm font-semibold text-sdc-navy" htmlFor="cq-filter">Job</label>
          <input id="cq-filter" className={`${INPUT} w-44`} placeholder="Filter by number or name" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <select
            aria-label="Job"
            className={`${INPUT} min-w-[16rem] max-w-[28rem]`}
            value={jobPk ?? ""}
            onChange={(e) => select(e.target.value === "" ? null : Number(e.target.value))}
            disabled={jobs === null}
          >
            <option value="">{jobs === null ? "Loading jobs…" : "Select a job…"}</option>
            {shownJobs.map((j) => (
              <option key={j.pk} value={j.pk}>
                {j.jobId} — {j.jobName}
                {j.changeQuoteCount > 0 ? `  (${j.changeQuoteCount} CQ)` : ""}
              </option>
            ))}
          </select>
          {data && (
            <label className="ml-2 flex items-center gap-1.5 text-sm text-sdc-navy">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all sections
            </label>
          )}
          {!canEdit && data && <span className="ml-auto text-note text-sdc-muted">{mayEdit ? "Turn on Editing in the toolbar to change these." : "Read-only for your role."}</span>}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {notice && (
            <p role={notice.kind === "error" ? "alert" : "status"} className={`mb-3 rounded-lg border px-3 py-2 text-sm ${notice.kind === "error" ? "border-sdc-red-text/30 bg-sdc-red-bg text-sdc-red-text" : "border-sdc-green-text/30 bg-sdc-green-bg text-sdc-green-text"}`}>
              {notice.text}
            </p>
          )}
          {jobPk === null && <p className="text-sm text-sdc-muted">Pick a job to see its original budget and change quotes.</p>}
          {busy === "load" && <p className="text-sm text-sdc-muted">Loading…</p>}

          {data && split && partsSplit && (
            <>
              <p className="mb-3 text-sm font-semibold text-sdc-navy">
                Job {data.job.jobId} — {data.job.jobName}
              </p>
              {split.negative.length > 0 && (
                <p role="alert" className="mb-3 rounded-lg border border-sdc-red-text/30 bg-sdc-red-bg px-3 py-2 text-sm text-sdc-red-text">
                  The applied change quotes add up to more than the grid total in {split.negative.map((s) => data.sections.find((x) => x.code === s)?.name ?? s).join(", ")}, so Original would be negative there. Someone has lowered those totals by hand — correct them on the grid.
                </p>
              )}

              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs tabular-nums">
                  <thead>
                    <tr className="bg-sdc-gray-100 text-sdc-navy">
                      <th className="sticky left-0 z-10 min-w-[9rem] bg-sdc-gray-100 px-2 py-2 text-left font-semibold">&nbsp;</th>
                      {sections.map((s) => (
                        <th key={s.code} title={`${s.name} · ${s.code}`} className="min-w-[4.2rem] border-l border-sdc-border px-1 py-2 text-center font-semibold leading-tight">
                          {s.name}
                          <div className="font-normal text-sdc-muted">{s.code}</div>
                        </th>
                      ))}
                      <th className="min-w-[4rem] border-l border-sdc-border px-2 py-2 text-center font-semibold">Hours</th>
                      <th className="min-w-[6rem] border-l border-sdc-border px-2 py-2 text-center font-semibold">Parts cost</th>
                      {data.canSeePricing && <th className="min-w-[7rem] border-l border-sdc-border px-2 py-2 text-center font-semibold">Amount</th>}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-sdc-border bg-sdc-blue-light/40 font-semibold text-sdc-navy">
                      <td className="sticky left-0 bg-sdc-blue-light px-2 py-1.5">Original</td>
                      {sections.map((s) => {
                        const o = split.bySection[s.code]?.original ?? 0;
                        return (
                          <td key={s.code} className={`border-l border-sdc-border px-1 py-1.5 text-center ${o < 0 ? "text-sdc-red-text" : ""}`}>{o === 0 ? "–" : hrs(o)}</td>
                        );
                      })}
                      <td className="border-l border-sdc-border px-2 py-1.5 text-center">{hrs(sections.reduce((a, s) => a + (split.bySection[s.code]?.original ?? 0), 0))}</td>
                      <td className={`border-l border-sdc-border px-2 py-1.5 text-center ${partsSplit.original < 0 ? "text-sdc-red-text" : ""}`}>{usd(partsSplit.original)}</td>
                      {data.canSeePricing && <td className="border-l border-sdc-border px-2 py-1.5 text-center text-sdc-muted">—</td>}
                    </tr>

                    {drafts.map((d) => {
                      const q = d.id === undefined ? undefined : quotes.find((x) => x.id === d.id);
                      const isApplied = q?.status === "Applied";
                      const server = q ? fromQuote(q) : null;
                      const dirty = server === null || !sameDraft(d, server);
                      const editable = canEdit && !isApplied;
                      const h = isApplied && q ? q.hours : draftHours(d);
                      const amountCents = parseCents(d.amount);
                      const partsCents = parseCents(d.parts);
                      const rec = reconcile(typeof amountCents === "number" ? amountCents : null, typeof partsCents === "number" ? partsCents : 0, h);
                      const rowBusy = busy !== null;
                      return (
                        <Fragment key={d.key}>
                          <tr className="border-t border-sdc-border align-middle">
                            <td className="sticky left-0 bg-white px-2 py-1.5">
                              <div className="flex items-center gap-1.5">
                                <input
                                  aria-label="Change quote label"
                                  className={`${INPUT} !h-7 !w-20 !px-2 !py-0 !text-xs font-semibold`}
                                  value={d.label}
                                  disabled={!editable}
                                  maxLength={64}
                                  onChange={(e) => patchDraft(d.key, { label: e.target.value })}
                                />
                                <span className={`rounded-full px-2 py-0.5 text-label font-semibold ${isApplied ? "bg-sdc-green-bg text-sdc-green-text" : "bg-sdc-gray-100 text-sdc-muted"}`}>
                                  {isApplied ? (q?.addedToTotals ? "Applied" : "Applied · was in totals") : d.id === undefined ? "Unsaved" : "Draft"}
                                </span>
                              </div>
                            </td>
                            {sections.map((s) => (
                              <td key={s.code} className="border-l border-sdc-border px-0.5 py-1 text-center">
                                {editable ? (
                                  <input
                                    aria-label={`${d.label} ${s.name} hours`}
                                    inputMode="numeric"
                                    className="h-7 w-full min-w-0 rounded border border-transparent bg-sdc-yellow/10 px-1 text-center outline-none focus:border-sdc-blue"
                                    value={d.hours[s.code] ?? ""}
                                    onChange={(e) => setHours(d.key, s.code, e.target.value.replace(/[^\d]/g, ""))}
                                  />
                                ) : (
                                  <span className={h[s.code] ? "text-sdc-navy" : "text-sdc-gray-400"}>{h[s.code] ? hrs(h[s.code]) : "–"}</span>
                                )}
                              </td>
                            ))}
                            <td className="border-l border-sdc-border px-2 py-1 text-center font-semibold">{hrs(totalHours(h))}</td>
                            <td className="border-l border-sdc-border px-1 py-1 text-center">
                              {editable ? (
                                <input aria-label={`${d.label} parts cost`} inputMode="decimal" className="h-7 w-24 rounded border border-transparent bg-sdc-yellow/10 px-1 text-center outline-none focus:border-sdc-blue" value={d.parts} placeholder="$0" onChange={(e) => patchDraft(d.key, { parts: e.target.value })} />
                              ) : (
                                usd(q?.partsCents ?? 0)
                              )}
                            </td>
                            {data.canSeePricing && (
                              <td className="border-l border-sdc-border px-1 py-1 text-center">
                                {editable ? (
                                  <input aria-label={`${d.label} amount`} inputMode="decimal" className="h-7 w-28 rounded border border-transparent bg-sdc-yellow/10 px-1 text-center outline-none focus:border-sdc-blue" value={d.amount} placeholder="$0" onChange={(e) => patchDraft(d.key, { amount: e.target.value })} />
                                ) : q?.amountCents != null ? (
                                  usd(q.amountCents)
                                ) : (
                                  "—"
                                )}
                              </td>
                            )}
                          </tr>
                          <tr className="bg-sdc-gray-100/40">
                            <td colSpan={gridCols} className="sticky left-0 px-2 pb-2 pt-1">
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-sdc-muted">
                                {editable ? (
                                  <>
                                    <label className="flex items-center gap-1">Date <input type="date" className={`${INPUT} !h-7 !px-2 !py-0 !text-xs`} value={d.date} onChange={(e) => patchDraft(d.key, { date: e.target.value })} /></label>
                                    <label className="flex flex-1 items-center gap-1 min-w-[14rem]">Note <input className={`${INPUT} !h-7 flex-1 !px-2 !py-0 !text-xs`} value={d.note} maxLength={255} placeholder="e.g. per CQ-4 document" onChange={(e) => patchDraft(d.key, { note: e.target.value })} /></label>
                                  </>
                                ) : (
                                  <>
                                    {d.date && <span>Dated {d.date}</span>}
                                    {d.note && <span>{d.note}</span>}
                                    {isApplied && q?.appliedAt && <span>Applied {q.appliedAt.slice(0, 10)}{q.appliedByEmail ? ` by ${q.appliedByEmail}` : ""}</span>}
                                  </>
                                )}
                                {data.canSeePricing && rec && (
                                  <span className={rec.partsExceedAmount ? "font-semibold text-sdc-red-text" : "text-sdc-navy"}>
                                    {rec.partsExceedAmount
                                      ? "Parts cost is more than the amount"
                                      : `Labor ${usd(rec.laborCents)} for ${hrs(rec.hours)} hrs${rec.ratePerHourCents !== null ? ` ≈ ${usd(rec.ratePerHourCents)}/hr` : ""}`}
                                  </span>
                                )}
                                {canEdit && (
                                  <span className="ml-auto flex flex-wrap items-center gap-1.5">
                                    {!isApplied && (
                                      <>
                                        <button type="button" className={BUTTON_SECONDARY} disabled={rowBusy || !dirty} onClick={() => act(`save-${d.key}`, () => saveChangeQuote({ jobPk: data.job.pk, id: d.id, label: d.label, note: d.note, amount: d.amount, partsCost: d.parts, quoteDate: d.date, hours: d.hours }), () => {
                                          // A newly created row now exists on the server: drop the unsaved copy, adopt() added the saved one.
                                          if (d.id === undefined) setDrafts((prev) => prev.filter((x) => x.key !== d.key));
                                        })}>
                                          {busy === `save-${d.key}` ? "Saving…" : "Save draft"}
                                        </button>
                                        {d.id !== undefined && (
                                          <>
                                            <button
                                              type="button"
                                              className={BUTTON_PRIMARY}
                                              disabled={rowBusy || dirty}
                                              title={dirty ? "Save your changes first — apply uses the saved figures" : "Add these hours and parts cost to the grid totals"}
                                              onClick={() => {
                                                if (window.confirm(`Add ${hrs(totalHours(h))} hours${q && q.partsCents > 0 ? ` and ${usd(q.partsCents)} parts cost` : ""} from ${d.label} to Job ${data.job.jobId}'s quoted totals on the grid?`)) {
                                                  void act(`apply-${d.key}`, () => applyChangeQuote({ jobPk: data.job.pk, id: d.id!, mode: "add" }));
                                                }
                                              }}
                                            >
                                              {busy === `apply-${d.key}` ? "Applying…" : "Apply to totals"}
                                            </button>
                                            <button
                                              type="button"
                                              className={BUTTON_COMPACT}
                                              disabled={rowBusy || dirty}
                                              title="These figures were already typed into the grid earlier — record this change quote without adding them again"
                                              onClick={() => {
                                                if (window.confirm(`Record ${d.label} as ALREADY included in Job ${data.job.jobId}'s grid totals? Nothing will be added to the grid.`)) {
                                                  void act(`incl-${d.key}`, () => applyChangeQuote({ jobPk: data.job.pk, id: d.id!, mode: "included" }));
                                                }
                                              }}
                                            >
                                              Already in totals
                                            </button>
                                          </>
                                        )}
                                        <button
                                          type="button"
                                          className={BUTTON_COMPACT_DANGER}
                                          disabled={rowBusy}
                                          onClick={() => {
                                            if (d.id === undefined) return setDrafts((prev) => prev.filter((x) => x.key !== d.key));
                                            if (window.confirm(`Delete draft ${d.label}?`)) void act(`del-${d.key}`, () => deleteChangeQuote({ jobPk: data.job.pk, id: d.id! }));
                                          }}
                                        >
                                          Delete
                                        </button>
                                      </>
                                    )}
                                    {isApplied && d.id !== undefined && (
                                      <button
                                        type="button"
                                        className={BUTTON_COMPACT_DANGER}
                                        disabled={rowBusy}
                                        title={q?.addedToTotals ? "Take these hours and parts cost back out of the grid totals and return this to a draft" : "Return this to a draft — the grid totals are not touched"}
                                        onClick={() => {
                                          const msg = q?.addedToTotals
                                            ? `Reverse ${d.label}? Its hours and parts cost will be SUBTRACTED from Job ${data.job.jobId}'s grid totals.`
                                            : `Return ${d.label} to a draft? The grid totals are not changed.`;
                                          if (window.confirm(msg)) void act(`rev-${d.key}`, () => reverseChangeQuote({ jobPk: data.job.pk, id: d.id! }));
                                        }}
                                      >
                                        {busy === `rev-${d.key}` ? "Reversing…" : "Reverse"}
                                      </button>
                                    )}
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        </Fragment>
                      );
                    })}

                    <tr className="border-t-2 border-sdc-border bg-sdc-gray-100 font-semibold text-sdc-navy">
                      <td className="sticky left-0 bg-sdc-gray-100 px-2 py-1.5" title="What the Projects grid holds today">Total (grid)</td>
                      {sections.map((s) => (
                        <td key={s.code} className="border-l border-sdc-border px-1 py-1.5 text-center">{data.totals[s.code] ? hrs(data.totals[s.code]) : "–"}</td>
                      ))}
                      <td className="border-l border-sdc-border px-2 py-1.5 text-center">{hrs(sections.reduce((a, s) => a + (data.totals[s.code] ?? 0), 0))}</td>
                      <td className="border-l border-sdc-border px-2 py-1.5 text-center">{data.partsTotalCents === null ? "—" : usd(data.partsTotalCents)}</td>
                      {data.canSeePricing && <td className="border-l border-sdc-border px-2 py-1.5 text-center text-sdc-muted">—</td>}
                    </tr>
                  </tbody>
                </table>
              </div>

              {data.canSeePricing && data.gridChangeQuoteCents !== null && applied.some((q) => q.amountCents !== null) && (() => {
                const sum = applied.reduce((a, q) => a + (q.amountCents ?? 0), 0);
                const matches = sum === data.gridChangeQuoteCents;
                return (
                  <p className={`mt-3 text-sm ${matches ? "text-sdc-muted" : "text-sdc-navy"}`}>
                    Applied change quotes total {usd(sum)}; the grid&apos;s Change Quote column shows {usd(data.gridChangeQuoteCents)}
                    {matches ? " — they match." : " — they differ. That column is still typed by hand; this panel doesn't change it."}
                  </p>
                );
              })()}

              {canEdit && (
                <button type="button" className={`${BUTTON_SECONDARY} mt-3`} onClick={addDraft}>
                  + New change quote
                </button>
              )}
              {drafts.length === 0 && <p className="mt-3 text-sm text-sdc-muted">No change quotes on this job yet. Original equals the grid total.</p>}
              <p className="mt-4 text-note text-sdc-muted">
                Original is the grid total minus every applied change quote. A draft is recorded but not in the totals until you apply it. &ldquo;Apply to totals&rdquo; adds the hours and parts cost to the grid;
                &ldquo;Already in totals&rdquo; is for figures that were typed into the grid by hand earlier and must not be added twice.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
