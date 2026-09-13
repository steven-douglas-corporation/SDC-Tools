import type { Prisma } from "@prisma/client";
import { decodeParamList } from "@/lib/quoted-display-prefs";
import { VALID_JOB_TYPES, DEFAULT_VISIBLE_STATUSES, compareJobIds } from "@/lib/job-filters";

// ── What the Projects grid is currently SHOWING, as a query ──────────────────
//
// Extracted from quoted/page.tsx when the export arrived (§24, 2026-08-04). The
// requirement is that "the exported file must match the table currently shown to the
// user" — filters, statuses, dates, sorting — and the only way to promise that is for
// the page and the export to build the WHERE clause with the same code. Two copies of
// this, reading the same query string, would agree on the day they were written and
// drift the first time a default changed.
//
// Every rule in here was already in the page and is preserved exactly, including the
// three that are easy to get wrong:
//
//   * "undefined means everything, explicit (even empty) means the user's picks" —
//     absent params are defaults, not empty selections.
//   * A Prisma `in` never matches NULL, so an unset Customer filter must not become
//     `customer: { in: [...] }` — that would permanently hide every job with no
//     customer, including one just added on this page.
//   * Date bounds are VALIDATED, not trusted: an unparseable value from the query
//     string would reach Prisma as an Invalid Date and take the request down.

export const PROJECTS_SORT_KEYS = ["jobId", "status", "startDate", "completeDate"] as const;
export type ProjectsSortKey = (typeof PROJECTS_SORT_KEYS)[number];

// The day-to-day view (DEFAULT_VISIBLE_STATUSES in job-filters.ts): Active/HeadStart
// work, billable only. Anything else is opt-in through the filter chips.

export type ProjectsViewParams = {
  customers?: string;
  types?: string;
  statuses?: string;
  billables?: string;
  sort?: string;
  dir?: string;
  dateField?: string;
  from?: string;
  to?: string;
};

export type ProjectsQuery = {
  where: Prisma.JobWhereInput;
  sortKey: ProjectsSortKey;
  sortDir: "asc" | "desc";
  // For the export's filename and its audit record — a plain description of what the
  // reader is looking at.
  filterLabel: string;
  selected: { types: string[]; statuses: string[]; billables: string[]; customers: string[] | null };
};

function parseBound(v: string | undefined, endOfDay: boolean): Date | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}${endOfDay ? "T23:59:59.999" : "T00:00:00.000"}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// `allStatuses` / `allCustomers` come from the DB (the distinct lists the filter menu
// offers). The caller passes them because the page already loads them; the export route
// loads them the same way.
export function buildProjectsQuery(
  sp: ProjectsViewParams,
  options: { allStatuses: string[]; allCustomers: string[] },
): ProjectsQuery {
  const allTypes = [...VALID_JOB_TYPES];
  const selectedTypes = sp.types === undefined ? allTypes : decodeParamList(sp.types);
  const selectedCustomers = sp.customers === undefined ? options.allCustomers : decodeParamList(sp.customers);
  const selectedStatuses =
    sp.statuses === undefined
      ? DEFAULT_VISIBLE_STATUSES.filter((s) => options.allStatuses.includes(s))
      : decodeParamList(sp.statuses);
  const selectedBillables = sp.billables === undefined ? ["Billable"] : decodeParamList(sp.billables);
  const showBillable = selectedBillables.includes("Billable");
  const showNonBillable = selectedBillables.includes("Non-Billable");

  // Boolean columns have no `in` filter — both checked is no filter at all, neither
  // checked matches nothing (the same "empty selection shows nothing" rule the other
  // filters get from an empty `in`).
  const billableWhere: Prisma.JobWhereInput =
    showBillable && showNonBillable ? {} : showBillable ? { billable: true } : showNonBillable ? { billable: false } : { id: -1 };

  const customerWhere: Prisma.JobWhereInput = sp.customers === undefined ? {} : { customer: { in: selectedCustomers } };

  const dateColumn = sp.dateField === "complete" ? "completeDate" : "startDate";
  const dateFrom = parseBound(sp.from, false);
  const dateTo = parseBound(sp.to, true);
  const dateWhere: Prisma.JobWhereInput =
    dateFrom || dateTo ? { [dateColumn]: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } } : {};

  const sortKey: ProjectsSortKey = PROJECTS_SORT_KEYS.includes(sp.sort as ProjectsSortKey)
    ? (sp.sort as ProjectsSortKey)
    : "jobId";
  const sortDir = sp.dir === "desc" ? "desc" : "asc";

  // Short enough for a filename, specific enough to tell two exports apart.
  const parts: string[] = [];
  if (sp.statuses === undefined) parts.push("Active");
  else if (selectedStatuses.length > 0 && selectedStatuses.length <= 2) parts.push(...selectedStatuses);
  else if (selectedStatuses.length === 0) parts.push("NoStatus");
  else parts.push("AllStatuses");
  if (!(showBillable && showNonBillable)) parts.push(showBillable ? "Billable" : showNonBillable ? "NonBillable" : "None");
  if (sp.customers !== undefined) parts.push(selectedCustomers.length === 1 ? selectedCustomers[0] : `${selectedCustomers.length}Customers`);
  if (dateFrom || dateTo) parts.push(`${dateColumn === "completeDate" ? "Complete" : "Start"}${sp.from ?? ""}to${sp.to ?? ""}`);

  return {
    where: {
      type: { in: selectedTypes },
      ...customerWhere,
      status: { in: selectedStatuses },
      ...billableWhere,
      ...dateWhere,
    },
    sortKey,
    sortDir,
    filterLabel: parts.join("_") || "All",
    selected: {
      types: selectedTypes,
      statuses: selectedStatuses,
      billables: selectedBillables,
      customers: sp.customers === undefined ? null : selectedCustomers,
    },
  };
}

// The grid's own row order, applied after the DB sort. Job Id is a STRING column, so
// only a numeric comparison puts 979 before 1020 before 10000; and SDC's internal
// projects always sink to the bottom whatever the chosen sort, keyed on the same
// predicate that tints their rows.
export function sortProjectRows<T extends { jobId: string; customer: string | null }>(
  rows: T[],
  sortKey: ProjectsSortKey,
  sortDir: "asc" | "desc",
  isSdcCustomer: (c: string | null) => boolean,
): T[] {
  const out = [...rows];
  if (sortKey === "jobId") {
    out.sort((a, b) => (sortDir === "desc" ? -1 : 1) * compareJobIds(a.jobId, b.jobId));
  }
  // Array#sort is stable, so this only reorders across the SDC / non-SDC boundary.
  out.sort((a, b) => Number(isSdcCustomer(a.customer)) - Number(isSdcCustomer(b.customer)));
  return out;
}
