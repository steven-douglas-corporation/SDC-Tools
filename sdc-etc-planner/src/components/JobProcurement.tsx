"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import type { BomNode, BomPart, JobBom, PoLineGroup, Vendor } from "@/lib/job-bom";
import { isUncoveredPart, quantityReadiness } from "@/lib/job-bom-rules";
import type { PartsCostLine } from "@/lib/sync-totaleto";
import { usd, safePct } from "@/components/ui/format";
import { useToast } from "@/components/ui/Toast";
import { DragScroll } from "@/components/DragScroll";
import { normPn, attributeInvoicedWindow, type WindowAttribution } from "@/lib/parts-cost-window-attribution";
import { normalizeVendor } from "@/lib/vendor-normalize";
import { loadPartsListInvoicedInWindow } from "@/lib/hours-detail-actions";
import { sequenced } from "@/lib/request-sequence";
import { useColumnSort } from "@/components/useColumnSort";
import { SortableTh, SortableColumnHeader } from "@/components/ui/SortableHeader";
import { sortRows, type SortColumns } from "@/lib/table-sort";
import { useStableNow } from "@/lib/use-stable-now";
import {
  STATUS_ROW_BG,
  COST_BASIS_NOTE,
  isEstimatedCost,
  num,
  fmtDate,
  partStatus,
  sectionLabelFor,
  findAuthoritativePo,
  authoritativeVendorRollup,
  makePoGroup,
  flattenBomParts,
  poCellState,
  NO_PO_KEY,
  type FlatPart,
  type PoGroup,
  type DrillablePart,
  type StatusKey,
} from "@/lib/po-detail";
import { PoPanel, ReleaseBadge, SupplierAvatar, Stat, ALL_COLS, partsListSortColumns, PartRowCells, type ColKey } from "@/components/procurement/PoDetailPanel";
import { PartPoPanel } from "@/components/procurement/PartPoPanel";
import { computeRiskCards, dueMs, earliestRequired, groupPartsByPo } from "@/lib/procurement-risk";
import { FILTER_ALL, resolveFilterChoice, filterOptionValues, sanitizeStatusSelection } from "@/lib/filter-choice";

// ─────────────────────────────────────────────────────────────────────────────
// Procurement drawer — the Build Readiness "Procurement" view, ported to the
// ETC app's design tokens. Two tabs:
//   • Assemblies — the Spec-grouped readiness tree (RCVD·TOTAL / NO PO / PRICED /
//     MATERIAL $ / READINESS %) with a section subtotal per group and a dark
//     "BOM materials value" footer.
//   • Parts List — every BOM leaf part flattened (so no-PO parts appear too),
//     joined to the live PO purchase lines by part number for category /
//     purchased / invoiced / PO#, plus the Delivery-Slip + No-PO summary cards.
// Pure/SSR-safe at module scope; every `new Date()` lives inside a handler or
// useMemo (this is a client component).
// ─────────────────────────────────────────────────────────────────────────────

// Status filter options, in the order the multi-select checkbox list (and the
// old single-select dropdown before it) presents them. Default selection is
// every status except `hold` — "On hold" parts are real but usually not what
// someone reviewing the buy-list wants to see by default; they can still turn
// it on.
const STATUS_FILTER_OPTIONS: { value: StatusKey; label: string }[] = [
  { value: "received", label: "Received" },
  { value: "ordered", label: "On order" },
  { value: "soon", label: "Due soon" },
  { value: "overdue", label: "Overdue" },
  { value: "stock", label: "From stock" },
  { value: "process", label: "In process" },
  { value: "noPO", label: "Uncovered (no PO)" },
  { value: "hold", label: "On hold" },
];
const ALL_STATUS_KEYS: StatusKey[] = STATUS_FILTER_OPTIONS.map((o) => o.value);
const DEFAULT_STATUS_KEYS: StatusKey[] = ALL_STATUS_KEYS.filter((k) => k !== "hold");

// Readiness bar color: green >= 90, amber >= 60, red below (matches the
// Scheduler's _procBarColor threshold).
function barClasses(pct: number): { bar: string; text: string } {
  if (pct >= 90) return { bar: "bg-sdc-green", text: "text-sdc-green-text" };
  if (pct >= 60) return { bar: "bg-sdc-yellow", text: "text-sdc-yellow-text" };
  return { bar: "bg-sdc-red", text: "text-sdc-red-text" };
}

// `size` defaults to the original dense "sm" the Assemblies tree's per-row bars
// still use (unchanged); "lg" is only for the Procurement header's Readiness
// summary (2026-08-14, by request — "too small and hard to read... should
// look like an important summary element, not a tiny secondary detail"), a
// thicker track and a headline-sized percentage rather than a scaled-up copy
// of the row bar.
function ReadinessBar({ pct, width = "w-full", size = "sm" }: { pct: number; width?: string; size?: "sm" | "lg" }) {
  // ── Nothing here may render `NaN%` (2026-09-04) ──────────────────────────
  //
  // The `NaN%` reported on this bar was caused upstream — a missing `receivedQty`
  // poisoning the numerator, see lib/job-bom-rules.ts — and that is where it is fixed.
  // This is the second line of defence, and it earns its place: `pct` is a plain
  // `number`, which in TypeScript includes NaN and Infinity, so the type says nothing
  // about whether this component can be trusted with it. The bar already clamped its
  // WIDTH and printed the raw value beside it, which is exactly how a broken number
  // reached the screen while the bar itself looked fine.
  //
  // `safePct` is shared (components/ui/format.ts) so every bar and pill in the app
  // clamps identically — a second copy here is how one of them ends up not doing it.
  const shown = safePct(pct);
  const { bar, text } = barClasses(shown);
  const lg = size === "lg";
  return (
    <div className={`flex items-center ${lg ? "gap-3" : "gap-2"} ${width}`} title={`${shown}% ready`}>
      <div className={`${lg ? "h-3" : "h-1.5"} flex-1 overflow-hidden rounded-full bg-sdc-gray-100`}>
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${shown}%` }} />
      </div>
      <span className={`${lg ? "w-16 text-2xl" : "w-9 text-note"} shrink-0 text-right font-bold tabular-nums ${text}`}>
        {shown}%
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Persisted UI state
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = "sdc-etc-proc-state";

/**
 * Which date the From/To range filters on.
 *
 * Named rather than written out inline, which is what it was in five places
 * (PersistedState, the useState, the PartsListTab prop pair, and the Segmented's
 * onChange cast) — adding "delivered" to a fifth copy is exactly how a filter
 * ends up accepting a value one of its own call sites cannot express.
 *
 * "delivered" reads FlatPart.receivedDate, the same field the Delivered Date
 * column shows, so "what actually landed in August" and the column that answers
 * it can never disagree.
 */
type PartsDateFilter = "purchase" | "invoice" | "req" | "exp" | "delivered";

type PersistedState = {
  tab: "assemblies" | "parts";
  view: "list" | "card";
  query: string;
  status: StatusKey[];
  category: string;
  manufacturer: string;
  supplier: string;
  dateType: PartsDateFilter;
  from: string;
  to: string;
  upcomingWeek: number;
  hiddenPartCols: ColKey[];
  /** One-shot marker: the Left to Invoice column has been revealed once (see below). */
  leftToInvoiceShown?: boolean;
  colWidths: Partial<Record<ColKey, number>>;
};

function loadPersisted(): Partial<PersistedState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function JobProcurement({ bom, partsLines }: { bom: JobBom; partsLines: PartsCostLine[] }) {
  const { toast } = useToast();
  const saved = useMemo(() => loadPersisted(), []);

  const [tab, setTab] = useState<"assemblies" | "parts">(() => saved.tab ?? "assemblies");

  // Parts List filter/view state lives here (not in PartsListTab) so a drill
  // from the Assemblies tab can reset every filter + force table mode before
  // the Parts List even mounts, guaranteeing the target row renders. All of it
  // is persisted to localStorage (see the effect below).
  const [view, setView] = useState<"list" | "card">(() => saved.view ?? "list");
  const [query, setQuery] = useState(() => saved.query ?? "");
  // Restored through sanitizeStatusSelection, not straight from storage: a stored key
  // that no longer exists matches no row, and a stored selection that has emptied out
  // means "hide every BOM part" — both of which arrive looking like a normal default.
  // An empty selection a user builds in front of themselves is still honoured; this is
  // the restore path only.
  const [status, setStatus] = useState<Set<StatusKey>>(
    () => new Set(sanitizeStatusSelection(saved.status, ALL_STATUS_KEYS, DEFAULT_STATUS_KEYS)),
  );
  // These three are persisted for the whole app rather than per job (one STORAGE_KEY),
  // so what is restored here may name a category/vendor the job in front of us has
  // never had. That is NOT resolved here — it is resolved against the live option list
  // in PartsList, where both the predicate and the <select> read the same answer. See
  // lib/filter-choice.ts for what went wrong when only one of them did.
  const [category, setCategory] = useState(() => saved.category ?? FILTER_ALL);
  const [manufacturer, setManufacturer] = useState(() => saved.manufacturer ?? FILTER_ALL);
  const [supplier, setSupplier] = useState(() => saved.supplier ?? FILTER_ALL);
  const [dateType, setDateType] = useState<PartsDateFilter>(() => saved.dateType ?? "purchase");
  const [from, setFrom] = useState(() => saved.from ?? "");
  const [to, setTo] = useState(() => saved.to ?? "");
  // Default hidden columns (fresh users; anyone with a stored set keeps theirs).
  // ── Why a stored set gets one forced correction (2026-09-02) ──────────────
  //
  // `saved.hiddenPartCols` wins over DEFAULT_HIDDEN_COLS, which is right — a user
  // who arranged their columns should keep them. But it means anyone who has EVER
  // opened the Columns menu has "leftspend" written into their stored set from when
  // it was hidden by default, so simply dropping it from the defaults would ship
  // Left to Invoice to new users only, and to nobody who actually uses this table.
  //
  // So the column is unhidden once, per browser, and the marker below records that
  // it has happened. Hiding it again afterwards sticks: this cannot run twice.
  // ── Which population the table is showing (2026-09-02) ────────────────────
  //
  // "all" is the default and is the honest one: it is the job's whole purchase
  // population, and its footer equals the Parts Cost card. The other two exist
  // because "just the BOM" and "just the charges that are not BOM parts" are both
  // real questions — not because either is the true list.
  const [scope, setScope] = useState<"all" | "bom" | "nonbom">("all");
  const [hidden, setHidden] = useState<Set<ColKey>>(() => {
    const stored = saved.hiddenPartCols;
    if (!stored) return new Set(DEFAULT_HIDDEN_COLS);
    if (saved.leftToInvoiceShown) return new Set(stored);
    return new Set(stored.filter((k) => k !== "leftspend"));
  });
  const [upcomingWeek, setUpcomingWeek] = useState<number>(() => saved.upcomingWeek ?? 1);
  // Shared by the risk cards mounted below and passed down unchanged — one
  // clock for the whole drawer, so a card and a table row cannot disagree about
  // what "overdue" means mid-render.
  const now = useStableNow();
  const [colWidths, setColWidths] = useState<Partial<Record<ColKey, number>>>(() => saved.colWidths ?? {});

  // Persist everything under one key.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const data: PersistedState = { tab, view, query, status: [...status], category, manufacturer, supplier, dateType, from, to, upcomingWeek, hiddenPartCols: [...hidden], leftToInvoiceShown: true, colWidths };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* quota / disabled — non-fatal */
    }
  }, [tab, view, query, status, category, manufacturer, supplier, dateType, from, to, upcomingWeek, hidden, colWidths]);

  // Drill target — key = String(part.id). `nonce` bumps on every drill so the
  // Parts List effect re-fires even when the same row is targeted twice.
  const [drill, setDrill] = useState<{ key: string; nonce: number }>({ key: "", nonce: 0 });

  // PO detail — the right-side sliding panel. null = closed. `authoritative` is
  // the matched real PO line-group (undefined → panel falls back to BOM rows).
  const [poPanel, setPoPanel] = useState<{ supplier: string; po: PoGroup; authoritative?: PoLineGroup } | null>(null);

  // Part detail — the right-side panel behind a Parts List part number. Holds
  // the part id, not the FlatPart: `parts` is rebuilt whenever the window
  // attribution or the BOM changes, and a captured object would leave the panel
  // showing figures the table no longer agrees with. Resolved against the live
  // list on every render below.
  const [partPanelId, setPartPanelId] = useState<number | null>(null);

  // The primary click action anywhere a part is shown: jump to its Parts-List
  // row (table mode, filters cleared, then scroll+flash) and copy the part #.
  const drillToPart = useCallback(
    (p: DrillablePart) => {
      setStatus(() => new Set(ALL_STATUS_KEYS));
      setCategory(FILTER_ALL);
      setManufacturer(FILTER_ALL);
      setSupplier(FILTER_ALL);
      setQuery("");
      setFrom("");
      setTo("");
      setDateType("purchase");
      setView("list");
      setTab("parts");
      setDrill((d) => ({ key: String(p.id), nonce: d.nonce + 1 }));
      if (p.pn && p.pn !== "—") {
        navigator.clipboard?.writeText(p.pn).then(() => toast(`Copied ${p.pn}`, "success")).catch(() => {});
      }
    },
    [toast],
  );

  // Jump from a risk card's Part No (Group By = Part) straight to that
  // part's own row in the Parts List — WITHOUT touching any filter, search,
  // sort or column state, unlike drillToPart above (whose whole job is
  // guaranteeing the target renders by clearing everything that could hide
  // it). `p.id` already IS the stable identity this needs — job + part +
  // assembly/line, baked into the BOM row's own database id (job-bom-rules.ts
  // dedupes its "unique procurement requirement" by this same id) — so two
  // rows sharing a part number can never resolve to each other. If an active
  // filter is hiding the target row, PartsListTab's own drill effect detects
  // that (the row simply won't be in the DOM) and surfaces it via a toast
  // instead of silently doing nothing or quietly changing the user's filters.
  const jumpToPartRow = useCallback((p: DrillablePart) => {
    setTab("parts");
    setView("list");
    setDrill((d) => ({ key: String(p.id), nonce: d.nonce + 1 }));
  }, []);

  // Copy any string to the clipboard with a toast — reused by the PO-number
  // buttons (part numbers use drillToPart, which also copies).
  const copyText = useCallback(
    (text: string, label?: string) => {
      if (!text) return;
      navigator.clipboard?.writeText(text).then(() => toast(`Copied ${label ?? text}`, "success")).catch(() => {});
    },
    [toast],
  );

  const clearFilters = useCallback(() => {
    setStatus(() => new Set(DEFAULT_STATUS_KEYS));
    setCategory(FILTER_ALL);
    setManufacturer(FILTER_ALL);
    setSupplier(FILTER_ALL);
    setQuery("");
    setDateType("purchase");
    setFrom("");
    setTo("");
  }, []);

  const partsState = { view, setView, query, setQuery, status, setStatus, category, setCategory, manufacturer, setManufacturer, supplier, setSupplier, dateType, setDateType, from, setFrom, to, setTo, hidden, setHidden, upcomingWeek, setUpcomingWeek, colWidths, setColWidths, clearFilters } as const;

  // Every normalized part number in the CURRENT BOM tree — independent of
  // partsLines (which comes from TotalETO's purchasing data, not the
  // BOM). Needed so attributeInvoicedWindow can tell "a real invoiced line
  // whose part isn't in this job's BOM at all" apart from "a real BOM part
  // with zero invoice activity in the window" — found live (job 1142, July
  // 2026): nine AP lines (several "Shipping" line items, a corrosion
  // inhibitor, cable-tie mounts...) resolve to a part number, just not one
  // that's in the BOM — without this set that money would sit in
  // byPartNumber under a key no row ever looks up, missing from both a part
  // row and the reconciliation footer.
  const bomPartNumbers = useMemo(() => {
    const set = new Set<string>();
    const walk = (node: BomNode) => {
      for (const p of node.parts) set.add(normPn(p.pn));
      for (const c of node.children) walk(c);
    };
    for (const section of bom.roots) {
      for (const p of section.parts) set.add(normPn(p.pn));
      walk(section);
    }
    return set;
  }, [bom]);

  // ── Window-scoped invoiced totals for "Invoiced" + a date range ────────────
  //
  // Fetched on demand (not with the page) — the SAME lazy-drill judgement
  // hours-detail-actions.ts's own sibling actions already make, and for the
  // same reason: this hits the live TotalETO connection, which has a
  // documented multi-minute failure mode (see job-hours/page.tsx's own
  // withTimeoutOrNull commentary), and most visits to this tab never touch
  // the date filter at all.
  //
  // `windowResult` caches only the MOST RECENTLY resolved window. Keyed by
  // job + exact from/to so a job switch (JobProcurement is not remounted on
  // one — page.tsx doesn't `key=` it, unlike AssembliesTab's own
  // `key={bom.jobId}`) or any change to the range invalidates it rather than
  // silently reusing a stale answer.
  const [pendingWindow, startWindowFetch] = useTransition();
  const [windowResult, setWindowResult] = useState<{ jobId: string; from: string; to: string; attribution: WindowAttribution } | null>(null);
  const [windowError, setWindowError] = useState<string | null>(null);

  useEffect(() => {
    if (dateType !== "invoice" || (!from && !to)) return;
    const jobId = bom.jobId;
    const key = `${jobId}::${from}::${to}`;
    if (windowResult && `${windowResult.jobId}::${windowResult.from}::${windowResult.to}` === key) return; // already resolved
    startWindowFetch(async () => {
      const out = await sequenced("parts-list-window", key, () => loadPartsListInvoicedInWindow(jobId, from, to));
      if (out.ok) {
        setWindowResult({ jobId, from, to, attribution: attributeInvoicedWindow(out.value.lines, bomPartNumbers) });
        setWindowError(null);
      } else if (out.reason === "error") {
        setWindowError(out.error instanceof Error ? out.error.message : "Could not load invoiced totals for this range.");
      }
    });
  }, [dateType, from, to, bom.jobId, windowResult, bomPartNumbers]);

  // The resolved attribution to actually USE right now — null covers every
  // case that must fall back to lifetime figures: Purchase mode, Invoiced
  // mode with no range, still loading, a failed/timed-out fetch, or a cached
  // result that no longer matches the current job/from/to (a range or job
  // changed since it resolved). Never applies a stale or wrong-job result.
  const activeAttribution: WindowAttribution | null =
    dateType === "invoice" && (from || to) && windowResult && windowResult.jobId === bom.jobId && windowResult.from === from && windowResult.to === to
      ? windowResult.attribution
      : null;
  const windowRequested = dateType === "invoice" && Boolean(from || to);

  // Every BOM leaf part flattened + enriched + deduped by part id, so this is a
  // true procurement buy-list (each physical part once) — the source for the
  // Parts List table, the two summary cards, and the top readiness line.
  // (lib/po-detail.ts — shared with the Build Readiness PO drawer, which
  // fetches its own bom/partsLines for a single PO via a Server Action rather
  // than rendering this whole component.)
  const parts = useMemo<FlatPart[]>(() => flattenBomParts(bom, partsLines, activeAttribution), [bom, partsLines, activeAttribution]);
  const partPanelPart = useMemo(
    () => (partPanelId === null ? null : (parts.find((p) => p.id === partPanelId) ?? null)),
    [parts, partPanelId],
  );

  // ── The one number that closes the gap to the Parts Cost card ─────────────
  //
  // This table is the BOM. Its money columns now carry every PO line a BOM part has
  // (2026-09-02) — but a job also has PO lines for part numbers that are on no BOM
  // row at all: freight, tariffs, credit-card and miscellaneous purchases, parts
  // bought for a revision the BOM no longer shows. Measured on job 1101: $88,642 of
  // $791,609, across 51 part numbers the BOM does not carry.
  //
  // Before this, that money was simply absent and nothing said so, which is how the
  // footer came to read $290,266 beside a card reading $730,483 with no way to tell
  // whether either was wrong. Stating it turns the difference into an equation the
  // reader can check:
  //
  //     BOM rows + unmatched PO lines = the job's lifetime figure
  //
  // Computed over the UNFILTERED parts (and every line), because it describes the
  // job, not the current view — a supplier filter must not change what "unmatched"
  // means. `actualAmount`, not `invoicedAmount`: the GL-posted basis the card uses.
  const scopedParts = useMemo(
    () => (scope === "all" ? parts : parts.filter((p) => (scope === "nonbom" ? p.nonBom : !p.nonBom))),
    [parts, scope],
  );

  const reconcile = useMemo(() => {
    let jobTotal = 0;
    let jobInvoiced = 0;
    for (const l of partsLines ?? []) {
      jobTotal += l.totalPrice;
      jobInvoiced += l.actualAmount;
    }
    // Only the total is needed here; the invoiced side of the same loop was
    // accumulated and never read, which is what the unused-var warning was about.
    let matchedTotal = 0;
    for (const p of parts) matchedTotal += p.totalPrice;
    const nonBom = parts.filter((p) => p.nonBom);
    // BOM parts with nothing bought against them yet are priced from the BOM
    // (unit x qty), not from a purchase line — so they must come OUT before the
    // table's total is compared against the job's PO spend, or the comparison is
    // estimate-versus-actual wearing one label. Job 1101: $3,630 of them.
    const estimated = parts
      .filter((p) => p.matchReason === "no-purchase")
      .reduce((sum, p) => sum + p.totalPrice, 0);
    const nonBomTotal = nonBom.reduce((sum, p) => sum + p.totalPrice, 0);
    return {
      jobTotal,
      jobInvoiced,
      estimated,
      // ── The BOM side, stated rather than left to be subtracted (2026-09-03) ──
      //
      // The footer used to name only the non-BOM half and the job total, leaving
      // "so how much IS the BOM, then" as arithmetic for the reader. Both halves
      // are now stated, so the equation on the strip is one the eye can check.
      //
      // `allRows` and `bomRows` count the job's OWN rows — every row the table
      // would draw with no filter and no scope chip — because the footer's second
      // line is a job-level reconciliation and must not move when a supplier
      // filter changes what is on screen. The visible-row counts are computed
      // separately, in the table view, from the rows it actually renders.
      allRows: parts.length,
      bomRows: parts.length - nonBom.length,
      // Purchase money on BOM rows: their total MINUS the estimate-priced ones.
      // This is the term that actually adds up — a BOM part with nothing bought
      // against it is priced unit x qty from the BOM, so leaving it in would make
      // "BOM + non-BOM = job total" overshoot by exactly `estimated` (job 1101:
      // $3,630) and print an equation that visibly does not balance. Same
      // subtraction `unexplained` below already makes; named here so the strip can
      // show the two addends and their sum without doing it a second way.
      bomPurchased: parts.reduce((sum, p) => sum + p.totalPrice, 0) - nonBomTotal - estimated,
      nonBomRows: nonBom.length,
      nonBomTotal,
      nonBomInvoiced: nonBom.reduce((sum, p) => sum + p.invoicedAmount, 0),
      // What the rows on screen do NOT account for. Should be zero now that every
      // purchase line becomes a row — surfaced rather than assumed, because "the
      // total matches" is a claim this footer should be able to prove each render.
      unexplained: jobTotal - (matchedTotal - estimated),
    };
  }, [parts, partsLines]);

  // Top summary line. `noPO` is a real procurement gap — nothing purchased,
  // nothing pulled from stock, no process schedule — and is counted separately
  // from the parts that are covered without a PO, which get their own figure so
  // the difference is visible rather than hidden inside one number.
  // `pct` is quantity-weighted (job-bom-rules.ts's quantityReadiness) — the
  // exact same function+dedup Build Readiness's own project-level
  // overallReadinessPct uses (build-readiness-sync.ts), so this job's number
  // here and on the Build Readiness main table can never disagree.
  const summary = useMemo(() => {
    const total = parts.length;
    const received = parts.filter((p) => p.st.key === "received").length;
    const noPO = parts.filter(isUncoveredPart).length;
    const covered = parts.filter((p) => p.source === "stock" || p.source === "process").length;
    // ── Readiness is over BOM REQUIREMENTS, not over every row ────────────────
    //
    // Non-BOM rows are purchase lines with no BOM requirement behind them, so they are
    // not something that can be "not ready" — they are already bought. Counting them as
    // required-but-unreceived dragged the percentage down against a denominator that
    // was never a requirement, and it also broke the agreement this figure is supposed
    // to keep: Build Readiness's own project-level number comes from `statsForRoots`,
    // which walks BOM rows only.
    //
    // Measured from the same `parts` array the counts beside it come from, so the
    // percentage and the "628 parts · 4 uncovered" line can never be computed from
    // different data.
    const requirements = parts.filter((p) => !p.nonBom);
    const readiness = quantityReadiness(requirements);
    // `counted` is 0 when nothing carried a requirement — a job with only non-BOM
    // purchases, or a BOM still loading. That is "nothing to measure", which the line
    // says in words rather than reporting a confident 0%.
    return {
      total,
      received,
      noPO,
      covered,
      pct: readiness.pct,
      measurable: readiness.counted > 0,
    };
  }, [parts]);

  const assembliesCount = useMemo(
    () => bom.roots.reduce((s, sec) => s + sec.nestedAssemblies, 0),
    [bom],
  );

  // Open the PO side panel for a supplier + PO number, gathering that PO's parts
  // from the full (unfiltered) buy-list so the panel is always complete.
  const openPoFor = useCallback(
    (sup: string | null, poNumber: string | null) => {
      const supKey = sup ?? "Unknown supplier";
      const poKey = poNumber ?? NO_PO_KEY;
      const poParts = parts.filter((p) => (p.supplier ?? "Unknown supplier") === supKey && (p.poNumber ?? NO_PO_KEY) === poKey);
      if (!poParts.length) return;
      const authoritative = findAuthoritativePo(bom.vendors, poNumber);
      setPoPanel({ supplier: supKey, po: makePoGroup(poKey, poParts), authoritative });
    },
    [parts, bom.vendors],
  );

  // Open the PO side panel from an ALREADY-BUILT PoGroup, rather than
  // re-deriving its parts from `poNumber ?? NO_PO_KEY` the way openPoFor does
  // (2026-08-14, found live: the risk cards' own "No Purchase Order" group is
  // NOT "every part with no PO for this supplier" — it's isUncoveredPart's
  // narrower "no PO AND not stock/process-covered AND not on hold" — so
  // re-deriving via a bare supplier+null-PO match pulled in stock/process/
  // hold parts the card never counted, and the drawer opened showing 6 parts
  // for a card row that said 1). The risk cards already hold the exact,
  // correctly-filtered PoGroup they rendered the row from; handing it
  // straight to the panel is the only way "card count" and "drawer count"
  // can never drift apart, regardless of what a future eligibility rule
  // changes on any one card. Delivery Slip/Upcoming route through this too,
  // not just No PO — their own eligibility happens to agree with a raw
  // poNumber match today, but that agreement is incidental, not guaranteed.
  const openPoGroup = useCallback(
    (sup: string, po: PoGroup) => {
      const authoritative = findAuthoritativePo(bom.vendors, po.poNumber);
      setPoPanel({ supplier: sup, po, authoritative });
    },
    [bom.vendors],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Top readiness summary line — sized up (2026-08-14, by request) to read
          as the important summary it is, not a secondary detail: a larger
          label, a headline-sized percentage on a thicker bar (ReadinessBar's
          size="lg"), and bigger counts text, with more breathing room in the
          card itself. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border border-sdc-border bg-white px-5 py-4 shadow-sm">
        <span className="text-sm font-bold uppercase tracking-wider text-sdc-gray-400">Readiness</span>
        <div className="w-56">
          {summary.measurable ? (
            <ReadinessBar pct={summary.pct} size="lg" />
          ) : (
            // Nothing carried a BOM requirement, so there is no ratio to report. Saying
            // so beats a confident 0%, which reads as "nothing is ready".
            <span className="text-base text-sdc-muted" title="No BOM requirement on this job yet, so there is nothing to measure readiness against.">
              Not yet measurable
            </span>
          )}
        </div>
        <span className="text-base text-sdc-gray-600">
          <span className="font-semibold text-sdc-navy tabular-nums" title="Unique procurement requirements. An assembly released as “Assembly Only” counts once, as itself — its subcomponents are bought with it and are not counted separately.">{num(summary.total)}</span> parts
          {" · "}
          <span className={summary.noPO ? "font-semibold text-sdc-red-text tabular-nums" : "tabular-nums"} title="Not covered by anything: no purchase order, no inventory pull and no process schedule.">
            {num(summary.noPO)}
          </span>{" "}
          uncovered
          {summary.covered > 0 && (
            <>
              {" · "}
              <span className="font-semibold text-sdc-navy tabular-nums" title="Covered without a purchase order — pulled from inventory or built in-house on an ETO process schedule.">
                {num(summary.covered)}
              </span>{" "}
              stock/in-house
            </>
          )}
          {" · "}
          <span className="font-semibold text-sdc-navy tabular-nums" title="Material cost across every requirement. Priced off this job's PO lines where they exist, otherwise the inventory pull price, the BOM line cost or the item master's last purchased price.">{usd(bom.grandTotalCost)}</span> materials
        </span>
      </div>

      {/* ── Delivery Slip · No Purchase Order · Upcoming Deliveries ─────────
          Mounted HERE — below the readiness summary, above the tab chips — so
          the Assemblies view shows them too. They used to live inside
          PartsListTab, which is why they vanished when you switched to
          Assemblies.

          Deliberately the SAME MOUNTED INSTANCE for both tabs rather than one
          per tab: same `parts` array, same RiskCards, same `upcomingWeek`
          state (already lifted to this component). The two views cannot report
          different counts because there is only one card row, and the week
          picker keeps its selection when you switch tabs instead of resetting.

          The "No Purchase Order" figure it shows is isUncoveredPart's, via
          computeRiskCards — the same rule as the readiness line directly above
          it and the Parts List's own "Uncovered (no PO)" filter. */}
      {/* BOM parts only: these cards are about delivery readiness, and a freight
          charge or a tariff has no delivery state to be at risk. */}
      <RiskCards
        parts={useMemo(() => parts.filter((p) => !p.nonBom), [parts])}
        onOpenPoGroup={openPoGroup}
        onJumpToPart={jumpToPartRow}
        now={now}
        upcomingWeek={upcomingWeek}
        setUpcomingWeek={setUpcomingWeek}
      />

      {/* Tab chips */}
      <div className="flex items-center gap-2">
        <TabChip active={tab === "assemblies"} onClick={() => setTab("assemblies")} label="Assemblies" count={assembliesCount} />
        <TabChip active={tab === "parts"} onClick={() => setTab("parts")} label="Parts List" count={parts.length} />
      </div>

      {tab === "assemblies" ? (
        // §53: `key={bom.jobId}` forces a fresh mount — and so a fresh
        // collapsed-by-default state — when the selected job changes. Without
        // it, switching jobs updates `bom` on the SAME AssembliesTab instance
        // (same position in the tree, no type change), so its `collapsed`
        // state's lazy useState initializer never re-runs; the old job's
        // Set<string> of collapsed keys survives and matches none of the new
        // job's node keys, so every row in the newly selected job renders
        // expanded. Procurement only ever renders for a single job (the
        // isMulti branch above skips it entirely), so jobId alone identifies
        // "is this a different tree" — no separate reset effect needed.
        <AssembliesTab key={bom.jobId} bom={bom} onPartClick={drillToPart} onOpenPo={openPoFor} />
      ) : (
        <PartsListTab
          parts={scopedParts}
          scope={scope}
          setScope={setScope}
          allParts={parts}
          reconcile={reconcile}
          state={partsState}
          drill={drill}
          vendors={bom.vendors}
          onOpenPart={(p) => setPartPanelId(p.id)}
          onCopy={copyText}
          onOpenPo={openPoFor}
          windowStatus={{
            requested: windowRequested,
            pending: pendingWindow,
            error: windowError,
            active: activeAttribution !== null,
            unattachedAmount: activeAttribution?.unattachedAmount ?? 0,
            unattachedCount: activeAttribution?.unattachedCount ?? 0,
          }}
        />
      )}

      {poPanel && (
        <PoPanel
          supplier={poPanel.supplier}
          po={poPanel.po}
          authoritative={poPanel.authoritative}
          onClose={() => setPoPanel(null)}
          onPartClick={drillToPart}
          onOpenPo={openPoFor}
        />
      )}

      {/* Resolved from `parts` by id rather than held as an object: the list is
          rebuilt whenever the invoiced window resolves, so a captured FlatPart
          would go on showing figures the table behind it had already replaced.
          A missing id renders nothing, which is the right answer if the part
          stopped existing. */}
      {partPanelPart && (
        <PartPoPanel
          part={partPanelPart}
          onClose={() => setPartPanelId(null)}
          onOpenPo={openPoFor}
          windowActive={activeAttribution !== null}
        />
      )}
    </div>
  );
}

function TabChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-lg border px-3.5 h-9 text-sm font-semibold motion-interactive ${
        active
          ? "border-sdc-blue bg-sdc-blue-light text-sdc-blue-dark"
          : "border-sdc-border bg-white text-sdc-gray-600 hover:bg-sdc-blue-light"
      }`}
    >
      {label}
      <span
        className={`inline-flex min-w-[1.5rem] items-center justify-center rounded px-1.5 py-0.5 text-note font-bold tabular-nums ${
          active ? "bg-white/70 text-sdc-blue-dark" : "bg-sdc-gray-100 text-sdc-gray-600"
        }`}
      >
        {num(count)}
      </span>
    </button>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Assemblies tab
// ═════════════════════════════════════════════════════════════════════════════

// Grid template shared by every assembly row (Scheduler layout):
// Assembly · Desc · Priced · Rcvd/Total · Material $ · Readiness
// The ASSEMBLY rows still carry no header — each cell is labelled in place or
// self-evident. The part list nested inside them does have one (see PartsDetailTable).
//
// The part-number column is sized to its CONTENT (max-content), not given a
// share of the free space. As a 1.5fr column it grew with the window, so on a
// wide screen the number sat at the far left and its description started a
// third of the way across the page — you had to track a line of whitespace to
// see which name belonged to which number. Content-sizing pulls the description
// up against the number it describes and hands the slack to the description
// instead, where a long assembly name can use it.
const ASM_GRID = "minmax(200px,max-content) minmax(260px,3fr) 92px 72px 108px 150px";

function AssembliesTab({ bom, onPartClick, onOpenPo }: { bom: JobBom; onPartClick: (p: DrillablePart) => void; onOpenPo: (supplier: string | null, poNumber: string | null) => void }) {
  const now = useStableNow();
  // Every assembly node key — for Expand/Collapse All + collapsed-by-default.
  //
  // ── The section's own loose parts get a key too ─────────────────────────
  //
  // `section.parts` (job-bom.ts: the flattened-away top node's own direct parts —
  // "no parent sub-assembly") used to render unconditionally below the section's
  // assembly list, with no header, no caret and no membership in `collapsed` at
  // all — so a section with 40 loose parts showed all 40 the moment the page
  // loaded, collapse-by-default or not. `loosePartsKey` gives that block the same
  // kind of key an assembly has, so it collapses, expands, and joins Expand
  // All/Collapse All exactly like every other row.
  const { pricedByKey, allKeys } = useMemo(() => {
    const priced = new Map<string, { priced: number; total: number }>();
    const keys = new Set<string>();
    const leavesOf = (node: BomNode): BomPart[] => {
      const byId = new Map<number, BomPart>();
      const walk = (n: BomNode) => {
        // `n.self` is the assembly's OWN buy line, set only for "Both Assembly
        // and Contents" — a real requirement that lives on the node rather than
        // in `parts`, so every traversal has to pick it up or it vanishes from
        // the counts while still being in the cost rollup.
        if (n.self && !byId.has(n.self.id)) byId.set(n.self.id, n.self);
        for (const p of n.parts) if (!byId.has(p.id)) byId.set(p.id, p);
        for (const c of n.children) walk(c);
      };
      walk(node);
      return [...byId.values()];
    };
    const visit = (n: BomNode) => {
      keys.add(n.key);
      const leaves = leavesOf(n);
      priced.set(n.key, { priced: leaves.filter((p) => p.unitPrice > 0).length, total: leaves.length });
      n.children.forEach(visit);
    };
    bom.roots.forEach((sec) => {
      sec.children.forEach(visit);
      if (sec.parts.length > 0) keys.add(loosePartsKey(sec));
    });
    return { pricedByKey: priced, allKeys: keys };
  }, [bom]);

  // Collapsed-by-default: start with every assembly collapsed. This lazy
  // initializer only runs once per MOUNT (§53) — the caller keys this
  // component on `bom.jobId` so a job switch remounts it and re-collapses,
  // rather than reusing a stale Set of the previous job's node keys.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(allKeys));
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const ghostBtn =
    "rounded-md border border-sdc-border bg-white px-2.5 py-1 text-xs font-medium text-sdc-navy hover:bg-sdc-blue-light";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setCollapsed(new Set())} className={ghostBtn}>Expand All</button>
        <button type="button" onClick={() => setCollapsed(new Set(allKeys))} className={ghostBtn}>Collapse All</button>
      </div>

      {/* 1.01, up from 0.78 (2026-08-14, by request — "increase vertical height
          ~30%") — the extra room goes straight to more visible rows before this
          scrolls, since it's a max-height on the scroll container, not padding. */}
      <DragScroll scrollKey="assemblies-tree" className="max-h-[calc(var(--app-vh)_*_1.01)] overflow-auto styled-scrollbar rounded-xl border border-sdc-border bg-white shadow-sm">
        <div className="min-w-[846px]">
          {bom.roots.map((section) => (
            <div key={section.key}>
              {/* Section header. It used to be a light grey band that read as
                  just another row — on a 128-assembly tree you scrolled past a
                  section boundary without noticing and lost track of where you
                  were. Three things fix that, and they work together:
                    • STICKY. The section you're inside stays pinned at the top
                      of the scroll container, so the answer to "which section is
                      this?" is always on screen instead of somewhere above.
                    • Heavy rules above and below, and navy uppercase text, so
                      the break is unmissable when you scroll past it.
                    • The section's contents are indented beneath it (below), so
                      the title overhangs everything it contains on the left edge
                      — the outline reads as a hierarchy rather than a flat list.
                  z-[2] matches the sticky footer; the parts tables inside carry
                  no sticky header of their own, so nothing competes. */}
              <div className="sticky top-0 z-[2] flex items-center justify-between gap-2 border-y-2 border-sdc-navy bg-sdc-blue-light px-4 py-2 shadow-sm">
                <span className="text-sm font-bold uppercase tracking-wide text-sdc-navy">{sectionLabelFor(section)}</span>
                <span className="whitespace-nowrap text-xs font-bold tabular-nums text-sdc-navy">
                  {usd(section.totalCost)}
                </span>
              </div>

              {/* Indented, with a rule running the height of the section: the
                  left edge tells you at a glance whether you're still inside the
                  same one. */}
              <div className="ml-3 border-l-2 border-sdc-blue-100">
                {section.children.map((asm) => (
                  <AssemblyRow key={asm.key} node={asm} depth={0} collapsed={collapsed} toggle={toggle} pricedByKey={pricedByKey} onPartClick={onPartClick} onOpenPo={onOpenPo} now={now} />
                ))}
                {/* The section's own loose parts — collapsed by default like every
                    assembly, via the same `collapsed` set and the same key vocabulary
                    (see the note above `allKeys`). */}
                {section.parts.length > 0 && (
                  <LoosePartsRow
                    keyId={loosePartsKey(section)}
                    parts={section.parts}
                    depth={0}
                    collapsed={collapsed}
                    toggle={toggle}
                    onPartClick={onPartClick}
                    onOpenPo={onOpenPo}
                    now={now}
                  />
                )}
              </div>
            </div>
          ))}

          {bom.roots.length === 0 && (
            <p className="px-4 py-10 text-center text-sm text-sdc-gray-400">No assemblies found for this job.</p>
          )}

          {/* Dark BOM-materials footer — sticky to the bottom of the scroll container */}
          <div className="sticky bottom-0 z-[2] flex items-center justify-between gap-2 bg-sdc-navy px-4 py-2.5 text-white">
            <span className="text-note font-semibold uppercase tracking-wide">
              BOM materials value
              <span className="ml-2 font-normal normal-case text-white/60">assembly parts at latest PO price</span>
            </span>
            <span className="text-sm font-bold tabular-nums">{usd(bom.grandTotalCost)}</span>
          </div>
        </div>
      </DragScroll>
    </div>
  );
}

function AssemblyRow({
  node,
  depth,
  collapsed,
  toggle,
  pricedByKey,
  onPartClick,
  onOpenPo,
  now,
}: {
  node: BomNode;
  depth: number;
  collapsed: Set<string>;
  toggle: (key: string) => void;
  pricedByKey: Map<string, { priced: number; total: number }>;
  onPartClick: (p: DrillablePart) => void;
  onOpenPo: (supplier: string | null, poNumber: string | null) => void;
  now: number;
}) {
  const isOpen = !collapsed.has(node.key);
  const { text } = barClasses(node.stats.pct);
  const priced = pricedByKey.get(node.key) ?? { priced: 0, total: node.stats.total };
  const detailParts = node.self ? [node.self, ...node.parts] : node.parts;

  return (
    <div className="border-b border-sdc-border-soft/60">
      <div
        onClick={() => toggle(node.key)}
        className="grid cursor-pointer items-center gap-3 py-2 pr-3 hover:bg-sdc-blue-light/30"
        style={{ gridTemplateColumns: ASM_GRID }}
      >
        {/* Assembly (caret + indent + pn chip) */}
        <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: `${8 + depth * 18}px` }}>
          <span aria-label={isOpen ? "Collapse" : "Expand"} className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-sdc-blue">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" className={`motion-interactive ${isOpen ? "rotate-90" : ""}`}>
              <path d="M6 3.5 L10.5 8 L6 12.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="shrink-0 truncate font-mono text-note font-bold text-sdc-blue" title={node.pn}>
            {node.pn || "—"}
          </span>
          {node.self ? <ReleaseBadge p={{ isAssembly: true, release: node.release }} /> : null}
        </div>
        {/* Description */}
        <div className="min-w-0 truncate text-sm font-bold text-sdc-navy" title={node.desc || node.label}>
          {node.desc || node.label || "—"}
          {node.children.length ? <span className="ml-1 text-label font-medium text-sdc-gray-400">· {node.children.length} sub-assy</span> : null}
        </div>
        {/* Priced */}
        <span className="text-right text-note font-semibold tabular-nums text-sdc-gray-600" title="Parts with a price">
          {priced.priced}/{priced.total} parts
        </span>
        {/* Rcvd / Total */}
        <span className="text-right text-note font-semibold tabular-nums text-sdc-gray-600" title="Received / total parts">
          <span className={`font-bold ${text}`}>{node.stats.received}</span>/{node.stats.total}
        </span>
        {/* Material $ */}
        <span className="text-right text-sm font-bold tabular-nums text-sdc-navy">
          {node.totalCost ? usd(node.totalCost) : "—"}
        </span>
        {/* Readiness */}
        <ReadinessBar pct={node.stats.pct} />
      </div>

      {isOpen && (
        <div>
          {node.children.map((child) => (
            <AssemblyRow key={child.key} node={child} depth={depth + 1} collapsed={collapsed} toggle={toggle} pricedByKey={pricedByKey} onPartClick={onPartClick} onOpenPo={onOpenPo} now={now} />
          ))}
          {/* `node.self` first: for a "Both Assembly and Contents" release the
              assembly itself is a purchase, and it reads as the header of the
              contents bought alongside it. */}
          {detailParts.length > 0 && <PartsDetailTable parts={detailParts} depth={depth + 1} onPartClick={onPartClick} onOpenPo={onOpenPo} now={now} />}
        </div>
      )}
    </div>
  );
}

// The collapse key for a section's OWN loose parts (job-bom.ts: `section.parts`, the
// flattened-away top node's direct children — parts with no parent sub-assembly). A
// section's own `key` ("S30") already names its assembly children's parent; this is a
// sibling key for the one group of parts that has no assembly of its own to be keyed by.
function loosePartsKey(section: BomNode): string {
  return `${section.key}::loose`;
}

// A collapsible row for a section's loose parts — same look and the same `collapsed`
// membership as AssemblyRow, but built from a flat BomPart[] rather than a BomNode: there
// is no sub-assembly here to carry a part number, a child count or its own `.stats`, so
// those are computed inline from the parts themselves instead of read off a node.
//
// Without this, `section.parts` rendered unconditionally — the defect this fixes. A
// section with dozens of parts belonging to no sub-assembly showed every one of them on
// load, with no header, no caret, and no way to hide them — collapsed-by-default in name
// only.
function LoosePartsRow({
  parts,
  depth,
  keyId,
  collapsed,
  toggle,
  onPartClick,
  onOpenPo,
  now,
}: {
  parts: BomPart[];
  depth: number;
  keyId: string;
  collapsed: Set<string>;
  toggle: (key: string) => void;
  onPartClick: (p: DrillablePart) => void;
  onOpenPo: (supplier: string | null, poNumber: string | null) => void;
  now: number;
}) {
  const isOpen = !collapsed.has(keyId);
  // Priced/received/cost/readiness, the same four figures AssemblyRow shows — computed
  // directly over this flat list rather than via `pricedByKey` (that map is built by
  // walking BomNode trees; there is no node here, and the list is never large enough for
  // the recompute-on-every-render to matter).
  const total = parts.length;
  const priced = parts.filter((p) => p.unitPrice > 0).length;
  const received = parts.filter((p) => partStatus(p, now).key === "received").length;
  const cost = parts.reduce((s, p) => s + p.unitPrice * p.qty, 0);
  const pct = total ? Math.round((received / total) * 100) : 0;
  const { text } = barClasses(pct);

  return (
    <div className="border-b border-sdc-border-soft/60">
      <div
        onClick={() => toggle(keyId)}
        className="grid cursor-pointer items-center gap-3 py-2 pr-3 hover:bg-sdc-blue-light/30"
        style={{ gridTemplateColumns: ASM_GRID }}
      >
        <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: `${8 + depth * 18}px` }}>
          <span aria-label={isOpen ? "Collapse" : "Expand"} className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-sdc-blue">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" className={`motion-interactive ${isOpen ? "rotate-90" : ""}`}>
              <path d="M6 3.5 L10.5 8 L6 12.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          {/* No part-number chip — unlike a real assembly, this group has no PN of its
              own. The em dash keeps the column's alignment rather than leaving it blank. */}
          <span className="shrink-0 text-note font-bold text-sdc-gray-400">—</span>
        </div>
        <div className="min-w-0 truncate text-sm font-bold italic text-sdc-gray-600" title="Parts listed directly under this section, outside any sub-assembly">
          Loose parts
        </div>
        <span className="text-right text-note font-semibold tabular-nums text-sdc-gray-600" title="Parts with a price">
          {priced}/{total} parts
        </span>
        <span className="text-right text-note font-semibold tabular-nums text-sdc-gray-600" title="Received / total parts">
          <span className={`font-bold ${text}`}>{received}</span>/{total}
        </span>
        <span className="text-right text-sm font-bold tabular-nums text-sdc-navy">{cost ? usd(cost) : "—"}</span>
        <ReadinessBar pct={pct} />
      </div>

      {isOpen && <PartsDetailTable parts={parts} depth={depth + 1} onPartClick={onPartClick} onOpenPo={onOpenPo} now={now} />}
    </div>
  );
}

// Sort keys for the Assemblies tree's nested parts table — module scope, like
// every other X_COLUMNS map in this app, since every accessor closes over
// nothing but the row itself (see table-sort.ts / HoursDetailPanel's own
// LINE_COLUMNS for the established convention this mirrors).
type PartsDetailSortKey = "qty" | "pn" | "desc" | "mfr" | "supplier" | "po" | "poDate" | "origDue" | "revised" | "received" | "costPer" | "totalCost";

const PARTS_DETAIL_COLUMNS: SortColumns<BomPart, PartsDetailSortKey> = {
  qty: { type: "number", value: (p) => p.qty },
  pn: { type: "id", value: (p) => p.pn },
  desc: { type: "text", value: (p) => p.desc || null },
  // Sorts on exactly what the cell displays, same convention as every
  // "status"-typed column in this app (DataQualityExplorer, etc.).
  // `p.manufacturer` arrives already canonical from po-detail.ts, so the old
  // `=== "SDC" ? "In-house (SDC)"` relabel is gone (2026-09-03): it was a SECOND
  // spelling of the same company, invented at the display layer, and it is exactly
  // what made the filter list and the table disagree.
  mfr: { type: "text", value: (p) => p.manufacturer || null },
  supplier: { type: "text", value: (p) => p.supplier },
  // `poId` is null for STOCK/PROCESS/NO-PO rows alike — nulls already sort
  // last in both directions (compareByType), which reads correctly here:
  // rows with no PO number drop to the end instead of clustering at
  // whichever end happened to match a coincidental string/number compare.
  po: { type: "id", value: (p) => p.poId },
  poDate: { type: "date", value: (p) => p.poDate },
  origDue: { type: "date", value: (p) => p.originalDate },
  revised: { type: "date", value: (p) => p.revisedDate },
  received: { type: "date", value: (p) => p.receivedDate },
  costPer: { type: "currency", value: (p) => p.unitPrice },
  // The cell shows unitPrice × qty (line total), not unitPrice alone — sort
  // on that same product rather than on unit price a second time.
  totalCost: { type: "currency", value: (p) => p.unitPrice * p.qty },
};

function PartsDetailTable({
  parts,
  depth,
  onPartClick,
  onOpenPo,
  now,
}: {
  parts: BomPart[];
  depth: number;
  onPartClick: (p: DrillablePart) => void;
  onOpenPo: (supplier: string | null, poNumber: string | null) => void;
  now: number;
}) {
  const sort = useColumnSort<PartsDetailSortKey>();
  const sortedParts = sortRows(parts, sort.sort, PARTS_DETAIL_COLUMNS);
  return (
    <div className="border-l-2 border-sdc-blue bg-sdc-gray-50/60" style={{ marginLeft: `${8 + depth * 18}px` }}>
      <div className="overflow-x-auto styled-scrollbar">
        {/* Thin header row, by request. The Scheduler's version has none, and
            this list went without one for the same reason (bc56a97) — but with
            seven columns, two of them money and two of them free text, "which
            price is this" isn't self-evident after all.
            Dark navy fill (also by request), which is what every other grid in
            the app uses for a header — the first pass was muted grey on no fill
            and read as another data row rather than a header. Still thin: 9px,
            uppercase, one line of padding. */}
        {/* Twelve columns now, by request: the buy-list detail people were
            going to Total ETO for — supplier, when the PO went out, what date
            was promised, whether it has since slipped, and when it landed.
            Wider than the pane, so this table scrolls horizontally on its own
            (the wrapper above) rather than forcing the whole tree to. */}
        <table className="w-full min-w-[1320px] border-collapse text-left">
          <thead>
            <tr className="bg-sdc-navy text-micro font-bold uppercase tracking-wide text-white [&>th]:px-2 [&>th]:py-1 [&>th]:font-bold">
              <SortableTh label="Qty" sortKey="qty" type="number" sort={sort.sort} onSort={sort.onSort} className="w-10" />
              <SortableTh label="Part #" sortKey="pn" type="id" sort={sort.sort} onSort={sort.onSort} />
              <SortableTh label="Description" sortKey="desc" type="text" sort={sort.sort} onSort={sort.onSort} />
              <SortableTh label="Manufacturer" sortKey="mfr" type="text" sort={sort.sort} onSort={sort.onSort} />
              <SortableTh label="Supplier" sortKey="supplier" type="text" sort={sort.sort} onSort={sort.onSort} />
              <SortableTh label="PO #" sortKey="po" type="id" sort={sort.sort} onSort={sort.onSort} />
              <SortableTh label="PO date" sortKey="poDate" type="date" sort={sort.sort} onSort={sort.onSort} title="When the purchase order was raised" />
              <SortableTh label="Orig. due" sortKey="origDue" type="date" sort={sort.sort} onSort={sort.onSort} title="Delivery date required when the PO was raised" />
              <SortableTh label="Revised" sortKey="revised" type="date" sort={sort.sort} onSort={sort.onSort} title="Current required date, shown only where it has moved off the original" />
              <SortableTh label="Received" sortKey="received" type="date" sort={sort.sort} onSort={sort.onSort} title="Date the part was last received" />
              <SortableTh label="Cost per" sortKey="costPer" type="currency" sort={sort.sort} onSort={sort.onSort} />
              <SortableTh label="Total cost" sortKey="totalCost" type="currency" sort={sort.sort} onSort={sort.onSort} />
            </tr>
          </thead>
          <tbody>
            {sortedParts.map((p, i) => {
              const st = partStatus(p, now);
              return (
                <tr
                  key={`${p.id}-${i}`}
                  onClick={() => onPartClick(p)}
                  title="Open in Parts List · copies part #"
                  className={`cursor-pointer border-b border-sdc-border-soft/60 ${STATUS_ROW_BG[st.key]}`}
                >
                  <td className="w-10 px-2 py-1.5 text-right text-note font-bold tabular-nums text-sdc-gray-600" title={st.sub || st.label}>{num(p.qty)}</td>
                  <td className="px-2 py-1.5">
                    <span className="inline-flex items-center gap-1 font-mono text-note font-bold text-sdc-blue">
                      {p.pn}
                      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" className="shrink-0 text-sdc-gray-400" aria-hidden>
                        <rect x="5" y="5" width="8" height="8" rx="1.5" /><path d="M3 11 V3 a1 1 0 0 1 1-1 h7" strokeLinecap="round" />
                      </svg>
                      <ReleaseBadge p={p} />
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-note font-semibold text-sdc-navy" title={p.desc}><span className="line-clamp-1">{p.desc || "—"}</span></td>
                  <td className="px-2 py-1.5 text-note font-semibold text-sdc-gray-600" title={p.manufacturer}>
                    <span className="line-clamp-1">{p.manufacturer || "—"}</span>
                  </td>
                  <td className="px-2 py-1.5 text-note text-sdc-gray-600" title={p.supplier ?? ""}>
                    <span className="line-clamp-1">{p.supplier || "—"}</span>
                  </td>
                  <td className="px-2 py-1.5">
                    {/* poCellState, the shared rule — red NO PO here means the
                        same thing it means on the card and in the Parts List
                        filter. This cell used to decide it from `p.poId` alone,
                        which painted every held and already-received part red
                        and, worse, hid a real gap behind a zero-quantity PO.
                        See po-detail.ts. */}
                    {(() => {
                      const cell = poCellState(p);
                      switch (cell.kind) {
                        case "po":
                          return (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); onOpenPo(p.supplier, p.poId); }}
                              title="View PO"
                              className="font-mono text-label font-bold text-sdc-blue underline decoration-dotted underline-offset-2"
                            >
                              {cell.po}
                            </button>
                          );
                        case "stock":
                          return <span className="text-label font-bold text-sdc-green-text" title={`Pulled from inventory (${num(p.pullQty)} issued) — no purchase order needed`}>STOCK</span>;
                        case "process":
                          return <span className="text-label font-bold text-sdc-blue-dark" title="Built in-house on an ETO process schedule — no purchase order needed">IN-HOUSE</span>;
                        case "received":
                          return <span className="text-label font-bold text-sdc-gray-400" title="Already satisfied — no purchase order to raise">N/A</span>;
                        case "hold":
                          return <span className="text-label font-bold text-sdc-yellow-text" title="On hold in ETO — not an actionable purchasing gap while paused">ON HOLD</span>;
                        case "none":
                          return (
                            <span
                              className="text-label font-bold text-sdc-red-text"
                              title={cell.stalePo ? `PO ${cell.stalePo} exists but covers no quantity — this is still an open buy` : "No purchase order, no inventory pull and no process schedule"}
                            >
                              NO PO
                            </span>
                          );
                      }
                    })()}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap font-mono text-label text-sdc-gray-600">{fmtDate(p.poDate)}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap font-mono text-label text-sdc-gray-600">{fmtDate(p.originalDate)}</td>
                  {/* A revision is news — a date that moved is the reason a part
                      is late — so it's called out rather than printed like the
                      rest. Blank where nothing moved (see job-bom.ts). */}
                  <td className={`px-2 py-1.5 whitespace-nowrap font-mono text-label ${p.revisedDate ? "font-bold text-sdc-red-text" : "text-sdc-gray-400"}`}>
                    {p.revisedDate ? fmtDate(p.revisedDate) : "—"}
                  </td>
                  <td className={`px-2 py-1.5 whitespace-nowrap font-mono text-label ${p.receivedDate ? "font-semibold text-sdc-green-text" : "text-sdc-gray-400"}`}>
                    {p.receivedDate ? fmtDate(p.receivedDate) : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-note font-semibold text-sdc-gray-600" title={`${COST_BASIS_NOTE[p.costBasis]} · Required ${fmtDate(p.requiredDate)} · Expected ${fmtDate(p.expectedDate)}`}>
                    {p.unitPrice > 0 ? usd(p.unitPrice) : "—"}
                    {p.unitPrice > 0 && isEstimatedCost(p.costBasis) ? <span className="ml-0.5 text-sdc-gray-400" aria-hidden>*</span> : null}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-note font-bold text-sdc-navy">{p.unitPrice > 0 ? usd(p.unitPrice * p.qty) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Parts List tab
// ═════════════════════════════════════════════════════════════════════════════

// Columns hidden on a first visit. Named so "Reset" can actually restore them —
// it used to be an inline literal at the useState call, which left Reset and
// "Show all" doing the identical thing (clear the set), so Reset never reset.
//
// The default-VISIBLE set is deliberately the 13 columns named in the request
// (2026-08-14): Qty, Part No, Desc, Mfr, Supplier, PO #, Purchased, Required
// Date, Expected Date, Unit $, Total $, Invoiced $, Status — everything else
// in ALL_COLS is hidden by default, including "invoiceddate" (the Invoiced
// DATE column, "Invoiced" — not to be confused with "invoiced", the Invoiced
// $ money column, which stays visible) and "req"/"exp" (Required/Expected
// Date), which are NOW in the default-visible 13 rather than hidden.
// "leftspend" (Left to Invoice) left this list 2026-09-02 — it is one of the
// financial columns now, beside Total $ and Invoiced $, rather than an optional
// extra behind the Columns menu.
//
// "subs" (# Subs) and "purchqty" (Purch Qty) joined the default-VISIBLE set
// 2026-09-10. "# Subs" replaces the "+N" badge that used to sit inside the PO
// cell, so hiding it by default would simply delete information the table
// already showed; "Purch Qty" is the quantity Unit $ multiplies by, and a money
// row that cannot be checked is the thing this change exists to fix.
//
// "delivered" (Delivered Date) joined the default-VISIBLE set 2026-09-10, beside
// Required/Expected Date — the three read as one group and the request was for
// the actual date next to the promised ones. It needs no migration of the kind
// "leftspend" did: a stored `hiddenPartCols` lists what is HIDDEN, so a key that
// did not exist when it was written is simply absent, and the column shows up for
// existing users as well as new ones.
const DEFAULT_HIDDEN_COLS: ColKey[] = ["parent", "category", "invoiceddate", "lead", "due", "pctinv"];

// Invoiced+range window fetch status — passed down so PartsListTab can show a
// fail-soft status message and PartsTableView can render the reconciliation
// footer row. `active` mirrors JobProcurement's own activeAttribution check
// (null falls back to lifetime figures everywhere); when active is true,
// unattachedAmount/unattachedCount are meaningful.
/** What the Parts List's own totals do and do not cover, stated in the footer. */
type JobReconcile = {
  jobTotal: number;
  jobInvoiced: number;
  /** Every row the table draws for this job, before any filter or scope chip. */
  allRows: number;
  bomRows: number;
  /** Purchase money on BOM rows — their total less the estimate-priced ones (see `estimated`). */
  bomPurchased: number;
  nonBomRows: number;
  nonBomTotal: number;
  nonBomInvoiced: number;
  /** BOM parts with no purchase line — priced from the BOM, not from spend. */
  estimated: number;
  /** Job lifetime minus every PURCHASED row the table draws. Zero is the expected value. */
  unexplained: number;
};

type WindowStatus = {
  requested: boolean; // Invoiced mode + a range is set, whether or not it has resolved yet
  pending: boolean;
  error: string | null;
  active: boolean;
  unattachedAmount: number;
  unattachedCount: number;
};

type PartsListState = {
  view: "list" | "card";
  setView: (v: "list" | "card") => void;
  query: string;
  setQuery: (v: string) => void;
  status: Set<StatusKey>;
  setStatus: (updater: (prev: Set<StatusKey>) => Set<StatusKey>) => void;
  category: string;
  setCategory: (v: string) => void;
  manufacturer: string;
  setManufacturer: (v: string) => void;
  supplier: string;
  setSupplier: (v: string) => void;
  dateType: PartsDateFilter;
  setDateType: (v: PartsDateFilter) => void;
  from: string;
  setFrom: (v: string) => void;
  to: string;
  setTo: (v: string) => void;
  hidden: Set<ColKey>;
  setHidden: (updater: (prev: Set<ColKey>) => Set<ColKey>) => void;
  upcomingWeek: number;
  setUpcomingWeek: (n: number) => void;
  colWidths: Partial<Record<ColKey, number>>;
  setColWidths: (updater: (prev: Partial<Record<ColKey, number>>) => Partial<Record<ColKey, number>>) => void;
  clearFilters: () => void;
};

// Default Parts-List column widths (px) — the fallback when a column has no
// persisted resize. Mirrors the Scheduler's PROC_PART_COLS defaults.
const DEFAULT_COL_WIDTH: Record<ColKey, number> = {
  qty: 52,
  pn: 150,
  desc: 260,
  parent: 180,
  category: 130,
  mfr: 115,
  supplier: 130,
  po: 72,
  // Narrow on purpose: it holds a single digit on all but a handful of rows
  // (job 1116: 748 rows with purchases, 63 of them on more than one PO).
  subs: 62,
  purchased: 80,
  invoiceddate: 64,
  req: 84,
  exp: 84,
  // Wider than req/exp: "Delivered Date" is the longest header in the date group,
  // and at text-micro it needs the room its neighbours don't.
  delivered: 96,
  lead: 60,
  due: 68,
  // ── The financial group, widened 2026-09-02 ──────────────────────────────
  //
  // These were 72/72/72/84 with `status` at 120, and the headers crowded into each
  // other: at text-micro, "Invoiced $" plus its sort chevron plus 2×8px of padding
  // does not fit 72px, so the label truncated into its neighbour's border and the
  // group read as one smeared band. Sized to the widest thing each column actually
  // has to hold — a 7-character currency figure and its own header — rather than to
  // whatever kept the table from scrolling. The table is `width: totalWidth` inside
  // an `overflow-auto` scroller, so the extra width costs horizontal scroll, which
  // is the correct trade and what the request asks for.
  unit: 84,
  purchqty: 80,
  total: 92,
  invoiced: 96,
  pctinv: 64,
  leftspend: 104,
  // "NON-BOM", "JOIN FIX", "NO PART NO" plus the badge padding.
  match: 96,
  // RECEIVED / DUE SOON in 2d / NO PO, plus the badge padding around them.
  status: 132,
};
const MIN_COL_WIDTH = 48;


function PartsListTab({
  parts,
  state,
  drill,
  vendors,
  onOpenPart,
  onCopy,
  onOpenPo,
  windowStatus,
  reconcile,
  scope,
  setScope,
  allParts,
}: {
  parts: FlatPart[];
  state: PartsListState;
  drill: { key: string; nonce: number };
  vendors: Vendor[];
  /** Opens the part's PO-history panel — the part NUMBER's own click. The row
   *  itself copies (onCopy); the filter-clearing jump (drillToPart) is for
   *  arriving from the Assemblies tree or a risk card, not for this table. */
  onOpenPart: (p: FlatPart) => void;
  onCopy: (text: string, label?: string) => void;
  onOpenPo: (supplier: string | null, poNumber: string | null) => void;
  windowStatus: WindowStatus;
  reconcile: JobReconcile;
  scope: "all" | "bom" | "nonbom";
  setScope: (s: "all" | "bom" | "nonbom") => void;
  /** Every row regardless of scope — for the chip counts, which must not move when the scope does. */
  allParts: FlatPart[];
}) {
  const { view, setView, query, setQuery, status, setStatus, category, setCategory, manufacturer, setManufacturer, supplier, setSupplier, dateType, setDateType, from, setFrom, to, setTo, hidden, setHidden, colWidths, setColWidths, clearFilters } = state;
  const { toast } = useToast();
  const now = useStableNow();
  // "Active" for status means the selection differs from the default (every
  // status except On Hold) — the same "not the neutral view" test every other
  // filter here already applies against its own "all" baseline.
  // (filtersActive itself is computed below, once the three dropdown choices have been
  // resolved against the options that actually exist — an orphaned choice is not an
  // active filter, and showing Clear for one was this bug's only visible symptom.)
  const statusIsDefault = status.size === DEFAULT_STATUS_KEYS.length && DEFAULT_STATUS_KEYS.every((k) => status.has(k));

  // Drill effect — after a short delay, scroll the matching row into center and
  // flash it. Keyed on `nonce` so re-drilling the same part re-fires. Uses the
  // vibrant --sdc-yellow token (not the pale --sdc-yellow-bg every status
  // tint already uses) so the flash reads as unmistakably stronger than the
  // row's own status tint, fading out after a few seconds.
  //
  // `parts` (the job's FULL, unfiltered buy-list — not `filtered` below) is
  // what tells "genuinely hidden by an active filter" apart from "no such
  // part in this job at all": the general onPartClick drill (drillToPart,
  // above in JobProcurement) always clears every filter before setting
  // `drill`, so its target is guaranteed to render and this branch is
  // effectively dead for it; onJumpToPart's whole point is NOT clearing
  // filters, so a genuinely-hidden row is an expected outcome here, not a bug
  // — surfaced as a toast rather than a silent no-op or a quiet filter reset.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!drill.key) return;
    const t = window.setTimeout(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-part-key="${drill.key}"]`);
      if (!el) {
        const targetId = Number(drill.key);
        if (parts.some((p) => p.id === targetId)) {
          toast("That part is hidden by the current Parts List filters.", "info");
        }
        return;
      }
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.style.transition = "background-color 0.3s ease";
      el.style.backgroundColor = "var(--sdc-yellow)";
      window.setTimeout(() => {
        el.style.backgroundColor = "";
      }, 3000);
    }, 200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drill.nonce]);

  // Columns menu: close when the click lands outside it, the way every other
  // dropdown here behaves (JobSelect, the ETC view menu). A bare <details> stays
  // open until its own summary is clicked again, so it sat over the table.
  //
  // Deliberately NOT closing when a checkbox is toggled — picking columns is
  // usually several picks in a row, and closing after each one would mean
  // reopening the menu per column.
  const colMenuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const el = colMenuRef.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // ── The options, built from EVERY row rather than the scoped subset ─────────
  //
  // `allParts`, not `parts`. The same rule the chip counts already follow: switching
  // BOM/Non-BOM must not change what the filters claim is available. It also matters
  // for correctness now that an off-list choice is discarded (below) — sourcing the
  // options from the scoped rows would make a legitimate manufacturer look orphaned
  // the moment you switched scope, and silently drop it.
  const distinct = useMemo(() => {
    const cats: (string | null)[] = [];
    const mfrs: (string | null)[] = [];
    const sups: (string | null)[] = [];
    for (const p of allParts) {
      cats.push(p.category);
      // Normalized before they reach the option list, so SDC can only ever produce ONE
      // option — the reported bug was two, each matching a subset of the job's SDC
      // parts. `p.manufacturer`/`p.supplier` are already canonical (po-detail.ts);
      // normalizing again is idempotent and makes this line independent of that.
      mfrs.push(normalizeVendor(p.manufacturer));
      sups.push(normalizeVendor(p.supplier));
    }
    // filterOptionValues dedupes, sorts, drops blanks, and refuses to emit a literal
    // "all" — which would be indistinguishable from the no-restriction sentinel.
    return { cats: filterOptionValues(cats), mfrs: filterOptionValues(mfrs), sups: filterOptionValues(sups) };
  }, [allParts]);

  // ── What is ACTUALLY filtered on ────────────────────────────────────────────
  //
  // These three, never the raw state, and everything downstream uses them: the
  // predicate, the <select> value, and the filtersActive test behind the Clear button.
  // A stored choice this job has no rows for resolves to "all" — the whole bug was a
  // <select> painting "All suppliers" (its first option, because the controlled value
  // was not among the options) while the predicate tested all 327 rows against that
  // orphaned value and rejected every one.
  const effCategory = resolveFilterChoice(category, distinct.cats);
  const effManufacturer = resolveFilterChoice(manufacturer, distinct.mfrs);
  const effSupplier = resolveFilterChoice(supplier, distinct.sups);

  // Write the correction back, so the orphan does not sit in localStorage waiting for
  // the next job. Deriving above is what makes the FIRST paint right; this is what
  // stops it recurring. Guarded so it only fires on an actual mismatch — setState in
  // an effect that always ran would loop.
  useEffect(() => {
    if (effCategory !== category) setCategory(effCategory);
    if (effManufacturer !== manufacturer) setManufacturer(effManufacturer);
    if (effSupplier !== supplier) setSupplier(effSupplier);
  }, [effCategory, effManufacturer, effSupplier, category, manufacturer, supplier, setCategory, setManufacturer, setSupplier]);

  const filtersActive =
    !statusIsDefault ||
    effCategory !== FILTER_ALL ||
    effManufacturer !== FILTER_ALL ||
    effSupplier !== FILTER_ALL ||
    query !== "" ||
    dateType !== "purchase" ||
    from !== "" ||
    to !== "";

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return parts.filter((p) => {
      // ── Status does not apply to a non-BOM charge (2026-09-02) ───────────
      //
      // Every status here is a BOM-delivery state: received, due soon, late,
      // uncovered. A freight charge or a tariff has no delivery state, so it can
      // only ever fail this test — which is exactly what happened: 99 non-BOM rows
      // were synthesized, the scope chip counted them, and every one was then
      // filtered off the screen by a filter that has no opinion about them. A row
      // the user cannot see is the bug this whole change exists to remove, so the
      // status filter is scoped to the rows it actually describes.
      if (!p.nonBom && status.size < ALL_STATUS_KEYS.length) {
        // OR across every CURRENTLY SELECTED status, each judged by its own
        // rule — unchanged from the single-select version, just no longer
        // limited to exactly one bucket at a time. "noPO" still resolves via
        // isUncoveredPart rather than p.st.key, since a part can be genuinely
        // uncovered while its displayed status reads "ON HOLD" (partStatus
        // checks `hold` before `noPO`) — isUncoveredPart doesn't care about
        // hold, so selecting "Uncovered (no PO)" must still catch it even
        // though p.st.key for that row is "hold", not "noPO".
        const matches = [...status].some((s) => (s === "noPO" ? isUncoveredPart(p) : p.st.key === s));
        if (!matches) return false;
      }
      // effCategory / effManufacturer / effSupplier, never the raw state — an off-list
      // choice has already resolved to FILTER_ALL, which is what the <select> is
      // showing. Reading the raw value here is exactly how the two came apart.
      if (effCategory !== FILTER_ALL && p.category !== effCategory) return false;
      // Compared through the same function that built the options, so a selected
      // option always matches every aliased line behind it.
      if (effManufacturer !== FILTER_ALL && normalizeVendor(p.manufacturer) !== effManufacturer) return false;
      if (effSupplier !== FILTER_ALL && normalizeVendor(p.supplier) !== effSupplier) return false;
      if (from || to) {
        if (windowStatus.active) {
          // Invoiced mode, window resolved: inclusion is "did this part have
          // any real invoice activity in the window" — attributeInvoicedWindow
          // already summed across every PO line the part has ever had, not
          // just the newest one this row is otherwise built from. A part with
          // zero in-window invoiced amount is excluded, mirroring
          // getJobPartsInvoicedInMonth's own zero-invoice rule. This is the
          // fix's other half: a part invoiced in this window via an OLDER PO
          // line (not the newest) now correctly appears, instead of being
          // invisible because that older line's lifetime-latest invoice fell
          // in a different month.
          if (p.invoicedAmount === 0) return false;
        } else {
          // Purchase mode (always), Req Date/Exp Date (always — no windowed
          // attribution exists for either, only Invoiced gets one), or
          // Invoiced mode before the window has resolved (loading/failed) —
          // unchanged from before this fix.
          const d =
            dateType === "purchase" ? p.purchasedDate :
            dateType === "invoice" ? p.invoicedDate :
            dateType === "req" ? p.requiredDate :
            // The Delivered Date column's own field — actual arrival, never a
            // promised date. A row with nothing received has no delivered date
            // and drops out of the range, the same way a row with no purchase
            // date drops out of a Purchase range: "delivered in August" is a
            // question about parts that were delivered.
            dateType === "delivered" ? p.receivedDate :
            p.expectedDate; // "exp"
          if (!d) return false;
          const day = d.slice(0, 10);
          if (from && day < from) return false;
          if (to && day > to) return false;
        }
      }
      if (q) {
        const hay = `${p.pn} ${p.desc} ${p.manufacturer} ${p.supplier ?? ""} ${p.parentPN} ${p.parentDesc} ${p.poNumber ?? ""} ${p.category ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [parts, status, effCategory, effManufacturer, effSupplier, from, to, dateType, query, windowStatus.active]);

  // A windowed Invoiced figure means something different from the lifetime one
  // ALL_COLS's static label describes (that array also drives the Columns-
  // visibility menu, so it has to stay mode-agnostic) — a per-render override
  // here makes the change visible in the header, not just discoverable by
  // hovering a tooltip. % Inv/Left to Invoice need no header change: every cell
  // in those columns already renders "—" when null (PartRowCells), which is
  // self-evident on its own — the title still explains why.
  const windowedRangeLabel = windowStatus.active ? `${from || "…"} – ${to || "…"}` : "";
  const visibleCols = ALL_COLS.filter((c) => !hidden.has(c.key)).map((c) => {
    if (!windowStatus.active) return c;
    // The header stays "Invoiced $" — the window is explained in the tooltip and,
    // permanently visible, in the footer's scope line. "(window)" inside a 96px
    // header cell was two thirds of the label and truncated the part that says what
    // the column IS, which is the opposite of clarifying it.
    if (c.key === "invoiced") return { ...c, title: `Invoiced within ${windowedRangeLabel}, not lifetime` };
    if (c.key === "pctinv" || c.key === "leftspend") return { ...c, title: "Not meaningful for a windowed Invoiced $ figure" };
    return c;
  });

  return (
    <div ref={rootRef} className="flex flex-col gap-3">
      {/* RiskCards used to render here, inside the Parts List tab only. It is
          now mounted once at the top of JobProcurement so the Assemblies view
          gets the same three cards — see the note at that call site. */}

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sdc-border bg-white px-3 py-2.5 shadow-sm">
        {/* List / Card */}
        <Segmented
          value={view}
          onChange={(v) => setView(v as "list" | "card")}
          options={[{ value: "list", label: "List" }, { value: "card", label: "Card" }]}
        />
        {/* ── BOM / non-BOM scope (2026-09-02) ────────────────────────────────
            "All" is the default because it is the job's whole purchase population
            and its totals equal the Parts Cost card. The counts come from the
            unfiltered set, so switching scope never changes what the chips claim
            is available. */}
        <Segmented
          value={scope}
          onChange={(v) => setScope(v as "all" | "bom" | "nonbom")}
          options={[
            { value: "all", label: `All ${num(allParts.length)}` },
            { value: "bom", label: `BOM ${num(allParts.filter((p) => !p.nonBom).length)}` },
            { value: "nonbom", label: `Non-BOM ${num(allParts.filter((p) => p.nonBom).length)}` },
          ]}
        />
        {/* Columns toggle (table mode only) */}
        {view === "list" && (
          <details ref={colMenuRef} className="relative">
            <summary className={`flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border px-3 text-xs font-medium hover:bg-sdc-blue-light ${hidden.size ? "border-sdc-blue bg-sdc-blue-light text-sdc-blue-dark" : "border-sdc-border bg-white text-sdc-navy"}`}>
              Columns
              {hidden.size > 0 && <span className="inline-flex min-w-[16px] items-center justify-center rounded-full bg-sdc-blue px-1 text-label font-bold text-white tabular-nums">{hidden.size}</span>}
              <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6 L8 11 L13 6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </summary>
            <div className="absolute left-0 z-20 mt-1 max-h-80 w-52 overflow-auto styled-scrollbar rounded-lg border border-sdc-border bg-white p-1.5 shadow-lg">
              {ALL_COLS.map((c) => (
                <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-sdc-navy hover:bg-sdc-blue-light">
                  <input
                    type="checkbox"
                    checked={!hidden.has(c.key)}
                    onChange={() =>
                      setHidden((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.key)) next.delete(c.key);
                        else next.add(c.key);
                        return next;
                      })
                    }
                  />
                  {c.label}
                </label>
              ))}
              <div className="mt-1.5 flex flex-wrap gap-2 border-t border-sdc-border-soft pt-1.5">
                <button type="button" onClick={() => setHidden(() => new Set())} className="rounded-md border border-sdc-border bg-white px-2 py-1 text-note font-medium text-sdc-navy hover:bg-sdc-blue-light">Show all</button>
                <button type="button" onClick={() => setHidden(() => new Set(DEFAULT_HIDDEN_COLS))} title="Back to the default column set" className="rounded-md border border-sdc-border bg-white px-2 py-1 text-note font-medium text-sdc-navy hover:bg-sdc-blue-light">Reset</button>
                <button type="button" onClick={() => setColWidths(() => ({}))} className="rounded-md border border-sdc-border bg-white px-2 py-1 text-note font-medium text-sdc-navy hover:bg-sdc-blue-light" title="Restore default column widths">Reset widths</button>
              </div>
            </div>
          </details>
        )}

        <span className="mx-1 h-5 w-px bg-sdc-border" aria-hidden />

        <StatusFilter value={status} onChange={setStatus} />
        <FilterSelect label="Category" value={effCategory} onChange={setCategory} options={[{ value: FILTER_ALL, label: "All categories" }, ...distinct.cats.map((c) => ({ value: c, label: c }))]} />
        <FilterSelect label="Mfr" value={effManufacturer} onChange={setManufacturer} options={[{ value: FILTER_ALL, label: "All manufacturers" }, ...distinct.mfrs.map((c) => ({ value: c, label: c }))]} />
        <FilterSelect label="Supplier" value={effSupplier} onChange={setSupplier} options={[{ value: FILTER_ALL, label: "All suppliers" }, ...distinct.sups.map((c) => ({ value: c, label: c }))]} />

        <span className="mx-1 h-5 w-px bg-sdc-border" aria-hidden />

        <Segmented
          value={dateType}
          onChange={(v) => setDateType(v as PartsDateFilter)}
          options={[
            { value: "purchase", label: "Purchase" },
            { value: "invoice", label: "Invoiced" },
            { value: "req", label: "Req Date" },
            { value: "exp", label: "Exp Date" },
            { value: "delivered", label: "Delivered" },
          ]}
        />
        <input type="date" aria-label="From date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 rounded-md border border-sdc-border bg-white px-2 text-xs text-sdc-navy outline-none focus:border-sdc-blue" />
        <span className="text-xs text-sdc-gray-400">to</span>
        <input type="date" aria-label="To date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 rounded-md border border-sdc-border bg-white px-2 text-xs text-sdc-navy outline-none focus:border-sdc-blue" />

        {filtersActive && (
          <button type="button" onClick={clearFilters} className="h-8 rounded-md border border-sdc-border bg-white px-3 text-xs font-medium text-sdc-navy hover:bg-sdc-blue-light">
            Clear
          </button>
        )}

        {/* Fail-soft status for the Invoiced+range window fetch — never blanks
            the table, just discloses which figures are currently showing. */}
        {windowStatus.requested && windowStatus.pending && (
          <span className="whitespace-nowrap text-label text-sdc-gray-400">Loading invoiced totals for this range…</span>
        )}
        {windowStatus.requested && !windowStatus.pending && windowStatus.error && (
          <span className="whitespace-nowrap text-label font-medium text-sdc-red-text" title={windowStatus.error}>
            Couldn&apos;t load this range — showing lifetime totals
          </span>
        )}

        {/* Search */}
        <div className="flex h-8 min-w-[160px] flex-1 items-center gap-2 rounded-md border border-sdc-border bg-white px-2.5">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-sdc-gray-400">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search parts…" aria-label="Search parts" className="w-full border-none bg-transparent text-xs text-sdc-navy outline-none placeholder:text-sdc-gray-400" />
        </div>

        <span className="ml-auto whitespace-nowrap text-xs font-semibold text-sdc-gray-600 tabular-nums">
          {num(filtered.length)} line items
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-sdc-border bg-white px-4 py-10 text-center text-sm text-sdc-gray-400 shadow-sm">
          No parts match the current filters.
        </p>
      ) : view === "list" ? (
        <PartsTableView parts={filtered} cols={visibleCols} onCopy={onCopy} onOpenPart={onOpenPart} onOpenPo={onOpenPo} now={now} colWidths={colWidths} setColWidths={setColWidths} windowStatus={windowStatus} rangeLabel={windowedRangeLabel} reconcile={reconcile} scope={scope} setScope={setScope} drillKey={drill.key} />
      ) : (
        <PartsCardView parts={filtered} vendors={vendors} onCopy={onCopy} onOpenPo={onOpenPo} />
      )}
    </div>
  );
}


// ── One continuous scroll, windowed (2026-09-04, by request) ─────────────────
//
// This was Prev/Next paging over 50 rows at a time, added 2026-09-03 for job 1101's
// 628 rows. Replaced by request: "I do not want page-by-page navigation... the user
// should be able to continuously scroll through all matching parts without ever
// clicking Next."
//
// The rule the paging version established survives verbatim, because it was never
// about paging: **what is DRAWN is not what is COUNTED.** The column totals, the row
// counts and the reconciliation strip are all computed over every filtered row, and
// windowing changes only which <tr> elements exist. A footer that summed the visible
// window would be the same scope-mixing bug the reconciliation strip was rewritten to
// remove — and it would now be worse, because the window moves as you scroll.
//
// ── Why spacer rows rather than a virtualization library ────────────────────
//
// The table is `table-fixed` with an explicit <colgroup>, so column widths come from
// the colgroup and NOT from the rendered cells. That is what makes windowing safe
// here: rows can come and go without the columns resizing under the user, which is
// the usual reason a virtualized <table> looks broken. Two spacer <tr>s carrying the
// height of the rows above and below keep the scrollbar honest, the sticky <thead>
// and <tfoot> keep working because the table is still one table, and horizontal
// scrolling is untouched because the element that scrolls is unchanged.
//
// A library would add a dependency and, to work inside a real table, would want the
// rows re-parented into absolutely-positioned divs — losing the colgroup, the sticky
// header and the resize handles in the process.
//
// ── Row height is fixed, deliberately ──────────────────────────────────────
//
// Windowing arithmetic needs to know where row N is without measuring it. Every cell
// in this table already truncates to one line (PartRowCells), so the rows were
// uniform in practice; ROW_H makes that a guarantee rather than an observation. A row
// that grew to two lines would otherwise drift the window against the scrollbar.
const ROW_H = 21;
/** Rows rendered beyond each edge, so a fast scroll does not show a blank band. */
const OVERSCAN = 12;
/**
 * The table's own height. Fixed rather than `max-h` so the card does not change size
 * with the row count — 12 parts and 628 parts get the same table, which is what was
 * asked for.
 */
const TABLE_H = "calc(var(--app-vh) * 0.62)";

/**
 * Which slice of `total` rows to render for the current scroll offset.
 *
 * Height is measured rather than derived from TABLE_H: the pane can be half a split
 * view, and a window sized from a CSS expression the element does not actually have
 * would render too few rows and leave a gap under the last one.
 */
function useRowWindow(total: number, scrollRef: React.RefObject<HTMLDivElement | null>) {
  const [range, setRange] = useState({ start: 0, end: Math.min(total, 60) });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const measure = () => {
      const first = Math.floor(el.scrollTop / ROW_H);
      const visible = Math.ceil(el.clientHeight / ROW_H);
      const start = Math.max(0, first - OVERSCAN);
      const end = Math.min(total, first + visible + OVERSCAN);
      // Only commit a real change: scroll fires per frame and a new object every time
      // would re-render the whole table on every pixel.
      setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
    };

    measure();
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [total, scrollRef]);

  // Clamped on every render, not only in the effect: `total` can drop when a filter
  // narrows the set, and a stale window past the new end renders nothing at all.
  const start = Math.min(range.start, Math.max(0, total - 1));
  const end = Math.min(range.end, total);
  return { start, end: Math.max(end, Math.min(total, start + 1)) };
}

function PartsTableView({
  parts,
  cols,
  onCopy,
  onOpenPart,
  onOpenPo,
  now,
  colWidths,
  setColWidths,
  windowStatus,
  rangeLabel,
  reconcile,
  scope,
  setScope,
  drillKey,
}: {
  parts: FlatPart[];
  cols: { key: ColKey; label: string; align?: "right"; title?: string }[];
  // ── Why this is onCopy and not onPartClick (2026-09-10) ──────────────────
  //
  // The row used to call `drillToPart`, which clears every filter, switches to
  // List view and scroll-flashes the target. That is exactly right when you
  // arrive from the Assemblies tree or a risk card — it guarantees the row you
  // asked for is actually on screen. Called from a Parts List row, it could only
  // ever throw away the filters you had set in order to "find" the row you were
  // already looking at and had just clicked.
  //
  // So the row keeps the useful half, copying the part number, and matches
  // PartsCardView beside it, which already took onCopy for the same reason. The
  // part number itself is now the real destination (onOpenPart).
  onCopy: (text: string, label?: string) => void;
  onOpenPart: (p: FlatPart) => void;
  onOpenPo: (supplier: string | null, poNumber: string | null) => void;
  now: number;
  colWidths: Partial<Record<ColKey, number>>;
  setColWidths: (updater: (prev: Partial<Record<ColKey, number>>) => Partial<Record<ColKey, number>>) => void;
  windowStatus: WindowStatus;
  /** "2026-08-01 – 2026-08-31" while an Invoiced window is active, "" otherwise. */
  rangeLabel: string;
  /** Job-lifetime totals and the part of them that is not a BOM part. */
  reconcile: JobReconcile;
  scope: "all" | "bom" | "nonbom";
  setScope: (s: "all" | "bom" | "nonbom") => void;
  /**
   * The part id PartsListTab wants scrolled into view, or "".
   *
   * Needed because of the windowing: the drill effect above finds its row with
   * `querySelector('[data-part-key=...]')` and treats a miss as "hidden by a filter".
   * With only ~60 rows in the DOM, a row that is perfectly visible to the filters but
   * 400 rows down would miss and report itself as filtered out. So the table scrolls
   * the row into the window first, and the parent's own timeout then finds it.
   */
  drillKey: string;
}) {
  const widthOf = (key: ColKey) => colWidths[key] ?? DEFAULT_COL_WIDTH[key];
  const totalWidth = cols.reduce((s, c) => s + widthOf(c.key), 0);

  // Sort is independent of, and applied after, the filtering `PartsListTab`
  // already did to `parts` before handing them down — same "third, separate
  // concern" as every other table in this app (table-sort.ts). The column set
  // itself is a function of `now` (see partsListSortColumns's own comment).
  const sort = useColumnSort<ColKey>();
  const sortColumns = useMemo(() => partsListSortColumns(now), [now]);
  const sortedParts = sortRows(parts, sort.sort, sortColumns);

  // Sorted FIRST, then sliced — so page 1 is the top of the sort rather than the
  // first fifty rows re-sorted among themselves. The signature resets the page
  // whenever the filtered set changes; the sort key is in it too, since re-sorting
  // makes the current page's contents arbitrary.
  // ── The scroll container, and the slice of rows it needs ──────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const win = useRowWindow(sortedParts.length, scrollRef);
  const visibleParts = sortedParts.slice(win.start, win.end);
  // Spacer heights: the rows that exist but are not rendered. These are what keep the
  // scrollbar the right length and the rendered rows at the right offset.
  const padTop = win.start * ROW_H;
  const padBottom = Math.max(0, (sortedParts.length - win.end) * ROW_H);

  // ── Scrolling a drilled-to row into the window ────────────────────────────
  //
  // PartsListTab finds its target with querySelector and treats a miss as "hidden by
  // a filter". Only ~60 rows are in the DOM now, so a perfectly visible row 400 down
  // would miss. Putting it in the window first makes that lookup mean what it did
  // before windowing: found = present, missing = genuinely filtered out.
  useEffect(() => {
    if (!drillKey) return;
    const el = scrollRef.current;
    if (!el) return;
    const i = sortedParts.findIndex((p) => String(p.id) === drillKey);
    if (i < 0) return; // genuinely not in the filtered set — the parent says so
    // Centred, matching the scrollIntoView({ block: "center" }) the parent then does,
    // so the row does not jump twice.
    el.scrollTop = Math.max(0, i * ROW_H - el.clientHeight / 2);
  }, [drillKey, sortedParts]);

  // Drag-to-resize: listeners are added on mousedown and torn down on mouseup;
  // stopPropagation keeps a drag from also triggering the row click.
  const startResize = (key: ColKey, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(key);
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(MIN_COL_WIDTH, startW + (ev.clientX - startX));
      setColWidths((prev) => ({ ...prev, [key]: w }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    // Plain imperative DOM mutation inside a mousedown handler -- not render,
    // not an effect, so "consider using an effect" doesn't apply here; this
    // is the standard vanilla drag-resize pattern (global cursor + disabled
    // text-selection for the duration of the drag, restored in onUp above).
    // eslint-disable-next-line react-hooks/immutability
    document.body.style.cursor = "col-resize";
    // eslint-disable-next-line react-hooks/immutability
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // ── What the footer's first line counts (2026-09-03) ──────────────────────
  //
  // Off `parts` — the rows this view renders, after PartsListTab's filters AND the
  // scope chip — so the count can never disagree with what actually scrolls. This
  // is deliberately a DIFFERENT scope from `reconcile` below it, which describes the
  // whole job; the footer labels each line with the scope it covers rather than
  // letting the reader assume they are the same set (see the footer's own comment).
  //
  // `narrowed` is the one thing that decides whether the footer says "all 56 rows"
  // or "56 of 334 rows" plus a "Whole job" label on the money line. Comparing
  // against reconcile.allRows catches every way the view can be narrowed — status,
  // category, manufacturer, supplier, date window, search, and the scope chip — with
  // no list of filter states to keep in sync as filters are added.
  const visible = useMemo(() => {
    let bomRows = 0;
    for (const p of parts) if (!p.nonBom) bomRows++;
    return { bomRows, nonBomRows: parts.length - bomRows, narrowed: parts.length < reconcile.allRows };
  }, [parts, reconcile.allRows]);

  // Half a dollar of tolerance, not zero — see the footer's status comment.
  const reconcileStatus: "reconciled" | "partial" | "mismatch" =
    Math.abs(reconcile.unexplained) > 0.5
      ? "mismatch"
      : windowStatus.active && windowStatus.unattachedAmount !== 0
        ? "partial"
        : "reconciled";

  // Column totals for the sticky footer (over the currently-filtered rows),
  // mirroring the Power BI Parts Cost total row. leftToSpend/pctInvoiced are
  // `number | null` now (null uniformly, component-wide, exactly when
  // windowStatus.active — see JobProcurement's enrich()), so the footer skips
  // summing them in that case rather than silently summing nulls-as-zero into
  // a number that would look real but mean nothing.
  const tot = parts.reduce(
    (a, p) => {
      a.qty += p.qty;
      a.unit += p.unitPrice;
      a.total += p.totalPrice;
      a.invoiced += p.invoicedAmount;
      if (p.leftToSpend !== null) a.left += p.leftToSpend;
      return a;
    },
    { qty: 0, unit: 0, total: 0, invoiced: 0, left: 0 },
  );
  const totPct = windowStatus.active ? null : tot.total > 0 ? Math.round((tot.invoiced / tot.total) * 100) : tot.invoiced > 0 ? 100 : 0;
  const footCell = (key: ColKey, idx: number): string => {
    switch (key) {
      case "qty": return num(tot.qty);
      case "unit": return usd(tot.unit);
      case "total": return usd(tot.total);
      case "invoiced": return usd(tot.invoiced);
      case "pctinv": return totPct === null ? "—" : `${totPct}%`;
      case "leftspend": return windowStatus.active ? "—" : usd(tot.left);
      default: return idx === 0 ? "Total" : "";
    }
  };

  return (
    // 0.96, up from 0.74 (2026-08-14, by request — "increase vertical height
    // ~30%") — kept in step with the Card view below (view === "card") and the
    // Assemblies tab above, so switching between them doesn't visibly jump.
    <div className="overflow-hidden rounded-xl border border-sdc-border bg-white shadow-sm">
      {/* A FIXED height, not max-h: the card must not change size with the row count.
          The filters sit above this element and the totals are a sticky <tfoot> inside
          it, so the only thing that moves is the rows. */}
      <DragScroll
        // Named so the Parts List keeps its place across a tab switch by NAME rather
        // than by DOM position — see lib/tab-scroll-state.ts.
        scrollKey="parts-list"
        scrollRef={scrollRef}
        className="overflow-auto styled-scrollbar"
        style={{ height: TABLE_H }}
      >
      <table className="table-fixed border-collapse text-left" style={{ width: totalWidth, minWidth: "100%" }}>
        <colgroup>
            {cols.map((c) => (
              <col key={c.key} style={{ width: widthOf(c.key) }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-[2]">
            <tr className="bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
              {cols.map((c) => (
                <th key={c.key} title={c.title} className={`relative border-r border-white/15 px-2 py-1.5 font-bold ${c.align === "right" ? "text-right" : ""}`}>
                  {/* SortableColumnHeader, not SortableTh — this `<th>` already
                      carries its own title/border/resize-handle chrome, so the
                      shared component's non-`<th>` variant (built for exactly
                      this case, see its own doc comment) is embedded inside it
                      rather than replacing it wholesale. */}
                  <SortableColumnHeader
                    label={<span className="block truncate">{c.label}</span>}
                    sortKey={c.key}
                    type={sortColumns[c.key].type}
                    align={c.align === "right" ? "right" : "left"}
                    sort={sort.sort}
                    onSort={sort.onSort}
                  />
                  <span
                    onMouseDown={(e) => startResize(c.key, e)}
                    role="separator"
                    aria-label={`Resize ${c.label} column`}
                    title="Drag to resize"
                    className="absolute right-0 top-0 z-[1] h-full w-1.5 cursor-col-resize bg-white/0 hover:bg-white/40"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Spacer for the rows above the window. `aria-hidden` because it is
                scrollbar arithmetic, not content. */}
            {padTop > 0 && (
              <tr aria-hidden style={{ height: padTop }}>
                <td colSpan={cols.length} className="p-0" />
              </tr>
            )}
            {visibleParts.map((p, i) => {
              // Row tint by status (STATUS_ROW_BG) so each row reads by its
              // status at a glance. Precedence: drill-flash (inline style, set
              // imperatively) > the status tint's hover > the status tint.
              const rowBg = STATUS_ROW_BG[p.st.key];
              return (
                <tr
                  key={`${p.id}-${i}`}
                  data-part-key={String(p.id)}
                  data-pn={p.pn}
                  data-part-id={p.id}
                  onClick={() => onCopy(p.pn, p.pn)}
                  title="Copy part # · click the part number for its PO history"
                  // The height the windowing arithmetic assumes. Every cell already
                  // truncates to one line, so this fixes what was true by convention.
                  style={{ height: ROW_H }}
                  className={`group cursor-pointer ${rowBg}`}
                >
                  <PartRowCells p={p} cols={cols} now={now} onOpenPo={onOpenPo} onOpenPart={onOpenPart} />
                </tr>
              );
            })}
            {padBottom > 0 && (
              <tr aria-hidden style={{ height: padBottom }}>
                <td colSpan={cols.length} className="p-0" />
              </tr>
            )}
          </tbody>
          {/* ── One row high, always (2026-09-02) ────────────────────────────
              `whitespace-nowrap` and a fixed `h-7` on the totals row, because a
              sticky footer's height comes straight off the visible table: every
              pixel it grows is a pixel of rows the user stops seeing. Nothing in
              this row is long enough to need two lines — the reconciliation
              sentence that DID need them has its own row below now. */}
          <tfoot className="sticky bottom-0 z-[2]">
            <tr className="h-7 border-t-2 border-sdc-blue bg-sdc-navy text-xs font-bold text-white">
              {cols.map((c, idx) => (
                <td key={c.key} className={`overflow-hidden whitespace-nowrap border-r border-white/15 px-2 py-1 align-middle font-mono font-bold tabular-nums ${c.align === "right" ? "text-right" : ""}`}>
                  {footCell(c.key, idx)}
                </td>
              ))}
            </tr>
            {/* ── The reconciliation line, out of the Qty column (2026-09-02) ──
                Invoiced money in this window that doesn't attach to any part row
                above: non-PO AP lines (freight, tariffs, direct reimbursements), or
                a PO line for a part outside the current BOM. Never silently
                dropped — this is what makes the grand total match the Monthly ETC
                Parts Spent drill exactly rather than falling quietly short by
                whatever doesn't attach to a BOM part.

                It used to be rendered as a normal footer row, which put a
                twelve-word sentence in the FIRST column — `qty`, 52px wide, with
                `overflow-hidden` — where it wrapped to roughly ten lines and dragged
                every other cell in the row to that height. That is the whole of the
                oversized navy block: not a sticky-footer bug, one long string in the
                narrowest column in the table.

                A single `colSpan` cell instead, so the text has the full table width
                and occupies exactly one line. The amount is stated inline rather than
                aligned under Invoiced $ deliberately — it is NOT part of that column's
                total (see the scope note below), and sitting under it implied it was.

                Deliberately NOT reactive to Status/Category/Manufacturer/Supplier/
                search: it reflects the whole window, not the currently-visible rows,
                so it stays a stable structural figure rather than one that silently
                moves with an unrelated filter. That difference in scope is now stated
                on the strip itself rather than left for the reader to infer. */}
            {/* ── The equation, and a way into every part of it (2026-09-02) ──
                This began as a sentence: "$88,643 more sits on 90 part numbers with
                no BOM row". That is an assertion the reader cannot check — and on
                job 1101 it was also partly wrong, since four of those "non-BOM"
                lines were a BOM part whose number is punctuated differently
                upstream, a join failure the summary was quietly absorbing.

                Those lines are rows in this table now, each carrying its own
                classified reason, so the summary no longer stands in for data
                nobody can reach. What is left here is the arithmetic, with the
                non-BOM half clickable: press it and the table switches to exactly
                the rows the figure is made of. */}
            {/* ── Rewritten as two labelled lines (2026-09-03, by request) ─────
                Reported directly: the wording is awkward and people are not
                understanding it. The old strip was one run-on sentence that mixed
                two different scopes without saying so — "56 rows shown ... every PO
                line each part has" counts the rows left after every filter, while
                "13 are not BOM parts" and "Job lifetime $36,931" describe the whole
                job regardless of what is on screen. A reader with a supplier filter
                on was being shown a row count and a job total that did not belong to
                each other, with nothing marking the seam.

                So the two scopes are now two lines, each labelled with the scope it
                covers, and neither borrows a figure from the other:

                  Rows        what the table is showing right now, split BOM/non-BOM,
                              and — when a filter is on — out of how many the job has.
                  Whole job   the reconciliation: BOM + non-BOM = job total, with a
                              status word for whether it balances.

                "Whole job" is the literal label on the second line whenever a filter
                is narrowing the first, which is what keeps the two from reading as
                one number (the request's own rule). With nothing filtered both lines
                describe the same rows, so the first says "all 56 rows" and the second
                needs no qualifier.

                Gone, as asked: "every PO line each part has", "sits on", "fully
                accounted for by the rows above". The first was trying to state the
                grain of a row (one part, all of its POs) — a real fact, but not one a
                footer needs to re-teach on every render; the drill panel and the
                Total $ column both carry it. Kept: the non-BOM figure is still a
                button that switches the scope chip, since "show me those 13 rows" is
                the first thing anyone asks of that number. */}
            <tr className="bg-sdc-navy text-label text-white/70">
              <td colSpan={cols.length} className="border-t border-white/10 px-2 py-1 align-middle">
                <span className="flex flex-col gap-y-0.5">
                  {/* Line 1 — WHAT IS ON SCREEN. Counted off `parts`, the rows this
                      view actually renders after PartsListTab's filters and the
                      scope chip, so it can never disagree with what scrolls. */}
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="text-white/45">Rows</span>
                    <span>
                      {visible.narrowed ? (
                        <>
                          Showing <span className="font-semibold text-white">{num(parts.length)}</span> of{" "}
                          {num(reconcile.allRows)} rows
                        </>
                      ) : (
                        <>
                          Showing all <span className="font-semibold text-white">{num(parts.length)}</span> row
                          {parts.length === 1 ? "" : "s"} for this job
                        </>
                      )}
                      {parts.length > 0 && (
                        <>
                          {" — "}
                          {num(visible.bomRows)} BOM, {num(visible.nonBomRows)} non-BOM
                        </>
                      )}
                      {/* The paging note that used to sit here is gone with the
                          pager (2026-09-04). It existed because the counts either side
                          of it were over every filtered row while the table drew only
                          50 — a discrepancy the user could see. Scrolling reaches every
                          one of those rows, so there is no longer two scopes to
                          reconcile and saying "1–50 on this page" would now be false. */}
                    </span>
                    {/* The scope chip's own state in words, rather than left to be
                        inferred from a count that is merely smaller than expected. */}
                    {scope !== "all" && (
                      <button
                        type="button"
                        onClick={() => setScope("all")}
                        className="motion-interactive rounded px-1 underline decoration-dotted underline-offset-2 hover:bg-white/10 hover:text-white"
                        title="Clear the BOM / non-BOM filter"
                      >
                        {scope === "bom" ? "BOM rows only" : "Non-BOM rows only"} — show all
                      </button>
                    )}
                  </span>

                  {/* Line 2 — THE WHOLE JOB, always, whatever line 1 is showing. The
                      addends are printed in the order they sum, so the equation is
                      checkable on sight instead of asserted. */}
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="text-white/45">{visible.narrowed ? "Whole job" : "Totals"}</span>
                    <span>
                      BOM{" "}
                      <span className="font-mono font-semibold tabular-nums text-white">{usd(reconcile.bomPurchased)}</span>
                      {" + "}
                      {reconcile.nonBomRows > 0 && scope !== "nonbom" ? (
                        <button
                          type="button"
                          onClick={() => setScope("nonbom")}
                          className="motion-interactive rounded px-1 underline decoration-dotted underline-offset-2 hover:bg-white/10 hover:text-white"
                          title={`Show only the ${num(reconcile.nonBomRows)} rows that are not BOM parts`}
                        >
                          non-BOM{" "}
                          <span className="font-mono font-semibold tabular-nums text-white">
                            {usd(reconcile.nonBomTotal)}
                          </span>
                        </button>
                      ) : (
                        <>
                          non-BOM{" "}
                          <span className="font-mono font-semibold tabular-nums text-white">
                            {usd(reconcile.nonBomTotal)}
                          </span>
                        </>
                      )}
                      {" = "}
                      <span className="font-mono font-semibold tabular-nums text-white">{usd(reconcile.jobTotal)}</span>{" "}
                      job total
                    </span>
                    {/* ── The status word ──────────────────────────────────────────
                        Three states, each a real condition rather than a threshold
                        invented to fill a third slot:
                          reconciled  the rows account for the job's own total.
                          partial     they do, but an Invoiced window has money on
                                      lines no part row carries — that detail is the
                                      row directly below this one.
                          mismatch    they do not add up, the one thing here worth
                                      shouting. Never silently absorbed.
                        Half a dollar of tolerance, not zero: these are floats summed
                        over hundreds of lines, so an exact equality would report
                        rounding dust as a data problem. */}
                    {reconcileStatus === "mismatch" ? (
                      <span className="rounded bg-sdc-yellow px-1.5 font-semibold text-sdc-navy">
                        Mismatch — {usd(Math.abs(reconcile.unexplained))} unaccounted, report this
                      </span>
                    ) : reconcileStatus === "partial" ? (
                      <span className="rounded bg-white/15 px-1.5 font-semibold text-white">
                        Partially reconciled — see below
                      </span>
                    ) : (
                      <span className="rounded bg-white/10 px-1.5 font-semibold text-white/90">Fully reconciled</span>
                    )}
                    {/* Estimate money, when there is any: deliberately NOT inside the
                        BOM addend above (it would unbalance the equation by its own
                        amount — see `bomPurchased`), so it is named here rather than
                        disappearing between the two. */}
                    {reconcile.estimated > 0.5 && (
                      <span className="text-white/45">
                        plus <span className="font-mono tabular-nums text-white/70">{usd(reconcile.estimated)}</span> of BOM
                        parts not bought yet (priced from the BOM, not spend)
                      </span>
                    )}
                  </span>
                </span>
              </td>
            </tr>
            {windowStatus.active && windowStatus.unattachedAmount !== 0 && (
              <tr className="bg-sdc-navy text-label text-white/80">
                <td colSpan={cols.length} className="border-t border-white/10 px-2 py-1 align-middle">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span>
                      Other invoiced{rangeLabel ? ` in ${rangeLabel}` : ""} with no matching part row:{" "}
                      <span className="font-mono font-semibold tabular-nums text-white">
                        {usd(windowStatus.unattachedAmount)}
                      </span>{" "}
                      · {num(windowStatus.unattachedCount)} line{windowStatus.unattachedCount === 1 ? "" : "s"}
                    </span>
                    {/* The scopes, named. The totals row above sums the rows on
                        screen after every filter; this figure covers the whole date
                        window. Two different questions, and the request is explicit
                        that they must not read as one number. */}
                    <span className="text-white/55">— not included in the totals above, which cover the visible rows only</span>
                  </span>
                </td>
              </tr>
            )}
          </tfoot>
        </table>
      </DragScroll>
    </div>
  );
}

// What a PO row's dot conveys. Deliberately its own type rather than reusing
// PoGroup["status"], which has no way to say "open, on time, nothing in yet" —
// the gap that made a not-yet-due PO render as if it had no PO.
type PoRowState = "received" | "partial" | "open" | "late" | "noPO";

// The dot is the only thing carrying this state, so it gets a tooltip — a bare
// colour with no legend is what let "red" be read as "late".
const PO_ROW_STATE_LABEL: Record<PoRowState, string> = {
  received: "All lines received",
  partial: "Partially received — on time",
  open: "On order — nothing received yet, not yet due",
  late: "Past due",
  noPO: "No PO raised",
};

type VendorGroup = {
  supplier: string;
  pos: PoGroup[];
  received: number;
  total: number;
  pct: number;
  poCount: number; // excludes the NO-PO group
  status: { label: string; cls: string };
  order: number; // sort priority (0 = most urgent)
  pastDue: boolean;
};

// Vendor card layout — group the flat parts by supplier → PO, matching the
// Scheduler drawer's Card mode. One card per supplier, a mini PO table inside,
// and each PO row expands inline to reveal its parts.
function PartsCardView({
  parts,
  vendors,
  onCopy,
  onOpenPo,
}: {
  parts: FlatPart[];
  vendors: Vendor[];
  onCopy: (text: string, label?: string) => void;
  onOpenPo: (supplier: string | null, poNumber: string | null) => void;
}) {
  const vendorGroups = useMemo<VendorGroup[]>(() => {
    const byVendor = new Map<string, Map<string, FlatPart[]>>();
    for (const p of parts) {
      const vKey = p.supplier ?? "Unknown supplier";
      const poKey = p.poNumber ?? NO_PO_KEY;
      let pos = byVendor.get(vKey);
      if (!pos) byVendor.set(vKey, (pos = new Map()));
      const arr = pos.get(poKey);
      if (arr) arr.push(p);
      else pos.set(poKey, [p]);
    }

    const groups: VendorGroup[] = [];
    for (const [supplier, poMap] of byVendor) {
      const pos: PoGroup[] = [];
      let vReceived = 0;
      let vTotal = 0;
      let vPastDue = false;
      for (const [poKey, poParts] of poMap) {
        const po = makePoGroup(poKey, poParts);
        pos.push(po);
        vReceived += po.received;
        vTotal += po.total;
        if (po.pastDue) vPastDue = true;
      }
      // Incomplete first, received last; then most parts first.
      pos.sort((a, b) => {
        const ar = a.status === "received" ? 1 : 0;
        const br = b.status === "received" ? 1 : 0;
        if (ar !== br) return ar - br;
        return b.total - a.total;
      });
      const pct = vTotal ? Math.round((vReceived / vTotal) * 100) : 0;
      const poCount = pos.filter((p) => p.poKey !== NO_PO_KEY).length;
      let status: VendorGroup["status"];
      let order: number;
      if (vPastDue) {
        status = { label: "PAST DUE", cls: "bg-sdc-red-bg text-sdc-red-text" };
        order = 0;
      } else if (pct >= 90) {
        status = { label: "RECEIVED", cls: "bg-sdc-green-bg text-sdc-green-text" };
        order = 3;
      } else if (pct >= 60) {
        status = { label: "PARTIAL", cls: "bg-sdc-yellow-bg text-sdc-yellow-text" };
        order = 2;
      } else {
        status = { label: "PENDING", cls: "bg-sdc-blue-light text-sdc-blue-dark" };
        order = 1;
      }
      groups.push({ supplier, pos, received: vReceived, total: vTotal, pct, poCount, status, order, pastDue: vPastDue });
    }
    groups.sort((a, b) => a.order - b.order || a.pct - b.pct || a.supplier.localeCompare(b.supplier));
    return groups;
  }, [parts]);

  // Vendor readiness bar color: >=90 green, >=60 amber, else blue.
  const vendorBar = (pct: number) => (pct >= 90 ? "bg-sdc-green" : pct >= 60 ? "bg-sdc-yellow" : "bg-sdc-blue");
  const vendorText = (pct: number) => (pct >= 90 ? "text-sdc-green-text" : pct >= 60 ? "text-sdc-yellow-text" : "text-sdc-blue-dark");
  // PO row dot. Red means "needs someone's attention" and nothing else — no PO
  // raised, or a PO whose date has passed. An open PO that simply hasn't
  // arrived yet is blue, however little of it has been received.
  //
  // Per Dan (2026-07-30): a PO due in August with nothing received was showing
  // red, reading as late when it isn't. The cause was `dotKey` bucketing any PO
  // under 60% received into "noPO" — the same state as having no PO at all —
  // so low-receipt and missing-PO were painted identically.
  const dotColor = (s: PoRowState) =>
    s === "received" ? "bg-sdc-green" : s === "partial" ? "bg-sdc-yellow" : s === "late" || s === "noPO" ? "bg-sdc-red" : "bg-sdc-blue";

  return (
    // 0.96, up from 0.74 (2026-08-14, by request) — kept in step with the List
    // (table) view above, so switching the List/Card segmented control doesn't
    // visibly jump.
    <div
      className="grid max-h-[calc(var(--app-vh)_*_0.96)] gap-3 overflow-y-auto styled-scrollbar"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}
    >
      {vendorGroups.map((v) => {
        // Authoritative supplier rollup (real PO line counts) overrides the
        // BOM-derived bar %. Falls back to the BOM % when the vendor has no
        // authoritative match — no regression.
        const rollup = authoritativeVendorRollup(vendors, v.supplier);
        const barPct = rollup?.pct ?? v.pct;
        return (
        <div key={v.supplier} className="flex flex-col overflow-hidden rounded-lg border border-sdc-border bg-white shadow-sm">
          {/* Header */}
          <div className="flex flex-col gap-2 border-b border-sdc-border-soft p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <SupplierAvatar supplier={v.supplier} size={30} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-bold text-sdc-navy" title={v.supplier}>{v.supplier}</div>
                  <div className="text-label text-sdc-gray-400">
                    {v.poCount} PO{v.poCount === 1 ? "" : "s"} · {v.total} item{v.total === 1 ? "" : "s"}
                  </div>
                </div>
              </div>
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-micro font-bold tracking-wide ${v.status.cls}`}>{v.status.label}</span>
            </div>
            <div className="flex items-center gap-2" title={`${barPct}% received${rollup ? " (supplier PO lines)" : ""}`}>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sdc-gray-100">
                <div className={`h-full rounded-full ${vendorBar(barPct)}`} style={{ width: `${Math.min(100, barPct)}%` }} />
              </div>
              <span className={`w-9 shrink-0 text-right text-note font-semibold tabular-nums ${vendorText(barPct)}`}>{barPct}%</span>
            </div>
          </div>

          {/* Mini PO table */}
          <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 bg-sdc-gray-100 px-3 py-1.5 text-micro font-bold uppercase tracking-wider text-sdc-gray-400">
            <span>PO #</span>
            <span className="text-right">Received</span>
            <span className="text-right">Date</span>
            <span />
          </div>
          <div className="max-h-56 overflow-y-auto styled-scrollbar">
            {v.pos.map((po) => {
              const rowKey = `${v.supplier}::${po.poKey}`;
              // Authoritative per-PO override — real line counts when matched,
              // otherwise the BOM-derived counts.
              const apo = findAuthoritativePo(vendors, po.poNumber);
              const rc = apo ? apo.received : po.received;
              const tot = apo ? apo.itemCount : po.total;
              const effPct = apo ? apo.pct : po.total ? Math.round((po.received / po.total) * 100) : 0;
              // Order matters: fully received wins over past due (a PO that
              // arrived can't be late), and past due wins over any partial
              // progress. Only a genuinely missing PO is "noPO".
              const dotKey: PoRowState =
                po.poKey === NO_PO_KEY
                  ? "noPO"
                  : effPct >= 100
                    ? "received"
                    : po.pastDue
                      ? "late"
                      : effPct > 0
                        ? "partial"
                        : "open";
              return (
                <button
                  key={rowKey}
                  type="button"
                  onClick={() => onOpenPo(v.supplier, po.poNumber)}
                  title="Open PO details"
                  className="grid w-full grid-cols-[1fr_auto_auto_auto] items-center gap-2 border-b border-sdc-border-soft/60 px-3 py-1.5 text-left last:border-b-0 hover:bg-sdc-blue-light/30"
                >
                  {po.poNumber ? (
                    <span
                      role="button"
                      tabIndex={0}
                      title="Copy PO number"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCopy(po.poNumber!, `PO ${po.poNumber}`);
                      }}
                      className="truncate font-mono text-note font-semibold text-sdc-blue underline decoration-dotted underline-offset-2"
                    >
                      {po.poNumber}
                    </span>
                  ) : (
                    <span className="text-label font-semibold text-sdc-red-text">NO PO</span>
                  )}
                  <span className="text-right text-label tabular-nums text-sdc-gray-600" title={apo ? "Supplier PO line count" : "BOM-derived count"}>{rc}/{tot} rcvd</span>
                  <span className={`text-right font-mono text-label ${po.pastDue ? "text-sdc-red-text" : "text-sdc-gray-600"}`}>{fmtDate(po.expected)}</span>
                  <span className="flex items-center gap-1.5">
                    <span
                      title={PO_ROW_STATE_LABEL[dotKey]}
                      className={`inline-block h-2 w-2 rounded-full ${dotColor(dotKey)}`}
                    />
                    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" className="text-sdc-gray-400" aria-hidden>
                      <path d="M6 3.5 L10.5 8 L6 12.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        );
      })}

      {vendorGroups.length === 0 && (
        <p className="col-span-full rounded-xl border border-sdc-border bg-white px-4 py-10 text-center text-sm text-sdc-gray-400 shadow-sm">
          No parts match the current filters.
        </p>
      )}
    </div>
  );
}

// ── Generic right-side sliding panel (shared slide/close mechanics) ──────────

function SidePanel({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setOpen(true));
    return () => window.cancelAnimationFrame(id);
  }, []);
  const requestClose = useCallback(() => {
    setOpen(false);
    window.setTimeout(onClose, 200);
  }, [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      <div onClick={requestClose} className={`absolute inset-0 bg-sdc-navy/40 motion-interactive ${open ? "opacity-100" : "opacity-0"}`} />
      <aside className={`absolute right-0 top-0 flex h-full w-[560px] max-w-[calc(var(--app-vw)_*_0.94)] flex-col bg-white shadow-xl motion-interactive ${open ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex items-center justify-between gap-3 border-b border-sdc-border-soft p-4">
          <div className="min-w-0">
            <div className="truncate text-base font-bold text-sdc-navy">{title}</div>
            {subtitle ? <div className="text-xs text-sdc-gray-600">{subtitle}</div> : null}
          </div>
          <button type="button" onClick={requestClose} aria-label="Close" className="rounded p-1 text-sdc-gray-400 hover:bg-sdc-gray-100 hover:text-sdc-navy">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4 L12 12 M12 4 L4 12" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto styled-scrollbar">{children}</div>
      </aside>
    </div>
  );
}

// ── Risk panels: Delivery Slip · No Purchase Order · Upcoming Deliveries ─────

// ── The three risk cards' shared header shell ───────────────────────────────
//
// One string, used by all three, because "keep the three headers aligned on the
// same horizontal level" is a promise that three separately-maintained class
// lists cannot keep — they were already drifting (Upcoming carried `gap-3`
// where the other two had `gap-2`, for no reason anyone recorded).
//
// TWO layouts, switched on the CARD's own width — `@container` per card, the
// same tool and reasoning as EtcMonthKpiCards. It has to be the card and not
// the viewport: at one fixed viewport these cards are two different widths
// depending on whether the sidebar is collapsed, so an `xl:` breakpoint would
// be right only half the time.
//
//   >= 470px of card — the tidy one, and the case that matters. `flex-col`,
//     two DECIDED lines, 64px. Line 1 is title | Parts, Suppliers, Nearest,
//     See all; line 2 is the week picker alone. Nothing wraps, so the height
//     is arithmetic rather than a measurement:
//         28.5 (a Stat) + 3.75 (gap-1) + 20.25 (a button) + 11.25 (py-1.5) = 64
//     A Stat is a `text-micro` label over a `text-xs` value; the odd numbers
//     are because this app's root font is 15px, not 16.
//
//   below that — ONE free-flowing wrap row, which is what this header used to
//     be and is genuinely better when space is short. The row and group divs go
//     `display: contents`, so title, each Stat, See all and the picker become
//     direct flex items again and pack themselves. Forcing the two-line
//     structure down here cost 152px on content free flow fits in 118:
//     grouping items into rows means a row breaks when ANY member does not
//     fit, and half-empty lines add up fast.
//
// The heights below the switch are measured worst cases, not estimates, and
// the thing that drives them is the week picker: a button carrying a count is
// 43px against 21px bare, so eight of them go from 194px to 370px (426px at two
// digits) purely on DATA. Measured with every week counted:
//     card 415 -> 116     card 357 -> 118     card 317 -> 139
// hence 124px from 355 up, and 152px below it. An early pass set this from a
// job whose weeks were all empty and would have overflowed the moment any
// count appeared — worth remembering that a quiet job is not the worst case.
//
// Thresholds are in PIXELS on purpose. `@[26rem]` reads as 416 but resolves
// against that same 15px root to 390, which silently put an earlier switch
// BELOW the width the tidy layout needs — the header went short while its
// content still wanted another line and the card's `overflow-hidden` ate the
// difference.
//
// 152px is a floor, not a guarantee. Under roughly a 220px card — a ~500px
// window with the sidebar still expanded — the picker needs a third line and
// overflows even that. Deliberately not chasing it with a fourth tier: this is
// a sidebar-plus-dense-table desktop report, that width is already unusable for
// the grids above it, and the previous fixed 125px clipped the same content
// harder at the same size.
const PANEL_HEADER =
  "flex h-[152px] flex-wrap content-center items-center gap-x-3 gap-y-1 border-b border-sdc-border-soft bg-sdc-gray-100 px-4 py-1.5 " +
  "@[355px]:h-[124px] @[470px]:h-[64px] @[470px]:flex-col @[470px]:flex-nowrap @[470px]:items-stretch @[470px]:justify-center @[470px]:gap-x-2";

// One line inside a header — title on the left, everything else hard right.
//
// `contents` below the switch: this element stops generating a box at all, so
// its children join the header's own wrap row instead of being trapped in a
// sub-row that can only break as a unit. Above the switch it becomes a real
// flex row again and `justify-between` does the title-left/rest-right split.
const PANEL_HEADER_ROW =
  "contents @[470px]:flex @[470px]:w-full @[470px]:flex-wrap @[470px]:items-center @[470px]:justify-between @[470px]:gap-x-2 @[470px]:gap-y-1";

// A run of Stats (plus See all) inside a line. Same trick and the same reason:
// grouped, the whole run drops to the next line the moment one member does not
// fit; ungrouped, the Stats fill the line and only the overflow moves down.
const PANEL_HEADER_GROUP =
  "contents @[470px]:flex @[470px]:flex-wrap @[470px]:items-center @[470px]:gap-x-4 @[470px]:gap-y-1";

// One row per (supplier, PO) group — both the compact cards' own primary row
// and the "See all" side panel's table (2026-08-14, by request — "group by
// PO instead of individual parts"). `relevantDate` is precomputed per card's
// own meaning before sorting (Delivery Slip/Upcoming: the PO's soonest
// Expected date, `makePoGroup`'s own `expected`; No Purchase Order: the PO's
// soonest Required date, via `earliestRequired` above) so one sort-column
// map can serve all three cards without knowing which one a row came from.
type RiskPoRow = { supplier: string; po: PoGroup; relevantDate: string | null };
type RiskPoSortKey = "po" | "supplier" | "count" | "date";

const RISK_PO_COLUMNS: SortColumns<RiskPoRow, RiskPoSortKey> = {
  po: { type: "id", value: (r) => r.po.poNumber },
  supplier: { type: "text", value: (r) => r.supplier },
  count: { type: "number", value: (r) => r.po.total },
  date: { type: "date", value: (r) => r.relevantDate },
};

function RiskCards({
  parts,
  onOpenPoGroup,
  onJumpToPart,
  now,
  upcomingWeek,
  setUpcomingWeek,
}: {
  parts: FlatPart[];
  // Takes the ALREADY-BUILT PoGroup a card's own eligibility filter produced,
  // not a bare (supplier, poNumber) pair — see openPoGroup's own comment for
  // why: a card's grouping can be narrower than "every part sharing this
  // supplier and PO", and re-deriving from scratch loses that.
  onOpenPoGroup: (supplier: string, po: PoGroup) => void;
  // Part mode's own click action — jump to this exact part's row in the
  // Parts List below, preserving every filter/search/sort/column choice
  // (see onJumpToPart's own comment in JobProcurement for why this can't
  // just reuse the PO drawer's onOpenPoGroup or Assemblies' onPartClick).
  onJumpToPart: (p: DrillablePart) => void;
  now: number;
  upcomingWeek: number;
  setUpcomingWeek: (n: number) => void;
}) {
  const [seeAll, setSeeAll] = useState<null | "delivery" | "nopo" | "upcoming">(null);
  // Presentation only — PO mode groups rows by (supplier, PO) and clicking one
  // opens the PO drawer; Part mode lists the same qualifying parts individually
  // (Part No / Description / Supplier / Required / Expected) with no drawer.
  // Every card switches together, and neither mode changes which parts
  // qualify — `risk` below is computed once, independent of `groupBy`.
  const [groupBy, setGroupBy] = useState<"po" | "part">("po");
  // One sort state for all three "See all" modes (they share a row shape and
  // a table), reset on every open — a sort left over from a differently-
  // shaped table would apply invisibly, with no header arrow on screen to
  // explain the new order.
  const seeAllSort = useColumnSort<RiskPoSortKey>();
  const openSeeAll = (mode: "delivery" | "nopo" | "upcoming") => {
    seeAllSort.setSort(null);
    setSeeAll(mode);
  };

  // Every rule behind these three cards lives in procurement-risk.ts, which
  // is also what /api/integration/jobs/[jobId]/procurement serves to the Build
  // Readiness app — one implementation, two consumers.
  const risk = useMemo(() => computeRiskCards(parts, now), [parts, now]);

  const selectedWeek = risk.weekData.find((w) => w.week === upcomingWeek) ?? risk.weekData[0];
  // Memoized so its reference is stable across renders once the selected
  // week settles — the `?? []` fallback would otherwise mint a fresh empty
  // array every render (whenever `selectedWeek` is undefined), which
  // defeats `upcomingPos`'s own memo below (its dep would look "changed"
  // every render even with no real data change).
  const selectedParts = useMemo(() => selectedWeek?.parts ?? [], [selectedWeek]);
  const upSuppliers = new Set(selectedParts.map((p) => p.supplier).filter(Boolean)).size;
  const upNearest = selectedParts.length ? selectedParts.map(dueMs).filter(Number.isFinite).sort((a, b) => a - b)[0] : null;
  // Same grouping the other two cards use, over whichever week is selected —
  // `selectedParts` is already a sorted subset of `upcoming` (itself sorted
  // by due date ascending), so this comes out earliest-due-first too.
  const upcomingPos = useMemo(() => groupPartsByPo(selectedParts), [selectedParts]);

  const openPo = (row: { supplier: string; po: PoGroup }) => onOpenPoGroup(row.supplier, row.po);

  return (
    <div className="flex flex-col gap-3">
      {/* Group By — presentation only. Toggling never changes which parts
          qualify for a card (see `groupBy`'s own comment above); it only
          swaps each card's rows between one-per-PO (opens the drawer) and
          one-per-part (no drawer) and the header count that goes with it. */}
      <div className="flex items-center gap-2 self-start">
        <span className="text-xs font-semibold uppercase tracking-wide text-sdc-muted">Group By</span>
        <Segmented
          value={groupBy}
          onChange={setGroupBy}
          options={[
            { value: "po", label: "PO" },
            { value: "part", label: "Part" },
          ]}
        />
      </div>

      {/* Delivery Slip · No Purchase Order · Upcoming Deliveries — one row on
          desktop (by request). All three used to be a 2-up grid plus a
          full-width third card below it; folded into a single 3-column grid
          instead, so they read as one matched set rather than 2-then-1.
          `sm:grid-cols-2 xl:grid-cols-3`: stacked on mobile, a 2-up
          intermediate on tablet, three-across from 1280px — "normal desktop
          width" for this app's sidebar-plus-content layout (verified live;
          `lg` at 1024px left too little room per card once the sidebar's
          width comes out of it, and Upcoming Deliveries' own row grid started
          clipping its rightmost date column).

          ── Sizing: header and list are EACH a fixed height, not stretch-to-
          tallest-sibling ─────────────────────────────────────────────────

          Two earlier passes let CSS Grid's `items-stretch` size the row from
          whichever card's own header+content was naturally tallest, with the
          list body `flex-1` (grow-to-fill) under a `max-h-*` ceiling — first
          150px, then 300px once a busy job (42 Delivery Slip parts) still
          showed a gap beneath the list. Both were the same mistake at a
          different size: a `flex-1` body's real height is "whatever the row
          stretched to, minus this card's own header" — which is a DIFFERENT
          number on every card whenever headers differ (Upcoming's own
          8-button week picker wraps 2-3 lines depending on width; the other
          two are one line), so no single fixed row height could ever put the
          SAME row count in all three at once — only ever "however many rows
          happen to fit this card's own leftover space today."

          Fixing BOTH the header and the list to their own constant heights
          removes the ambiguity instead of chasing it: every card's header is
          exactly `PANEL_HEADER`'s own height, and every list body is exactly `h-[284px]` —
          10 rows at a SlipRow/UpcomingRow's own measured 28.42px (10 × 28.42
          = 284.2, floored rather than rounded up so the 10th row is never
          cut a hair short AND the 11th never peeks through). A shorter
          header (Delivery Slip, No Purchase Order) centers its one-line
          content in the extra space via the `items-center` it already had;
          nothing about the row's own height depends on any card's row count
          any more, which is what makes "exactly 10 rows, no more, regardless
          of how many exist" possible everywhere at once. `auto-rows`/
          `h-full` stretch is gone — 68 + 284 = 352px is every card's own
          natural height now, identically, so there's nothing left to
          stretch.

          `h-[68px]` (2026-08-12, second pass — "use as little vertical header
          space as possible") replaces a measured-worst-case 125px, and the
          51px came from removing the CAUSE rather than trimming padding
          again. 125px was Upcoming's 8-button week picker WRAPPING: one
          `flex-wrap` row held the title, eight buttons, three Stats and See
          all, so its line count was whatever the card's width happened to
          produce — two lines at 1440px, three at the 1280-1300px pinch — and
          every card had to reserve the worst case even though only one of
          them ever hit it.

          Deciding the line count instead of discovering it makes the height
          a constant rather than a measurement: Upcoming states two lines
          (title + Parts/Suppliers, then picker + Nearest + See all), the
          other two state one, and `justify-center` centers whatever is
          there. Nothing wraps at any width, so nothing has to be re-measured
          when the picker gains a week or a Stat's digits grow — which is the
          real reason this is worth doing, beyond the 51px.

          68px is two 26px Stat lines (`text-micro` label over `text-xs`
          value) plus the `gap-1` between them and `py-1.5` top and bottom.
          The Stat is the tallest thing in either line, so the number follows
          from the content rather than being reserved for it. Verified live at
          1280 / 1440 / 1920 and at the sm/md 2-up tier: all three headers
          report the same height, and no header's content exceeds it. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {/* Delivery Slip */}
        <div className="@container flex flex-col overflow-hidden rounded-lg border border-sdc-border bg-white shadow-sm">
          <div className={PANEL_HEADER}>
            <div className={PANEL_HEADER_ROW}>
              <span className="inline-flex items-center gap-2 text-note font-bold uppercase tracking-wider text-sdc-yellow-text">
                <span className="inline-flex h-[18px] w-[18px] items-center justify-center rounded bg-sdc-yellow-bg text-xs font-bold text-sdc-yellow-text">!</span>
                Delivery Slip
              </span>
              <div className={PANEL_HEADER_GROUP}>
                {/* "5 · 37" under "POs · Parts" (2026-08-14, by request —
                    "counts... should clearly represent the new PO-based
                    grouping... show both metrics"), replacing the bare part
                    count this used to show. Part mode emphasizes the part
                    count alone — there's no PO grouping to report. */}
                {groupBy === "po" ? (
                  <Stat label="POs · Parts" value={`${risk.deliveryPos.length} · ${risk.delivery.length}`} />
                ) : (
                  <Stat label="Parts" value={num(risk.delivery.length)} />
                )}
                <Stat label="Avg Late" value={`+${risk.deliveryAvgLate}d`} tone={risk.deliveryAvgLate > 0 ? "danger" : undefined} />
                <Stat label="Oldest Req" value={fmtDate(risk.deliveryOldest)} />
                <SeeAllBtn onClick={() => openSeeAll("delivery")} disabled={risk.deliveryPos.length === 0} />
              </div>
            </div>
          </div>
          <RiskTableHead />
          <div className="h-[262px] overflow-y-auto styled-scrollbar">
            {/* One row per PO (2026-08-14, by request — "group by PO instead
                of individual parts"), clicking opens the PO drawer instead
                of drilling to the Parts List row. `row.po.total` is the
                exact same count `makePoGroup` also feeds the Card view and
                PoPanel with, so this can never disagree with either. */}
            {groupBy === "po" ? (
              risk.deliveryPos.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-sdc-gray-400">No deliveries due or overdue.</p>
              ) : (
                risk.deliveryPos.map((row, i) => (
                  <PoRiskRow
                    key={`${row.supplier}-${row.po.poKey}-${i}`}
                    poNumber={row.po.poNumber}
                    supplier={row.supplier}
                    parts={row.po.parts}
                    expected={row.po.expected}
                    pastDue={row.po.pastDue}
                    onClick={() => openPo(row)}
                  />
                ))
              )
            ) : risk.delivery.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-sdc-gray-400">No deliveries due or overdue.</p>
            ) : (
              risk.delivery.map((p) => <PartRiskRow key={p.id} part={p} onClick={() => onJumpToPart(p)} />)
            )}
          </div>
        </div>

        {/* No Purchase Order */}
        <div className="@container flex flex-col overflow-hidden rounded-lg border border-sdc-border bg-white shadow-sm">
          <div className={PANEL_HEADER}>
            <div className={PANEL_HEADER_ROW}>
              <span className="inline-flex items-center gap-2 text-note font-bold uppercase tracking-wider text-sdc-red-text">
                <span className="inline-flex h-[18px] w-[18px] items-center justify-center rounded bg-sdc-red-bg text-sm font-bold text-sdc-red-text">×</span>
                No Purchase Order
              </span>
              <div className={PANEL_HEADER_GROUP}>
                {/* "Suppliers · Parts", not "POs · Parts" — every row here is
                    a genuinely no-PO group (isUncoveredPart guarantees
                    `poNumber === null`), so grouping only ever splits by
                    supplier; a "POs" count would always just read the same
                    as the supplier count and add nothing. Part mode drops
                    the supplier grouping entirely, so only Parts remains. */}
                {groupBy === "po" ? (
                  <Stat label="Suppliers · Parts" value={`${risk.noPoPos.length} · ${risk.noPo.length}`} tone={risk.noPo.length ? "danger" : undefined} />
                ) : (
                  <Stat label="Parts" value={num(risk.noPo.length)} tone={risk.noPo.length ? "danger" : undefined} />
                )}
                <Stat label="This Week" value={num(risk.noPoThisWeek)} />
                <Stat label="Oldest Req" value={fmtDate(risk.noPoOldest)} />
                <SeeAllBtn onClick={() => openSeeAll("nopo")} disabled={risk.noPoPos.length === 0} />
              </div>
            </div>
          </div>
          <RiskTableHead />
          <div className="h-[262px] overflow-y-auto styled-scrollbar">
            {/* One row per supplier (2026-08-14, by request — "group... under
                a clear No PO / Unassigned grouping using the same existing
                uncovered logic"): every row is labelled "No PO" (there is no
                real PO number to show), grouped by supplier, clicking opens
                the same PO drawer with `poNumber: null` — its existing
                "Parts without PO" branch, unchanged. */}
            {groupBy === "po" ? (
              risk.noPoPos.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-sdc-gray-400">All parts have purchase orders.</p>
              ) : (
                risk.noPoPos.map((row, i) => (
                  <PoRiskRow
                    key={`${row.supplier}-${i}`}
                    poNumber={null}
                    supplier={row.supplier}
                    parts={row.po.parts}
                    // Nothing has been raised, so there is no expected date to
                    // show — the column stays, rendering "—", so the three
                    // cards keep the same shape.
                    expected={null}
                    onClick={() => openPo(row)}
                  />
                ))
              )
            ) : risk.noPoSorted.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-sdc-gray-400">All parts have purchase orders.</p>
            ) : (
              risk.noPoSorted.map((p) => <PartRiskRow key={p.id} part={p} onClick={() => onJumpToPart(p)} />)
            )}
          </div>
        </div>

        {/* Upcoming Deliveries — `sm:col-span-2 xl:col-span-1`: at the sm/md
            2-up tier this is the odd one out (3 cards in 2 columns), and
            without a span it drops into column 1 of its own new row, leaving
            column 2 sitting empty beside it. Spanning both columns there
            uses that row fully instead; back to spanning one column once
            xl's 3-up applies, or it would just as awkwardly overshoot into a
            second row on its own. */}
        <div className="@container flex flex-col overflow-hidden rounded-lg border border-sdc-border bg-white shadow-sm sm:col-span-2 xl:col-span-1">
          <div className={PANEL_HEADER}>
            {/* Line 1 — the same shape the other two cards' single line has:
                title left, then Stats, then See all hard right — the same shape
                the other two cards' single line already had.

                All three Stats sit here, which is the honest grouping: Parts,
                Suppliers AND Nearest are every one of them derived from
                `selectedParts`, so they all change together when the week
                changes. An earlier pass kept Nearest down with the picker on
                the theory that it was the week-dependent one; it is not the
                only week-dependent one, and splitting it off both misdescribed
                it and made line 2 the widest thing in the header. See all comes
                up here too so all three cards put it in the same place.

                Leaving line 2 to the picker alone is also what lets the tidy
                layout start at a 470px card instead of 530 — see PANEL_HEADER. */}
            <div className={PANEL_HEADER_ROW}>
              <span className="inline-flex items-center gap-2 text-note font-bold uppercase tracking-wider text-sdc-blue-dark">
                <span className="inline-flex h-[18px] w-[18px] items-center justify-center rounded bg-sdc-blue-light text-note font-bold text-sdc-blue-dark">→</span>
                Upcoming Deliveries
              </span>
              <div className={PANEL_HEADER_GROUP}>
                {groupBy === "po" ? (
                  <Stat label="POs · Parts" value={`${upcomingPos.length} · ${selectedParts.length}`} />
                ) : (
                  <Stat label="Parts" value={num(selectedParts.length)} />
                )}
                <Stat label="Suppliers" value={num(upSuppliers)} />
                <Stat label="Nearest" value={upNearest ? fmtDate(new Date(upNearest).toISOString()) : "—"} />
                <SeeAllBtn onClick={() => openSeeAll("upcoming")} disabled={risk.upcomingAllPos.length === 0} />
              </div>
            </div>
            {/* Line 2 — the week picker, and nothing else.
                `min-w-0 flex-wrap`: the buttons are the one thing in this
                header that can afford to reflow, so they are the one thing
                allowed to. Both halves are load-bearing and each was wrong on
                its own in an earlier pass — `min-w-0` alone let the strip
                compress below its content and the card's `overflow-hidden`
                clipped weeks 6-8 off with no sign they existed; `flex-wrap`
                alone did nothing, because a strip that never has to shrink
                never has to wrap. */}
            <div className="flex min-w-0 flex-wrap items-center gap-0.5">
              {risk.weekData.map((w) => (
                <button
                  key={w.week}
                  type="button"
                  onClick={() => setUpcomingWeek(w.week)}
                  className={`rounded px-1 py-0.5 text-note font-semibold motion-interactive ${
                    w.week === (selectedWeek?.week ?? 1) ? "bg-sdc-blue text-white" : w.count > 0 ? "bg-sdc-blue-light text-sdc-blue-dark hover:bg-sdc-blue-100" : "text-sdc-gray-400 hover:bg-sdc-gray-100"
                  }`}
                >
                  {w.week}W{w.count > 0 ? <span className="ml-0.5 opacity-80">({w.count})</span> : null}
                </button>
              ))}
            </div>
          </div>
          <RiskTableHead />
          <div className="h-[262px] overflow-y-auto styled-scrollbar">
            {groupBy === "po" ? (
              upcomingPos.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-sdc-gray-400">No parts with an expected date in week {selectedWeek?.week ?? 1}.</p>
              ) : (
                upcomingPos.map((row, i) => (
                  <PoRiskRow
                    key={`${row.supplier}-${row.po.poKey}-${i}`}
                    poNumber={row.po.poNumber}
                    supplier={row.supplier}
                    parts={row.po.parts}
                    expected={row.po.expected}
                    onClick={() => openPo(row)}
                  />
                ))
              )
            ) : selectedParts.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-sdc-gray-400">No parts with an expected date in week {selectedWeek?.week ?? 1}.</p>
            ) : (
              selectedParts.map((p) => <PartRiskRow key={p.id} part={p} onClick={() => onJumpToPart(p)} />)
            )}
          </div>
        </div>
      </div>

      {/* "See all" — PO-grouped rows too (2026-08-14, by request — kept
          consistent with the compact cards above: same rows, same click-
          opens-the-PO-drawer behavior, just more of them visible at once and
          sortable by PO #/Supplier/Parts/Date). Built fresh on every render
          rather than memoized — these lists are already computed above and
          this only re-shapes them with one precomputed `relevantDate` per
          row, cheap at the sizes a risk card ever holds. */}
      {(() => {
        const seeAllRows: RiskPoRow[] =
          seeAll === "delivery"
            ? risk.deliveryPos.map((row) => ({ ...row, relevantDate: row.po.expected }))
            : seeAll === "nopo"
              ? risk.noPoPos.map((row) => ({ ...row, relevantDate: earliestRequired(row.po.parts) }))
              : seeAll === "upcoming"
                ? risk.upcomingAllPos.map((row) => ({ ...row, relevantDate: row.po.expected }))
                : [];
        // Part mode's own row set — the SAME qualifying parts, individually,
        // with no PO grouping. "upcoming" here is the full 8-week set
        // (risk.upcoming), matching upcomingAllPos' own "see all ignores the
        // compact card's selected week" rule.
        const seeAllParts: FlatPart[] =
          seeAll === "delivery" ? risk.delivery : seeAll === "nopo" ? risk.noPoSorted : seeAll === "upcoming" ? risk.upcoming : [];
        return (
          seeAll && (
            <SidePanel
              title={seeAll === "delivery" ? "Delivery Slip" : seeAll === "nopo" ? "Parts without Purchase Order" : "Upcoming Deliveries"}
              subtitle={
                seeAll === "delivery"
                  ? `${risk.deliveryPos.length} POs · ${risk.delivery.length} parts due or overdue`
                  : seeAll === "nopo"
                    ? `${risk.noPoPos.length} suppliers · ${risk.noPo.length} parts need a PO`
                    : `${risk.upcomingAllPos.length} POs · ${risk.upcoming.length} parts due in the next 8 weeks`
              }
              onClose={() => setSeeAll(null)}
            >
              {groupBy === "po" ? (
                <table className="w-full border-collapse text-left">
                  <thead className="sticky top-0 z-[1]">
                    <tr className="bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
                      <SortableTh label="PO #" sortKey="po" type="id" sort={seeAllSort.sort} onSort={seeAllSort.onSort} className="px-3 py-2" />
                      <SortableTh label="Supplier" sortKey="supplier" type="text" sort={seeAllSort.sort} onSort={seeAllSort.onSort} className="px-2 py-2" />
                      <SortableTh label="Parts" sortKey="count" type="number" sort={seeAllSort.sort} onSort={seeAllSort.onSort} className="px-2 py-2" />
                      <SortableTh label={seeAll === "nopo" ? "Oldest Req" : "Expected"} sortKey="date" type="date" sort={seeAllSort.sort} onSort={seeAllSort.onSort} className="px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortRows(seeAllRows, seeAllSort.sort, RISK_PO_COLUMNS).map((row, i) => (
                      <tr
                        key={`${row.supplier}-${row.po.poKey}-${i}`}
                        onClick={() => { openPo(row); setSeeAll(null); }}
                        title="Open PO details"
                        className={`cursor-pointer border-b border-sdc-border-soft/60 ${row.po.pastDue ? "bg-sdc-red-bg/40 hover:bg-sdc-red-bg/70" : "hover:bg-sdc-blue-light/30"}`}
                      >
                        <td className="px-3 py-1.5 font-mono text-note font-semibold text-sdc-blue">{row.po.poNumber ?? "No PO"}</td>
                        <td className="px-2 py-1.5 text-note text-sdc-navy" title={row.supplier}><span className="line-clamp-1">{row.supplier}</span></td>
                        <td className="px-2 py-1.5 text-right font-mono text-note font-semibold tabular-nums text-sdc-gray-600">{row.po.total}</td>
                        <td className={`px-2 py-1.5 whitespace-nowrap font-mono text-label ${row.po.pastDue ? "font-semibold text-sdc-red-text" : "text-sdc-gray-600"}`}>{fmtDate(row.relevantDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                // Part mode — no drawer to open, so no onClick/cursor-pointer
                // on these rows, unlike every PO-mode row above.
                <table className="w-full border-collapse text-left">
                  <thead className="sticky top-0 z-[1]">
                    <tr className="bg-sdc-navy text-micro font-bold uppercase tracking-wider text-white">
                      <th className="px-3 py-2">Part No</th>
                      <th className="px-2 py-2">Description</th>
                      <th className="px-2 py-2">Supplier</th>
                      <th className="px-2 py-2">Required</th>
                      <th className="px-2 py-2">Expected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {seeAllParts.map((p) => (
                      <tr key={p.id} className="border-b border-sdc-border-soft/60">
                        <td className="px-3 py-1.5 font-mono text-note font-semibold text-sdc-navy">{p.pn}</td>
                        <td className="px-2 py-1.5 text-note text-sdc-gray-600" title={p.desc}><span className="line-clamp-1">{p.desc}</span></td>
                        <td className="px-2 py-1.5 text-note text-sdc-navy" title={p.supplier ?? "—"}><span className="line-clamp-1">{p.supplier ?? "—"}</span></td>
                        <td className="px-2 py-1.5 whitespace-nowrap font-mono text-label text-sdc-gray-600">{fmtDate(p.requiredDate)}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap font-mono text-label text-sdc-gray-600">{fmtDate(p.expectedDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </SidePanel>
          )
        );
      })()}
    </div>
  );
}

function SeeAllBtn({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-sdc-border bg-white px-2 py-1 text-note font-medium text-sdc-navy hover:bg-sdc-blue-light disabled:cursor-not-allowed disabled:opacity-40"
    >
      See all
    </button>
  );
}

// One compact row per (supplier, PO) group — the risk cards' own primary row
// shape (2026-08-14, by request — "group by PO instead of individual parts"),
// replacing the old per-part SlipRow/UpcomingRow/inline-No-PO-row. `dates`
// carries 1 or 2 {label, value, late?} entries so the same component serves
// all three cards: Delivery Slip and Upcoming each show two dates (mirroring
// the old SlipRow/UpcomingRow's own two-date layout, in each row's own
// order); No Purchase Order shows only Required, since there's no PO/
// Expected to speak of. `count` is the PO group's own `total` — never
// re-derived, so it can't disagree with what opening the drawer shows.
// `gridTemplateColumns` is inline rather than a Tailwind arbitrary class
// because the column count is dynamic (1 vs 2 date columns) — a Tailwind
// class has to be a static string the build can scan for, which a
// `dates.length`-shaped template can't be.
// ── The three risk cards share ONE mini-table (2026-08-28) ──────────────────
//
// Delivery Slip, No Purchase Order and Upcoming Deliveries used to render two
// different row shapes with different column counts — PoRiskRow was
// `PO | Supplier | count | dates…` (the date count varying per card) and
// PartRiskRow was `Part | Desc | Supplier | Required | Expected`. Neither had
// a header, neither showed Qty, and no two cards lined up with each other.
//
// One template, one header, one row component, both grouping modes:
//
//     PO # / Part # | Qty | Description | Supplier | Required | Expected
//
// Every value comes from the field the Parts List already reads — `p.qty`
// through `num()`, `p.desc`, `p.supplier`, `p.requiredDate`, `p.expectedDate`,
// and `fmtDate` from po-detail — so there is no second definition of any
// column here, only a second place they are laid out.
// Widths tuned so no HEADER label truncates at the narrowest the cards get
// (three across from 1280px, minus the sidebar). Values still truncate with the
// full text on hover — that is expected for a description; a truncated column
// HEADING is not, and the first cut of this read "DESCRIPTI…".
//
// Description and Supplier are the two flexible columns, description weighted
// heavier, because they are the only ones whose content has no natural width.
const RISK_COLS = "minmax(0,78px) minmax(0,32px) minmax(62px,1.35fr) minmax(54px,1fr) minmax(0,54px) minmax(0,56px)";
const RISK_ROW = "grid items-center gap-2 px-4";

function RiskTableHead() {
  return (
    <div
      className={`${RISK_ROW} border-b border-sdc-border bg-sdc-gray-50 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.04em] text-sdc-muted`}
      style={{ gridTemplateColumns: RISK_COLS }}
      role="row"
    >
      <span className="truncate" title="Purchase order number, or the part number when there is no PO">PO # / Part #</span>
      <span className="truncate text-right">Qty</span>
      <span className="truncate" title="Description">Desc</span>
      <span className="truncate">Supplier</span>
      <span className="truncate text-right">Required</span>
      <span className="truncate text-right">Expected</span>
    </div>
  );
}

/**
 * One row of the mini-table.
 *
 * `ident` is the PO number when the row HAS one and the part number otherwise —
 * never the literal "No PO", which is not an identifier and told the reader
 * nothing the card's own title had not already said.
 */
function RiskTableRow({
  ident,
  identIsPo,
  qty,
  desc,
  supplier,
  requiredDate,
  expectedDate,
  expectedLate,
  title,
  onClick,
}: {
  ident: string;
  identIsPo: boolean;
  qty: number;
  desc: string;
  supplier: string;
  requiredDate: string | null;
  expectedDate: string | null;
  expectedLate?: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      title={title}
      role="row"
      className={`${RISK_ROW} cursor-pointer border-b border-sdc-border-soft/60 py-1 last:border-b-0 hover:bg-sdc-blue-light/30`}
      style={{ gridTemplateColumns: RISK_COLS }}
    >
      <span
        className={`truncate font-mono text-note font-semibold ${identIsPo ? "text-sdc-blue" : "text-sdc-navy"}`}
        title={identIsPo ? `PO ${ident}` : `Part ${ident}`}
      >
        {ident}
      </span>
      {/* num(p.qty), the Parts List's own qty cell. */}
      <span className="truncate text-right font-mono text-label tabular-nums text-sdc-navy">{num(qty)}</span>
      <span className="truncate text-note text-sdc-gray-600" title={desc}>{desc || "—"}</span>
      <span className="truncate text-note text-sdc-navy" title={supplier}>{supplier || "—"}</span>
      <span className="truncate text-right font-mono text-label text-sdc-gray-600" title={`Required ${fmtDate(requiredDate)}`}>
        {fmtDate(requiredDate)}
      </span>
      <span
        className={`truncate text-right font-mono text-label ${expectedLate ? "font-semibold text-sdc-red-text" : "text-sdc-gray-600"}`}
        title={`Expected ${fmtDate(expectedDate)}`}
      >
        {fmtDate(expectedDate)}
      </span>
    </div>
  );
}

/**
 * PO-grouping mode: one row per PO, on the same six columns.
 *
 * A PO covers several parts, so Qty is the group's summed quantity and
 * Description says how many parts it is — except for a single-part PO, where
 * the part's own description is more useful than "1 part".
 */
function PoRiskRow({
  poNumber,
  supplier,
  parts,
  expected,
  pastDue,
  onClick,
}: {
  poNumber: string | null;
  supplier: string;
  parts: FlatPart[];
  expected: string | null;
  pastDue?: boolean;
  onClick: () => void;
}) {
  const qty = parts.reduce((t, p) => t + (Number(p.qty) || 0), 0);
  const desc = parts.length === 1 ? parts[0].desc : `${parts.length} parts`;
  // A group with no PO number is the "unassigned" bucket — identify it by its
  // first part rather than by the words "No PO".
  const ident = poNumber ?? parts[0]?.pn ?? "—";
  return (
    <RiskTableRow
      ident={ident}
      identIsPo={poNumber !== null}
      qty={qty}
      desc={desc}
      supplier={supplier}
      requiredDate={earliestRequired(parts)}
      expectedDate={expected}
      expectedLate={pastDue}
      title={poNumber ? "Open PO details" : "Open these parts"}
      onClick={onClick}
    />
  );
}

// Part-mode equivalent — one row per individual part, no PO grouping. Unlike
// every PO-mode row, there's no drawer to open here (there may not even be a
// single PO behind the row), so clicking jumps to this exact part's row in the
// Parts List below via onJumpToPart.
function PartRiskRow({ part, onClick }: { part: FlatPart; onClick: () => void }) {
  // PO number when the part has one, its part number otherwise — so the
  // No Purchase Order card always identifies a row by something real.
  const po = part.poNumber ?? part.poId ?? null;
  return (
    <RiskTableRow
      ident={po ? String(po) : part.pn}
      identIsPo={po !== null}
      qty={part.qty}
      desc={part.desc}
      supplier={part.supplier ?? ""}
      requiredDate={part.requiredDate}
      expectedDate={part.expectedDate}
      title="Locate this part in the Parts List"
      onClick={onClick}
    />
  );
}

// ── Small filter controls ────────────────────────────────────────────────────

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="inline-flex h-8 items-center rounded-md border border-sdc-border bg-white p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`h-7 rounded px-2.5 text-xs font-medium motion-interactive ${
            value === o.value ? "bg-sdc-blue-light text-sdc-blue-dark" : "text-sdc-gray-600 hover:text-sdc-navy"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function FilterSelect({ value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  const active = value !== FILTER_ALL;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`h-8 max-w-[160px] rounded-md border bg-white px-2 text-xs font-medium outline-none focus:border-sdc-blue ${
        active ? "border-sdc-blue text-sdc-blue-dark" : "border-sdc-border text-sdc-gray-600"
      }`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

// Status filter — checkbox multi-select (by request: allow more than one
// status selected at once). Modeled on the Columns menu above rather than on
// FilterSelect's native <select>: a <select> has no way to show checkboxes or
// stay open across several picks in a row, and this needs both. Same
// stay-open-until-outside-click `<details>` pattern, its own ref/effect so it
// doesn't interfere with the Columns menu's.
function StatusFilter({ value, onChange }: { value: Set<StatusKey>; onChange: (updater: (prev: Set<StatusKey>) => Set<StatusKey>) => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const el = ref.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const allSelected = value.size >= ALL_STATUS_KEYS.length;
  const toggle = (key: StatusKey) =>
    onChange((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <details ref={ref} className="relative">
      <summary className={`flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border px-3 text-xs font-medium hover:bg-sdc-blue-light ${allSelected ? "border-sdc-border bg-white text-sdc-navy" : "border-sdc-blue bg-sdc-blue-light text-sdc-blue-dark"}`}>
        Status
        {!allSelected && (
          <span className="inline-flex min-w-[16px] items-center justify-center rounded-full bg-sdc-blue px-1 text-label font-bold text-white tabular-nums">
            {value.size}
          </span>
        )}
        <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6 L8 11 L13 6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </summary>
      <div className="absolute left-0 z-20 mt-1 w-52 overflow-auto styled-scrollbar rounded-lg border border-sdc-border bg-white p-1.5 shadow-lg">
        {STATUS_FILTER_OPTIONS.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-sdc-navy hover:bg-sdc-blue-light">
            <input type="checkbox" checked={value.has(o.value)} onChange={() => toggle(o.value)} />
            {o.label}
          </label>
        ))}
        <div className="mt-1.5 flex flex-wrap gap-2 border-t border-sdc-border-soft pt-1.5">
          <button type="button" onClick={() => onChange(() => new Set(ALL_STATUS_KEYS))} className="rounded-md border border-sdc-border bg-white px-2 py-1 text-note font-medium text-sdc-navy hover:bg-sdc-blue-light">
            Select all
          </button>
          <button type="button" onClick={() => onChange(() => new Set())} className="rounded-md border border-sdc-border bg-white px-2 py-1 text-note font-medium text-sdc-navy hover:bg-sdc-blue-light">
            Clear
          </button>
        </div>
      </div>
    </details>
  );
}
