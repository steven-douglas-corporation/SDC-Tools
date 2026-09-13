import { prisma } from "@/lib/prisma";
import { SECTIONS, PARTS_COST_SECTION } from "@/lib/sections";
import { validJobTypeFilter, isSdcCustomer } from "@/lib/job-filters";
import { buildProjectsQuery, sortProjectRows, type ProjectsViewParams } from "@/lib/projects-query";
import { loadActualHoursBySection } from "@/lib/actual-hours";
import { round2 } from "@/lib/etc";
import type { CellValue, SheetColumn, SheetSpec } from "@/lib/export/sheet";

// ── The Projects grid, as a spreadsheet (§24.3) ───────────────────────────────
//
// Built from the SAME query the page renders (lib/projects-query.ts), so the file a
// manager gets is the table they were looking at: same filters, same statuses, same date
// range, same sort, same SDC-projects-at-the-bottom order.
//
// Every field the grid shows, plus the three derived ones a reader would otherwise have
// to compute by hand (hours remaining per section total, and the two cost variances).
// Deliberately NOT exported: internal primary keys, sync timestamps, the
// `costQuotedManuallyEdited` bookkeeping flags — §24.11 says the export must not carry
// backend-only fields, and a numeric internal id is exactly the kind of thing that ends
// up pasted into a support ticket as if it meant something.

export type ProjectsExportResult = { spec: SheetSpec; rowCount: number; filterLabel: string };

export async function buildProjectsExport(
  sp: ProjectsViewParams,
  now: Date,
): Promise<ProjectsExportResult> {
  // The filter menu's own option lists, loaded exactly as the page loads them — the
  // "no filter means everything" rule needs to know what everything IS.
  const [distinctStatuses, distinctCustomers] = await Promise.all([
    prisma.job.findMany({ where: validJobTypeFilter, distinct: ["status"], select: { status: true } }),
    prisma.job.findMany({ where: validJobTypeFilter, distinct: ["customer"], select: { customer: true } }),
  ]);
  const query = buildProjectsQuery(sp, {
    allStatuses: distinctStatuses.map((s) => s.status),
    allCustomers: distinctCustomers.map((c) => c.customer).filter((c): c is string => c != null),
  });

  const jobs = await prisma.job.findMany({
    where: query.where,
    include: { estimatedHours: true },
    orderBy: { [query.sortKey]: query.sortDir },
  });
  const ordered = sortProjectRows(jobs, query.sortKey, query.sortDir, isSdcCustomer);
  // Actual hours come from actual-hours.ts, not from a join on EtcEntry: a closed
  // month's EtcEntry.hoursWorked is frozen while people keep booking late time, so the
  // join understated every finished job. Same source as the grid's Actuals toggle.
  const actuals = await loadActualHoursBySection(ordered.map((j) => j.id));

  // Section columns: quoted and actual hours per section, in the grid's own order.
  const sectionColumns: SheetColumn[] = [];
  for (const s of SECTIONS) {
    if (s.code === PARTS_COST_SECTION) continue;
    sectionColumns.push({ header: "Quoted", group: `${s.name}`, type: "hours" });
    sectionColumns.push({ header: "Actual", group: `${s.name}`, type: "hours" });
    sectionColumns.push({ header: "Remaining", group: `${s.name}`, type: "hours" });
  }

  const columns: SheetColumn[] = [
    { header: "Job Id", type: "text", width: 12 },
    { header: "Project Name", type: "text", width: 38 },
    { header: "Customer", type: "text", width: 26 },
    { header: "Type", type: "text", width: 14 },
    { header: "Status", type: "text", width: 12 },
    { header: "Billable", type: "text", width: 12 },
    { header: "Start Date", type: "date" },
    { header: "Complete Date", type: "date" },
    { header: "Quoted Hours (total)", type: "hours", width: 14 },
    { header: "Actual Hours (total)", type: "hours", width: 14 },
    { header: "Hours Remaining (total)", type: "hours", width: 16 },
    { header: "Parts Cost Quoted", type: "currency" },
    // ── The basis is IN the header (2026-09-04) ──────────────────────────
    //
    // docs/PARTS-COST-VARIANCE-2026-09.md exists because a column called "Parts Cost
    // Actual" in this export was compared against a column called the same thing in a
    // spreadsheet, and the two were measured on different bases — GL-posted here,
    // everything-billed there. Neither said which, so the difference read as an app
    // error for weeks.
    //
    // The filename already carries todayStamp(now), so the as-of half is answered.
    // This is the other half: a comparison is now either like-for-like or visibly not.
    { header: "Parts Cost Actual (GL-posted)", type: "currency" },
    { header: "Parts Cost Remaining", type: "currency" },
    ...sectionColumns,
  ];

  const rows: CellValue[][] = [];
  // Column totals, accumulated as the rows are built so the footer can never disagree
  // with the body (§24.13.12).
  const totalsByIndex = new Map<number, number>();
  const addTotal = (i: number, v: number | null) => {
    if (v === null || !Number.isFinite(v)) return;
    totalsByIndex.set(i, (totalsByIndex.get(i) ?? 0) + v);
  };

  for (const job of ordered) {
    const quotedBySection = new Map(job.estimatedHours.map((h) => [h.section, Number(h.quotedHours)]));
    const actualBySection = actuals.get(job.id) ?? new Map<string, number>();
    const quotedTotal = [...quotedBySection.entries()]
      .filter(([code]) => code !== PARTS_COST_SECTION)
      .reduce((s, [, v]) => s + v, 0);
    const actualTotal = [...actualBySection.entries()]
      .filter(([code]) => code !== PARTS_COST_SECTION)
      .reduce((s, [, v]) => s + Number(v), 0);
    const costQuoted = job.costQuoted != null ? Number(job.costQuoted) : null;
    const costActual = job.costActualHistorical != null ? Number(job.costActualHistorical) : null;

    const row: CellValue[] = [
      job.jobId,
      job.jobName,
      job.customer ?? null,
      job.type ?? null,
      job.status,
      // The same effective rule the grid paints rows by: SDC's own projects read as
      // Non-Billable whatever the stored flag says.
      job.billable && !isSdcCustomer(job.customer) ? "Billable" : "Non-Billable",
      job.startDate ?? null,
      job.completeDate ?? null,
      quotedTotal,
      actualTotal,
      quotedTotal - actualTotal,
      costQuoted,
      costActual,
      // Blank rather than 0 when there is no quote: "no figure on file" and "nothing
      // left" are different answers, and a 0 here would be the export inventing one.
      costQuoted === null ? null : costQuoted - (costActual ?? 0),
    ];
    // Fixed-column totals.
    addTotal(8, quotedTotal);
    addTotal(9, actualTotal);
    addTotal(10, quotedTotal - actualTotal);
    addTotal(11, costQuoted);
    addTotal(12, costActual);
    addTotal(13, costQuoted === null ? null : costQuoted - (costActual ?? 0));

    let i = 14;
    for (const s of SECTIONS) {
      if (s.code === PARTS_COST_SECTION) continue;
      const q = quotedBySection.get(s.code) ?? 0;
      const a = Number(actualBySection.get(s.code) ?? 0);
      row.push(q, a, q - a);
      addTotal(i, q);
      addTotal(i + 1, a);
      addTotal(i + 2, q - a);
      i += 3;
    }
    rows.push(row);
  }

  // Rounded, for the same reason as the ETC totals: a summed column of Decimal-derived
  // floats otherwise prints as 1572.6299999999999 and makes the whole file look wrong.
  const totals: CellValue[] = columns.map((_, i) => {
    if (i === 0) return `TOTAL (${rows.length} projects)`;
    const v = totalsByIndex.get(i);
    return v === undefined ? null : round2(v);
  });

  return {
    rowCount: rows.length,
    filterLabel: query.filterLabel,
    spec: {
      sheetName: "Projects",
      title: "Projects",
      subtitle: [
        `Filters: ${describeFilters(query.selected)}`,
        `Sorted by ${query.sortKey} ${query.sortDir}`,
        `Exported ${now.toISOString().slice(0, 16).replace("T", " ")} — ${rows.length} project${rows.length === 1 ? "" : "s"}`,
      ],
      columns,
      rows,
      totals,
      // Job Id + Project Name stay in view when scrolling across the section columns.
      freezeColumns: 2,
    },
  };
}

function describeFilters(selected: {
  types: string[];
  statuses: string[];
  billables: string[];
  customers: string[] | null;
}): string {
  const parts = [
    `status ${selected.statuses.join("/") || "(none)"}`,
    `${selected.billables.join("/") || "(none)"}`,
    `type ${selected.types.join("/")}`,
  ];
  if (selected.customers) parts.push(`customers ${selected.customers.length === 1 ? selected.customers[0] : `${selected.customers.length} selected`}`);
  return parts.join(", ");
}
