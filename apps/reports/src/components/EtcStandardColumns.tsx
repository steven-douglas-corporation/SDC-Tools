"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usd as currency, usdExact as currencyExact } from "@/components/ui/format";
import {
  calcTotalEtcDollars,
  calcPercentOfTotal,
  calcStandardFeeEngineering,
  calcStandardFeeShop,
  calcTotalStandardFees,
} from "@/lib/standard-fees";
import { saveContingencyAmount, saveJobNotes } from "@/lib/standard-sheet-actions";
import { useEtcLiveTotals } from "@/lib/etc-live-totals";
// The same store StandardFeesCard reads (§76 — "Fix Standard Sheet and Standard Fees
// Visibility"): one shared `hidden` flag is what makes the grid's columns and the card
// collapse and reappear together, rather than each keeping its own notion of visible.
import { readStandardsState, serverStandardsState, subscribeStandards } from "@/lib/standards-reveal";

// Same weight/treatment as the Monthly ETC grid's other block dividers.
const STD_EDGE = "border-l-8! border-l-[#808080]!";

// Money formatting comes from ui/format (§39.13): `usd` for whole dollars and
// `usdExact` for the cents-precision figure behind it. These were two local copies
// of both — three files had the identical pair, under the identical names.
function percent(n: number): string {
  return (n * 100).toLocaleString(undefined, { maximumFractionDigits: 2 }) + "%";
}
function num(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
export type StandardRates = { engrRate: number; shopRate: number; partsMarkup: number };

// One department pool's inputs — the two manual cells (pulled/rate) plus the
// fixed Hours Available they derive against. The provider owns pulled/rate as
// live state so editing them in the pool panel recomputes every job's Standard
// Fee on the grid instantly (Excel's cross-linked D77/D79 → job-row formulas).
export type PoolRowInput = { category: string; hoursAvailable: number; hoursPulled: number; rate: number };

export type StandardJobBase = {
  jobId: number;
  jobName: string;
  etcEngineering: number;
  etcShop: number;
  etcParts: number;
  contingencyAmount: number;
  notes: string;
};
export type PoolTotals = { engineeringPM: number; engineeringWarranty: number; shopManufacturing: number; shopWarranty: number };

type StandardComputed = {
  totalEtcDollars: number;
  percentOfTotal: number;
  standardFees: number;
  totalStandardFees: number;
};

// Frozen snapshot values for a submitted month — a plain array (serializable
// across the RSC boundary) the provider indexes by jobId. When present, the
// grid renders these instead of the live rate/pool math, so a later global-rate
// or pool edit can never mutate a locked month's numbers.
export type FrozenStandardRow = StandardComputed & { jobId: number };

type StandardGrandTotals = {
  totalEtcDollars: number;
  percentOfTotal: number;
  standardFees: number;
  contingencyAmount: number;
  totalStandardFees: number;
};

// Live per-category pool cell, exposed to the pool panel so it renders and
// edits the same state that drives the grid's job Standard Fees.
export type LivePoolCell = {
  pulled: string;
  rate: string;
  newEtcHours: number;
  standardFee: number;
  setPulled: (v: string) => void;
  setRate: (v: string) => void;
};

type Ctx = {
  getComputed: (jobId: number) => StandardComputed | undefined;
  getGrandTotals: () => StandardGrandTotals;
  // Contingency is an EDITABLE cell whose value feeds Total Standard Fees
  // (calcTotalStandardFees) and the grand total. It used to live only in the
  // input's own state, so typing into it moved nothing until the blur-save came
  // back from the server — the same stale-formula problem as the ETC totals.
  // Reporting it up here makes the column behave like the spreadsheet it mirrors.
  setLiveContingency: (jobId: number, amount: number) => void;
  editable: boolean;
  getPoolCell: (category: string) => LivePoolCell | undefined;
  getPoolTotals: () => PoolTotals;
  // True when a live pulled/rate cell differs from the saved (server-seeded)
  // value — i.e. there are pool edits the grid is showing but that "Save Pool
  // Cells" hasn't persisted yet. Submit Standard Sheet freezes from the SAVED values,
  // so it must be blocked while this is true or the frozen fees won't match
  // what's on screen.
  isPoolDirty: () => boolean;
};

const StandardRatesCtx = createContext<Ctx | null>(null);

// The ETC grid's inline "Standard Sheet" columns mirror /standard-sheet's own
// rate/fee math. Rates are now a single global set (entered via the "ETC Rates"
// toolbar button, stored on StandardSheetSetting) applied to every job here, so
// there are no per-row rate inputs — a rate change reruns the whole block
// (% Total depends on every job's Total ETC $ at once) after the server
// revalidates this page.
export function StandardRatesProvider({
  jobs,
  rates,
  poolRows,
  contingencyRate,
  frozenRows,
  editable = false,
  children,
}: {
  jobs: StandardJobBase[];
  rates: StandardRates;
  poolRows: PoolRowInput[];
  contingencyRate: number;
  frozenRows?: FrozenStandardRow[];
  editable?: boolean;
  children: React.ReactNode;
}) {
  // Live per-job ETC totals published by the grid's section cells. Subscribing
  // here rather than threading them down means only this provider re-renders on
  // a keystroke, not the ~800 cells that produced the number.
  const liveTotals = useEtcLiveTotals();

  // Contingency amounts as they are being typed, jobId -> amount. An absent entry
  // means nobody has touched that job, so the server value stands.
  const [liveContingency, setLiveContingency] = useState<Record<number, number>>({});

  // The two manual pool cells live here (seeded once from server data) so the
  // pool panel and the grid's job Standard Fees read the same live values.
  //
  // Hours being pulled is seeded ROUNDED (2026-08-02, by request): it is a
  // manual decision, the panel renders every hours figure through whole(), and
  // the cell was showing "669.02" while the New ETC Hours line beneath it
  // already displayed the rounded result — so the decimals bought precision
  // nobody could see and made the displayed hours disagree with the money.
  // `pulledBaseline` is used for the seed AND for the dirty check below, so a
  // month whose stored value still carries decimals doesn't load looking
  // unsaved; the stored value catches up on the next Save or Refresh.
  const pulledBaseline = (p: PoolRowInput) => Math.round(p.hoursPulled);
  const [pulled, setPulledState] = useState<Record<string, string>>(() =>
    Object.fromEntries(poolRows.map((p) => [p.category, String(pulledBaseline(p))]))
  );
  const [rate, setRateState] = useState<Record<string, string>>(() =>
    Object.fromEntries(poolRows.map((p) => [p.category, String(p.rate)]))
  );

  // ── Adopt pool figures another user saved (2026-08-04) ──────────────────────
  //
  // Per category, and only where this user has not diverged: a category they have
  // edited keeps their value, every other one follows the server. Without this the
  // pool panel stays frozen at page-load values while the grid beside it updates,
  // and the Standard Fee dollars derived from these two would disagree with what is
  // stored. Same clean/dirty rule as EtcSectionCells and MoneyCell.
  const serverPool = useMemo(
    () => ({
      pulled: Object.fromEntries(poolRows.map((p) => [p.category, String(pulledBaseline(p))])),
      rate: Object.fromEntries(poolRows.map((p) => [p.category, String(p.rate)])),
    }),
    [poolRows],
  );
  const [seenPool, setSeenPool] = useState(serverPool);
  if (seenPool !== serverPool) {
    const adopt = (current: Record<string, string>, seen: Record<string, string>, next: Record<string, string>) => {
      let changed = false;
      const out = { ...current };
      for (const key of Object.keys(next)) {
        if (seen[key] === next[key]) continue; // this figure did not move on the server
        if (current[key] !== seen[key]) continue; // this user diverged — keep their edit
        out[key] = next[key];
        changed = true;
      }
      return changed ? out : current;
    };
    const nextPulled = adopt(pulled, seenPool.pulled, serverPool.pulled);
    const nextRate = adopt(rate, seenPool.rate, serverPool.rate);
    setSeenPool(serverPool);
    if (nextPulled !== pulled) setPulledState(nextPulled);
    if (nextRate !== rate) setRateState(nextRate);
  }

  // Standard Fee per category = (Hours Available − Pulled) × Rate (Excel D77/D79),
  // recomputed live — this is the % Total → job Standard Fee driver.
  const poolTotals = useMemo<PoolTotals>(() => {
    const fee = (category: string) => {
      const p = poolRows.find((x) => x.category === category);
      if (!p) return 0;
      const pulledVal = num(pulled[category] ?? String(pulledBaseline(p)));
      const rateVal = num(rate[category] ?? String(p.rate));
      return (p.hoursAvailable - pulledVal) * rateVal;
    };
    return {
      engineeringPM: fee("ENGINEERING_PM"),
      engineeringWarranty: fee("ENGINEERING_WARRANTY"),
      shopManufacturing: fee("SHOP_MANUFACTURING"),
      shopWarranty: fee("SHOP_WARRANTY"),
    };
  }, [poolRows, pulled, rate]);

  const computedByJob = useMemo(() => {
    // Submitted month: render exactly the frozen snapshot rows.
    if (frozenRows) {
      const m = new Map<number, StandardComputed>();
      for (const r of frozenRows) m.set(r.jobId, { totalEtcDollars: r.totalEtcDollars, percentOfTotal: r.percentOfTotal, standardFees: r.standardFees, totalStandardFees: r.totalStandardFees });
      return m;
    }
    // Live ETC hours where the grid has published them, the server's figures
    // otherwise (2026-08-03).
    //
    // etcEngineering/etcShop/etcParts arrive as SERVER props, summed from stored
    // EtcEntry values. So this whole chain — Total ETC $, % Total, Standard Fees,
    // Total Standard Fees, and the grand totals below — was frozen at page load
    // while a manager typed New ETC values into the grid beside it. The rates and
    // pool cells recomputed live; the thing they multiply did not.
    //
    // Falls back per job rather than all-or-nothing: a job whose section cells
    // haven't mounted (filtered out, or the Standard block open on a month with no
    // grid rendered) keeps its server figure instead of collapsing to zero.
    const withTotals = jobs.map((j) => {
      const live = liveTotals.get(j.jobId);
      const engineering = live ? live.engineering.newEtc : j.etcEngineering;
      const shop = live ? live.shop.newEtc : j.etcShop;
      const parts = live?.parts ? live.parts.newEtc : j.etcParts;
      const totalEtcDollars = calcTotalEtcDollars({ engineering, shop, parts }, rates);
      return { ...j, totalEtcDollars };
    });
    const grandTotal = withTotals.reduce((sum, r) => sum + r.totalEtcDollars, 0);
    const map = new Map<number, StandardComputed>();
    for (const r of withTotals) {
      const percentOfTotal = calcPercentOfTotal(r.totalEtcDollars, grandTotal);
      const standardFeeEngineering = calcStandardFeeEngineering(percentOfTotal, poolTotals);
      const standardFeeShop = calcStandardFeeShop(percentOfTotal, poolTotals);
      // Live contingency where the cell has reported one, the server's value
      // otherwise — the cell is editable and this is what multiplies it.
      const contingency = liveContingency[r.jobId] ?? r.contingencyAmount;
      const totalStandardFees = calcTotalStandardFees(
        r.totalEtcDollars,
        standardFeeEngineering,
        standardFeeShop,
        contingency,
        contingencyRate
      );
      map.set(r.jobId, {
        totalEtcDollars: r.totalEtcDollars,
        percentOfTotal,
        standardFees: standardFeeEngineering + standardFeeShop,
        totalStandardFees,
      });
    }
    return map;
  }, [jobs, rates, poolTotals, contingencyRate, frozenRows, liveTotals, liveContingency]);

  const grandTotals = useMemo<StandardGrandTotals>(() => {
    const acc = { totalEtcDollars: 0, percentOfTotal: 0, standardFees: 0, contingencyAmount: 0, totalStandardFees: 0 };
    for (const j of jobs) {
      const c = computedByJob.get(j.jobId);
      if (!c) continue;
      acc.totalEtcDollars += c.totalEtcDollars;
      acc.percentOfTotal += c.percentOfTotal;
      acc.standardFees += c.standardFees;
      acc.contingencyAmount += liveContingency[j.jobId] ?? j.contingencyAmount;
      acc.totalStandardFees += c.totalStandardFees;
    }
    return acc;
  }, [jobs, computedByJob, liveContingency]);

  function getPoolCell(category: string): LivePoolCell | undefined {
    const p = poolRows.find((x) => x.category === category);
    if (!p) return undefined;
    const pulledStr = pulled[category] ?? String(pulledBaseline(p));
    const rateStr = rate[category] ?? String(p.rate);
    const newEtcHours = p.hoursAvailable - num(pulledStr);
    return {
      pulled: pulledStr,
      rate: rateStr,
      newEtcHours,
      standardFee: newEtcHours * num(rateStr),
      setPulled: (v: string) => setPulledState((prev) => ({ ...prev, [category]: v })),
      setRate: (v: string) => setRateState((prev) => ({ ...prev, [category]: v })),
    };
  }

  const isPoolDirty = () =>
    poolRows.some((p) => {
      const pv = num(pulled[p.category] ?? String(pulledBaseline(p)));
      const rv = num(rate[p.category] ?? String(p.rate));
      // Compared against the ROUNDED baseline, not the raw stored value —
      // otherwise every month whose pulled hours still carry decimals would
      // open already flagged "unsaved pool edits" and block Submit Standard Sheet
      // behind a Save nobody asked for.
      return pv !== pulledBaseline(p) || rv !== p.rate;
    });

  const ctx: Ctx = {
    getComputed: (jobId) => computedByJob.get(jobId),
    getGrandTotals: () => grandTotals,
    setLiveContingency: (jobId, amount) =>
      setLiveContingency((prev) => (prev[jobId] === amount ? prev : { ...prev, [jobId]: amount })),
    editable,
    getPoolCell,
    getPoolTotals: () => poolTotals,
    isPoolDirty,
  };
  return <StandardRatesCtx.Provider value={ctx}>{children}</StandardRatesCtx.Provider>;
}

// Consumed by the pool panel to disable Submit Standard Sheet while there are unsaved
// pulled/rate edits (see isPoolDirty above).
export function useStandardPoolDirty(): boolean {
  const ctx = useContext(StandardRatesCtx);
  if (!ctx) throw new Error("useStandardPoolDirty must be used inside a StandardRatesProvider");
  return ctx.isPoolDirty();
}

// Consumed by the pool panel to read/write the live pulled/rate cells.
export function useStandardPoolCell(category: string): LivePoolCell | undefined {
  const ctx = useContext(StandardRatesCtx);
  if (!ctx) throw new Error("useStandardPoolCell must be used inside a StandardRatesProvider");
  return ctx.getPoolCell(category);
}

// Consumed by the pool panel for its Engineering/Shop/Grand Total lines —
// same per-category Standard Fee math (Hours Available − Pulled) × Rate that
// drives each job's fee, just summed by billing group instead of allocated
// per job. Matches the Excel sheet's own "Engineering Total"/"Shop Total"/
// grand-total rows at the bottom of the department pool block.
export function useStandardPoolTotals(): PoolTotals {
  const ctx = useContext(StandardRatesCtx);
  if (!ctx) throw new Error("useStandardPoolTotals must be used inside a StandardRatesProvider");
  return ctx.getPoolTotals();
}

function useStandardRates(): Ctx {
  const ctx = useContext(StandardRatesCtx);
  if (!ctx) throw new Error("EtcStandardCells must be rendered inside a StandardRatesProvider");
  return ctx;
}

// One subscription, shared by every Standard Sheet consumer in this file (§76): the
// grid's per-row cells, its grand-total row, and the header wrapper below all need the
// SAME answer to "has the user hidden this", and a single hook is what guarantees they
// can never read it out of step with each other.
function useStandardsHidden(): boolean {
  return useSyncExternalStore(subscribeStandards, readStandardsState, serverStandardsState).hidden;
}

// Renders one job's Standard Sheet Fragment inside the Monthly ETC grid's
// row — reads live totals from StandardRatesProvider (driven by the global
// ETC Rates). The per-job ENGR/Shop/Parts rate columns were removed; those
// rates are now set once via the "ETC Rates" toolbar button.
export function EtcStandardCells({ job }: { job: StandardJobBase }) {
  const { getComputed, editable } = useStandardRates();
  const hidden = useStandardsHidden();
  const std = getComputed(job.jobId);
  // `hidden` collapses the row's own cells the same instant it collapses the header
  // above them (§76) — both read the same store, so there is never a render where one
  // has hidden its columns and the other has not.
  if (!std || hidden) return null;

  const cell = (edge: boolean) => `${edge ? STD_EDGE : "border-l border-sdc-border"} px-2 py-1 text-center text-label text-sdc-navy`;

  return (
    <>
      {/* Heavy gray dividers between each Standard block, matching the sheet:
          [Total ETC · % Total] | [Standard Fees] | [Contingency] | [Total Std
          Fees] | [Notes]. % Total stays thin (same block as Total ETC). */}
      <td className={`${cell(true)} bg-sdc-gray-50`} title={`${currencyExact(std.totalEtcDollars)} = (Engineering hrs × Engr Rate) + (Shop hrs × Shop Rate) + (Parts × Parts Markup)`}>
        {currency(std.totalEtcDollars)}
      </td>
      <td className={`${cell(false)} bg-sdc-gray-50`} title={`${(std.percentOfTotal * 100).toFixed(6)}% of the grand total Total ETC $`}>
        {percent(std.percentOfTotal)}
      </td>
      <td className={`${cell(true)} bg-[#D6E4F0]/40`} title={`${currencyExact(std.standardFees)} = this job's % of Total × (Engineering Pool Fee + Shop Pool Fee)`}>
        {currency(std.standardFees)}
      </td>
      <td className={cell(true)}>
        <ContingencyNotesInputs jobId={job.jobId} field="contingency" jobName={job.jobName} contingency={job.contingencyAmount} notes={job.notes} editable={editable} />
      </td>
      <td className={`${cell(true)} bg-sdc-yellow-bg/60 font-medium`} title={`${currencyExact(std.totalStandardFees)} = Total ETC $ + Standard Fees + (Contingency × Contingency Rate)`}>
        {currency(std.totalStandardFees)}
      </td>
      <td className={`${STD_EDGE} px-2 py-1 text-center text-label text-sdc-muted whitespace-nowrap`} title={job.notes}>
        <ContingencyNotesInputs jobId={job.jobId} field="notes" jobName={job.jobName} contingency={job.contingencyAmount} notes={job.notes} editable={editable} />
      </td>
    </>
  );
}

// Contingency $ and Notes are the sheet's two per-job manual columns. Each is a
// single-field autosave input (on blur) when the month is unlocked; read-only
// text otherwise.
function ContingencyNotesInputs({
  jobId,
  field,
  jobName,
  contingency,
  notes,
  editable,
}: {
  jobId: number;
  field: "contingency" | "notes";
  jobName: string;
  contingency: number;
  notes: string;
  editable: boolean;
}) {
  // Only the contingency branch uses it, but the hook has to run unconditionally.
  const { setLiveContingency } = useStandardRates();
  const initial = field === "contingency" ? (contingency ? String(contingency) : "") : notes;
  const [value, setValue] = useState(initial);
  const [focused, setFocused] = useState(false);
  const lastSaved = useRef(initial);

  // Adopt a value another user saved, unless this user has typed their own or has
  // the caret in the box (2026-08-04). Same rule as EtcSectionCells / MoneyCell —
  // this block was missed in the first pass, which would have left the Standard
  // Fees columns as the one stale patch on a page where everything else converges.
  const [serverValue, setServerValue] = useState(initial);
  if (serverValue !== initial) {
    const wasClean = value === serverValue;
    setServerValue(initial);
    if (wasClean && !focused) setValue(initial);
  }

  // `lastSaved` is what save() compares against to decide "nothing to write". It has
  // to move with an adopted value, or the next blur would re-post a figure this user
  // never touched, straight back over the person who did.
  //
  // In an effect because a ref must not be written during render. Keyed on the box
  // agreeing with the server, which is true both after an adoption and after this
  // user types the server's value back by hand — in either case there is nothing to
  // save, which is exactly what lastSaved is claiming.
  useEffect(() => {
    if (value === initial) lastSaved.current = initial;
  }, [value, initial]);

  async function save() {
    if (value === lastSaved.current) return;
    try {
      if (field === "contingency") {
        const parsed = value.trim() === "" ? 0 : Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) return;
        await saveContingencyAmount(jobId, parsed);
      } else {
        await saveJobNotes(jobId, value);
      }
      lastSaved.current = value;
    } catch {
      // Best-effort autosave; typed value stays and retries on next blur.
    }
  }

  if (!editable) {
    if (field === "contingency") return <span title={contingency ? currencyExact(contingency) : undefined}>{contingency ? currency(contingency) : "—"}</span>;
    return <>{notes || "—"}</>;
  }

  if (field === "notes") {
    return (
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        aria-label={`Notes, ${jobName}`}
        placeholder="—"
        className="w-28 border-none bg-transparent text-center text-label outline-none focus:bg-white"
      />
    );
  }

  // Contingency — plain digits while being typed, "$X,XXX" once blurred, like
  // the read-only view above. `value` itself always stays raw digits (what
  // save() parses); only the displayed string swaps on focus/blur.
  const displayValue = focused ? value : value.trim() === "" ? "" : currency(Number(value));

  return (
    <input
      type="text"
      inputMode="numeric"
      value={displayValue}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        const next = e.target.value.replace(/[^0-9]/g, "");
        setValue(next);
        // Report it up as it is typed, not on blur: Total Standard Fees and the
        // grand total are computed FROM this number, and a formula column that
        // waits for a blur-save round trip is exactly what this page was
        // criticised for. save() on blur still persists it.
        setLiveContingency(jobId, next.trim() === "" ? 0 : Number(next));
      }}
      onBlur={() => {
        setFocused(false);
        save();
      }}
      aria-label={`Contingency amount, ${jobName}`}
      placeholder="—"
      className="w-20 border-none bg-transparent text-center text-label outline-none focus:bg-white"
    />
  );
}

// The grid's grand-total row for the Standard columns — same live totals
// (summed across every job) as the per-row cells above.
//
// Each cell states the total row's background explicitly. They used to be
// transparent and rely on the <tr>'s fill; that row is now a sticky <tfoot>, and
// a transparent cell in a sticky row lets the scrolling data show through it.
export function StandardGrandCells() {
  const { getGrandTotals } = useStandardRates();
  const hidden = useStandardsHidden();
  const grand = getGrandTotals();
  if (hidden) return null;

  return (
    <>
      <td className={`${STD_EDGE} bg-sdc-gray-100 px-2 py-2.5 text-center text-label text-sdc-navy`} title={currencyExact(grand.totalEtcDollars)}>
        {currency(grand.totalEtcDollars)}
      </td>
      <td className="border-l border-sdc-border bg-sdc-gray-100 px-2 py-2.5 text-center text-label text-sdc-navy" title={`${(grand.percentOfTotal * 100).toFixed(6)}%`}>
        {percent(grand.percentOfTotal)}
      </td>
      <td className={`${STD_EDGE} bg-sdc-gray-100 px-2 py-2.5 text-center text-label text-sdc-navy`} title={currencyExact(grand.standardFees)}>
        {currency(grand.standardFees)}
      </td>
      <td className={`${STD_EDGE} bg-sdc-gray-100 px-2 py-2.5 text-center text-label text-sdc-navy`} title={grand.contingencyAmount ? currencyExact(grand.contingencyAmount) : undefined}>
        {grand.contingencyAmount ? currency(grand.contingencyAmount) : "—"}
      </td>
      <td className={`${STD_EDGE} bg-sdc-gray-100 px-2 py-2.5 text-center text-label font-semibold text-sdc-navy`} title={currencyExact(grand.totalStandardFees)}>
        {currency(grand.totalStandardFees)}
      </td>
      <td className={`${STD_EDGE} bg-sdc-gray-100 px-2 py-2.5 text-center`} />
    </>
  );
}

// ── The two header blocks, hidden in lockstep with the rows (§76) ───────────
//
// page.tsx renders these as plain server JSX — the "Standard Sheet" merged banner and
// the six leaf-column labels — because a header label needs no per-job data and was
// never worth a client component before. But EtcStandardCells now hides its OWN cells
// on `hidden`, and a header sitting above columns that have vanished from every row is a
// worse defect than the one this fixes: a "Standard Sheet" banner spanning six columns
// of nothing. Wrapping the (already server-rendered) header markup in this one client
// component — a Fragment when shown, nothing when hidden — is what keeps the header row
// and every body row losing (and regaining) the same columns on the same frame, without
// turning the header itself into something that has to compute its own data.
export function StandardHeaderVisible({ children }: { children: ReactNode }) {
  const hidden = useStandardsHidden();
  if (hidden) return null;
  return <>{children}</>;
}

// ── The "no jobs" placeholder row's colSpan, kept honest (§76) ──────────────
//
// A `<td colSpan={N}>` for the empty-grid message has to span exactly as many columns as
// are actually visible, or the cell either falls short of the table's right edge or (with
// a table that auto-sizes) reads as a stray gap. `standardsColumnCount` is 0 when
// `showStandards` was false for this render (the columns never existed at all) and
// STANDARD_LEAF_COLUMNS.length when it was true — this component's OWN job is only the
// part that can change without a server render: subtracting them back out again once the
// user hides them, same as every other Standard Sheet consumer here.
export function NoJobsMessageRow({
  baseColSpan,
  standardsColumnCount,
  message,
}: {
  /** Every column this row must span EXCEPT the Standard Sheet block. */
  baseColSpan: number;
  /** STANDARD_LEAF_COLUMNS.length when showStandards was true this render, else 0. */
  standardsColumnCount: number;
  message: string;
}) {
  const hidden = useStandardsHidden();
  return (
    <tr>
      <td colSpan={baseColSpan + (hidden ? 0 : standardsColumnCount)} className="px-4 py-5 text-center text-sdc-gray-400">
        {message}
      </td>
    </tr>
  );
}
