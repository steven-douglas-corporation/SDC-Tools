"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import {
  computeJobCost,
  isUtilityJob,
  type CostRates,
  type JobCostComputed,
  type JobCostRow,
  type JobHourAllocation,
  type YearRateOverrides,
} from "@/lib/job-cost";
import { saveDefaultRate, saveYearRateOverride, clearAllYearRateOverrides, saveJobHourAllocation, clearJobHourAllocation } from "@/lib/job-cost-actions";
import { exportJobCostRows } from "@/lib/export/job-cost-export";
import {
  BUTTON_COMPACT,
  BUTTON_MENU_LINK,
  TOOLBAR_BTN_COMPACT,
  TOOLBAR_BTN_ACTIVE,
  TOOLBAR_BTN_NEUTRAL,
  BTN_H_COMPACT,
  GRID_SCROLLER,
  busySlot,
} from "@/components/ui/classnames";
import { usd, hours } from "@/components/ui/format";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { MenuStatus, MenuGroup, MenuBulkActions, MenuCheckbox } from "@/components/MenuStatus";
import { SortableTh } from "@/components/ui/SortableHeader";
import type { SortState } from "@/lib/table-sort";
import { JobCostRateMatrixModal } from "@/components/JobCostRateMatrixModal";
import { JobCostHourAllocationModal } from "@/components/JobCostHourAllocationModal";

type ColKey =
  | "customerName" | "actualHours" | "engineeringHours" | "shopHours" | "otherHours"
  | "pmCost" | "mfgCost" | "laborCost" | "etcEngHours" | "etcShopHours" | "etcPartsCost"
  | "partCost" | "partInvoiced" | "percentComplete" | "salesPrice" | "startDate" | "completeDate"
  | "profit" | "margin";

type SortKey = ColKey | "jobId" | "jobName" | "status";

// ── Compact toolbar controls (2026-08-10) ────────────────────────────────────
//
// Built fresh rather than layering size overrides onto the shared INPUT token:
// INPUT already sets padding/font-size of its own (px-3.5 py-2.5 text-sm), and
// two Tailwind classes for the SAME property (INPUT's text-sm and an appended
// text-xs) don't reliably resolve by which one is written last — Tailwind
// orders generated utilities by its own rules, not by string position. Writing
// each property exactly once, at the compact size, avoids that ambiguity
// entirely instead of hoping an override wins.
const COMPACT_SELECT = `${BTN_H_COMPACT} rounded-md border border-sdc-border bg-white px-2 text-xs text-sdc-navy shadow-sm motion-interactive outline-none focus:border-sdc-blue focus:ring-2 focus:ring-sdc-blue/15`;

// ── Column groups, for scanning — not decoration (2026-08-10) ────────────────
//
// Five groups plus the identity block (Job Id/Name/Customer/Status), each with a
// SOFT tint derived from the existing SDC palette rather than a new one: Hours
// reuses the brand blue, Parts and ETC reuse the exact tints the Monthly ETC grid
// already uses for its own Parts Cost / ETC bands (etc/page.tsx), so a manager who
// knows that grid recognises these on sight. Labor $ and Sales/Margin get their own
// soft washes (navy, lime) since nothing already claims those roles. All five are
// `-bg`/opacity-modified tokens, never a saturated fill — see GROUP_META below.
type GroupKey = "identity" | "hours" | "labor" | "etc" | "parts" | "sales";

const GROUP_META: Record<GroupKey, { label: string; band: string; text: string }> = {
  identity: { label: "Job", band: "bg-sdc-gray-100", text: "text-sdc-gray-600" },
  hours: { label: "Hours", band: "bg-sdc-blue-light", text: "text-sdc-blue-dark" },
  labor: { label: "Labor $", band: "bg-sdc-navy/5", text: "text-sdc-navy" },
  etc: { label: "ETC", band: "bg-sdc-yellow-bg", text: "text-sdc-yellow-text" },
  parts: { label: "Parts", band: "bg-sdc-green-bg", text: "text-sdc-green-text" },
  sales: { label: "Sales / Margin", band: "bg-sdc-lime/15", text: "text-sdc-navy" },
};

// Column widths, as tokens rather than per-cell literals — one width per shape of
// data, so every hour column lines up with every other hour column regardless of
// which happen to be visible. Same idea as classnames.ts's ETC_COL_W/PARTS_COL_W
// (reused directly below); these two are local because nothing outside this table
// has a percent or a bare year to size for.
const PCT_COL_W = "w-[64px] min-w-[64px]";
const YEAR_COL_W = "w-[56px] min-w-[56px]";

type ColMeta = {
  key: ColKey;
  label: string;
  group: GroupKey;
  type: "hours" | "currency" | "number" | "date" | "text";
  widthClass: string;
};

// Customer's own `type`/`widthClass` below are dead for RENDERING — it's
// pulled out of this array and given its own hardcoded <SortableTh> in the
// identity block (see the header row), same as Job Id/Name/Status are. It
// stays IN this array only because handleExport's `visibleKeys` reads
// COLS.filter(...).map(c => c.key), and Customer has to be one of those keys
// to be exportable when shown.
const COLS: ColMeta[] = [
  { key: "customerName", label: "Customer", group: "identity", type: "text", widthClass: "min-w-[9rem]" },
  { key: "actualHours", label: "Act Hrs", group: "hours", type: "hours", widthClass: "w-[64px] min-w-[64px]" },
  { key: "engineeringHours", label: "Eng Hrs", group: "hours", type: "hours", widthClass: "w-[64px] min-w-[64px]" },
  { key: "shopHours", label: "Shop Hrs", group: "hours", type: "hours", widthClass: "w-[64px] min-w-[64px]" },
  { key: "otherHours", label: "Other Hrs", group: "hours", type: "hours", widthClass: "w-[64px] min-w-[64px]" },
  { key: "pmCost", label: "PM $", group: "labor", type: "currency", widthClass: "w-[96px] min-w-[96px]" },
  { key: "mfgCost", label: "Mfg $", group: "labor", type: "currency", widthClass: "w-[96px] min-w-[96px]" },
  { key: "laborCost", label: "Labor $", group: "labor", type: "currency", widthClass: "w-[96px] min-w-[96px]" },
  { key: "etcEngHours", label: "ETC Eng", group: "etc", type: "hours", widthClass: "w-[64px] min-w-[64px]" },
  { key: "etcShopHours", label: "ETC Shop", group: "etc", type: "hours", widthClass: "w-[64px] min-w-[64px]" },
  { key: "etcPartsCost", label: "ETC Parts", group: "etc", type: "currency", widthClass: "w-[96px] min-w-[96px]" },
  { key: "partCost", label: "Parts Purchased", group: "parts", type: "currency", widthClass: "w-[96px] min-w-[96px]" },
  { key: "partInvoiced", label: "Parts Invoiced", group: "parts", type: "currency", widthClass: "w-[96px] min-w-[96px]" },
  { key: "percentComplete", label: "% Complete", group: "sales", type: "number", widthClass: PCT_COL_W },
  { key: "salesPrice", label: "Sales $", group: "sales", type: "currency", widthClass: "w-[96px] min-w-[96px]" },
  { key: "startDate", label: "Start", group: "sales", type: "date", widthClass: YEAR_COL_W },
  { key: "completeDate", label: "Complete", group: "sales", type: "date", widthClass: YEAR_COL_W },
  { key: "profit", label: "Profit", group: "sales", type: "currency", widthClass: "w-[96px] min-w-[96px]" },
  { key: "margin", label: "Margin", group: "sales", type: "number", widthClass: PCT_COL_W },
];

// Header text for the three columns whose two-word label doesn't fit an
// ~96px money column on one line without mid-word wrapping ("Parts Purcha-
// sed"). A deliberate line break beats the browser's own — reported directly
// against these three by name.
const WRAP_LABEL: Partial<Record<ColKey, [string, string]>> = {
  partCost: ["Parts", "Purchased"],
  partInvoiced: ["Parts", "Invoiced"],
  percentComplete: ["%", "Complete"],
};

function headerLabel(key: ColKey, label: string) {
  const wrap = WRAP_LABEL[key];
  if (!wrap) return label;
  return (
    <>
      {wrap[0]}
      <br />
      {wrap[1]}
    </>
  );
}

const HIDDEN_COLS_KEY = "job-cost-explorer-hidden-cols";

// Fixed lead-in order for the status picker — matches every other status
// control in the app (e.g. the Projects grid's own status <select>). Anything
// not in this list (a status this app didn't anticipate) sorts alphabetically
// after these three, rather than being silently omitted.
const STATUS_ORDER = ["Active", "HeadStart", "Complete"];

const fmtNum = (n: number | null) => (n == null ? "—" : hours(n));
// usd() places the sign before the symbol ("-$5,000"); the hand-rolled version
// this replaced built "$" + a signed number string, so a loss rendered "$-5,000"
// — right figure, wrong reading order. Same numbers, corrected punctuation.
const fmtMoney = (n: number | null) => (n == null ? "—" : usd(n));
const fmtPct = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}%`);

// Same three-way status convention the Projects grid already uses
// (lib/quoted-tone.ts's neighbour, inlined here since it's two lines and this
// is the only other place it's needed): Complete is done-and-fine (green),
// HeadStart is intent-not-yet-authorised (amber), everything else is a normal
// running job (blue). A pill, not plain text, so status reads at a glance in
// a column that's otherwise all numbers.
function statusTone(status: string): string {
  if (status === "Complete") return "bg-sdc-green-bg text-sdc-green-text";
  if (status === "HeadStart") return "bg-sdc-yellow-bg text-sdc-yellow-text";
  return "bg-sdc-blue-light text-sdc-blue-dark";
}

// One frozen pane: Job Id + Job Name. Status and Customer stay in the normal
// scrolling flow, immediately after the freeze boundary — freezing them too was
// optional per spec, and a THIRD frozen column sitting between two others that
// don't freeze isn't geometrically possible (a sticky-left pane has to be a
// contiguous run of the leftmost columns), so extending it further would have
// meant reordering Status ahead of Customer. Two frozen columns already answers
// "which job is this row" while scrolling through fifteen numeric ones, which is
// the actual problem being solved.
const JOB_ID_COL_W = "w-24 min-w-24 max-w-24"; // 6rem
const JOB_NAME_COL_W = "w-56 min-w-56 max-w-56"; // 14rem
const JOB_NAME_LEFT = "left-24"; // = JOB_ID_COL_W's width, so the pane has no gap (§ sticky-column rem-offset gotcha)

type HeaderSlot = { key: string; group: GroupKey; frozen: boolean };

export function JobCostExplorer({
  rows,
  defaultRates,
  yearRateOverrides,
  hourAllocations,
  inventoryAsOf,
  etcRefreshedThru,
  partsCostAvailable,
  asOf,
  inventoryMissing,
  etcMissing,
  asOfOptions,
}: {
  rows: JobCostRow[];
  defaultRates: CostRates;
  yearRateOverrides: YearRateOverrides;
  hourAllocations: Record<string, JobHourAllocation>;
  inventoryAsOf: string | null;
  /** The submitted ETC month actually used ("YYYY-MM"), or null if none qualified. */
  etcRefreshedThru: string | null;
  partsCostAvailable: boolean;
  /** The applied month-end snapshot ("YYYY-MM-DD"), or null for Current. */
  asOf: string | null;
  inventoryMissing: boolean;
  etcMissing: boolean;
  /** Available month-end dates for the picker, descending. */
  asOfOptions: string[];
}) {
  // Optimistic local mirror of the shared server state: a modal's "Apply"
  // updates this immediately so the table recalculates with no round trip
  // (the original app's own design principle — "changing an assumption is
  // instant and needs no re-query"), while the underlying save persists in
  // the background. When another tab's edit lands, a realtime-triggered
  // refresh gives this component fresh props, and the effects below
  // reconcile local state back to the authoritative server value.
  // Set-state-during-render (not an effect) to resync when the SERVER prop
  // itself changes identity — same technique useDrillFilters.ts uses for its
  // resetKey. An effect here would apply the update one frame late, which
  // for these three is a real, if brief, "another tab's edit didn't land"
  // window rather than a cosmetic one.
  const [rates, setRates] = useState(defaultRates);
  const [seenDefaultRates, setSeenDefaultRates] = useState(defaultRates);
  if (seenDefaultRates !== defaultRates) {
    setSeenDefaultRates(defaultRates);
    setRates(defaultRates);
  }
  const [overrides, setOverrides] = useState(yearRateOverrides);
  const [seenOverrides, setSeenOverrides] = useState(yearRateOverrides);
  if (seenOverrides !== yearRateOverrides) {
    setSeenOverrides(yearRateOverrides);
    setOverrides(yearRateOverrides);
  }
  const [allocations, setAllocations] = useState(hourAllocations);
  const [seenAllocations, setSeenAllocations] = useState(hourAllocations);
  if (seenAllocations !== hourAllocations) {
    setSeenAllocations(hourAllocations);
    setAllocations(hourAllocations);
  }

  // The As-of picker navigates rather than holding local state — unlike the
  // other filters below, changing it needs a fresh SERVER fetch (the ROWS
  // themselves change per snapshot, not just which are shown), the same
  // client-nav-triggers-server-refetch pattern the ETC grid's own month picker
  // (MonthYearSelect) already uses. asOf/asOfOptions come from props, not
  // local state, precisely because the server is the one source of truth for
  // "what does this snapshot look like".
  const router = useRouter();
  const pathname = usePathname();
  function handleAsOfChange(value: string) {
    router.push(value === "current" ? pathname : `${pathname}?asOf=${value}`);
  }
  function formatAsOfOption(d: string): string {
    const [y, m, day] = d.split("-");
    return `${m}/${day}/${y}`;
  }

  const [search, setSearch] = useState("");
  // Empty means "All statuses"/"All customers"/"All years" — not "nothing
  // matches". Sets, not arrays or a single string, so all three filters are
  // the same shape (2026-08-12, by request — "the same consistent multi-select
  // UX") and toggling one value is an O(1) add/delete rather than a
  // filter-and-rebuild on every click, on every one of them.
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [yearFilter, setYearFilter] = useState<Set<string>>(new Set());
  const [customerFilter, setCustomerFilter] = useState<Set<string>>(new Set());
  const [hideUtility, setHideUtility] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("jobId");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const [hiddenCols, setHiddenCols] = useState<Set<ColKey>>(new Set());
  useEffect(() => {
    // Deliberately an effect, not a lazy useState initializer: localStorage
    // isn't available during the server render, and reading it in the
    // initializer would make the client's first (hydration) render disagree
    // with the server's, which React flags as a hydration mismatch. This way
    // hydration always matches (both start from the same empty Set), and the
    // real value applies in the one harmless re-render right after.
    try {
      const saved = JSON.parse(localStorage.getItem(HIDDEN_COLS_KEY) || "[]");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (Array.isArray(saved)) setHiddenCols(new Set(saved));
    } catch {
      // localStorage unavailable or corrupt — start with every column shown.
    }
  }, []);
  function toggleCol(key: ColKey) {
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(HIDDEN_COLS_KEY, JSON.stringify([...next]));
      } catch {
        // Not fatal — the picker just won't remember across visits.
      }
      return next;
    });
  }
  function showAllCols() {
    setHiddenCols(new Set());
    try {
      localStorage.setItem(HIDDEN_COLS_KEY, JSON.stringify([]));
    } catch {
      // Same non-fatal case as toggleCol.
    }
  }
  function hideAllCols() {
    const all = new Set(COLS.map((c) => c.key));
    setHiddenCols(all);
    try {
      localStorage.setItem(HIDDEN_COLS_KEY, JSON.stringify([...all]));
    } catch {
      // Same non-fatal case as toggleCol.
    }
  }

  const [rateMatrixOpen, setRateMatrixOpen] = useState(false);
  const [allocationJobId, setAllocationJobId] = useState<string | null>(null);

  // Columns dropdown — a <details> (same mechanism the Filters menu below
  // uses), not the useState toggle this replaced. A native <details> gives
  // "click the button again to close" for free; this effect adds the other
  // two closes the spec calls for that <details> doesn't do on its own.
  const colPickerRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (colPickerRef.current?.open && !colPickerRef.current.contains(e.target as Node)) colPickerRef.current.open = false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && colPickerRef.current?.open) colPickerRef.current.open = false;
    }
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // Filters dropdown — Status, Customer, Completion Year, consolidated into
  // one button (2026-08-12, by request — the toolbar had six separate
  // filter-shaped controls before As-of/Hide-utility even start). Same
  // click-outside/Escape mechanism as Columns above, and for the same reason
  // it matters MORE here than there: this panel holds three independent
  // multi-selects, and closing on the first checkbox ticked (any one of
  // Status/Customer/Year) would make "set all 3 without leaving the
  // dropdown" — the one thing this redesign exists to do — impossible. Only
  // a click truly outside the panel closes it; every click inside, including
  // every checkbox in all three groups, does not.
  const filtersRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (filtersRef.current?.open && !filtersRef.current.contains(e.target as Node)) filtersRef.current.open = false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && filtersRef.current?.open) filtersRef.current.open = false;
    }
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // Export dropdown — CSV/Excel, one button (2026-08-12, by request,
  // replacing two separate buttons). Unlike Columns/Filters above, picking an
  // option here is a complete action, not one tick among several — so each
  // option's own onClick closes the menu itself (see the JSX below) instead
  // of leaving it open the way a multi-select would. This effect still
  // covers the case that action-close doesn't: a click that lands OUTSIDE
  // the menu without picking anything.
  const exportRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (exportRef.current?.open && !exportRef.current.contains(e.target as Node)) exportRef.current.open = false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && exportRef.current?.open) exportRef.current.open = false;
    }
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const computed = useMemo<JobCostComputed[]>(
    () => rows.map((r) => computeJobCost(r, rates, overrides, allocations[r.jobId])),
    [rows, rates, overrides, allocations],
  );

  const customers = useMemo(
    () => [...new Set(computed.map((r) => r.customerName).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b)),
    [computed],
  );
  // Whatever statuses actually exist on real rows — not a hardcoded
  // Active/HeadStart/Complete literal — so a status this app adds later shows
  // up in the picker on its own. STATUS_ORDER (module scope, below) puts
  // Active/HeadStart/Complete first in that fixed order, then anything else
  // alphabetically after.
  const allStatuses = useMemo(() => {
    const present = [...new Set(computed.map((r) => r.status))];
    return present.sort((a, b) => {
      const ai = STATUS_ORDER.indexOf(a);
      const bi = STATUS_ORDER.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });
  }, [computed]);
  const years = useMemo(
    () => [...new Set(computed.filter((r) => r.completeDate).map((r) => r.completeDate!.slice(0, 4)))].sort((a, b) => b.localeCompare(a)),
    [computed],
  );

  // "Narrowing" means the same thing for each of the three it always did
  // (Status: some but not all statuses picked; Customer/Year: anything but
  // the "All" option) — this just adds the three booleans together into the
  // one badge count the consolidated Filters button needs, rather than each
  // filter reporting its own count independently the way it did as three
  // separate buttons.
  const statusNarrowing = statusFilter.size > 0 && statusFilter.size < allStatuses.length;
  const customerNarrowing = customerFilter.size > 0 && customerFilter.size < customers.length;
  const yearNarrowing = yearFilter.size > 0 && yearFilter.size < years.length;
  const activeFilterCount = (statusNarrowing ? 1 : 0) + (customerNarrowing ? 1 : 0) + (yearNarrowing ? 1 : 0);
  function clearAllFilters() {
    setStatusFilter(new Set());
    setCustomerFilter(new Set());
    setYearFilter(new Set());
  }

  const visibleRows = useMemo(() => {
    const terms = search.toLowerCase().split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    let out = computed
      .filter((r) => !(hideUtility && isUtilityJob(r.jobId)))
      .filter((r) => statusFilter.size === 0 || statusFilter.has(r.status))
      .filter((r) => yearFilter.size === 0 || (r.completeDate != null && yearFilter.has(r.completeDate.slice(0, 4))))
      .filter((r) => customerFilter.size === 0 || (r.customerName != null && customerFilter.has(r.customerName)))
      .filter((r) => !terms.length || terms.some((t) => `${r.jobId} ${r.jobName} ${r.customerName ?? ""} ${r.status}`.toLowerCase().includes(t)));
    out = [...out].sort((a, b) => {
      const av = a[sortKey as keyof JobCostComputed];
      const bv = b[sortKey as keyof JobCostComputed];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
      return String(av).localeCompare(String(bv)) * sortDir;
    });
    return out;
  }, [computed, search, statusFilter, yearFilter, customerFilter, hideUtility, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    setSortDir((d) => (sortKey === key ? ((-d) as 1 | -1) : 1));
    setSortKey(key);
  }
  // Adapter for SortableTh's display-only chevron — the comparator above is
  // untouched, this just describes its current state so every header (including
  // Job Id/Name/Status, previously plain onClick text) gets the same clear
  // asc/desc indicator instead of only some columns having one.
  const sortState: SortState<SortKey> = { key: sortKey, direction: sortDir === 1 ? "asc" : "desc" };

  async function applyDefaultRate(next: CostRates) {
    setRates(next);
    const fd = new FormData();
    fd.set("engRate", String(next.engRate));
    fd.set("shopRate", String(next.shopRate));
    fd.set("pmPct", String(next.pmPct));
    fd.set("mfgPct", String(next.mfgPct));
    await saveDefaultRate(fd);
  }
  async function applyYearOverride(year: string, partial: Partial<CostRates>) {
    setOverrides((prev) => ({ ...prev, [year]: partial }));
    const fd = new FormData();
    fd.set("year", year);
    if (partial.engRate != null) fd.set("engRate", String(partial.engRate));
    if (partial.shopRate != null) fd.set("shopRate", String(partial.shopRate));
    if (partial.pmPct != null) fd.set("pmPct", String(partial.pmPct));
    if (partial.mfgPct != null) fd.set("mfgPct", String(partial.mfgPct));
    await saveYearRateOverride(fd);
  }
  async function clearAllOverrides() {
    setOverrides({});
    await clearAllYearRateOverrides();
  }
  async function applyAllocation(jobId: string, alloc: JobHourAllocation | null) {
    setAllocations((prev) => {
      const next = { ...prev };
      if (alloc) next[jobId] = alloc;
      else delete next[jobId];
      return next;
    });
    if (alloc) await saveJobHourAllocation(jobId, alloc.eng, alloc.shop);
    else await clearJobHourAllocation(jobId);
  }

  const { toast } = useToast();
  const [exporting, setExporting] = useState<"csv" | "xlsx" | null>(null);

  async function handleExport(format: "csv" | "xlsx") {
    if (exporting) return;
    setExporting(format);
    try {
      const visibleKeys = COLS.filter((c) => !hiddenCols.has(c.key)).map((c) => c.key);
      const { base64, fileName, mime } = await exportJobCostRows(visibleRows, visibleKeys, format);
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      toast(`${fileName} downloaded.`, "success");
    } catch (err) {
      toast(err instanceof Error ? `Export failed — ${err.message}` : "Export failed.", "error");
    } finally {
      setExporting(null);
    }
  }

  const totals = useMemo(() => {
    const sum = (f: keyof JobCostComputed) => visibleRows.reduce((a, r) => a + (Number(r[f]) || 0), 0);
    return {
      actualHours: sum("actualHours"), engineeringHours: sum("engineeringHours"), shopHours: sum("shopHours"), otherHours: sum("otherHours"),
      pmCost: sum("pmCost"), mfgCost: sum("mfgCost"), laborCost: sum("laborCost"),
      etcEngHours: sum("etcEngHours"), etcShopHours: sum("etcShopHours"), etcPartsCost: sum("etcPartsCost"),
      partCost: sum("partCost"), partInvoiced: sum("partInvoiced"), salesPrice: sum("salesPrice"),
      profit: visibleRows.some((r) => r.profit != null) ? sum("profit") : null,
    };
  }, [visibleRows]);

  const activeJobForAllocation = allocationJobId ? computed.find((r) => r.jobId === allocationJobId) ?? null : null;

  // ── The group-band header row, derived rather than hand-spanned (2026-08-10) ──
  //
  // A run of consecutive VISIBLE columns sharing both a group AND frozen-ness
  // collapses into one colSpan band cell. Frozen-ness has to break a run even
  // when the group doesn't, because a single spanning <th> can only be sticky as
  // one box — Job Id/Job Name (frozen) and Customer/Status (not, even though
  // they're all "identity") can never share one cell or the freeze pane would
  // try to pin part of a cell that isn't pinned.
  const headerSlots = useMemo<HeaderSlot[]>(() => {
    const slots: HeaderSlot[] = [
      { key: "jobId", group: "identity", frozen: true },
      { key: "jobName", group: "identity", frozen: true },
    ];
    if (!hiddenCols.has("customerName")) slots.push({ key: "customerName", group: "identity", frozen: false });
    slots.push({ key: "status", group: "identity", frozen: false });
    for (const c of COLS) {
      if (c.key === "customerName" || hiddenCols.has(c.key)) continue;
      slots.push({ key: c.key, group: c.group, frozen: false });
    }
    return slots;
  }, [hiddenCols]);

  const bandCells = useMemo(() => {
    const out: { group: GroupKey; span: number; frozen: boolean }[] = [];
    for (const s of headerSlots) {
      const last = out[out.length - 1];
      if (last && last.group === s.group && last.frozen === s.frozen) last.span++;
      else out.push({ group: s.group, span: 1, frozen: s.frozen });
    }
    return out;
  }, [headerSlots]);

  // ── Column grid lines (2026-08-12, by request — "easier to distinguish
  // columns and column groups") ────────────────────────────────────────────
  //
  // Two tokens only, both already in this app's palette rather than a third
  // shade invented for this: sdc-border (#d9d9d9), already used for the
  // frozen-pane edge and the header's own border-b-2, becomes the STRONGER
  // group-boundary line; sdc-border-soft (#ececec), already this file's
  // "quiet row separator" on every body <td>, becomes the ordinary
  // between-column line. Reusing both is what keeps this "clean and
  // minimal" rather than noisy — nothing on the table gets a new color.
  const COL_BORDER_SOFT = "border-r border-sdc-border-soft";
  const COL_BORDER_STRONG = "border-r border-sdc-border";

  // Which column is the LAST one in its group, in the order the table
  // actually renders — derived from headerSlots (which already resolves
  // hiddenCols) rather than a hand-listed set of keys, so hiding a column via
  // the Columns picker can never leave a boundary line floating over a gap
  // where that column used to be, or silently drop the boundary because the
  // column that used to carry it disappeared. jobId/jobName never appear
  // here: they're both "identity", same as customerName/status, so the ONLY
  // real group boundary inside that band sits at whichever of those four is
  // rendered last (always "status", since it's never hidden) — Job Name's
  // own border-r is a SEPARATE, pre-existing concern (the frozen-pane edge)
  // and stays exactly as it already was, untouched by this.
  const groupBoundaryKeys = useMemo(() => {
    const out = new Set<string>();
    for (let idx = 0; idx < headerSlots.length - 1; idx++) {
      if (headerSlots[idx].group !== headerSlots[idx + 1].group) out.add(headerSlots[idx].key);
    }
    return out;
  }, [headerSlots]);
  // The table's own last visible column gets no border-r of its own — the
  // GRID_SCROLLER wrapper already draws that outer right edge, so one more
  // line right beside it would double it rather than add information.
  const lastColKey = headerSlots[headerSlots.length - 1]?.key;

  // One column's own vertical separator, called with the SAME key at every
  // tier this table has — the column-header row, every body row, and the
  // totals row (the band row above them draws its own boundary via colSpan
  // instead, so it never calls this) — so the line can never drift out of
  // alignment between tiers the way three independently hand-written copies
  // could.
  function vBorder(key: string): string {
    if (key === lastColKey) return "";
    return groupBoundaryKeys.has(key) ? COL_BORDER_STRONG : COL_BORDER_SOFT;
  }

  const visibleColCount = COLS.filter((c) => !hiddenCols.has(c.key)).length;
  const hiddenCount = COLS.length - visibleColCount;

  return (
    // Job Cost Explorer's own export-result toasts are suppressed app-wide per the
    // task's "no global side notifications from this area" — it has no critical-per-spec
    // call sites (see lib/notification-stack.ts's shouldSuppress for the bypass a
    // future critical one would need). Exports still succeed/fail identically; only the
    // global toast is silenced.
    //
    // SuppressToasts is NOT wrapped here. A component cannot supply its own
    // useToast() call — made above, in this component's OWN render scope — with a
    // Provider it renders as part of its own returned JSX: useContext resolves
    // against ANCESTORS at the point the hook actually runs, and a self-wrap is a
    // descendant of that point, not an ancestor. The wrap lives one level up, at
    // the call site in app/(app)/job-cost-explorer/page.tsx, which correctly makes
    // it an ancestor of this whole component.
    <div className="flex flex-col gap-2">
      {/* ── Toolbar (2026-08-11: baked into the tab, not a card) ────────────
          No card/border/background/shadow wraps this any more — it used to sit
          in its own bordered, shadowed, padded panel floating above the table,
          which read as a separate widget bolted onto the page rather than part
          of it. The Projects page (quoted/page.tsx) is the pattern every other
          Reports tab already follows: title, then a flat toolbar row, straight
          into the grid, nothing but margin between them. This now matches it.

          Every control also dropped a size tier — TOOLBAR_BTN/BUTTON_SECONDARY's
          2.4rem down to TOOLBAR_BTN_COMPACT/BUTTON_COMPACT's 1.9rem (the same
          geometry the app already uses for in-row/in-menu actions elsewhere) —
          reported directly: the controls were the same size as a full toolbar on
          a page that's supposed to feel like a dense report, not a form. */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
        <div className={`flex items-center gap-1.5 rounded-md border border-sdc-border bg-white px-2 ${BTN_H_COMPACT}`}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-sdc-gray-400">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            className="w-36 border-none bg-transparent text-xs text-sdc-navy outline-none placeholder:text-sdc-gray-400"
            placeholder="Search job, name, customer…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* As of / Month End — a snapshot selector, not a row filter, so it
            gets its own visually-distinct control (blue-tinted whenever it's
            not "Current", matching the other active-filter tint convention
            below) rather than blending into the status/customer/year group. */}
        <div className="flex items-center gap-1 border-l border-sdc-border-soft pl-1.5">
          <select
            className={`${COMPACT_SELECT} ${asOf ? "border-sdc-blue bg-sdc-blue-light/30 font-semibold" : ""}`}
            value={asOf ?? "current"}
            onChange={(e) => handleAsOfChange(e.target.value)}
            title="As of / Month End — recomputes hours, ETC, inventory and every cost figure as of that date"
          >
            <option value="current">Current</option>
            {asOfOptions.map((d) => (
              <option key={d} value={d}>{formatAsOfOption(d)}</option>
            ))}
          </select>
        </div>

        {/* Filters — Status, Customer, Completion Year, one button
            (2026-08-11, replacing three separate controls; upgraded to a
            matching multi-select on all three 2026-08-12, by request — "the
            same consistent multi-select UX"). Each keeps the SAME filter
            chain shape (visibleRows below): an empty Set means "no
            narrowing", exactly like Status already worked, which is why
            Customer and Completion Year could become Sets without changing
            what "combines with Status" means — every one of these three
            filters was already ANDed together; only what was inside each
            slot changed, from one string to a Set of them. */}
        <div className="flex items-center gap-1 border-l border-sdc-border-soft pl-1.5">
          <details ref={filtersRef} className="group relative inline-block">
            <summary className={`${TOOLBAR_BTN_COMPACT} ${activeFilterCount > 0 ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL}`}>
              {activeFilterCount > 0 ? `Filters (${activeFilterCount})` : "Filters"}
              <MenuStatus pending={false} />
            </summary>
            <div className="motion-menu-panel absolute left-0 top-full z-30 mt-1 w-64 rounded-lg border border-sdc-border bg-white p-2 shadow-lg">
              <div className="mb-1.5 flex items-center justify-between gap-2 border-b border-sdc-border-soft pb-1.5">
                <p className="text-xs font-semibold text-sdc-navy">Filters</p>
                <button
                  type="button"
                  className={BUTTON_MENU_LINK}
                  onClick={clearAllFilters}
                  disabled={activeFilterCount === 0}
                >
                  Clear all
                </button>
              </div>
              <MenuGroup label={statusNarrowing ? `Status (${statusFilter.size})` : "Status"}>
                <MenuBulkActions onAll={() => setStatusFilter(new Set(allStatuses))} onNone={() => setStatusFilter(new Set())} />
                <div className="max-h-40 overflow-y-auto styled-scrollbar">
                  {allStatuses.map((s) => (
                    <MenuCheckbox
                      key={s}
                      label={s}
                      checked={statusFilter.size === 0 || statusFilter.has(s)}
                      onChange={() =>
                        setStatusFilter((prev) => {
                          // Unchecking one box while every status is implicitly
                          // selected (the empty-Set "All" state) must read as
                          // "every status EXCEPT this one" — seed the full set
                          // first, so a single uncheck doesn't look like it
                          // selected two unrelated statuses out of nowhere.
                          const next = prev.size === 0 ? new Set(allStatuses) : new Set(prev);
                          if (next.has(s)) next.delete(s);
                          else next.add(s);
                          return next;
                        })
                      }
                    />
                  ))}
                </div>
              </MenuGroup>
              <MenuGroup label={customerNarrowing ? `Customer (${customerFilter.size})` : "Customer"}>
                <MenuBulkActions onAll={() => setCustomerFilter(new Set(customers))} onNone={() => setCustomerFilter(new Set())} />
                <div className="max-h-40 overflow-y-auto styled-scrollbar">
                  {customers.map((c) => (
                    <MenuCheckbox
                      key={c}
                      label={c}
                      checked={customerFilter.size === 0 || customerFilter.has(c)}
                      onChange={() =>
                        setCustomerFilter((prev) => {
                          // Same "seed the full set on first uncheck" rule as
                          // Status — an empty Set is implicitly every customer,
                          // so unchecking one from THAT state has to become
                          // "every customer except this one", not a set of one.
                          const next = prev.size === 0 ? new Set(customers) : new Set(prev);
                          if (next.has(c)) next.delete(c);
                          else next.add(c);
                          return next;
                        })
                      }
                    />
                  ))}
                </div>
              </MenuGroup>
              {years.length > 0 && (
                <MenuGroup label={yearNarrowing ? `Completion Year (${yearFilter.size})` : "Completion Year"}>
                  <MenuBulkActions onAll={() => setYearFilter(new Set(years))} onNone={() => setYearFilter(new Set())} />
                  <div className="max-h-40 overflow-y-auto styled-scrollbar">
                    {years.map((y) => (
                      <MenuCheckbox
                        key={y}
                        label={y}
                        checked={yearFilter.size === 0 || yearFilter.has(y)}
                        onChange={() =>
                          setYearFilter((prev) => {
                            const next = prev.size === 0 ? new Set(years) : new Set(prev);
                            if (next.has(y)) next.delete(y);
                            else next.add(y);
                            return next;
                          })
                        }
                      />
                    ))}
                  </div>
                </MenuGroup>
              )}
            </div>
          </details>
        </div>

        <div className="flex items-center border-l border-sdc-border-soft pl-1.5">
          <button
            type="button"
            aria-pressed={hideUtility}
            className={`${TOOLBAR_BTN_COMPACT} ${hideUtility ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL}`}
            onClick={() => setHideUtility((v) => !v)}
          >
            Hide utility jobs
          </button>
        </div>

        {/* Actions — visually secondary (BUTTON_COMPACT, not a filled primary)
            since none of them changes what's on screen the way the filters to
            their left do. */}
        <div className="ml-auto flex items-center gap-1.5">
          {/* Columns — a dropdown/popover (2026-08-11), replacing the always-
              expanded panel that used to push the whole page down. Same
              <details> + click-outside/Escape mechanism the Status and
              Group By menus above already use, so checking several boxes in
              a row doesn't reopen anything between clicks — it only closes
              on outside click, Escape, or clicking the button again. */}
          <details ref={colPickerRef} className="group relative inline-block">
            <summary
              className={`list-none cursor-pointer ${BUTTON_COMPACT} ${hiddenCount > 0 ? "border-sdc-blue bg-sdc-blue-light/30" : ""}`}
            >
              {hiddenCount > 0 ? `Columns (${visibleColCount} selected)` : "Columns"}
              <MenuStatus pending={false} />
            </summary>
            <div className="motion-menu-panel absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border border-sdc-border bg-white p-2 shadow-lg">
              <div className="mb-1.5 flex items-center justify-between gap-2 border-b border-sdc-border-soft pb-1.5">
                <p className="text-xs font-semibold text-sdc-navy">Choose columns</p>
                <div className="flex items-center gap-1">
                  <button type="button" className={BUTTON_MENU_LINK} onClick={showAllCols}>Select all</button>
                  <button type="button" className={BUTTON_MENU_LINK} onClick={hideAllCols}>Clear all</button>
                </div>
              </div>
              {/* Grouped by the same five bands the table header colors, each
                  with a small dot in that band's own hue — the picker teaches
                  the same grouping the table already shows, instead of one
                  undifferentiated wall of checkboxes. */}
              <div className="max-h-[calc(var(--app-vh)_*_0.6)] overflow-y-auto styled-scrollbar">
                {(["hours", "labor", "etc", "parts", "sales"] as const).map((g) => {
                  const cols = COLS.filter((c) => c.group === g);
                  if (cols.length === 0) return null;
                  const shown = cols.filter((c) => !hiddenCols.has(c.key)).length;
                  return (
                    <div key={g} className="border-b border-sdc-border-soft py-1.5 last:border-b-0">
                      <div className="mb-0.5 flex items-center gap-1.5 px-1.5">
                        <span className={`inline-block h-2 w-2 rounded-full ${GROUP_META[g].band}`} />
                        <span className="text-label font-semibold uppercase tracking-wider text-sdc-gray-400">{GROUP_META[g].label}</span>
                        <span className="ml-auto text-label tabular-nums text-sdc-gray-400">{shown}/{cols.length}</span>
                      </div>
                      {cols.map((c) => (
                        <MenuCheckbox key={c.key} label={c.label} checked={!hiddenCols.has(c.key)} onChange={() => toggleCol(c.key)} />
                      ))}
                    </div>
                  );
                })}
                {/* Customer lives in the identity block on the table itself, but
                    it's the one identity column that's actually optional — kept
                    in the picker under its own small heading rather than folded
                    into one of the five colored groups it doesn't belong to. */}
                <div className="py-1.5">
                  <div className="mb-0.5 flex items-center gap-1.5 px-1.5">
                    <span className={`inline-block h-2 w-2 rounded-full ${GROUP_META.identity.band}`} />
                    <span className="text-label font-semibold uppercase tracking-wider text-sdc-gray-400">Job</span>
                    <span className="ml-auto text-label tabular-nums text-sdc-gray-400">{hiddenCols.has("customerName") ? 0 : 1}/1</span>
                  </div>
                  <MenuCheckbox label="Customer" checked={!hiddenCols.has("customerName")} onChange={() => toggleCol("customerName")} />
                </div>
              </div>
            </div>
          </details>
          {/* Export — one dropdown, replacing separate CSV/Excel buttons
              (2026-08-12, by request). Same shell as Columns; the CSV/Excel
              choice moves from "which of two buttons" to "which of two menu
              rows", and handleExport itself is untouched — each row calls the
              exact same function with the exact same format argument the old
              buttons did, so the export behavior (file contents, filename,
              toast, error handling) carries over unchanged. */}
          <details ref={exportRef} className="group relative inline-block">
            <summary className={`list-none cursor-pointer ${BUTTON_COMPACT}`}>
              <span className={busySlot("min-w-[4.5rem]")}>{exporting ? "Preparing…" : "Export"}</span>
              <MenuStatus pending={false} />
            </summary>
            <div className="motion-menu-panel absolute right-0 top-full z-30 mt-1 w-36 rounded-lg border border-sdc-border bg-white p-1 shadow-lg">
              <button
                type="button"
                disabled={exporting !== null}
                className="w-full rounded px-1.5 py-1.5 text-left text-xs text-sdc-navy hover:bg-sdc-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                  if (exportRef.current) exportRef.current.open = false;
                  handleExport("csv");
                }}
              >
                Export CSV
              </button>
              <button
                type="button"
                disabled={exporting !== null}
                className="w-full rounded px-1.5 py-1.5 text-left text-xs text-sdc-navy hover:bg-sdc-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                  if (exportRef.current) exportRef.current.open = false;
                  handleExport("xlsx");
                }}
              >
                Export Excel
              </button>
            </div>
          </details>
          <button className={BUTTON_COMPACT} onClick={() => setRateMatrixOpen(true)}>Rate Matrix</button>
        </div>
      </div>

      <p className="text-note text-sdc-gray-400">
        {visibleRows.length} jobs
        {inventoryAsOf && ` · Sales/% complete as of ${inventoryAsOf}`}
        {etcRefreshedThru && ` · Submitted ETC for ${etcRefreshedThru}`}
      </p>
      {!partsCostAvailable && (
        <p className="rounded border border-sdc-yellow bg-sdc-yellow-bg px-2 py-1 text-note text-sdc-yellow-text">
          Total ETO didn&apos;t respond in time for Parts Purchased/Invoiced — those columns show &ldquo;—&rdquo; below. Everything else on this page is unaffected; try again shortly.
        </p>
      )}
      {/* Missing-data states — a banner, never a silent fall-forward into a
          newer/incomplete month. Only meaningful once a specific As-of date is
          picked; Current always has SOME latest snapshot to fall back to (or
          this app has no ETC/inventory data at all, an unrelated problem). */}
      {asOf && inventoryMissing && (
        <p className="rounded border border-sdc-yellow bg-sdc-yellow-bg px-2 py-1 text-note text-sdc-yellow-text">
          No inventory snapshot on or before {asOf} — % Complete/Sales $ show &ldquo;—&rdquo; below rather than a later month&apos;s figures.
        </p>
      )}
      {asOf && etcMissing && (
        <p className="rounded border border-sdc-yellow bg-sdc-yellow-bg px-2 py-1 text-note text-sdc-yellow-text">
          No submitted ETC report on or before {asOf} — ETC Eng/Shop/Parts show &ldquo;—&rdquo; below rather than a later month&apos;s figures. Actual/Eng/Shop/Other Hours are unaffected — they come from this app&apos;s own ledger, not the ETC submission.
        </p>
      )}

      {visibleRows.length === 0 ? (
        <EmptyState title="No jobs match the current filters" message="Try clearing a filter or the search box." />
      ) : (
        /* 87.5rem = header (2 rows) + 40 body rows + the totals row at this
           table's own (now-compact) row height, measured live: 51.29px header +
           40 × 30.23px body rows + 25.81px totals ≈ 1286px ≈ 85.7rem at the 15px
           root — rounded up a further ~1.8rem past that so the 40th row clears
           fully (verified live: 85.7rem exactly rendered 39 full rows, the 40th
           clipped by sub-pixel rounding in the browser's own row-height math).
           Wrapped in min() with the existing viewport-relative cap rather than
           switching to it outright — on a normal laptop viewport, 40 rows of
           even this compact height plus the title/toolbar above them (measured
           ≈ 131.6px) exceeds the viewport itself, and forcing that height would
           make the PAGE scroll behind the grid's own scrollbar, which no other
           grid in this app does and which "avoid unnecessary...scrolling" rules
           out on its own terms. The min() keeps today's safe, viewport-relative
           behavior as the FLOOR on a normal screen, while capping at 40 rows'
           worth on any screen tall enough to otherwise show more. */
        <div data-scroll-key="profitability-grid" className={`${GRID_SCROLLER} rounded-xl max-h-[min(87.5rem,calc(var(--app-vh)_-_11rem))]`}>
          {/* Still not TABLE_GRID (2026-08-12): that token draws a uniform
              #808080 line around every cell, which is the right call for the
              Projects/Monthly ETC grids (people EDIT cells there, and a
              spreadsheet look sets that expectation) but would be exactly
              the "visual noise" this READ-ONLY, report-style table was
              built to avoid. Grid lines here are two-tier instead — ordinary
              columns get sdc-border-soft (this app's own "quiet row
              separator" — see hours/page.tsx, DataQualityDrill), and the six
              real sections (Job/Hours/Labor $/ETC/Parts/Sales-Margin) get
              the slightly darker sdc-border at their own boundary only. See
              vBorder/groupBoundaryKeys above: one lookup, called with the
              same key at the header, body, and totals row, so the boundary
              set can't drift between tiers the way three hand-written
              copies could. */}
          <table className="w-full border-separate border-spacing-0 text-sm [&_td]:tabular-nums [&_td]:font-semibold">
            <thead className="sticky top-0 z-20 bg-white">
              <tr>
                {bandCells.map((b, i) => {
                  const meta = GROUP_META[b.group];
                  // The identity band splits into two cells at the freeze
                  // boundary (frozen-ness breaks a run even when the group
                  // doesn't — see bandCells above), which would otherwise
                  // print "JOB   JOB" side by side. Same colour, no border
                  // between them, so leaving the second one's label blank
                  // reads as one continuous strip instead of a repeated word.
                  const repeatsPrev = i > 0 && bandCells[i - 1].group === b.group;
                  // Every band gets the strong group-boundary line at its OWN
                  // right edge, except the last one — colSpan already makes a
                  // band's right edge line up exactly with the last column of
                  // that group below it, so this is the one place the whole
                  // Job/Hours/Labor $/ETC/Parts/Sales-Margin boundary set can
                  // be drawn without repeating per-column logic. The frozen
                  // identity band's own right edge (Job Id/Job Name vs.
                  // everything scrolling) already carried this border before
                  // this change; it's unconditional now so the SECOND
                  // identity band (Customer/Status) — the actual Job→Hours
                  // boundary — gets it too, instead of being the one band
                  // with no line under it.
                  const isLastBand = i === bandCells.length - 1;
                  return (
                    <th
                      key={i}
                      colSpan={b.span}
                      className={`px-2 py-0.5 text-center text-label font-semibold uppercase tracking-wider ${meta.band} ${meta.text} ${
                        b.frozen ? "frozen-col frozen-col-last sticky left-0 z-10" : ""
                      } ${isLastBand ? "" : "border-r border-sdc-border"}`}
                    >
                      {repeatsPrev ? "" : meta.label}
                    </th>
                  );
                })}
              </tr>
              <tr className="border-b-2 border-sdc-border text-center text-label font-semibold uppercase tracking-wider text-sdc-gray-600">
                <SortableTh
                  label="Job Id"
                  sortKey="jobId"
                  type="id"
                  align="left"
                  sort={sortState}
                  onSort={toggleSort}
                  className={`frozen-col sticky left-0 z-10 bg-sdc-gray-100 px-2 py-1 align-bottom ${JOB_ID_COL_W} ${COL_BORDER_SOFT}`}
                />
                <SortableTh
                  label="Job Name"
                  sortKey="jobName"
                  type="text"
                  align="left"
                  sort={sortState}
                  onSort={toggleSort}
                  className={`frozen-col frozen-col-last sticky ${JOB_NAME_LEFT} z-10 border-r border-sdc-border bg-sdc-gray-100 px-2 py-1 align-bottom ${JOB_NAME_COL_W}`}
                />
                {!hiddenCols.has("customerName") && (
                  <SortableTh
                    label="Customer"
                    sortKey="customerName"
                    type="text"
                    align="left"
                    sort={sortState}
                    onSort={toggleSort}
                    className={`min-w-[9rem] px-2 py-1 align-bottom ${vBorder("customerName")}`}
                  />
                )}
                <SortableTh
                  label="Status"
                  sortKey="status"
                  type="status"
                  align="left"
                  sort={sortState}
                  onSort={toggleSort}
                  className={`min-w-[6.5rem] px-2 py-1 align-bottom ${vBorder("status")}`}
                />
                {COLS.filter((c) => c.key !== "customerName" && !hiddenCols.has(c.key)).map((c) => (
                  <SortableTh
                    key={c.key}
                    label={headerLabel(c.key, c.label)}
                    sortKey={c.key}
                    type={c.type}
                    align="right"
                    sort={sortState}
                    onSort={toggleSort}
                    className={`px-2 py-1 align-bottom leading-tight ${c.widthClass} ${vBorder(c.key)}`}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r, i) => {
                const alloc = allocations[r.jobId];
                // Translucent for normal cells — it composites with the row's
                // OWN hover tint underneath (see TABLE_ROW_HOVER on the <tr>);
                // opaque for the two frozen cells, which must stay solid on
                // every axis of scroll or the columns sliding underneath them
                // would show through (§ frozen-col doc comment, globals.css).
                const zebra = i % 2 === 1 ? "bg-sdc-gray-50/60" : "";
                const zebraFrozen = i % 2 === 1 ? "bg-sdc-gray-50" : "bg-white";
                return (
                  <tr key={r.jobId} className="group motion-interactive hover:bg-sdc-blue-light/40">
                    <td className={`frozen-col sticky left-0 z-10 border-b border-sdc-border-soft px-2 py-1.5 text-left align-middle ${JOB_ID_COL_W} ${COL_BORDER_SOFT} ${zebraFrozen} group-hover:bg-sdc-blue-light`}>
                      <button
                        className="font-mono text-sdc-blue-dark underline decoration-dotted"
                        title="Set a manual hour allocation for this job"
                        onClick={() => setAllocationJobId(r.jobId)}
                      >
                        {r.jobId}
                      </button>
                      {alloc && (alloc.eng.length > 0 || alloc.shop.length > 0) && (
                        <span className="ml-1 text-sdc-blue" title="Has a manual hour allocation">●</span>
                      )}
                    </td>
                    <td
                      className={`frozen-col frozen-col-last sticky ${JOB_NAME_LEFT} z-10 truncate border-b border-r border-b-sdc-border-soft border-r-sdc-border px-2 py-1.5 text-left align-middle ${JOB_NAME_COL_W} ${zebraFrozen} group-hover:bg-sdc-blue-light`}
                    >
                      <Link href={`/job-hours?jobs=${r.jobId}`} className="hover:underline" title={r.jobName || "Open in Job Details"}>
                        {r.jobName || "—"}
                      </Link>
                    </td>
                    {!hiddenCols.has("customerName") && (
                      <td className={`px-2 py-1.5 text-left align-middle border-b border-sdc-border-soft ${vBorder("customerName")} ${zebra}`}>{r.customerName || "—"}</td>
                    )}
                    <td className={`px-2 py-1.5 text-left align-middle border-b border-sdc-border-soft ${vBorder("status")} ${zebra}`}>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-label font-semibold ${statusTone(r.status)}`}>{r.status}</span>
                    </td>
                    {!hiddenCols.has("actualHours") && <td className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("actualHours")} ${zebra}`}>{fmtNum(r.actualHours)}</td>}
                    {!hiddenCols.has("engineeringHours") && <td className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("engineeringHours")} ${zebra}`}>{fmtNum(r.engineeringHours)}</td>}
                    {!hiddenCols.has("shopHours") && <td className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("shopHours")} ${zebra}`}>{fmtNum(r.shopHours)}</td>}
                    {!hiddenCols.has("otherHours") && <td className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("otherHours")} ${zebra}`}>{r.otherHours ? fmtNum(r.otherHours) : "—"}</td>}
                    {!hiddenCols.has("pmCost") && <td className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("pmCost")} ${zebra}`}>{fmtMoney(r.pmCost)}</td>}
                    {!hiddenCols.has("mfgCost") && <td className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("mfgCost")} ${zebra}`}>{fmtMoney(r.mfgCost)}</td>}
                    {!hiddenCols.has("laborCost") && <td className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("laborCost")} ${zebra}`}>{fmtMoney(r.laborCost)}</td>}
                    {!hiddenCols.has("etcEngHours") && (
                      <td className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("etcEngHours")} ${zebra}`}>
                        {r.etcEngHours == null ? "—" : fmtNum(r.etcEngHours)}
                      </td>
                    )}
                    {!hiddenCols.has("etcShopHours") && (
                      <td className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("etcShopHours")} ${zebra}`}>
                        {r.etcShopHours == null ? "—" : fmtNum(r.etcShopHours)}
                      </td>
                    )}
                    {!hiddenCols.has("etcPartsCost") && (
                      <td className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("etcPartsCost")} ${zebra}`}>
                        {r.etcPartsCost == null ? "—" : fmtMoney(r.etcPartsCost)}
                      </td>
                    )}
                    {!hiddenCols.has("partCost") && <td className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("partCost")} ${zebra}`}>{fmtMoney(r.partCost)}</td>}
                    {!hiddenCols.has("partInvoiced") && <td className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("partInvoiced")} ${zebra}`}>{fmtMoney(r.partInvoiced)}</td>}
                    {!hiddenCols.has("percentComplete") && <td className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("percentComplete")} ${zebra}`}>{fmtPct(r.percentComplete)}</td>}
                    {!hiddenCols.has("salesPrice") && <td className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("salesPrice")} ${zebra}`}>{fmtMoney(r.salesPrice)}</td>}
                    {!hiddenCols.has("startDate") && <td className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("startDate")} ${zebra}`}>{r.startDate ? r.startDate.slice(0, 4) : "—"}</td>}
                    {!hiddenCols.has("completeDate") && <td className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("completeDate")} ${zebra}`}>{r.completeDate ? r.completeDate.slice(0, 4) : "—"}</td>}
                    {!hiddenCols.has("profit") && (
                      <td
                        className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("profit")} ${
                          r.profit == null ? zebra : r.profit >= 0 ? "bg-sdc-green-bg/50 text-sdc-green-text" : "bg-sdc-red-bg/50 text-sdc-red-text"
                        }`}
                      >
                        {fmtMoney(r.profit)}
                      </td>
                    )}
                    {!hiddenCols.has("margin") && (
                      <td
                        className={`px-2 py-1.5 text-right align-middle border-b border-sdc-border-soft ${vBorder("margin")} ${
                          r.margin == null ? zebra : r.margin >= 0 ? "bg-sdc-green-bg/50 text-sdc-green-text" : "bg-sdc-red-bg/50 text-sdc-red-text"
                        }`}
                      >
                        {fmtPct(r.margin)}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              {/* The totals row: a colored top border (brand blue, not just
                  another gray hairline) plus a solid tint distinguish it from
                  a 143rd data row without going dark — "always easy to find"
                  without turning into a black bar. Sticky bottom-0 keeps it in
                  view against the scroll container the same way the header
                  already stays pinned against its top. */}
              <tr className="sticky bottom-0 border-t-2 border-sdc-blue bg-sdc-blue-light font-semibold text-sdc-navy">
                <td className="frozen-col sticky left-0 z-10 border-r border-sdc-border bg-sdc-blue-light px-2 py-1.5 text-left" colSpan={2}>
                  {visibleRows.length} jobs
                </td>
                {!hiddenCols.has("customerName") && <td className={`px-2 py-1.5 ${vBorder("customerName")}`} />}
                <td className={`px-2 py-1.5 ${vBorder("status")}`} />
                {!hiddenCols.has("actualHours") && <td className={`px-2 py-1.5 text-right ${vBorder("actualHours")}`}>{fmtNum(totals.actualHours)}</td>}
                {!hiddenCols.has("engineeringHours") && <td className={`px-2 py-1.5 text-right ${vBorder("engineeringHours")}`}>{fmtNum(totals.engineeringHours)}</td>}
                {!hiddenCols.has("shopHours") && <td className={`px-2 py-1.5 text-right ${vBorder("shopHours")}`}>{fmtNum(totals.shopHours)}</td>}
                {!hiddenCols.has("otherHours") && <td className={`px-2 py-1.5 text-right ${vBorder("otherHours")}`}>{fmtNum(totals.otherHours)}</td>}
                {!hiddenCols.has("pmCost") && <td className={`px-2 py-1.5 text-right ${vBorder("pmCost")}`}>{fmtMoney(totals.pmCost)}</td>}
                {!hiddenCols.has("mfgCost") && <td className={`px-2 py-1.5 text-right ${vBorder("mfgCost")}`}>{fmtMoney(totals.mfgCost)}</td>}
                {!hiddenCols.has("laborCost") && <td className={`px-2 py-1.5 text-right ${vBorder("laborCost")}`}>{fmtMoney(totals.laborCost)}</td>}
                {!hiddenCols.has("etcEngHours") && <td className={`px-2 py-1.5 text-right ${vBorder("etcEngHours")}`}>{fmtNum(totals.etcEngHours)}</td>}
                {!hiddenCols.has("etcShopHours") && <td className={`px-2 py-1.5 text-right ${vBorder("etcShopHours")}`}>{fmtNum(totals.etcShopHours)}</td>}
                {!hiddenCols.has("etcPartsCost") && <td className={`px-2 py-1.5 text-right ${vBorder("etcPartsCost")}`}>{fmtMoney(totals.etcPartsCost)}</td>}
                {!hiddenCols.has("partCost") && <td className={`px-2 py-1.5 text-right ${vBorder("partCost")}`}>{fmtMoney(totals.partCost)}</td>}
                {!hiddenCols.has("partInvoiced") && <td className={`px-2 py-1.5 text-right ${vBorder("partInvoiced")}`}>{fmtMoney(totals.partInvoiced)}</td>}
                {!hiddenCols.has("percentComplete") && <td className={`px-2 py-1.5 ${vBorder("percentComplete")}`} />}
                {!hiddenCols.has("salesPrice") && <td className={`px-2 py-1.5 text-right ${vBorder("salesPrice")}`}>{fmtMoney(totals.salesPrice)}</td>}
                {!hiddenCols.has("startDate") && <td className={`px-2 py-1.5 ${vBorder("startDate")}`} />}
                {!hiddenCols.has("completeDate") && <td className={`px-2 py-1.5 ${vBorder("completeDate")}`} />}
                {!hiddenCols.has("profit") && (
                  <td className={`px-2 py-1.5 text-right ${vBorder("profit")} ${totals.profit != null && totals.profit >= 0 ? "text-sdc-green-text" : "text-sdc-red-text"}`}>{fmtMoney(totals.profit)}</td>
                )}
                {!hiddenCols.has("margin") && <td className={`px-2 py-1.5 ${vBorder("margin")}`} />}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {rateMatrixOpen && (
        <JobCostRateMatrixModal
          defaultRates={rates}
          overrides={overrides}
          years={[...new Set([...years, ...Object.keys(overrides)])].sort((a, b) => b.localeCompare(a))}
          onClose={() => setRateMatrixOpen(false)}
          onSaveDefault={applyDefaultRate}
          onSaveYear={applyYearOverride}
          onClearAll={clearAllOverrides}
        />
      )}
      {activeJobForAllocation && (
        <JobCostHourAllocationModal
          row={activeJobForAllocation}
          rates={rates}
          overrides={overrides}
          allocation={allocations[activeJobForAllocation.jobId] ?? null}
          onClose={() => setAllocationJobId(null)}
          onSave={(alloc) => applyAllocation(activeJobForAllocation.jobId, alloc)}
        />
      )}
    </div>
  );
}
