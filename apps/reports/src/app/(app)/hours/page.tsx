import Link from "next/link";
import { PageTitle } from "@/components/ui/Typography";
import { PAGE_SHELL, card } from "@/components/ui/classnames";
import { IndicatorCard } from "@/components/charts/IndicatorCard";
import { ExportMenu } from "@/components/ExportMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { hours, hoursCell, hoursExact } from "@/components/ui/format";
import { HoursFilterMenu, type HoursFilterSpec } from "@/components/HoursFilterMenu";
import { HoursDateFilter } from "@/components/HoursDateFilter";
import { HoursGroupByMenu } from "@/components/HoursGroupByMenu";
import { HoursGroupedTree } from "@/components/HoursGroupedTree";
import { HoursViewsMenu } from "@/components/HoursViewsMenu";
import { HoursClearFiltersButton } from "@/components/HoursClearFiltersButton";
import { getHoursFilterOptions, queryHoursGrouped, queryHoursRows, queryHoursSummary, type HoursRow } from "@/lib/hours-explorer";
import { parseHoursFilters, parseHoursGroupByList, parseHoursSort, countActiveHoursFilters, type HoursDetailSortKey } from "@/lib/hours-filters";
import { cycleSortState, type SortState } from "@/lib/table-sort";
import { listSharedHoursViews } from "@/lib/hours-saved-views-actions";
import { requirePagePermission } from "@/lib/require-permission";

// ── The Hours tab — a filterable, paginated view over JobHoursDetail ────────
//
// Server-rendered and URL-param-driven throughout (filters, date range, page, sort,
// group by), the same architecture Projects (lib/projects-query.ts) already uses — not
// a client component fetching over server actions. That is what makes the export match
// the table "for free": both read the query string through hours-filters.ts's one
// parser.
//
// Detail rows are paginated (skip/take in hours-explorer.ts) rather than loaded whole —
// the table never renders more than one page's worth of DOM rows, which is what the "not
// every punch in the browser at once" requirement asks for, with no new pagination
// library. Grouping supports MULTIPLE ordered dimensions now (HoursGroupByMenu +
// HoursGroupedTree) — level 0 is still computed here, server-side, exactly like the old
// single-dimension view; every deeper level is fetched lazily, on expand, by the tree
// component itself.

const PAGE_SIZE = 100;

type HoursPageSearchParams = {
  jobs?: string;
  employees?: string;
  sections?: string;
  departments?: string;
  from?: string;
  to?: string;
  page?: string;
  groupBy?: string;
  sort?: string;
  dir?: string;
  // Written by HoursViewsMenu when a saved view is loaded. Nothing on this page
  // filters by it — it is carried so the toolbar can count a loaded view as
  // active filtering and so "Clear filters" drops it with everything else.
  view?: string;
};

export async function HoursView({ params }: { params: HoursPageSearchParams }) {
  await requirePagePermission("hours:view");
  const sp = params;
  const filters = parseHoursFilters(sp);
  const groupByLevels = parseHoursGroupByList(sp.groupBy);
  const sort = parseHoursSort(sp.sort, sp.dir);
  const page = Math.max(1, Number(sp.page) || 1);
  const grouped = groupByLevels.length > 0;

  const [options, summary, rootRows, detail, sharedViewsResult] = await Promise.all([
    getHoursFilterOptions(),
    queryHoursSummary(filters),
    grouped ? queryHoursGrouped(filters, groupByLevels[0]) : Promise.resolve(null),
    grouped ? Promise.resolve(null) : queryHoursRows(filters, { page, pageSize: PAGE_SIZE, sort }),
    listSharedHoursViews(),
  ]);

  const filterSpecs: HoursFilterSpec[] = [
    {
      key: "jobs",
      label: "Jobs / Machines",
      searchable: true,
      selected: filters.jobIds ?? [],
      options: options.jobs.map((j) => ({ value: j.jobId, label: `${j.jobId} — ${j.jobName}` })),
    },
    {
      key: "employees",
      label: "Employees",
      searchable: true,
      selected: filters.employeeIds ?? [],
      options: options.employees.map((e) => ({ value: e.employeeId, label: e.name })),
    },
    {
      key: "sections",
      label: "Section-Function",
      searchable: true,
      selected: filters.sections ?? [],
      options: options.sections.map((s) => ({ value: s.code, label: `${s.code} — ${s.name}` })),
    },
    {
      key: "departments",
      label: "Department",
      selected: filters.departments ?? [],
      options: options.departments.map((d) => ({ value: d, label: d })),
    },
  ];

  // Builds a /hours?<qs> link that carries every currently-set param except the ones
  // being overridden — used by the detail table's sort headers and the pager, both
  // plain navigations (no client JS needed for either).
  function hrefWith(extra: Record<string, string | undefined>): string {
    const next = new URLSearchParams();
    const base: HoursPageSearchParams = { ...sp, ...extra };
    for (const [k, v] of Object.entries(base)) {
      if (v) next.set(k, v);
    }
    const s = next.toString();
    return s ? `/hours?${s}` : "/hours";
  }

  const hasAnyFilter = Boolean(sp.jobs || sp.employees || sp.sections || sp.departments || sp.from || sp.to);
  // Counted from the SAME query string the results come from, server-side, so
  // the badge cannot disagree with what is actually applied — see
  // countActiveHoursFilters for what does and does not count as a filter.
  const activeFilterCount = countActiveHoursFilters(sp);

  // Remounts HoursGroupedTree (dropping its expand/fetch state) only when the filters
  // or chosen levels themselves change — NOT on a routine LiveRefresh re-render with
  // the same filters/levels, which would otherwise collapse every open node every
  // 45s-5min. See HoursGroupedTree's own header for how it handles a same-key refresh.
  const treeKey = JSON.stringify({ filters, groupByLevels });

  return (
    <div className={`flex flex-col gap-4 ${PAGE_SHELL}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle>Hours</PageTitle>
        <div className="flex items-center gap-2">
          <HoursFilterMenu filters={filterSpecs} />
          <HoursDateFilter from={sp.from ?? ""} to={sp.to ?? ""} />
          <HoursGroupByMenu groupBy={groupByLevels} />
          <HoursViewsMenu sharedViews={sharedViewsResult.shared} />
          {/* Between the menus it resets and the Export it does not — the
              position the request asks for, and the one that reads as "undo all
              of the above". Muted styling: it is a way out, not the main act. */}
          <HoursClearFiltersButton activeCount={activeFilterCount} />
          <ExportMenu report="hours" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {/* `hours()`, not an inline toLocaleString — the one shared whole-hours
            formatter every screen in the app uses (ui/format.ts), so this KPI
            can never round differently from the grouped tree's own total or
            the export's. */}
        <IndicatorCard label="Total Hours" value={hours(summary.totalHours)} />
        <IndicatorCard label="Jobs" value={summary.jobs.toLocaleString()} />
        <IndicatorCard label="Employees" value={summary.employees.toLocaleString()} />
        <IndicatorCard label="Section-Function Codes" value={summary.sections.toLocaleString()} />
      </div>

      <div className={card("p-4")}>
        {grouped && rootRows ? (
          rootRows.length === 0 ? (
            <EmptyState
              title="No punches match these filters"
              message={hasAnyFilter ? "Try widening the date range or clearing a filter." : undefined}
            />
          ) : (
            <HoursGroupedTree key={treeKey} rootRows={rootRows} groupByLevels={groupByLevels} filters={filters} />
          )
        ) : detail ? (
          detail.rows.length === 0 ? (
            <EmptyState
              title="No punches match these filters"
              message={hasAnyFilter ? "Try widening the date range or clearing a filter." : undefined}
            />
          ) : (
            <>
              <DetailTable rows={detail.rows} sort={sort} hrefWith={hrefWith} />
              <Pager page={detail.page} pageSize={detail.pageSize} total={detail.total} hrefWith={hrefWith} />
            </>
          )
        ) : null}
      </div>
    </div>
  );
}

const TH = "border-b border-sdc-border px-3 py-1.5 text-left text-label font-semibold uppercase tracking-[0.08em] text-sdc-muted";
const TD = "border-b border-sdc-border-soft px-3 py-1.5 text-sm text-sdc-navy";
const TD_NUM = "border-b border-sdc-border-soft px-3 py-1.5 text-right font-mono text-sm tabular-nums text-sdc-navy";

// A server-rendered sortable header cell — a plain Link with a precomputed next-state
// href (cycleSortState, none -> asc -> desc -> none), the same "compute the next state
// as a Link" pattern this file already used for the old single-dimension Group By chips.
// No client component needed just for the detail table's sort: it's server-paginated,
// so the sort has to be a real Prisma ORDER BY (see hours-explorer.ts's orderByForSort)
// triggered by a navigation either way.
function SortLinkTh({
  label,
  sortKey,
  align,
  sort,
  hrefWith,
}: {
  label: string;
  sortKey: HoursDetailSortKey;
  align?: "right";
  sort: SortState<HoursDetailSortKey>;
  hrefWith: (extra: Record<string, string | undefined>) => string;
}) {
  const active = sort?.key === sortKey;
  const next = cycleSortState(sort, sortKey);
  const href = hrefWith({ sort: next?.key, dir: next?.direction, page: undefined });
  return (
    <th aria-sort={active ? (sort!.direction === "desc" ? "descending" : "ascending") : "none"} className={`${TH} ${align === "right" ? "text-right" : ""}`}>
      <Link
        href={href}
        className={`inline-flex w-full items-center gap-1 motion-interactive hover:opacity-70 ${align === "right" ? "justify-end" : ""}`}
      >
        <span>{label}</span>
        <svg
          viewBox="0 0 16 16"
          width="9"
          height="9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
          className={`shrink-0 ${active ? "opacity-100" : "opacity-30"} ${active && sort!.direction === "desc" ? "rotate-180" : ""}`}
        >
          <path d="M4 9 L8 5 L12 9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Link>
    </th>
  );
}

function DetailTable({
  rows,
  sort,
  hrefWith,
}: {
  rows: HoursRow[];
  sort: SortState<HoursDetailSortKey>;
  hrefWith: (extra: Record<string, string | undefined>) => string;
}) {
  return (
    <div className="styled-scrollbar overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <SortLinkTh label="Date" sortKey="date" sort={sort} hrefWith={hrefWith} />
            <th className={TH}>Employee</th>
            <th className={TH}>Department</th>
            <SortLinkTh label="Job Id" sortKey="jobId" sort={sort} hrefWith={hrefWith} />
            <SortLinkTh label="Job / Machine" sortKey="jobName" sort={sort} hrefWith={hrefWith} />
            {/* Section and Function are SEPARATE columns (2026-08-21). The single
                combined "Function / Section" cell ("10-211 — General") could not tell a
                reader whether the Section was wrong, the Function was wrong, or only
                the pairing was — which is the question every Paylocity reconciliation
                asks. Sorting is still on the combined `section` code, which is the
                indexed column; the split is presentational. */}
            <SortLinkTh label="Section" sortKey="section" sort={sort} hrefWith={hrefWith} />
            <th className={TH}>Section Name</th>
            <th className={TH}>Function</th>
            <th className={TH}>Function Name</th>
            <th className={TH}>Mapping Status</th>
            <SortLinkTh label="Hours" sortKey="hours" align="right" sort={sort} hrefWith={hrefWith} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-sdc-gray-50">
              <td className={TD}>{r.date}</td>
              <td className={TD}>{r.employee}</td>
              <td className={TD}>{r.department}</td>
              <td className={TD}>{r.jobId}</td>
              <td className={`${TD} max-w-xs truncate`} title={r.jobName}>
                {r.jobName}
              </td>
              {/* RAW Section/Function — what Paylocity actually said, never overwritten
                  with the standardized value. `standardTaskDescription` is the rule book's
                  verdict and reads "Undefined" for an unapproved combination, so the two
                  columns together show exactly where a punch is being reclassified. */}
              <td className={`${TD} font-mono`}>{r.rawSection}</td>
              <td className={TD}>{r.rawSectionName}</td>
              <td className={`${TD} font-mono`}>{r.rawFunction}</td>
              <td className={TD}>{r.standardTaskDescription}</td>
              <td className={TD}>
                {r.mappingStatus === "Undefined" ? (
                  <span
                    className="text-sdc-yellow-text"
                    title={
                      r.undefinedReason
                        ? `Undefined: ${r.undefinedReason} — Section ${r.rawSection || "(blank)"} + Function ${r.rawFunction || "(blank)"} is not in the approved rule book. The hours are still counted.`
                        : undefined
                    }
                  >
                    Undefined
                  </span>
                ) : (
                  <span className="text-sdc-muted">Mapped</span>
                )}
              </td>
              {/* hoursCell(), not a raw toLocaleString — never a decimal, and a real
                  but sub-half-hour punch reads as "<1" rather than a misleading "0"
                  (the same convention every other punch-level view in the app uses).
                  The exact figure is still reachable via the tooltip. */}
              <td className={TD_NUM} title={hoursExact(r.hours)}>{hoursCell(r.hours)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pager({
  page,
  pageSize,
  total,
  hrefWith,
}: {
  page: number;
  pageSize: number;
  total: number;
  hrefWith: (extra: Record<string, string | undefined>) => string;
}) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const hasPrev = page > 1;
  const hasNext = to < total;
  return (
    <div className="mt-3 flex items-center justify-between gap-3 text-xs text-sdc-muted">
      <span>
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()} punches
      </span>
      <div className="flex items-center gap-1.5">
        <PagerLink href={hrefWith({ page: page - 1 > 1 ? String(page - 1) : undefined })} disabled={!hasPrev}>
          Previous
        </PagerLink>
        <PagerLink href={hrefWith({ page: String(page + 1) })} disabled={!hasNext}>
          Next
        </PagerLink>
      </div>
    </div>
  );
}

function PagerLink({ href, disabled, children }: { href: string; disabled: boolean; children: React.ReactNode }) {
  if (disabled) {
    return <span className="cursor-not-allowed rounded-md border border-sdc-border px-2.5 py-1 text-sdc-gray-300">{children}</span>;
  }
  return (
    <Link href={href} className="rounded-md border border-sdc-border px-2.5 py-1 text-sdc-navy motion-interactive hover:bg-sdc-blue-light">
      {children}
    </Link>
  );
}


// -- Route entry point --
//
// The page's body lives in `HoursView` above so that BOTH this route and the split
// view can render it. Split view renders two views in ONE document (see
// lib/split-view.ts for why one document rather than two frames), which means a
// pane cannot be a route and therefore cannot read `searchParams` - there is only
// one URL, and two panes reading it would collide. So the body takes its context as
// a plain argument, and the two callers differ only in where they read that context
// from: this wrapper reads the URL, a pane reads its own `l.`/`r.` namespace.
//
// Nothing about this route's behaviour changes: same URL, same params, same server
// render. `searchParams` is still awaited HERE, which is what keeps this route
// dynamic exactly as before.
export default async function HoursPage({ searchParams }: { searchParams: Promise<HoursPageSearchParams> }) {
  return <HoursView params={await searchParams} />;
}
