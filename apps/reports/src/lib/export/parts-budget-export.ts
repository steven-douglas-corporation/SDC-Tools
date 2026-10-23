import type { CellValue, SheetSpec } from "@/lib/export/sheet";
import {
  BANDS,
  BASIS_LABEL,
  DEFAULT_SORT,
  FOCUS_LABEL,
  NONE_LABEL,
  filterRows,
  sortRows,
  type BandKey,
  type Focus,
  type PartsBudgetRow,
  type SortKey,
  type SortState,
  type StatusFilter,
} from "@/lib/parts-budget-bands";

// ── Excel / CSV export of the Projection vs Budget analysis (2026-10-22) ────────────────────────
//
// The file holds exactly the rows the Dashboard table shows: the same status chip, band, search text
// and sort, through the same functions (lib/parts-budget-bands.ts), applied to the same analysis. The
// browser sends only the FILTER (in the URL), never rows, so the file cannot contain anything the
// signed-in user could not already open on the Dashboard.

const SORT_KEYS: ReadonlySet<string> = new Set<SortKey>([
  "jobId", "jobName", "customer", "type", "status", "budget", "projected", "delta", "pct", "stillToPurchase", "excess",
]);
const STATUSES: ReadonlySet<string> = new Set<StatusFilter>(["both", "active", "complete"]);
const BAND_KEYS: ReadonlySet<string> = new Set<BandKey>(BANDS.map((b) => b.key));
const FOCUS_KEYS: ReadonlySet<string> = new Set<Focus>(["over", "excess", "pct", "dollars"]);

export type PartsBudgetExportQuery = {
  status?: string;
  band?: string;
  focus?: string;
  customers?: readonly string[];
  types?: readonly string[];
  q?: string;
  sort?: string;
  dir?: string;
};

export type ParsedPartsBudgetQuery = {
  status: StatusFilter;
  band: BandKey | null;
  focus: Focus | null;
  customers: string[];
  types: string[];
  q: string;
  sort: SortState;
};

// Customer and Type values come from the URL, so they are bounded: at most 200 of them, each trimmed to 200
// characters. A value that matches no job simply narrows to nothing, which is what a filter does.
const cleanList = (v: readonly string[] | undefined): string[] =>
  (v ?? []).slice(0, 200).map((s) => s.slice(0, 200));

/** Anything unrecognised falls back to the default rather than failing: a filter can only narrow. */
export function parsePartsBudgetQuery(q: PartsBudgetExportQuery): ParsedPartsBudgetQuery {
  return {
    status: q.status && STATUSES.has(q.status) ? (q.status as StatusFilter) : "both",
    // A card's list and a band are never combined: a focus wins, as it does on the Dashboard.
    focus: q.focus && FOCUS_KEYS.has(q.focus) ? (q.focus as Focus) : null,
    band: !(q.focus && FOCUS_KEYS.has(q.focus)) && q.band && BAND_KEYS.has(q.band) ? (q.band as BandKey) : null,
    customers: cleanList(q.customers),
    types: cleanList(q.types),
    q: (q.q ?? "").slice(0, 200),
    sort:
      q.sort && SORT_KEYS.has(q.sort)
        ? { key: q.sort as SortKey, dir: q.dir === "asc" ? "asc" : "desc" }
        : DEFAULT_SORT,
  };
}

const STATUS_LABEL: Record<StatusFilter, string> = { both: "Active and complete jobs", active: "Active jobs", complete: "Completed jobs" };

export function buildPartsBudgetSheet(
  rows: readonly PartsBudgetRow[],
  query: ParsedPartsBudgetQuery,
  asOf: string,
  now: Date,
): { spec: SheetSpec; rowCount: number; fileLabel: string } {
  const shown = sortRows(filterRows(rows, {
      status: query.status,
      band: query.band,
      q: query.q,
      focus: query.focus,
      customers: query.customers,
      types: query.types,
    }), query.sort);
  const band = query.band ? BANDS.find((b) => b.key === query.band)! : null;

  const cells = (r: PartsBudgetRow): CellValue[] => [
    r.jobId,
    r.jobName,
    r.customer,
    r.type,
    r.status,
    r.budget,
    r.projected,
    r.delta,
    r.pct,
    r.purchased,
    r.stillToPurchase,
    r.excess > 0.5 ? r.excess : null,
    BASIS_LABEL[r.basis],
  ];

  // Totals over the jobs that HAVE a budget, so Projected and Over/Under add up to the rows they sit under.
  const budgeted = shown.filter((r) => r.budget != null);
  const sum = (f: (r: PartsBudgetRow) => number) => budgeted.reduce((s, r) => s + f(r), 0);
  const totalBudget = sum((r) => r.budget as number);
  const totalProjected = sum((r) => r.projected);
  const totals: CellValue[] = [
    "Total",
    `${budgeted.length} job${budgeted.length === 1 ? "" : "s"} with a budget`,
    null, null, null,
    totalBudget,
    totalProjected,
    totalProjected - totalBudget,
    totalBudget !== 0 ? Math.round(((totalProjected - totalBudget) / totalBudget) * 1000) / 10 : null,
    null, null, null, null,
  ];

  const spec: SheetSpec = {
    sheetName: "Parts Cost vs Budget",
    title: "Parts Cost — Projection vs Budget",
    subtitle: [
      `${STATUS_LABEL[query.status]}${band ? ` · ${band.label}` : ""}${query.focus ? ` · ${FOCUS_LABEL[query.focus]}` : ""}${
        query.customers.length ? ` · customer: ${query.customers.map((c) => c || NONE_LABEL).join(", ")}` : ""
      }${query.types.length ? ` · type: ${query.types.map((t) => t || NONE_LABEL).join(", ")}` : ""}${query.q.trim() ? ` · matching "${query.q.trim()}"` : ""}`,
      `Live as of ${asOf.slice(0, 16).replace("T", " ")} UTC · exported ${now.toISOString().slice(0, 10)}`,
      "Projected = Purchased to date + Still to purchase; a closed job shows its final Parts Cost Actual. Over/Under = Projected − Budget.",
    ],
    columns: [
      { header: "Job ID", type: "text", width: 10 },
      { header: "Job", type: "text", width: 38 },
      { header: "Customer", type: "text", width: 26 },
      { header: "Type", type: "text", width: 12 },
      { header: "Status", type: "text", width: 11 },
      { header: "Budget", type: "currency", width: 14 },
      { header: "Projected", type: "currency", width: 14 },
      { header: "Over / Under ($)", type: "currency", width: 16 },
      { header: "Over / Under (%)", type: "number", width: 14 },
      { header: "Purchased to date", type: "currency", width: 16 },
      { header: "Still to purchase", type: "currency", width: 16 },
      { header: "Excess this month", type: "currency", width: 16 },
      { header: "Basis", type: "text", width: 24 },
    ],
    rows: shown.map(cells),
    totals,
    freezeColumns: 2,
  };
  return { spec, rowCount: shown.length, fileLabel: [query.status, query.focus ?? band?.key ?? "all"].join("_") };
}
